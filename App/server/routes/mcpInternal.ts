import { Router, Request, Response, NextFunction } from "express";
import cron from "node-cron";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { Project } from "../db/entities/Project.js";
import { Todo, TodoPriority, TodoRecurrence, TodoStatus } from "../db/entities/Todo.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { validateBody } from "../middleware/validate.js";
import { toSlug } from "../lib/slug.js";
import { routineTemplate } from "../services/files.js";
import { registerRoutine } from "../services/cron.js";
import { recordAudit } from "../services/audit.js";
import { resolveMcpToken } from "../services/mcpTokens.js";
import {
  invokeConnectionTool,
  loadEmployeeConnections,
} from "../services/integrations.js";
import { getProvider } from "../integrations/index.js";

/**
 * Internal HTTP surface called by the built-in Genosyn MCP server binary.
 *
 * The binary runs as a child of the provider CLI (claude / codex / opencode)
 * that we spawn per chat turn or routine run. It speaks MCP to the CLI and
 * plain JSON to us. We trust the binary because we launched it ourselves —
 * authentication is a short-lived Bearer token that resolves to the acting
 * {employee, company} pair via {@link resolveMcpToken}.
 *
 * Every write records an AuditEvent with `actorKind: "ai"` and a matching
 * JournalEntry on the employee's diary so humans can see what the AI did
 * after the fact.
 */
export const mcpInternalRouter = Router();

type McpRequest = Request & {
  mcpEmployee?: AIEmployee;
  mcpCompany?: Company;
};

async function requireMcpToken(req: McpRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  const info = resolveMcpToken(token);
  if (!info) return res.status(401).json({ error: "Invalid or expired token" });
  const [emp, co] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({ id: info.employeeId }),
    AppDataSource.getRepository(Company).findOneBy({ id: info.companyId }),
  ]);
  if (!emp || !co || emp.companyId !== co.id) {
    return res.status(401).json({ error: "Token resolves to a stale actor" });
  }
  req.mcpEmployee = emp;
  req.mcpCompany = co;
  next();
}

mcpInternalRouter.use(requireMcpToken);

async function journal(
  employeeId: string,
  title: string,
  body = "",
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title,
        body,
        runId: null,
        routineId: null,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // Same philosophy as recordAudit — never let journalling failures break
    // the operation the AI is trying to perform.
    // eslint-disable-next-line no-console
    console.warn("[mcp-internal] journal write failed", err);
  }
}

function serializeEmployee(e: AIEmployee) {
  return { id: e.id, slug: e.slug, name: e.name, role: e.role };
}

function serializeRoutine(r: Routine) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    slug: r.slug,
    name: r.name,
    cronExpr: r.cronExpr,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt,
    brief: r.body,
  };
}

function serializeSkill(s: Skill) {
  return { id: s.id, slug: s.slug, name: s.name, body: s.body };
}

function serializeProject(p: Project) {
  return {
    id: p.id,
    slug: p.slug,
    key: p.key,
    name: p.name,
    description: p.description,
  };
}

function serializeTodo(t: Todo) {
  return {
    id: t.id,
    projectId: t.projectId,
    number: t.number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assigneeEmployeeId: t.assigneeEmployeeId,
    dueAt: t.dueAt,
    recurrence: t.recurrence,
  };
}

// ----- Orientation -----

mcpInternalRouter.post("/tools/get_self", async (req: McpRequest, res) => {
  const emp = req.mcpEmployee!;
  const co = req.mcpCompany!;
  res.json({
    employee: serializeEmployee(emp),
    company: { id: co.id, slug: co.slug, name: co.name },
  });
});

mcpInternalRouter.post("/tools/list_employees", async (req: McpRequest, res) => {
  const co = req.mcpCompany!;
  const all = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: co.id },
    order: { createdAt: "ASC" },
  });
  res.json({ employees: all.map(serializeEmployee) });
});

// ----- Skills -----

const employeeRefSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
  })
  .strict();

async function resolveEmployee(
  co: Company,
  self: AIEmployee,
  slug?: string,
): Promise<AIEmployee | null> {
  if (!slug || slug === self.slug) return self;
  return AppDataSource.getRepository(AIEmployee).findOneBy({
    companyId: co.id,
    slug,
  });
}

