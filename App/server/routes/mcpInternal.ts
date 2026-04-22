import { Router, Request, Response, NextFunction } from "express";
import cron from "node-cron";
import { z } from "zod";
import { In } from "typeorm";
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
  getGrantWithConnection,
  invokeConnectionTool,
  loadEmployeeConnections,
} from "../services/integrations.js";
import {
  buildLinkOptionsFor,
  hasBaseGrant,
  hydrateField,
  hydrateRecord,
  listGrantedBasesForEmployee,
} from "../services/bases.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
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

// ----- Memory (durable facts injected into every prompt) -----

mcpInternalRouter.post("/tools/list_memory", async (req: McpRequest, res) => {
  const self = req.mcpEmployee!;
  const items = await AppDataSource.getRepository(EmployeeMemory).find({
    where: { employeeId: self.id },
    order: { createdAt: "ASC" },
  });
  res.json({
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      body: i.body,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    })),
  });
});

const addMemorySchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(4000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_memory",
  validateBody(addMemorySchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addMemorySchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = repo.create({
      employeeId: self.id,
      title: body.title,
      body: body.body ?? "",
      authorUserId: null,
    });
    await repo.save(row);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "memory.create",
      targetType: "memory_item",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({
      item: { id: row.id, title: row.title, body: row.body },
    });
  },
);

