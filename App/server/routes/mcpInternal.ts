import { Router, Request, Response, NextFunction } from "express";
import cron from "node-cron";
import { z } from "zod";
import { In, IsNull } from "typeorm";
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
import { routineTemplate, skillTemplate } from "../services/files.js";
import { registerRoutine } from "../services/cron.js";
import { recordAudit } from "../services/audit.js";
import { resolveMcpToken } from "../services/mcpTokens.js";
import { Approval } from "../db/entities/Approval.js";
import { createBrowserActionApproval } from "../services/approvals.js";
import { createNotification } from "../services/notifications.js";
import {
  getGrantWithConnection,
  invokeConnectionTool,
  loadEmployeeConnections,
} from "../services/integrations.js";
import {
  buildLinkOptionsFor,
  findBaseByName,
  findBaseTableByName,
  grantBaseAccess,
  hasBaseGrant,
  hydrateField,
  hydrateRecord,
  hydrateRecordAttachments,
  hydrateRecordComments,
  listGrantedBasesForEmployee,
  seedBaseFromTemplate,
  uniqueBaseSlug,
  uniqueTableSlug,
} from "../services/bases.js";
import { findBaseTemplate } from "../services/baseTemplates.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseField, BaseFieldType } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import {
  BASE_ATTACHMENTS_AI_MAX_BYTES,
  recordEmployeeAttachment,
  readBaseAttachmentText,
  resolveBaseAttachmentFile,
  deleteBaseAttachmentBytes,
} from "../services/baseRecordUploads.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { getProvider } from "../integrations/index.js";
import {
  archiveChannel,
  createChannel,
  findChannelBySlugOrId,
  findOrCreateDM,
  listChannelsForEmployee,
  postMessage,
  renameChannel,
} from "../services/workspaceChat.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { Team } from "../db/entities/Team.js";
import { Handoff, type HandoffStatus } from "../db/entities/Handoff.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { Resource } from "../db/entities/Resource.js";
import {
  hasNoteAccess,
  listAccessibleNoteIds,
  upsertNoteGrant,
} from "../services/notes.js";
import { ensureDefaultNotebook } from "../services/notebooks.js";
import {
  hasResourceAccess,
  listAccessibleResourceIds,
} from "../services/resources.js";

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
    reviewerEmployeeId: t.reviewerEmployeeId,
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

const createSkillSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(80),
    body: z.string().max(20_000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_skill",
  validateBody(createSkillSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createSkillSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const target = await resolveEmployee(co, self, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });

    const repo = AppDataSource.getRepository(Skill);
    const dup = await repo
      .createQueryBuilder("s")
      .where("s.employeeId = :eid", { eid: target.id })
      .andWhere("LOWER(s.name) = LOWER(:name)", { name: body.name.trim() })
      .getOne();
    if (dup) {
      return res.status(409).json({
        error: `A skill named "${body.name}" already exists for ${target.name}`,
      });
    }
    const baseSlug = toSlug(body.name) || "skill";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ employeeId: target.id, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }

    const s = repo.create({
      employeeId: target.id,
      name: body.name,
      slug,
      body: body.body?.trim() ? body.body : skillTemplate(body.name),
    });
    await repo.save(s);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "skill.create",
      targetType: "skill",
      targetId: s.id,
      targetLabel: s.name,
      metadata: { via: "mcp", employeeId: target.id },
    });
    await journal(
      target.id,
      `${self.name} added a skill: "${s.name}"`,
      "Created via the built-in MCP tool.",
    );

    res.json({ skill: serializeSkill(s) });
  },
);

const updateSkillSchema = z
  .object({
    skillId: z.string().uuid(),
    name: z.string().min(1).max(80).optional(),
    body: z.string().max(20_000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_skill",
  validateBody(updateSkillSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateSkillSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const repo = AppDataSource.getRepository(Skill);
    const skill = await repo.findOneBy({ id: body.skillId });
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: skill.employeeId,
      companyId: co.id,
    });
    if (!owner) return res.status(404).json({ error: "Skill not found" });

    if (body.name !== undefined && body.name.trim() !== skill.name) {
      const dup = await repo
        .createQueryBuilder("s")
        .where("s.employeeId = :eid", { eid: owner.id })
        .andWhere("LOWER(s.name) = LOWER(:name)", { name: body.name.trim() })
        .andWhere("s.id != :sid", { sid: skill.id })
        .getOne();
      if (dup) {
        return res.status(409).json({
          error: `A skill named "${body.name}" already exists for ${owner.name}`,
        });
      }
      skill.name = body.name;
    }
    if (body.body !== undefined) skill.body = body.body;
    await repo.save(skill);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "skill.update",
      targetType: "skill",
      targetId: skill.id,
      targetLabel: skill.name,
      metadata: { via: "mcp", employeeId: owner.id, changes: body },
    });
    res.json({ skill: serializeSkill(skill) });
  },
);

const deleteSkillSchema = z.object({ skillId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/delete_skill",
  validateBody(deleteSkillSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteSkillSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const repo = AppDataSource.getRepository(Skill);
    const skill = await repo.findOneBy({ id: body.skillId });
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: skill.employeeId,
      companyId: co.id,
    });
    if (!owner) return res.status(404).json({ error: "Skill not found" });

    await repo.delete({ id: skill.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "skill.delete",
      targetType: "skill",
      targetId: skill.id,
      targetLabel: skill.name,
      metadata: { via: "mcp", employeeId: owner.id },
    });
    await journal(
      owner.id,
      `${self.name} removed the skill "${skill.name}"`,
      "Deleted via the built-in MCP tool.",
    );
    res.json({ ok: true });
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
    const dup = await repo
      .createQueryBuilder("r")
      .where("r.employeeId = :eid", { eid: target.id })
      .andWhere("LOWER(r.name) = LOWER(:name)", { name: body.name.trim() })
      .getOne();
    if (dup) {
      return res.status(409).json({
        error: `A routine named "${body.name}" already exists for ${target.name}`,
      });
    }
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
    registerRoutine(r);
    await repo.save(r);

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
    const dup = await repo
      .createQueryBuilder("p")
      .where("p.companyId = :cid", { cid: co.id })
      .andWhere("LOWER(p.name) = LOWER(:name)", { name: body.name.trim() })
      .getOne();
    if (dup) {
      return res.status(409).json({
        error: `A project named "${body.name}" already exists in this company`,
      });
    }
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
    reviewerEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
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

    let reviewerId: string | null = null;
    if (body.reviewerEmployeeSlug) {
      const rv = await AppDataSource.getRepository(AIEmployee).findOneBy({
        companyId: co.id,
        slug: body.reviewerEmployeeSlug,
      });
      if (!rv) return res.status(400).json({ error: "Unknown reviewer" });
      reviewerId = rv.id;
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
      reviewerEmployeeId: reviewerId,
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
    reviewerEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
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
        t.assigneeUserId = null;
      }
    }
    if (body.reviewerEmployeeSlug !== undefined) {
      if (body.reviewerEmployeeSlug === null) {
        t.reviewerEmployeeId = null;
      } else {
        const rv = await AppDataSource.getRepository(AIEmployee).findOneBy({
          companyId: co.id,
          slug: body.reviewerEmployeeSlug,
        });
        if (!rv) return res.status(400).json({ error: "Unknown reviewer" });
        t.reviewerEmployeeId = rv.id;
        t.reviewerUserId = null;
      }
    }
    if (body.title !== undefined) t.title = body.title;
    if (body.description !== undefined) t.description = body.description;
    if (body.priority !== undefined) t.priority = body.priority;
    if (body.dueAt !== undefined) t.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    let justEnteredReview = false;
    if (body.status !== undefined) {
      const prev = t.status;
      t.status = body.status;
      if (body.status === "done" && prev !== "done") t.completedAt = new Date();
      if (body.status !== "done" && prev === "done") t.completedAt = null;
      if (body.status === "in_review" && prev !== "in_review") {
        justEnteredReview = true;
      }
    }
    await todoRepo.save(t);

    if (justEnteredReview && t.reviewerUserId) {
      void notifyTodoReviewByEmployee({
        companyId: co.id,
        todo: t,
        project,
        actorEmployeeId: self.id,
        actorEmployeeName: self.name,
      }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[mcpInternal] notify review requested failed:", e);
      });
    }

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