mcpInternalRouter.post(
  "/tools/list_skills",
  validateBody(employeeRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof employeeRefSchema>;
    const target = await resolveEmployee(req.mcpCompany!, req.mcpEmployee!, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const skills = await AppDataSource.getRepository(Skill).find({
      where: { employeeId: target.id },
      order: { createdAt: "ASC" },
    });
    res.json({ employee: serializeEmployee(target), skills: skills.map(serializeSkill) });
  },
);

// ----- Routines -----

mcpInternalRouter.post(
  "/tools/list_routines",
  validateBody(employeeRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof employeeRefSchema>;
    const target = await resolveEmployee(req.mcpCompany!, req.mcpEmployee!, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const routines = await AppDataSource.getRepository(Routine).find({
      where: { employeeId: target.id },
      order: { createdAt: "ASC" },
    });
    res.json({
      employee: serializeEmployee(target),
      routines: routines.map(serializeRoutine),
    });
  },
);

const createRoutineSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(80),
    cronExpr: z.string().refine((v) => cron.validate(v), "Invalid cron expression"),
    brief: z.string().max(20_000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_routine",
  validateBody(createRoutineSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createRoutineSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const target = await resolveEmployee(co, self, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });

    const repo = AppDataSource.getRepository(Routine);
    const baseSlug = toSlug(body.name) || "routine";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ employeeId: target.id, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }

    const r = repo.create({
      employeeId: target.id,
      name: body.name,
      slug,
      cronExpr: body.cronExpr,
      enabled: true,
      lastRunAt: null,
      body: body.brief?.trim() ? body.brief : routineTemplate(body.name, body.cronExpr),
    });
    await repo.save(r);
    registerRoutine(r);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "routine.create",
      targetType: "routine",
      targetId: r.id,
      targetLabel: r.name,
      metadata: { via: "mcp", employeeId: target.id, cronExpr: r.cronExpr },
    });
    await journal(
      target.id,
      `${self.name} scheduled a routine: "${r.name}"`,
      `Cron: \`${r.cronExpr}\`\n\nCreated via the built-in MCP tool.`,
    );

    res.json({ routine: serializeRoutine(r) });
  },
);

// ----- Projects & todos -----

mcpInternalRouter.post("/tools/list_projects", async (req: McpRequest, res) => {
  const co = req.mcpCompany!;
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId: co.id },
    order: { createdAt: "ASC" },
  });
  res.json({ projects: projects.map(serializeProject) });
});

const createProjectSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    key: z
      .string()
      .min(1)
      .max(6)
      .regex(/^[A-Za-z0-9]+$/)
      .optional(),
  })
  .strict();

function deriveProjectKey(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim();
  if (!cleaned) return "PRJ";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0] + (parts[2]?.[0] ?? "")).slice(0, 4);
  }
  return parts[0].slice(0, 4);
}

mcpInternalRouter.post(
  "/tools/create_project",
  validateBody(createProjectSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createProjectSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Project);
    const baseSlug = toSlug(body.name) || "project";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ companyId: co.id, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }
    const key = (body.key ?? deriveProjectKey(body.name)).toUpperCase();
    const p = repo.create({
      companyId: co.id,
      name: body.name,
      slug,
      description: body.description ?? "",
      key,
      createdById: null,
      todoCounter: 0,
    });
    await repo.save(p);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "project.create",
      targetType: "project",
      targetId: p.id,
      targetLabel: p.name,
      metadata: { via: "mcp", key: p.key },
    });
    await journal(self.id, `${self.name} created project "${p.name}"`, `Key: ${p.key}`);
    res.json({ project: serializeProject(p) });
  },
);

const listTodosSchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_todos",
  validateBody(listTodosSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listTodosSchema>;
    const co = req.mcpCompany!;
    const p = await AppDataSource.getRepository(Project).findOneBy({
      companyId: co.id,
      slug: body.projectSlug,
    });
    if (!p) return res.status(404).json({ error: "Project not found" });
    const todos = await AppDataSource.getRepository(Todo).find({
      where: { projectId: p.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    res.json({ project: serializeProject(p), todos: todos.map(serializeTodo) });
  },
);

const TODO_STATUSES: [TodoStatus, ...TodoStatus[]] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];
const TODO_PRIORITIES: [TodoPriority, ...TodoPriority[]] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];
const TODO_RECURRENCES: [TodoRecurrence, ...TodoRecurrence[]] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

const createTodoSchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    description: z.string().max(10_000).optional(),
    status: z.enum(TODO_STATUSES).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    assigneeEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    recurrence: z.enum(TODO_RECURRENCES).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_todo",
  validateBody(createTodoSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createTodoSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    const projRepo = AppDataSource.getRepository(Project);
    const project = await projRepo.findOneBy({ companyId: co.id, slug: body.projectSlug });
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Default assignee = the employee who called us. Humans can explicitly
    // pass null to unassign, or a different slug to delegate.
    let assigneeId: string | null = self.id;
    if (body.assigneeEmployeeSlug === null) {
      assigneeId = null;
    } else if (body.assigneeEmployeeSlug !== undefined) {
      const other = await AppDataSource.getRepository(AIEmployee).findOneBy({
        companyId: co.id,
        slug: body.assigneeEmployeeSlug,
      });
      if (!other) return res.status(400).json({ error: "Unknown assignee" });
      assigneeId = other.id;
    }

    project.todoCounter += 1;
    await projRepo.save(project);

    const status: TodoStatus = body.status ?? "todo";
    const todoRepo = AppDataSource.getRepository(Todo);
    const last = await todoRepo.findOne({
      where: { projectId: project.id, status },
      order: { sortOrder: "DESC" },
    });
    const sortOrder = (last?.sortOrder ?? 0) + 1000;

    const t = todoRepo.create({
      projectId: project.id,
      number: project.todoCounter,
      title: body.title,
      description: body.description ?? "",
      status,
      priority: body.priority ?? "none",
      assigneeEmployeeId: assigneeId,
      createdById: null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      sortOrder,
      completedAt: status === "done" ? new Date() : null,
      recurrence: body.recurrence ?? "none",
      recurrenceParentId: null,
    });
    await todoRepo.save(t);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "todo.create",
      targetType: "todo",
      targetId: t.id,
      targetLabel: `${project.key}-${t.number}: ${t.title}`,
      metadata: { via: "mcp", projectId: project.id, assigneeId },
    });
    await journal(
      self.id,
      `${self.name} created todo ${project.key}-${t.number}: "${t.title}"`,
      assigneeId === self.id
        ? "Assigned to self."
        : assigneeId
          ? "Assigned to a teammate."
          : "Unassigned.",
    );

    res.json({ todo: serializeTodo(t), projectKey: project.key });
  },
);

const updateTodoSchema = z
  .object({
    todoId: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    status: z.enum(TODO_STATUSES).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    assigneeEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_todo",
  validateBody(updateTodoSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateTodoSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    const todoRepo = AppDataSource.getRepository(Todo);
    const t = await todoRepo.findOneBy({ id: body.todoId });
    if (!t) return res.status(404).json({ error: "Todo not found" });
    const project = await AppDataSource.getRepository(Project).findOneBy({
      id: t.projectId,
      companyId: co.id,
    });
    if (!project) return res.status(404).json({ error: "Todo not found" });

    if (body.assigneeEmployeeSlug !== undefined) {
      if (body.assigneeEmployeeSlug === null) {
        t.assigneeEmployeeId = null;
      } else {
        const other = await AppDataSource.getRepository(AIEmployee).findOneBy({
          companyId: co.id,
          slug: body.assigneeEmployeeSlug,
        });
        if (!other) return res.status(400).json({ error: "Unknown assignee" });
        t.assigneeEmployeeId = other.id;
      }
    }
    if (body.title !== undefined) t.title = body.title;
    if (body.description !== undefined) t.description = body.description;
    if (body.priority !== undefined) t.priority = body.priority;
    if (body.dueAt !== undefined) t.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.status !== undefined) {
      const prev = t.status;
      t.status = body.status;
      if (body.status === "done" && prev !== "done") t.completedAt = new Date();
      if (body.status !== "done" && prev === "done") t.completedAt = null;
    }
    await todoRepo.save(t);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "todo.update",
      targetType: "todo",
      targetId: t.id,
      targetLabel: `${project.key}-${t.number}: ${t.title}`,
      metadata: { via: "mcp", changes: body },
    });
    res.json({ todo: serializeTodo(t) });
  },
);