const updateMemorySchema = z
  .object({
    itemId: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(4000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_memory",
  validateBody(updateMemorySchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateMemorySchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = await repo.findOneBy({ id: body.itemId, employeeId: self.id });
    if (!row) return res.status(404).json({ error: "Memory item not found" });
    if (body.title !== undefined) row.title = body.title;
    if (body.body !== undefined) row.body = body.body;
    await repo.save(row);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "memory.update",
      targetType: "memory_item",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({ item: { id: row.id, title: row.title, body: row.body } });
  },
);

const deleteMemorySchema = z.object({ itemId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/delete_memory",
  validateBody(deleteMemorySchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteMemorySchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = await repo.findOneBy({ id: body.itemId, employeeId: self.id });
    if (!row) return res.status(404).json({ error: "Memory item not found" });
    await repo.delete({ id: row.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "memory.delete",
      targetType: "memory_item",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({ ok: true });
  },
);

// ----- Bases (per-employee grants) -----

/**
 * Load the base for this slug + assert the calling employee has an active
 * grant. Returns the base row on success, or `null` + writes a 403/404 and
 * returns `null` so the caller can early-out.
 */
async function loadGrantedBase(
  req: McpRequest,
  res: Response,
  baseSlug: string,
): Promise<Base | null> {
  const emp = req.mcpEmployee!;
  const co = req.mcpCompany!;
  const b = await AppDataSource.getRepository(Base).findOneBy({
    companyId: co.id,
    slug: baseSlug,
  });
  if (!b) {
    res.status(404).json({ error: "Base not found" });
    return null;
  }
  const ok = await hasBaseGrant(emp.id, b.id);
  if (!ok) {
    res.status(403).json({
      error: `No grant: ${emp.name} does not have access to base "${b.name}". Ask a teammate to grant it in Base settings → AI access.`,
    });
    return null;
  }
  return b;
}

mcpInternalRouter.post("/tools/list_bases", async (req: McpRequest, res) => {
  const emp = req.mcpEmployee!;
  const bases = await listGrantedBasesForEmployee(emp.id);
  res.json({
    bases: bases.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
    })),
  });
});

const baseRefSchema = z.object({ baseSlug: z.string().min(1).max(120) }).strict();

mcpInternalRouter.post(
  "/tools/get_base",
  validateBody(baseRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof baseRefSchema>;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const tables = await AppDataSource.getRepository(BaseTable).find({
      where: { baseId: b.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    const fields = tables.length
      ? await AppDataSource.getRepository(BaseField).find({
          where: { tableId: In(tables.map((t) => t.id)) },
          order: { sortOrder: "ASC", createdAt: "ASC" },
        })
      : [];
    const fieldsByTable = new Map<string, BaseField[]>();
    for (const f of fields) {
      if (!fieldsByTable.has(f.tableId)) fieldsByTable.set(f.tableId, []);
      fieldsByTable.get(f.tableId)!.push(f);
    }
    res.json({
      base: { id: b.id, slug: b.slug, name: b.name, description: b.description },
      tables: tables.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        fields: (fieldsByTable.get(t.id) ?? []).map(hydrateField),
      })),
    });
  },
);

const listRowsSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_base_rows",
  validateBody(listRowsSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listRowsSchema>;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const [fields, records] = await Promise.all([
      AppDataSource.getRepository(BaseField).find({
        where: { tableId: t.id },
        order: { sortOrder: "ASC", createdAt: "ASC" },
      }),
      AppDataSource.getRepository(BaseRecord).find({
        where: { tableId: t.id },
        order: { sortOrder: "ASC", createdAt: "ASC" },
        take: body.limit ?? 100,
      }),
    ]);
    const linkOptions = await buildLinkOptionsFor(fields);
    res.json({
      table: { id: t.id, slug: t.slug, name: t.name },
      fields: fields.map(hydrateField),
      records: records.map(hydrateRecord),
      linkOptions,
    });
  },
);

const writeRowSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    data: z.record(z.unknown()),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_base_row",
  validateBody(writeRowSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof writeRowSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const repo = AppDataSource.getRepository(BaseRecord);
    const last = await repo.findOne({
      where: { tableId: t.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await repo.save(
      repo.create({
        tableId: t.id,
        dataJson: JSON.stringify(body.data ?? {}),
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_row.create",
      targetType: "base_record",
      targetId: saved.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    await journal(
      self.id,
      `${self.name} added a row to ${b.name}/${t.name}`,
      "Via the base MCP tool.",
    );
    res.json({ row: hydrateRecord(saved) });
  },
);

const updateRowSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    rowId: z.string().uuid(),
    data: z.record(z.unknown()),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_base_row",
  validateBody(updateRowSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateRowSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const repo = AppDataSource.getRepository(BaseRecord);
    const r = await repo.findOneBy({ id: body.rowId, tableId: t.id });
    if (!r) return res.status(404).json({ error: "Row not found" });
    const data: Record<string, unknown> = JSON.parse(r.dataJson || "{}");
    for (const [k, v] of Object.entries(body.data)) {
      if (v === null || v === undefined || v === "") delete data[k];
      else data[k] = v;
    }
    r.dataJson = JSON.stringify(data);
    await repo.save(r);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_row.update",
      targetType: "base_record",
      targetId: r.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    res.json({ row: hydrateRecord(r) });
  },
);

const deleteRowSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    rowId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_base_row",
  validateBody(deleteRowSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteRowSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const repo = AppDataSource.getRepository(BaseRecord);
    const r = await repo.findOneBy({ id: body.rowId, tableId: t.id });
    if (!r) return res.status(404).json({ error: "Row not found" });
    await repo.delete({ id: r.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_row.delete",
      targetType: "base_record",
      targetId: r.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    res.json({ ok: true });
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
    const co = req.mcpCompany!;

    // Pre-read the connection so we can stamp provider + label onto the
    // audit row even when the invocation throws. The authoritative grant
    // check still lives inside `invokeConnectionTool`.
    const pair = await getGrantWithConnection(emp.id, body.connectionId);
    const connection = pair?.connection ?? null;

    const startedAt = Date.now();
    const args = body.args ?? {};
    try {
      const result = await invokeConnectionTool({
        employee: emp,
        connectionId: body.connectionId,
        toolName: body.toolName,
        toolArgs: args,
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: emp.id,
        action: "integration.invoke",
        targetType: "connection",
        targetId: body.connectionId,
        targetLabel: connection?.label
          ? `${connection.label} · ${body.toolName}`
          : body.toolName,
        metadata: {
          via: "mcp",
          provider: connection?.provider ?? null,
          connectionId: body.connectionId,
          connectionLabel: connection?.label ?? null,
          toolName: body.toolName,
          status: "ok",
          durationMs: Date.now() - startedAt,
          argsPreview: previewForAudit(args),
          resultPreview: previewForAudit(result),
        },
      });
      res.json({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: emp.id,
        action: "integration.invoke",
        targetType: "connection",
        targetId: body.connectionId,
        targetLabel: connection?.label
          ? `${connection.label} · ${body.toolName}`
          : body.toolName,
        metadata: {
          via: "mcp",
          provider: connection?.provider ?? null,
          connectionId: body.connectionId,
          connectionLabel: connection?.label ?? null,
          toolName: body.toolName,
          status: "error",
          durationMs: Date.now() - startedAt,
          argsPreview: previewForAudit(args),
          error: message,
        },
      });
      res.status(400).json({ error: message });
    }
  },
);

/**
 * Cap a payload stored in the audit log. Tool results (especially Metabase
 * dashboards, NocoDB rows) can be large — we want enough to make the "view
 * logs" modal useful but not so much that the audit row balloons. 20 KB of
 * pretty JSON is roughly 400 lines, which is plenty for humans to skim.
 */
function previewForAudit(value: unknown, capBytes = 20_000): string {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else {
    try {
      str = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      str = String(value);
    }
  }
  if (str.length <= capBytes) return str;
  return (
    str.slice(0, capBytes) +
    `\n…[truncated, ${str.length.toLocaleString()} chars total]`
  );
}

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