// ----- Record detail (comments + attachments) -----

/**
 * Walk a row id back up through table → base, asserting the calling employee
 * holds a grant on the owning base. Returns `null` plus a 403/404 response on
 * failure so the route handler can early-out with a single check.
 */
async function loadGrantedRecord(
  req: McpRequest,
  res: Response,
  rowId: string,
): Promise<
  | { record: BaseRecord; table: BaseTable; base: Base }
  | null
> {
  const emp = req.mcpEmployee!;
  const co = req.mcpCompany!;
  const record = await AppDataSource.getRepository(BaseRecord).findOneBy({
    id: rowId,
  });
  if (!record) {
    res.status(404).json({ error: "Record not found" });
    return null;
  }
  const table = await AppDataSource.getRepository(BaseTable).findOneBy({
    id: record.tableId,
  });
  if (!table) {
    res.status(404).json({ error: "Table not found" });
    return null;
  }
  const base = await AppDataSource.getRepository(Base).findOneBy({
    id: table.baseId,
    companyId: co.id,
  });
  if (!base) {
    res.status(404).json({ error: "Base not found" });
    return null;
  }
  const ok = await hasBaseGrant(emp.id, base.id);
  if (!ok) {
    res.status(403).json({
      error: `No grant: ${emp.name} does not have access to base "${base.name}". Ask a teammate to grant it in Base settings → AI access.`,
    });
    return null;
  }
  return { record, table, base };
}

const recordRefSchema = z
  .object({
    recordId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_base_record",
  validateBody(recordRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof recordRefSchema>;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const fields = await AppDataSource.getRepository(BaseField).find({
      where: { tableId: found.table.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    const linkOptions = await buildLinkOptionsFor(fields);
    const [comments, attachments] = await Promise.all([
      AppDataSource.getRepository(BaseRecordComment).find({
        where: { recordId: found.record.id },
        order: { createdAt: "ASC" },
      }),
      AppDataSource.getRepository(BaseRecordAttachment).find({
        where: { recordId: found.record.id },
        order: { createdAt: "ASC" },
      }),
    ]);
    const co = req.mcpCompany!;
    res.json({
      base: { id: found.base.id, slug: found.base.slug, name: found.base.name },
      table: {
        id: found.table.id,
        slug: found.table.slug,
        name: found.table.name,
      },
      record: hydrateRecord(found.record),
      fields: fields.map(hydrateField),
      linkOptions,
      comments: await hydrateRecordComments(co.id, comments),
      attachments: await hydrateRecordAttachments(co.id, attachments),
    });
  },
);

mcpInternalRouter.post(
  "/tools/list_record_comments",
  validateBody(recordRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof recordRefSchema>;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const co = req.mcpCompany!;
    const comments = await AppDataSource.getRepository(BaseRecordComment).find({
      where: { recordId: found.record.id },
      order: { createdAt: "ASC" },
    });
    res.json({ comments: await hydrateRecordComments(co.id, comments) });
  },
);

const createRecordCommentSchema = z
  .object({
    recordId: z.string().uuid(),
    body: z.string().min(1).max(10_000),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_record_comment",
  validateBody(createRecordCommentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createRecordCommentSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordComment);
    const saved = await repo.save(
      repo.create({
        recordId: found.record.id,
        authorUserId: null,
        authorEmployeeId: self.id,
        body: body.body,
      }),
    );
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_comment.create",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: {
        via: "mcp",
        commentId: saved.id,
        baseId: found.base.id,
        tableId: found.table.id,
      },
    });
    await journal(
      self.id,
      `${self.name} commented on ${found.base.name}/${found.table.name}`,
      body.body.length > 240 ? `${body.body.slice(0, 240)}…` : body.body,
    );
    const [hydrated] = await hydrateRecordComments(co.id, [saved]);
    res.json({ comment: hydrated });
  },
);

const deleteRecordCommentSchema = z
  .object({
    recordId: z.string().uuid(),
    commentId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_record_comment",
  validateBody(deleteRecordCommentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteRecordCommentSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordComment);
    const cmt = await repo.findOneBy({
      id: body.commentId,
      recordId: found.record.id,
    });
    if (!cmt) return res.status(404).json({ error: "Comment not found" });
    // AI employees can only delete comments they themselves authored. They
    // shouldn't be able to silence humans on a record.
    if (cmt.authorEmployeeId !== self.id) {
      return res.status(403).json({
        error: "AI employees may only delete their own comments",
      });
    }
    await repo.delete({ id: cmt.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_comment.delete",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: { via: "mcp", commentId: cmt.id },
    });
    res.json({ ok: true });
  },
);

mcpInternalRouter.post(
  "/tools/list_record_attachments",
  validateBody(recordRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof recordRefSchema>;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const co = req.mcpCompany!;
    const rows = await AppDataSource.getRepository(BaseRecordAttachment).find({
      where: { recordId: found.record.id },
      order: { createdAt: "ASC" },
    });
    res.json({ attachments: await hydrateRecordAttachments(co.id, rows) });
  },
);

const attachToRecordSchema = z
  .object({
    recordId: z.string().uuid(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120).optional(),
    contentText: z.string().optional(),
    contentBase64: z.string().optional(),
  })
  .strict()
  .refine(
    (b) =>
      (b.contentText !== undefined) !== (b.contentBase64 !== undefined),
    "Provide exactly one of contentText or contentBase64",
  );

mcpInternalRouter.post(
  "/tools/attach_file_to_record",
  validateBody(attachToRecordSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof attachToRecordSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;

    let bytes: Buffer;
    let mimeType = body.mimeType;
    if (body.contentText !== undefined) {
      bytes = Buffer.from(body.contentText, "utf8");
      if (!mimeType) mimeType = "text/plain; charset=utf-8";
    } else {
      try {
        bytes = Buffer.from(body.contentBase64 ?? "", "base64");
      } catch {
        return res.status(400).json({ error: "Invalid base64" });
      }
      if (!mimeType) mimeType = "application/octet-stream";
    }
    if (bytes.length === 0) {
      return res.status(400).json({ error: "Empty file" });
    }
    if (bytes.length > BASE_ATTACHMENTS_AI_MAX_BYTES) {
      return res.status(413).json({
        error: `Attachment exceeds the ${BASE_ATTACHMENTS_AI_MAX_BYTES / (1024 * 1024)} MB AI upload cap`,
      });
    }

    const row = await recordEmployeeAttachment({
      companyId: co.id,
      companySlug: co.slug,
      recordId: found.record.id,
      filename: body.filename,
      mimeType,
      bytes,
      uploadedByEmployeeId: self.id,
    });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_attachment.create",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: {
        via: "mcp",
        attachmentId: row.id,
        filename: row.filename,
        sizeBytes: Number(row.sizeBytes),
      },
    });
    await journal(
      self.id,
      `${self.name} attached "${body.filename}" to ${found.base.name}/${found.table.name}`,
      `Mime: ${mimeType}, ${bytes.length} bytes.`,
    );
    const [hydrated] = await hydrateRecordAttachments(co.id, [row]);
    res.json({ attachment: hydrated });
  },
);