// ----- Journal -----

const listJournalSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_journal",
  validateBody(listJournalSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listJournalSchema>;
    const target = await resolveEmployee(req.mcpCompany!, req.mcpEmployee!, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const entries = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId: target.id },
      order: { createdAt: "DESC" },
      take: body.limit ?? 20,
    });
    res.json({
      employee: serializeEmployee(target),
      entries: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        body: e.body,
        createdAt: e.createdAt,
      })),
    });
  },
);

const addJournalSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(10_000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_journal_entry",
  validateBody(addJournalSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addJournalSchema>;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(JournalEntry);
    const entry = repo.create({
      employeeId: self.id,
      kind: "note",
      title: body.title,
      body: body.body ?? "",
      runId: null,
      routineId: null,
      authorUserId: null,
    });
    await repo.save(entry);
    await recordAudit({
      companyId: req.mcpCompany!.id,
      actorEmployeeId: self.id,
      action: "journal.create",
      targetType: "journal_entry",
      targetId: entry.id,
      targetLabel: entry.title,
      metadata: { via: "mcp" },
    });
    res.json({
      entry: {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        createdAt: entry.createdAt,
      },
    });
  },
);

// ----- Integrations (dynamic tools per employee Grant) -----

/**
 * Return the integration-backed tools available to the calling employee.
 * Called by the MCP stdio binary on its first `tools/list` so the AI can
 * see one tool per (granted connection × provider tool it offers).
 *
 * Tool names are prefixed:
 *   - single connection for that provider → `<provider>_<tool>`
 *     (e.g. `stripe_list_customers`)
 *   - multiple connections → `<provider>_<connSlug>_<tool>`
 *     (e.g. `stripe_us_list_customers`, `stripe_eu_list_customers`)
 */
mcpInternalRouter.post("/integrations/_list", async (req: McpRequest, res) => {
  const emp = req.mcpEmployee!;
  const items = await loadEmployeeConnections(emp);

  // Group by provider so we know when to disambiguate by connection.
  const byProvider = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byProvider.get(it.connection.provider) ?? [];
    arr.push(it);
    byProvider.set(it.connection.provider, arr);
  }

  const out: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    connectionId: string;
    providerToolName: string;
  }> = [];

  for (const [providerId, group] of byProvider) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    const disambiguate = group.length > 1;
    for (const { connection } of group) {
      const connSlug = toolNameSegment(connection.label || connection.id);
      const prefix = disambiguate
        ? `${providerId}_${connSlug}`
        : providerId;
      for (const tool of provider.tools) {
        const name = `${prefix}_${tool.name}`;
        out.push({
          name,
          description: integrationToolDescription(
            provider.catalog.name,
            connection.label,
            tool.description,
          ),
          inputSchema: tool.inputSchema,
          connectionId: connection.id,
          providerToolName: tool.name,
        });
      }
    }
  }

  res.json({ tools: out });
});

const invokeToolSchema = z
  .object({
    connectionId: z.string().uuid(),
    toolName: z.string().min(1).max(80),
    args: z.record(z.unknown()).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/integrations/invoke",
  validateBody(invokeToolSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof invokeToolSchema>;
    const emp = req.mcpEmployee!;
    try {
      const result = await invokeConnectionTool({
        employee: emp,
        connectionId: body.connectionId,
        toolName: body.toolName,
        toolArgs: body.args ?? {},
      });
      await recordAudit({
        companyId: req.mcpCompany!.id,
        actorEmployeeId: emp.id,
        action: "integration.invoke",
        targetType: "connection",
        targetId: body.connectionId,
        targetLabel: body.toolName,
        metadata: { via: "mcp" },
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * Sanitize a connection label for use in an MCP tool name. MCP tool names
 * live in the same namespace as function names on most hosts — letters,
 * digits, underscores only. We lowercase, replace non-alphanum with `_`,
 * collapse repeats, and trim.
 */
function toolNameSegment(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "conn";
}

function integrationToolDescription(
  providerName: string,
  connectionLabel: string,
  inner: string,
): string {
  return `[${providerName} · ${connectionLabel}] ${inner}`;
}