const readAttachmentSchema = z
  .object({
    recordId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    /** Cap content read into memory. Defaults to 256 KiB. */
    maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/read_record_attachment",
  validateBody(readAttachmentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof readAttachmentSchema>;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordAttachment);
    const row = await repo.findOneBy({
      id: body.attachmentId,
      recordId: found.record.id,
    });
    if (!row) return res.status(404).json({ error: "Attachment not found" });
    if (row.companyId !== co.id) {
      return res.status(403).json({ error: "Wrong company" });
    }
    const max = body.maxBytes ?? 256 * 1024;
    const text = await readBaseAttachmentText(row, co.slug, max);
    if (text === null) {
      return res.status(413).json({
        error:
          "Attachment is missing on disk or exceeds the maxBytes cap. Ask a human to download it from the UI for now.",
      });
    }
    res.json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
      },
      content: text,
    });
  },
);

const deleteAttachmentSchema = z
  .object({
    recordId: z.string().uuid(),
    attachmentId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_record_attachment",
  validateBody(deleteAttachmentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteAttachmentSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordAttachment);
    const row = await repo.findOneBy({
      id: body.attachmentId,
      recordId: found.record.id,
    });
    if (!row) return res.status(404).json({ error: "Attachment not found" });
    // AI may only remove attachments it uploaded itself.
    if (row.uploadedByEmployeeId !== self.id) {
      return res.status(403).json({
        error: "AI employees may only delete attachments they uploaded",
      });
    }
    if (row.companyId !== co.id) {
      return res.status(403).json({ error: "Wrong company" });
    }
    // Resolve to confirm it lives under our root and grab the path before
    // dropping the row, so the bytes go too.
    const resolved = await resolveBaseAttachmentFile(row.id, co.id);
    if (resolved) await deleteBaseAttachmentBytes(resolved.row, co.slug);
    await repo.delete({ id: row.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_attachment.delete",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: { via: "mcp", attachmentId: row.id },
    });
    res.json({ ok: true });
  },
);

// ----- Base schema writes (create base / table / field) -----

const BASE_COLORS = ["indigo", "emerald", "amber", "rose", "sky", "violet", "slate"] as const;
const FIELD_TYPES_ENUM: [BaseFieldType, ...BaseFieldType[]] = [
  "text",
  "longtext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "email",
  "url",
  "select",
  "multiselect",
  "link",
];

function randOptionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function hydrateBase(b: Base) {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    description: b.description,
    icon: b.icon,
    color: b.color,
  };
}

function hydrateTable(t: BaseTable) {
  return { id: t.id, slug: t.slug, name: t.name, sortOrder: t.sortOrder };
}

const createBaseSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    icon: z.string().max(40).optional(),
    color: z.enum(BASE_COLORS).optional(),
    templateId: z.string().min(1).max(120).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_base",
  validateBody(createBaseSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createBaseSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const template = body.templateId ? findBaseTemplate(body.templateId) : null;
    if (body.templateId && !template) {
      return res.status(400).json({ error: `Unknown template: ${body.templateId}` });
    }

    if (await findBaseByName(co.id, body.name)) {
      return res
        .status(409)
        .json({ error: `A base named "${body.name}" already exists in this company` });
    }

    const slug = await uniqueBaseSlug(co.id, toSlug(body.name));
    const repo = AppDataSource.getRepository(Base);
    const b = await repo.save(
      repo.create({
        companyId: co.id,
        name: body.name,
        slug,
        description: body.description ?? template?.description ?? "",
        icon: body.icon ?? template?.icon ?? "Database",
        color: body.color ?? template?.color ?? "indigo",
        createdById: null,
      }),
    );
    if (template) await seedBaseFromTemplate(b.id, template);

    // Auto-grant the creating employee so the base shows up in list_bases
    // without a second human-driven step.
    await grantBaseAccess(self.id, b.id);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base.create",
      targetType: "base",
      targetId: b.id,
      targetLabel: b.name,
      metadata: { via: "mcp", templateId: template?.id ?? null, autoGranted: true },
    });
    await journal(
      self.id,
      `${self.name} created base "${b.name}"`,
      template
        ? `Seeded from template \`${template.id}\`. Access granted to self.`
        : "Empty base. Access granted to self.",
    );
    res.json({ base: hydrateBase(b) });
  },
);

const createBaseTableSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_base_table",
  validateBody(createBaseTableSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createBaseTableSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;

    if (await findBaseTableByName(b.id, body.name)) {
      return res.status(409).json({
        error: `A table named "${body.name}" already exists in base "${b.name}"`,
      });
    }
    const slug = await uniqueTableSlug(b.id, toSlug(body.name));
    const last = await AppDataSource.getRepository(BaseTable).findOne({
      where: { baseId: b.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await AppDataSource.getRepository(BaseTable).save(
      AppDataSource.getRepository(BaseTable).create({
        baseId: b.id,
        name: body.name,
        slug,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    const primary = await AppDataSource.getRepository(BaseField).save(
      AppDataSource.getRepository(BaseField).create({
        tableId: saved.id,
        name: "Name",
        type: "text",
        configJson: "{}",
        isPrimary: true,
        sortOrder: 1000,
      }),
    );

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_table.create",
      targetType: "base_table",
      targetId: saved.id,
      targetLabel: `${b.name}/${saved.name}`,
      metadata: { via: "mcp", baseId: b.id },
    });
    await journal(
      self.id,
      `${self.name} added table "${saved.name}" to ${b.name}`,
      "Seeded with a primary `Name` text field.",
    );
    res.json({ table: hydrateTable(saved), primaryField: hydrateField(primary) });
  },
);

const updateBaseTableSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_base_table",
  validateBody(updateBaseTableSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateBaseTableSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const tableRepo = AppDataSource.getRepository(BaseTable);
    const t = await tableRepo.findOneBy({ baseId: b.id, slug: body.tableSlug });
    if (!t) return res.status(404).json({ error: "Table not found" });

    if (await findBaseTableByName(b.id, body.name, t.id)) {
      return res.status(409).json({
        error: `A table named "${body.name}" already exists in base "${b.name}"`,
      });
    }
    const prevName = t.name;
    t.name = body.name;
    await tableRepo.save(t);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_table.update",
      targetType: "base_table",
      targetId: t.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, prevName },
    });
    res.json({ table: hydrateTable(t) });
  },
);

const deleteBaseTableSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_base_table",
  validateBody(deleteBaseTableSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteBaseTableSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const tableRepo = AppDataSource.getRepository(BaseTable);
    const t = await tableRepo.findOneBy({ baseId: b.id, slug: body.tableSlug });
    if (!t) return res.status(404).json({ error: "Table not found" });

    await AppDataSource.getRepository(BaseRecord).delete({ tableId: t.id });
    await AppDataSource.getRepository(BaseField).delete({ tableId: t.id });
    await tableRepo.delete({ id: t.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_table.delete",
      targetType: "base_table",
      targetId: t.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id },
    });
    await journal(
      self.id,
      `${self.name} deleted table "${t.name}" from ${b.name}`,
      "All fields and rows removed.",
    );
    res.json({ ok: true });
  },
);

const fieldOptionSchema = z
  .object({
    id: z.string().min(1).max(40).optional(),
    label: z.string().min(1).max(80),
    color: z.enum(BASE_COLORS).optional(),
  })
  .strict();

const addBaseFieldSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
    type: z.enum(FIELD_TYPES_ENUM),
    options: z.array(fieldOptionSchema).max(100).optional(),
    linkTargetTableSlug: z.string().min(1).max(120).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_base_field",
  validateBody(addBaseFieldSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addBaseFieldSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });

    let config: Record<string, unknown> = {};
    if (body.type === "select" || body.type === "multiselect") {
      const opts = body.options ?? [];
      config = {
        options: opts.map((o) => ({
          id: o.id && o.id.length > 0 ? o.id : randOptionId(),
          label: o.label,
          color: o.color ?? "slate",
        })),
      };
    } else if (body.type === "link") {
      if (!body.linkTargetTableSlug) {
        return res.status(400).json({
          error: "link fields require `linkTargetTableSlug` pointing at a table in the same base",
        });
      }
      const target = await AppDataSource.getRepository(BaseTable).findOneBy({
        baseId: b.id,
        slug: body.linkTargetTableSlug,
      });
      if (!target) {
        return res.status(400).json({
          error: `Link target table not found in base: ${body.linkTargetTableSlug}`,
        });
      }
      config = { targetTableId: target.id };
    }

    const fieldRepo = AppDataSource.getRepository(BaseField);
    const last = await fieldRepo.findOne({
      where: { tableId: t.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await fieldRepo.save(
      fieldRepo.create({
        tableId: t.id,
        name: body.name,
        type: body.type,
        configJson: JSON.stringify(config),
        isPrimary: !!body.isPrimary,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    if (body.isPrimary) {
      await fieldRepo
        .createQueryBuilder()
        .update()
        .set({ isPrimary: false })
        .where("tableId = :tid AND id != :sid", { tid: t.id, sid: saved.id })
        .execute();
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_field.create",
      targetType: "base_field",
      targetId: saved.id,
      targetLabel: `${b.name}/${t.name}.${saved.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id, type: saved.type },
    });
    res.json({ field: hydrateField(saved) });
  },
);

const updateBaseFieldSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    fieldId: z.string().uuid(),
    name: z.string().min(1).max(80).optional(),
    isPrimary: z.boolean().optional(),
    options: z.array(fieldOptionSchema).max(100).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_base_field",
  validateBody(updateBaseFieldSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateBaseFieldSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const fieldRepo = AppDataSource.getRepository(BaseField);
    const f = await fieldRepo.findOneBy({ id: body.fieldId, tableId: t.id });
    if (!f) return res.status(404).json({ error: "Field not found" });

    if (body.name !== undefined) f.name = body.name;

    if (body.options !== undefined) {
      if (f.type !== "select" && f.type !== "multiselect") {
        return res.status(400).json({
          error: `options can only be set on select or multiselect fields (this one is ${f.type})`,
        });
      }
      const config: Record<string, unknown> = (() => {
        try {
          return JSON.parse(f.configJson || "{}");
        } catch {
          return {};
        }
      })();
      config.options = body.options.map((o) => ({
        id: o.id && o.id.length > 0 ? o.id : randOptionId(),
        label: o.label,
        color: o.color ?? "slate",
      }));
      f.configJson = JSON.stringify(config);
    }

    if (body.isPrimary === true) {
      f.isPrimary = true;
    }

    await fieldRepo.save(f);
    if (body.isPrimary === true) {
      await fieldRepo
        .createQueryBuilder()
        .update()
        .set({ isPrimary: false })
        .where("tableId = :tid AND id != :fid", { tid: t.id, fid: f.id })
        .execute();
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_field.update",
      targetType: "base_field",
      targetId: f.id,
      targetLabel: `${b.name}/${t.name}.${f.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id, changes: body },
    });
    res.json({ field: hydrateField(f) });
  },
);

const deleteBaseFieldSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    fieldId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_base_field",
  validateBody(deleteBaseFieldSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteBaseFieldSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const fieldRepo = AppDataSource.getRepository(BaseField);
    const f = await fieldRepo.findOneBy({ id: body.fieldId, tableId: t.id });
    if (!f) return res.status(404).json({ error: "Field not found" });
    if (f.isPrimary) {
      return res.status(400).json({
        error: "Promote another field to primary via update_base_field before deleting this one",
      });
    }

    await fieldRepo.delete({ id: f.id });
    // Strip this field id from every row's dataJson so row payloads stay clean.
    const recordRepo = AppDataSource.getRepository(BaseRecord);
    const rows = await recordRepo.find({ where: { tableId: t.id } });
    for (const r of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(r.dataJson || "{}");
      } catch {
        continue;
      }
      if (f.id in data) {
        delete data[f.id];
        r.dataJson = JSON.stringify(data);
        await recordRepo.save(r);
      }
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_field.delete",
      targetType: "base_field",
      targetId: f.id,
      targetLabel: `${b.name}/${t.name}.${f.name}`,
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

// ─────────────────── Workspace channels (AI-admin) ──────────────────────

const listChannelsSchema = z.object({}).strict();
mcpInternalRouter.post(
  "/tools/list_workspace_channels",
  validateBody(listChannelsSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const channels = await listChannelsForEmployee(co.id, self.id);
    res.json({ channels });
  },
);

const createChannelMcpSchema = z
  .object({
    name: z.string().min(1).max(80),
    topic: z.string().max(280).optional(),
    kind: z.enum(["public", "private"]).optional(),
  })
  .strict();
mcpInternalRouter.post(
  "/tools/create_workspace_channel",
  validateBody(createChannelMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createChannelMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    try {
      const channel = await createChannel({
        companyId: co.id,
        name: body.name,
        topic: body.topic ?? "",
        kind: body.kind ?? "public",
        // Credit the creator as the company's owner rather than a fake
        // userId. Falls back to null if the company has no owner row.
        createdByUserId: await companyOwnerId(co.id),
        initialMemberUserIds: [],
        initialEmployeeIds: [self.id],
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "channel.create",
        targetType: "channel",
        targetId: channel.id,
        targetLabel: channel.name ?? channel.slug ?? "channel",
        metadata: { via: "mcp", kind: channel.kind },
      });
      await journal(
        self.id,
        `${self.name} created channel #${channel.slug}`,
        `Kind: ${channel.kind}. Topic: ${channel.topic || "(none)"}.`,
      );
      res.json({
        channel: {
          id: channel.id,
          name: channel.name,
          slug: channel.slug,
          kind: channel.kind,
          topic: channel.topic,
        },
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Create failed" });
    }
  },
);

const renameChannelMcpSchema = z
  .object({
    channel: z.string().min(1).max(120),
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(280).optional(),
  })
  .strict();
mcpInternalRouter.post(
  "/tools/rename_workspace_channel",
  validateBody(renameChannelMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof renameChannelMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const ch = await findChannelBySlugOrId(co.id, body.channel);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    if (body.name === undefined && body.topic === undefined) {
      return res
        .status(400)
        .json({ error: "Pass at least one of `name` or `topic`." });
    }
    try {
      const updated = await renameChannel({
        channelId: ch.id,
        name: body.name,
        topic: body.topic,
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "channel.rename",
        targetType: "channel",
        targetId: updated.id,
        targetLabel: updated.name ?? updated.slug ?? "channel",
        metadata: {
          via: "mcp",
          previousSlug: ch.slug,
          nextSlug: updated.slug,
        },
      });
      await journal(
        self.id,
        `${self.name} renamed channel #${ch.slug} → #${updated.slug}`,
        body.topic !== undefined ? `Topic: ${body.topic}` : "",
      );
      res.json({
        channel: {
          id: updated.id,
          name: updated.name,
          slug: updated.slug,
          kind: updated.kind,
          topic: updated.topic,
        },
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Rename failed" });
    }
  },
);

const archiveChannelMcpSchema = z
  .object({
    channel: z.string().min(1).max(120),
  })
  .strict();
mcpInternalRouter.post(
  "/tools/archive_workspace_channel",
  validateBody(archiveChannelMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof archiveChannelMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const ch = await findChannelBySlugOrId(co.id, body.channel);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    if (ch.kind === "dm") {
      return res.status(400).json({ error: "DMs cannot be archived via MCP." });
    }
    await archiveChannel(ch.id);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "channel.archive",
      targetType: "channel",
      targetId: ch.id,
      targetLabel: ch.name ?? ch.slug ?? "channel",
      metadata: { via: "mcp" },
    });
    await journal(
      self.id,
      `${self.name} archived channel #${ch.slug}`,
      "Via the built-in MCP tool.",
    );
    res.json({ ok: true });
  },
);

// ─────────────────── Workspace messages (AI ↔ AI / AI → human) ──────────

const sendWorkspaceMessageSchema = z
  .object({
    channel: z.string().min(1).max(120).optional(),
    dmEmployee: z.string().min(1).max(120).optional(),
    dmUser: z.string().uuid().optional(),
    content: z.string().min(1).max(16_000),
    parentMessageId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.channel, v.dmEmployee, v.dmUser].filter(
        (x) => typeof x === "string" && x.length > 0,
      ).length === 1,
    {
      message: "Specify exactly one of: channel, dmEmployee, dmUser.",
    },
  );

mcpInternalRouter.post(
  "/tools/send_workspace_message",
  validateBody(sendWorkspaceMessageSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof sendWorkspaceMessageSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    let channel: Channel;
    let auditTarget: { type: string; id: string; label: string };
    let journalTitle: string;

    if (body.channel) {
      const ch = await findChannelBySlugOrId(co.id, body.channel);
      if (!ch) return res.status(404).json({ error: "Channel not found" });
      if (ch.archivedAt) {
        return res.status(400).json({ error: "Channel is archived" });
      }
      if (ch.kind === "dm") {
        return res.status(400).json({
          error:
            "That is a DM channel; pass `dmEmployee` or `dmUser` instead of `channel`.",
        });
      }
      // Auto-join public channels (mirrors the @mention auto-join in chat).
      // Private channels require an explicit grant — refuse to broadcast
      // into a room the AI was never invited to.
      const memberRepo = AppDataSource.getRepository(ChannelMember);
      const existing = await memberRepo.findOneBy({
        channelId: ch.id,
        memberKind: "ai",
        employeeId: self.id,
      });
      if (!existing) {
        if (ch.kind === "private") {
          return res.status(403).json({
            error: "Not a member of this private channel.",
          });
        }
        await memberRepo.save(
          memberRepo.create({
            channelId: ch.id,
            memberKind: "ai",
            userId: null,
            employeeId: self.id,
            lastReadAt: null,
          }),
        );
      }
      channel = ch;
      auditTarget = {
        type: "channel",
        id: ch.id,
        label: ch.name ?? ch.slug ?? "channel",
      };
      journalTitle = `${self.name} posted in #${ch.slug ?? "channel"}`;
    } else if (body.dmEmployee) {
      const empRepo = AppDataSource.getRepository(AIEmployee);
      const target =
        (await empRepo.findOneBy({
          id: body.dmEmployee,
          companyId: co.id,
        })) ??
        (await empRepo.findOneBy({
          slug: body.dmEmployee.toLowerCase(),
          companyId: co.id,
        }));
      if (!target) {
        return res.status(404).json({ error: "Employee not found" });
      }
      if (target.id === self.id) {
        return res.status(400).json({ error: "Cannot DM yourself" });
      }
      channel = await findOrCreateDM({
        companyId: co.id,
        from: { kind: "ai", employeeId: self.id },
        target: { kind: "ai", employeeId: target.id },
      });
      auditTarget = {
        type: "channel",
        id: channel.id,
        label: `DM with ${target.name}`,
      };
      journalTitle = `${self.name} DM'd ${target.name}`;
    } else if (body.dmUser) {
      // Human Member of the same company. Cross-company DMs are refused.
      const member = await AppDataSource.getRepository(Membership).findOneBy({
        companyId: co.id,
        userId: body.dmUser,
      });
      if (!member) {
        return res.status(404).json({ error: "User not found" });
      }
      const user = await AppDataSource.getRepository(User).findOneBy({
        id: body.dmUser,
      });
      if (!user) return res.status(404).json({ error: "User not found" });
      channel = await findOrCreateDM({
        companyId: co.id,
        from: { kind: "ai", employeeId: self.id },
        target: { kind: "user", userId: user.id },
      });
      auditTarget = {
        type: "channel",
        id: channel.id,
        label: `DM with ${user.name || user.email}`,
      };
      journalTitle = `${self.name} DM'd ${user.name || user.email}`;
    } else {
      return res.status(400).json({ error: "No target specified" });
    }

    let summary;
    try {
      summary = await postMessage({
        channelId: channel.id,
        companyId: co.id,
        author: { kind: "ai", employeeId: self.id },
        content: body.content,
        parentMessageId: body.parentMessageId ?? null,
      });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : "Send failed",
      });
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "channel_message.create",
      targetType: auditTarget.type,
      targetId: auditTarget.id,
      targetLabel: auditTarget.label,
      metadata: {
        via: "mcp",
        messageId: summary.id,
        channelKind: channel.kind,
      },
    });
    await journal(
      self.id,
      journalTitle,
      body.content.length > 240
        ? `${body.content.slice(0, 240)}…`
        : body.content,
    );

    res.json({
      message: summary,
      channel: {
        id: channel.id,
        kind: channel.kind,
        slug: channel.slug,
        name: channel.name,
      },
    });
  },
);

// ─────────────────── Org chart (Teams + reporting line) ────────────────

const listTeamsSchema = z.object({}).strict();
mcpInternalRouter.post(
  "/tools/list_teams",
  validateBody(listTeamsSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const teams = await AppDataSource.getRepository(Team).find({
      where: { companyId: co.id },
      order: { name: "ASC" },
    });
    const empRepo = AppDataSource.getRepository(AIEmployee);
    const out = [];
    for (const t of teams) {
      if (t.archivedAt) continue;
      const members = await empRepo.find({
        where: { teamId: t.id, companyId: co.id },
        order: { name: "ASC" },
      });
      out.push({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        members: members.map((e) => ({
          id: e.id,
          slug: e.slug,
          name: e.name,
          role: e.role,
        })),
      });
    }
    res.json({ teams: out });
  },
);

// ─────────────────── Handoffs (AI → AI delegation) ──────────────────────

async function findEmployeeBySlugOrId(
  companyId: string,
  idOrSlug: string,
): Promise<AIEmployee | null> {
  const repo = AppDataSource.getRepository(AIEmployee);
  const byId = await repo.findOneBy({ id: idOrSlug, companyId });
  if (byId) return byId;
  return repo.findOneBy({ companyId, slug: idOrSlug.toLowerCase() });
}

function serializeHandoff(h: Handoff) {
  return {
    id: h.id,
    fromEmployeeId: h.fromEmployeeId,
    toEmployeeId: h.toEmployeeId,
    title: h.title,
    body: h.body,
    status: h.status,
    resolutionNote: h.resolutionNote,
    dueAt: h.dueAt?.toISOString() ?? null,
    completedAt: h.completedAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

const listHandoffsSchema = z
  .object({
    direction: z.enum(["incoming", "outgoing", "any"]).optional(),
    status: z.enum(["pending", "completed", "declined", "cancelled"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_handoffs",
  validateBody(listHandoffsSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listHandoffsSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const direction = body.direction ?? "incoming";
    const qb = AppDataSource.getRepository(Handoff)
      .createQueryBuilder("h")
      .where("h.companyId = :cid", { cid: co.id });
    if (direction === "incoming") {
      qb.andWhere("h.toEmployeeId = :eid", { eid: self.id });
    } else if (direction === "outgoing") {
      qb.andWhere("h.fromEmployeeId = :eid", { eid: self.id });
    } else {
      qb.andWhere(
        "(h.toEmployeeId = :eid OR h.fromEmployeeId = :eid)",
        { eid: self.id },
      );
    }
    if (body.status) qb.andWhere("h.status = :status", { status: body.status });
    qb.orderBy("h.createdAt", "DESC").take(body.limit ?? 50);
    const rows = await qb.getMany();
    res.json({ handoffs: rows.map(serializeHandoff) });
  },
);

const createHandoffSchema = z
  .object({
    toEmployee: z.string().min(1).max(120).optional(),
    toManager: z.boolean().optional(),
    title: z.string().min(1).max(160),
    body: z.string().max(20_000).optional(),
    dueAt: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.toEmployee) !== Boolean(v.toManager),
    {
      message: "Specify exactly one of `toEmployee` (slug/UUID) or `toManager: true`.",
    },
  );

mcpInternalRouter.post(
  "/tools/create_handoff",
  validateBody(createHandoffSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createHandoffSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    let target: AIEmployee | null = null;
    if (body.toManager) {
      if (!self.reportsToEmployeeId) {
        return res.status(400).json({
          error: "You don't have a manager set. Ask a human to wire up your reporting line, or pass `toEmployee` instead.",
        });
      }
      target = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: self.reportsToEmployeeId,
        companyId: co.id,
      });
      if (!target) {
        return res
          .status(400)
          .json({ error: "Manager record is stale; ask a human to fix it." });
      }
    } else if (body.toEmployee) {
      target = await findEmployeeBySlugOrId(co.id, body.toEmployee);
      if (!target) {
        return res.status(404).json({ error: "Employee not found" });
      }
    }
    if (!target) {
      return res.status(400).json({ error: "No target resolved" });
    }
    if (target.id === self.id) {
      return res.status(400).json({ error: "Cannot hand off to yourself" });
    }
    const repo = AppDataSource.getRepository(Handoff);
    const h = repo.create({
      companyId: co.id,
      fromEmployeeId: self.id,
      toEmployeeId: target.id,
      title: body.title.trim(),
      body: body.body ?? "",
      status: "pending",
      resolutionNote: null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      completedAt: null,
    });
    await repo.save(h);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "handoff.create",
      targetType: "handoff",
      targetId: h.id,
      targetLabel: h.title,
      metadata: {
        via: "mcp",
        fromEmployeeId: self.id,
        toEmployeeId: target.id,
      },
    });
    await journal(
      self.id,
      `Handed off "${h.title}" to ${target.name}`,
      h.body.length > 240 ? `${h.body.slice(0, 240)}…` : h.body,
    );
    await journal(
      target.id,
      `Received handoff "${h.title}" from ${self.name}`,
      h.body.length > 240 ? `${h.body.slice(0, 240)}…` : h.body,
    );
    res.json({ handoff: serializeHandoff(h) });
  },
);

const transitionHandoffSchema = z
  .object({
    handoffId: z.string().uuid(),
    resolutionNote: z.string().max(20_000).optional(),
  })
  .strict();

async function applyMcpTransition(
  req: McpRequest,
  res: import("express").Response,
  next: HandoffStatus,
  expectedActor: "from" | "to",
): Promise<void> {
  const body = req.body as z.infer<typeof transitionHandoffSchema>;
  const co = req.mcpCompany!;
  const self = req.mcpEmployee!;
  const repo = AppDataSource.getRepository(Handoff);
  const h = await repo.findOneBy({ id: body.handoffId, companyId: co.id });
  if (!h) {
    res.status(404).json({ error: "Handoff not found" });
    return;
  }
  if (h.status !== "pending") {
    res.status(400).json({
      error: `Handoff is already ${h.status}; only pending handoffs can transition.`,
    });
    return;
  }
  const allowedActorId =
    expectedActor === "to" ? h.toEmployeeId : h.fromEmployeeId;
  if (allowedActorId !== self.id) {
    res.status(403).json({
      error:
        expectedActor === "to"
          ? "Only the receiver can complete or decline a handoff."
          : "Only the sender can cancel a handoff.",
    });
    return;
  }
  h.status = next;
  h.resolutionNote = body.resolutionNote ?? null;
  h.completedAt = next === "completed" ? new Date() : null;
  await repo.save(h);
  await recordAudit({
    companyId: co.id,
    actorEmployeeId: self.id,
    action: `handoff.${next}`,
    targetType: "handoff",
    targetId: h.id,
    targetLabel: h.title,
    metadata: { via: "mcp" },
  });
  const verb =
    next === "completed"
      ? "completed"
      : next === "declined"
        ? "declined"
        : "cancelled";
  await journal(
    h.fromEmployeeId,
    `Handoff "${h.title}" ${verb}`,
    body.resolutionNote ?? "",
  );
  await journal(
    h.toEmployeeId,
    `Handoff "${h.title}" ${verb}`,
    body.resolutionNote ?? "",
  );
  res.json({ handoff: serializeHandoff(h) });
}

mcpInternalRouter.post(
  "/tools/complete_handoff",
  validateBody(transitionHandoffSchema),
  async (req: McpRequest, res) => {
    await applyMcpTransition(req, res, "completed", "to");
  },
);

mcpInternalRouter.post(
  "/tools/decline_handoff",
  validateBody(transitionHandoffSchema),
  async (req: McpRequest, res) => {
    await applyMcpTransition(req, res, "declined", "to");
  },
);

mcpInternalRouter.post(
  "/tools/cancel_handoff",
  validateBody(transitionHandoffSchema),
  async (req: McpRequest, res) => {
    await applyMcpTransition(req, res, "cancelled", "from");
  },
);

// ----- Notes (Notion-style company-wide knowledge base) -----

function serializeNote(n: Note) {
  return {
    id: n.id,
    slug: n.slug,
    title: n.title,
    body: n.body,
    icon: n.icon,
    notebookId: n.notebookId,
    parentId: n.parentId,
    archived: n.archivedAt !== null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

function serializeNotebook(nb: Notebook) {
  return {
    id: nb.id,
    slug: nb.slug,
    title: nb.title,
    icon: nb.icon,
    sortOrder: nb.sortOrder,
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
  };
}

async function uniqueNoteSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Note);
  let slug = base || "note";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

const listNotesSchema = z
  .object({
    notebookSlug: z.string().min(1).max(80).optional(),
    parentSlug: z.string().min(1).max(160).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_notes",
  validateBody(listNotesSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listNotesSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    let notebookId: string | undefined;
    if (body.notebookSlug) {
      const nb = await AppDataSource.getRepository(Notebook).findOneBy({
        companyId: co.id,
        slug: body.notebookSlug,
      });
      if (!nb) return res.status(404).json({ error: "Notebook not found" });
      notebookId = nb.id;
    }

    let parentId: string | null | undefined = undefined;
    if (body.parentSlug) {
      const parent = await repo.findOneBy({ companyId: co.id, slug: body.parentSlug });
      if (!parent) return res.status(404).json({ error: "Parent note not found" });
      // The employee can only inspect children of a parent they can see.
      if (!(await hasNoteAccess(self.id, parent.id, "read"))) {
        return res.status(403).json({ error: "No access to that note" });
      }
      parentId = parent.id;
    }

    const accessible = await listAccessibleNoteIds(co.id, self.id);
    if (accessible.size === 0) return res.json({ notes: [] });

    const where: Record<string, unknown> = {
      companyId: co.id,
      id: In([...accessible]),
    };
    if (notebookId !== undefined) where.notebookId = notebookId;
    if (parentId !== undefined) where.parentId = parentId;
    if (!body.includeArchived) where.archivedAt = IsNull();
    const notes = await repo.find({
      where,
      order: { sortOrder: "ASC", updatedAt: "DESC" },
    });
    res.json({ notes: notes.map(serializeNote) });
  },
);

const listNotebooksSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_notebooks",
  validateBody(listNotebooksSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    // Filter to notebooks the employee has any access to: either a direct
    // notebook grant, or a note grant somewhere inside the notebook.
    const accessible = await listAccessibleNoteIds(co.id, self.id);
    const rows = await AppDataSource.getRepository(Notebook).find({
      where: { companyId: co.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    if (accessible.size === 0) return res.json({ notebooks: [] });
    const accessibleNotebookIds = new Set<string>();
    if (accessible.size > 0) {
      const allNotes = await AppDataSource.getRepository(Note).find({
        where: { companyId: co.id, id: In([...accessible]) },
        select: ["notebookId"],
      });
      for (const n of allNotes) accessibleNotebookIds.add(n.notebookId);
    }
    res.json({
      notebooks: rows
        .filter((nb) => accessibleNotebookIds.has(nb.id))
        .map(serializeNotebook),
    });
  },
);

const searchNotesSchema = z
  .object({
    query: z.string().min(1).max(200),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/search_notes",
  validateBody(searchNotesSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof searchNotesSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleNoteIds(co.id, self.id);
    if (accessible.size === 0) return res.json({ notes: [] });

    const term = `%${body.query.replace(/[%_]/g, (c) => "\\" + c)}%`;
    const rows = await AppDataSource.getRepository(Note)
      .createQueryBuilder("n")
      .where("n.companyId = :cid", { cid: co.id })
      .andWhere("n.archivedAt IS NULL")
      .andWhere("n.id IN (:...ids)", { ids: [...accessible] })
      .andWhere(
        "(n.title LIKE :term ESCAPE '\\' OR n.body LIKE :term ESCAPE '\\')",
        { term },
      )
      .orderBy("n.updatedAt", "DESC")
      .limit(50)
      .getMany();
    res.json({ notes: rows.map(serializeNote) });
  },
);

const getNoteSchema = z
  .object({
    noteSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_note",
  validateBody(getNoteSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof getNoteSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const note = await AppDataSource.getRepository(Note).findOneBy({
      companyId: co.id,
      slug: body.noteSlug,
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!(await hasNoteAccess(self.id, note.id, "read"))) {
      return res.status(403).json({ error: "No access to that note" });
    }
    res.json({ note: serializeNote(note) });
  },
);

const createNoteMcpSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(200_000).optional(),
    icon: z.string().max(40).optional(),
    notebookSlug: z.string().min(1).max(80).optional(),
    parentSlug: z.string().min(1).max(160).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_note",
  validateBody(createNoteMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createNoteMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    let parentId: string | null = null;
    let parentNotebookId: string | null = null;
    if (body.parentSlug) {
      const parent = await repo.findOneBy({
        companyId: co.id,
        slug: body.parentSlug,
      });
      if (!parent) return res.status(400).json({ error: "Unknown parent note" });
      // Creating a child requires write on the parent — the new note will
      // inherit that access via the cascade so we don't add a fresh grant.
      if (!(await hasNoteAccess(self.id, parent.id, "write"))) {
        return res.status(403).json({ error: "Need write access on the parent note" });
      }
      parentId = parent.id;
      parentNotebookId = parent.notebookId;
    }

    let notebookId: string;
    if (body.notebookSlug) {
      const nb = await AppDataSource.getRepository(Notebook).findOneBy({
        companyId: co.id,
        slug: body.notebookSlug,
      });
      if (!nb) return res.status(400).json({ error: "Unknown notebook" });
      if (parentNotebookId && nb.id !== parentNotebookId) {
        return res.status(400).json({
          error: "Sub-pages must live in the same notebook as their parent",
        });
      }
      notebookId = nb.id;
    } else if (parentNotebookId) {
      notebookId = parentNotebookId;
    } else {
      const nb = await ensureDefaultNotebook(co.id, null);
      notebookId = nb.id;
    }

    const slug = await uniqueNoteSlug(co.id, toSlug(body.title));
    const siblings = await repo.find({
      where: {
        companyId: co.id,
        notebookId,
        parentId: parentId ?? IsNull(),
      },
      order: { sortOrder: "DESC" },
      take: 1,
    });
    const sortOrder = (siblings[0]?.sortOrder ?? 0) + 1000;

    const note = repo.create({
      companyId: co.id,
      notebookId,
      title: body.title,
      slug,
      body: body.body ?? "",
      icon: body.icon ?? "",
      parentId,
      sortOrder,
      createdById: null,
      createdByEmployeeId: self.id,
      lastEditedById: null,
      lastEditedByEmployeeId: self.id,
      archivedAt: null,
    });
    await repo.save(note);

    // Top-level notes have no ancestor chain to inherit access from, so the
    // creating AI gets an explicit write grant on its own page. Without
    // this it would lose visibility on the page it just authored.
    if (!parentId) {
      await upsertNoteGrant(self.id, note.id, "write");
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "note.create",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: { via: "mcp", parentId },
    });
    await journal(
      self.id,
      `${self.name} created note "${note.title}"`,
      `Slug: \`${note.slug}\`. Created via the built-in MCP tool.`,
    );

    res.json({ note: serializeNote(note) });
  },
);

const updateNoteMcpSchema = z
  .object({
    noteSlug: z.string().min(1).max(160),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(200_000).optional(),
    icon: z.string().max(40).optional(),
    parentSlug: z.string().min(1).max(160).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_note",
  validateBody(updateNoteMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateNoteMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    const note = await repo.findOneBy({ companyId: co.id, slug: body.noteSlug });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!(await hasNoteAccess(self.id, note.id, "write"))) {
      return res.status(403).json({ error: "No write access on that note" });
    }

    if (body.parentSlug !== undefined) {
      if (body.parentSlug === null) {
        note.parentId = null;
      } else {
        const parent = await repo.findOneBy({
          companyId: co.id,
          slug: body.parentSlug,
        });
        if (!parent) return res.status(400).json({ error: "Unknown parent note" });
        if (parent.id === note.id) {
          return res
            .status(400)
            .json({ error: "A note cannot be its own parent" });
        }
        if (await isNoteDescendant(co.id, parent.id, note.id)) {
          return res
            .status(400)
            .json({ error: "Cannot move a note under one of its own descendants" });
        }
        note.parentId = parent.id;
      }
    }

    if (body.title !== undefined) note.title = body.title;
    if (body.body !== undefined) note.body = body.body;
    if (body.icon !== undefined) note.icon = body.icon;
    if (body.archived !== undefined) {
      note.archivedAt = body.archived ? new Date() : null;
    }
    note.lastEditedById = null;
    note.lastEditedByEmployeeId = self.id;
    await repo.save(note);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "note.update",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: {
        via: "mcp",
        archived: note.archivedAt !== null,
      },
    });
    await journal(
      self.id,
      `${self.name} updated note "${note.title}"`,
      "Via the built-in MCP tool.",
    );

    res.json({ note: serializeNote(note) });
  },
);

const deleteNoteSchema = z
  .object({
    noteSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_note",
  validateBody(deleteNoteSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteNoteSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    const note = await repo.findOneBy({ companyId: co.id, slug: body.noteSlug });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!(await hasNoteAccess(self.id, note.id, "write"))) {
      return res.status(403).json({ error: "No write access on that note" });
    }

    await repo.update({ companyId: co.id, parentId: note.id }, { parentId: note.parentId });
    await AppDataSource.getRepository(EmployeeNoteGrant).delete({ noteId: note.id });
    await repo.delete({ id: note.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "note.delete",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: { via: "mcp" },
    });
    await journal(
      self.id,
      `${self.name} deleted note "${note.title}"`,
      "Permanent delete via the built-in MCP tool.",
    );

    res.json({ ok: true });
  },
);

/**
 * Walk children breadth-first to detect parent-cycles before re-parenting.
 */
async function isNoteDescendant(
  companyId: string,
  rootId: string,
  descendantId: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(Note);
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === descendantId) return true;
    const children = await repo.find({
      where: { companyId, parentId: id },
      select: ["id"],
    });
    for (const c of children) queue.push(c.id);
  }
  return false;
}

function serializeResource(r: Resource, opts: { includeBody?: boolean } = {}) {
  const tagList = r.tags
    ? r.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
    : [];
  const out: Record<string, unknown> = {
    id: r.id,
    title: r.title,
    slug: r.slug,
    sourceKind: r.sourceKind,
    sourceUrl: r.sourceUrl,
    sourceFilename: r.sourceFilename,
    summary: r.summary,
    tags: tagList,
    bodyLength: r.bodyText?.length ?? 0,
    bytes: Number(r.bytes),
    status: r.status,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (opts.includeBody) out.bodyText = r.bodyText;
  return out;
}

const listResourcesSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_resources",
  validateBody(listResourcesSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleResourceIds(self.id);
    if (accessible.size === 0) return res.json({ resources: [] });
    const rows = await AppDataSource.getRepository(Resource).find({
      where: { companyId: co.id, id: In([...accessible]) },
      order: { updatedAt: "DESC" },
    });
    res.json({ resources: rows.map((r) => serializeResource(r)) });
  },
);

const searchResourcesSchema = z
  .object({
    query: z.string().min(1).max(200),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/search_resources",
  validateBody(searchResourcesSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof searchResourcesSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleResourceIds(self.id);
    if (accessible.size === 0) return res.json({ resources: [] });

    const term = `%${body.query.replace(/[%_]/g, (c) => "\\" + c)}%`;
    const rows = await AppDataSource.getRepository(Resource)
      .createQueryBuilder("r")
      .where("r.companyId = :cid", { cid: co.id })
      .andWhere("r.id IN (:...ids)", { ids: [...accessible] })
      .andWhere(
        "(r.title LIKE :term ESCAPE '\\' OR r.summary LIKE :term ESCAPE '\\' OR r.tags LIKE :term ESCAPE '\\' OR r.bodyText LIKE :term ESCAPE '\\')",
        { term },
      )
      .orderBy("r.updatedAt", "DESC")
      .limit(50)
      .getMany();
    res.json({ resources: rows.map((r) => serializeResource(r)) });
  },
);

const getResourceSchema = z
  .object({
    resourceSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_resource",
  validateBody(getResourceSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof getResourceSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Resource).findOneBy({
      companyId: co.id,
      slug: body.resourceSlug,
    });
    if (!row) return res.status(404).json({ error: "Resource not found" });
    if (!(await hasResourceAccess(self.id, row.id, "read"))) {
      return res.status(403).json({ error: "No access to that resource" });
    }
    res.json({ resource: serializeResource(row, { includeBody: true }) });
  },
);

async function companyOwnerId(companyId: string): Promise<string | null> {
  const co = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  return co?.ownerId ?? null;
}

async function notifyTodoReviewByEmployee(args: {
  companyId: string;
  todo: Todo;
  project: Project;
  actorEmployeeId: string;
  actorEmployeeName: string;
}): Promise<void> {
  const { companyId, todo, project, actorEmployeeId, actorEmployeeName } = args;
  if (!todo.reviewerUserId) return;
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return;
  const ref = `${project.key}-${todo.number}`;
  await createNotification({
    companyId,
    userId: todo.reviewerUserId,
    kind: "todo_review_requested",
    title: `${actorEmployeeName} requested your review on ${ref}`,
    body: todo.title,
    link: `/c/${company.slug}/tasks/p/${project.slug}`,
    actorKind: "ai",
    actorId: actorEmployeeId,
    entityKind: "todo",
    entityId: todo.id,
  });
}

// --------------------------------------------------------------------------
// Browser-action approvals
// --------------------------------------------------------------------------
//
// Called by the built-in `browser` MCP child (`server/mcp-browser/`) when
// `AIEmployee.browserApprovalRequired` is on and the model invokes
// `browser_submit`. The MCP captures the live page URL + selector + key,
// queues an Approval row here, and returns `pending_approval` to the
// model. Once a human approves it from the UI, the model calls
// `browser_resume(approvalId)` and the MCP re-fires the held action; the
// server side never drives the browser itself.

const queueBrowserApprovalSchema = z.object({
  /** Free-text reason / target action shown to the approver. */
  summary: z.string().trim().min(1).max(1000),
  /** Page URL captured at queue time (best-effort; may be empty). */
  pageUrl: z.string().max(2048).optional(),
  /** Selector the MCP intends to act on. */
  selector: z.string().min(1).max(1000),
  /** Optional key press (e.g. `Enter`) — null/undefined for a click. */
  key: z.string().max(60).nullish(),
});

mcpInternalRouter.post(
  "/tools/queue_browser_approval",
  validateBody(queueBrowserApprovalSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof queueBrowserApprovalSchema>;
    const emp = req.mcpEmployee!;
    const co = req.mcpCompany!;
    if (!emp.browserApprovalRequired) {
      return res.status(400).json({
        error:
          "browserApprovalRequired is off for this employee — queue rejected to avoid stranding the action",
      });
    }
    const approval = await createBrowserActionApproval({
      companyId: co.id,
      employeeId: emp.id,
      selector: body.selector,
      key: body.key ?? null,
      pageUrl: body.pageUrl ?? "",
      summary: body.summary,
    });
    res.json({ approvalId: approval.id, status: approval.status });
  },
);

mcpInternalRouter.get(
  "/tools/check_browser_approval/:id",
  async (req: McpRequest, res) => {
    const id = req.params.id;
    const emp = req.mcpEmployee!;
    const approval = await AppDataSource.getRepository(Approval).findOneBy({ id });
    if (!approval || approval.kind !== "browser_action") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (approval.employeeId !== emp.id) {
      // The MCP token resolves to one employee; refuse to leak status of
      // a different employee's pending approvals.
      return res.status(403).json({ error: "Approval belongs to another employee" });
    }
    res.json({ status: approval.status });
  },
);
