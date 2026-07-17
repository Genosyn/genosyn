import { Request, Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import {
  PROJECT_ACCESS_LEVELS,
  ProjectAccessLevel,
  ProjectMember,
} from "../db/entities/ProjectMember.js";
import { Todo, TodoPriority, TodoRecurrence, TodoStatus } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { User } from "../db/entities/User.js";
import { Role } from "../db/entities/Membership.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { ChatTurn, chatWithEmployee } from "../services/chat.js";
import { createNotification } from "../services/notifications.js";
import { dispatchTodoCreated } from "../services/pipelines/events.js";
import { kickoffAssignedTodo } from "../services/todoKickoff.js";
import {
  ProjectActor,
  countWriteHumans,
  deleteMembersForProject,
  findProjectAccess,
  hasProjectAccess,
  listAccessibleProjectIds,
  listProjectMembers,
  restrictProject,
  upsertProjectMember,
} from "../services/projects.js";
import { deleteTagAssignments } from "../services/tags.js";

export const projectsRouter = Router({ mergeParams: true });
projectsRouter.use(requireAuth);
projectsRouter.use(requireCompanyMember);

const STATUSES: TodoStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];
const PRIORITIES: TodoPriority[] = ["none", "low", "medium", "high", "urgent"];
const RECURRENCES: TodoRecurrence[] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

/**
 * Advance a date by one recurrence period. `weekdays` skips ahead to the
 * next Monday–Friday slot; the others use straight calendar math via
 * `setDate`/`setMonth`/`setFullYear` so DST / month-length fall out for free.
 */
function nextOccurrence(from: Date, recurrence: TodoRecurrence): Date | null {
  if (recurrence === "none") return null;
  const d = new Date(from.getTime());
  switch (recurrence) {
    case "daily":
      d.setDate(d.getDate() + 1);
      return d;
    case "weekdays": {
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6);
      return d;
    }
    case "weekly":
      d.setDate(d.getDate() + 7);
      return d;
    case "biweekly":
      d.setDate(d.getDate() + 14);
      return d;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      return d;
    case "yearly":
      d.setFullYear(d.getFullYear() + 1);
      return d;
    default:
      return null;
  }
}

async function uniqueProjectSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Project);
  let slug = base || "project";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function findProjectByName(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<Project | null> {
  const qb = AppDataSource.getRepository(Project)
    .createQueryBuilder("p")
    .where("p.companyId = :companyId", { companyId })
    .andWhere("LOWER(p.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("p.id != :excludeId", { excludeId });
  return qb.getOne();
}

function deriveKey(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .trim();
  if (!cleaned) return "PRJ";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0] + (parts[2]?.[0] ?? "")).slice(0, 4);
  }
  return parts[0].slice(0, 4);
}

// ----- Review queue -----

/**
 * Cross-project inbox of everything currently `in_review`. Returns each todo
 * hydrated with assignee + reviewer (see hydrateTodos) plus a `project` stub
 * (id, key, name, slug) so the UI can render "{key}-{number}" + a jump link
 * without a second fetch.
 *
 * Intended consumer: the human reviewer queue page. Sorted by oldest first,
 * so work that's been sitting longest rises to the top.
 */
projectsRouter.get("/reviews", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const accessible = await listAccessibleProjectIds(cid, actorOf(req));
  if (accessible.size === 0) return res.json({ todos: [] });
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId: cid, id: In([...accessible]) },
    select: ["id", "key", "name", "slug"],
  });
  if (projects.length === 0) return res.json({ todos: [] });
  const todos = await AppDataSource.getRepository(Todo).find({
    where: { projectId: In(projects.map((p) => p.id)), status: "in_review" },
    order: { updatedAt: "ASC" },
  });
  const hydrated = await hydrateTodos(cid, todos);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  res.json({
    todos: hydrated.map((t) => ({
      ...t,
      project: projectById.get(t.projectId) ?? null,
    })),
  });
});

// ----- Projects -----

projectsRouter.get("/projects", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const accessible = await listAccessibleProjectIds(cid, actorOf(req));
  if (accessible.size === 0) return res.json([]);
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId: cid, id: In([...accessible]) },
    order: { createdAt: "ASC" },
  });
  // Attach todo counts so the sidebar can render lightweight badges without a
  // second round-trip. One GROUP BY is cheap even with thousands of todos.
  const todos = projects.length
    ? await AppDataSource.getRepository(Todo).find({
        select: ["projectId", "status"],
        where: { projectId: In(projects.map((p) => p.id)) },
      })
    : [];
  const counts = new Map<string, { total: number; open: number; review: number }>();
  for (const t of todos) {
    const c = counts.get(t.projectId) ?? { total: 0, open: 0, review: 0 };
    c.total += 1;
    if (t.status !== "done" && t.status !== "cancelled") c.open += 1;
    if (t.status === "in_review") c.review += 1;
    counts.set(t.projectId, c);
  }
  res.json(
    projects.map((p) => ({
      ...p,
      totalTodos: counts.get(p.id)?.total ?? 0,
      openTodos: counts.get(p.id)?.open ?? 0,
      reviewTodos: counts.get(p.id)?.review ?? 0,
    })),
  );
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  key: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Za-z0-9]+$/)
    .optional(),
});

projectsRouter.post("/projects", validateBody(createProjectSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof createProjectSchema>;
  if (await findProjectByName(cid, body.name)) {
    return res.status(409).json({ error: "A project with that name already exists" });
  }
  const repo = AppDataSource.getRepository(Project);
  const slug = await uniqueProjectSlug(cid, toSlug(body.name));
  const key = (body.key ?? deriveKey(body.name)).toUpperCase();
  const p = repo.create({
    companyId: cid,
    name: body.name,
    slug,
    description: body.description ?? "",
    key,
    createdById: req.userId ?? null,
    todoCounter: 0,
  });
  await repo.save(p);
  res.json(p);
});

async function loadProjectBySlug(cid: string, pSlug: string) {
  return AppDataSource.getRepository(Project).findOneBy({
    companyId: cid,
    slug: pSlug,
  });
}

/**
 * The human behind this request, as a principal `services/projects.ts` can
 * check. `requireCompanyMember` has already stamped `role` and proved the
 * membership, so this is a pure re-shaping — no DB hit.
 */
function actorOf(req: Request): ProjectActor {
  return {
    kind: "user",
    id: req.userId!,
    role: (req as Request & { role: Role }).role,
  };
}

projectsRouter.get("/projects/:pSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const level = await findProjectAccess(p, actorOf(req));
  if (!level) return res.status(403).json({ error: "No access to that project" });
  // The client hides edit affordances on a read-only project, so it needs to
  // know the level it was served with.
  res.json({ ...p, myAccessLevel: level });
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  key: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Za-z0-9]+$/)
    .optional(),
  accessMode: z.enum(["open", "restricted"]).optional(),
});

projectsRouter.patch(
  "/projects/:pSlug",
  validateBody(patchProjectSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (!(await hasProjectAccess(p, actorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }
    const body = req.body as z.infer<typeof patchProjectSchema>;
    // Validate everything before writing anything: a request carrying both a
    // duplicate name and an accessMode flip must not restrict the project on
    // its way to a 409.
    if (body.name !== undefined && (await findProjectByName(cid, body.name, p.id))) {
      return res
        .status(409)
        .json({ error: "A project with that name already exists" });
    }
    if (body.name !== undefined) p.name = body.name;
    if (body.description !== undefined) p.description = body.description;
    if (body.key !== undefined) p.key = body.key.toUpperCase();
    await AppDataSource.getRepository(Project).save(p);
    // Restricting goes through the service so the actor is seeded with `write`
    // in the same transaction — otherwise the flip locks everyone out,
    // including whoever just clicked the button. It saves the project itself,
    // so it runs after the plain-field save rather than before.
    if (body.accessMode !== undefined && body.accessMode !== p.accessMode) {
      if (body.accessMode === "restricted") {
        await restrictProject(p, actorOf(req));
      } else {
        p.accessMode = "open";
        await AppDataSource.getRepository(Project).save(p);
      }
    }
    res.json(p);
  },
);

projectsRouter.delete("/projects/:pSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!(await hasProjectAccess(p, actorOf(req), "write"))) {
    return res.status(403).json({ error: "No access to that project" });
  }
  await deleteMembersForProject(p.id);
  await AppDataSource.getRepository(Todo).delete({ projectId: p.id });
  await deleteTagAssignments("project", p.id);
  await AppDataSource.getRepository(Project).delete({ id: p.id });
  res.json({ ok: true });
});

// ----- Access -----

/**
 * Resolve `ProjectMember` rows into something renderable — names and avatars
 * for both principal kinds. Batched: two queries regardless of row count.
 */
async function hydrateProjectMembers(cid: string, rows: ProjectMember[]) {
  const userIds = rows.flatMap((r) => (r.userId ? [r.userId] : []));
  const empIds = rows.flatMap((r) => (r.employeeId ? [r.employeeId] : []));
  const users = userIds.length
    ? await AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
    : [];
  const emps = empIds.length
    ? await AppDataSource.getRepository(AIEmployee).find({
        where: { id: In(empIds), companyId: cid },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const empById = new Map(emps.map((e) => [e.id, e]));
  return rows.map((r) => {
    const u = r.userId ? userById.get(r.userId) : null;
    const e = r.employeeId ? empById.get(r.employeeId) : null;
    return {
      id: r.id,
      memberKind: r.memberKind,
      accessLevel: r.accessLevel,
      userId: r.userId,
      employeeId: r.employeeId,
      name: u?.name ?? e?.name ?? "Unknown",
      email: u?.email ?? null,
      slug: e?.slug ?? null,
    };
  });
}

projectsRouter.get("/projects/:pSlug/access", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const level = await findProjectAccess(p, actorOf(req));
  if (!level) return res.status(403).json({ error: "No access to that project" });
  const rows = await listProjectMembers(p.id);
  res.json({
    accessMode: p.accessMode,
    myAccessLevel: level,
    members: await hydrateProjectMembers(cid, rows),
  });
});

const addAccessSchema = z.object({
  memberKind: z.enum(["user", "ai"]),
  memberId: z.string().uuid(),
  accessLevel: z.enum(PROJECT_ACCESS_LEVELS as [ProjectAccessLevel, ...ProjectAccessLevel[]]).optional(),
});

projectsRouter.post(
  "/projects/:pSlug/access",
  validateBody(addAccessSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (!(await hasProjectAccess(p, actorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }
    const body = req.body as z.infer<typeof addAccessSchema>;
    // The id must name someone in *this* company, or a caller could hand out
    // access to a stranger by pasting a uuid.
    if (body.memberKind === "user") {
      const m = await AppDataSource.getRepository(Membership).findOneBy({
        companyId: cid,
        userId: body.memberId,
      });
      if (!m) return res.status(400).json({ error: "Unknown member" });
    } else {
      const e = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: body.memberId,
        companyId: cid,
      });
      if (!e) return res.status(400).json({ error: "Unknown member" });
    }
    const row = await upsertProjectMember(
      p.id,
      { kind: body.memberKind, id: body.memberId },
      body.accessLevel ?? "read",
    );
    const [hydrated] = await hydrateProjectMembers(cid, [row]);
    res.json(hydrated);
  },
);

const patchAccessSchema = z.object({
  accessLevel: z.enum(PROJECT_ACCESS_LEVELS as [ProjectAccessLevel, ...ProjectAccessLevel[]]),
});

/**
 * A restricted project must keep at least one human who can edit it, or it
 * becomes unadministrable from the UI — AI employees can't open the Access
 * tab. Owners/admins can still recover it, but that shouldn't be routine.
 */
async function wouldStrandProject(
  p: Project,
  row: ProjectMember,
  nextLevel: ProjectAccessLevel | null,
): Promise<boolean> {
  if (p.accessMode !== "restricted") return false;
  if (row.memberKind !== "user" || row.accessLevel !== "write") return false;
  if (nextLevel === "write") return false;
  return (await countWriteHumans(p.id)) <= 1;
}

projectsRouter.patch(
  "/projects/:pSlug/access/:memberRowId",
  validateBody(patchAccessSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (!(await hasProjectAccess(p, actorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }
    const repo = AppDataSource.getRepository(ProjectMember);
    const row = await repo.findOneBy({ id: req.params.memberRowId, projectId: p.id });
    if (!row) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof patchAccessSchema>;
    if (await wouldStrandProject(p, row, body.accessLevel)) {
      return res
        .status(400)
        .json({ error: "A project needs at least one person who can edit it" });
    }
    row.accessLevel = body.accessLevel;
    await repo.save(row);
    const [hydrated] = await hydrateProjectMembers(cid, [row]);
    res.json(hydrated);
  },
);

projectsRouter.delete("/projects/:pSlug/access/:memberRowId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!(await hasProjectAccess(p, actorOf(req), "write"))) {
    return res.status(403).json({ error: "No access to that project" });
  }
  const repo = AppDataSource.getRepository(ProjectMember);
  const row = await repo.findOneBy({ id: req.params.memberRowId, projectId: p.id });
  if (!row) return res.status(404).json({ error: "Not found" });
  if (await wouldStrandProject(p, row, null)) {
    return res
      .status(400)
      .json({ error: "A project needs at least one person who can edit it" });
  }
  await repo.delete({ id: row.id });
  res.json({ ok: true });
});

// ----- Todos -----

type PersonRef =
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | { kind: "human"; id: string; name: string; email: string | null };

/**
 * Shape returned to the client. Includes the assignee + reviewer display info
 * so the board view can render avatars without a second fetch. An assignee
 * or reviewer may be an AI employee OR a human member — the `kind` discriminates.
 */
async function hydrateTodos(cid: string, todos: Todo[]) {
  const empIds = [
    ...new Set(
      todos
        .flatMap((t) => [t.assigneeEmployeeId, t.reviewerEmployeeId])
        .filter((x): x is string => !!x),
    ),
  ];
  const userIds = [
    ...new Set(
      todos
        .flatMap((t) => [t.assigneeUserId, t.reviewerUserId])
        .filter((x): x is string => !!x),
    ),
  ];
  const [emps, users] = await Promise.all([
    empIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds), companyId: cid },
        })
      : Promise.resolve([]),
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
  ]);
  const empById = new Map(emps.map((e) => [e.id, e]));
  const userById = new Map(users.map((u) => [u.id, u]));

  function refFor(
    employeeId: string | null,
    userId: string | null,
  ): PersonRef | null {
    if (employeeId) {
      const e = empById.get(employeeId);
      if (e) return { kind: "ai", id: e.id, name: e.name, slug: e.slug, role: e.role };
    } else if (userId) {
      const u = userById.get(userId);
      if (u) return { kind: "human", id: u.id, name: u.name, email: u.email };
    }
    return null;
  }

  return todos.map((t) => ({
    ...t,
    assignee: refFor(t.assigneeEmployeeId, t.assigneeUserId),
    reviewer: refFor(t.reviewerEmployeeId, t.reviewerUserId),
  }));
}

async function validatePersonPair(
  cid: string,
  employeeId: string | null | undefined,
  userId: string | null | undefined,
  label: string,
  project: Project,
): Promise<string | null> {
  if (employeeId && userId) {
    return `Cannot set both an AI employee and a human as ${label} at the same time`;
  }
  let actor: ProjectActor | null = null;
  if (employeeId) {
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: employeeId,
      companyId: cid,
    });
    if (!emp) return `Invalid ${label}`;
    actor = { kind: "ai", id: employeeId };
  }
  if (userId) {
    const mem = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: cid,
      userId,
    });
    if (!mem) return `Invalid ${label}`;
    // Their real role, not an assumed one — an owner reaches every project in
    // their company, so assuming "member" here would reject assigning to them.
    actor = { kind: "user", id: userId, role: mem.role };
  }
  // On a restricted project, handing work to someone who can't open it would
  // leave them an invisible todo and a notification they can't act on.
  if (project.accessMode === "restricted" && actor) {
    if (!(await hasProjectAccess(project, actor, "read"))) {
      return `That ${label} doesn't have access to this project`;
    }
  }
  return null;
}

async function validateAssignees(
  cid: string,
  assigneeEmployeeId: string | null | undefined,
  assigneeUserId: string | null | undefined,
  project: Project,
): Promise<string | null> {
  return validatePersonPair(cid, assigneeEmployeeId, assigneeUserId, "assignee", project);
}

async function validateReviewers(
  cid: string,
  reviewerEmployeeId: string | null | undefined,
  reviewerUserId: string | null | undefined,
  project: Project,
): Promise<string | null> {
  return validatePersonPair(cid, reviewerEmployeeId, reviewerUserId, "reviewer", project);
}

/**
 * Subtask rules: the parent must exist in the same project, can't be the
 * todo itself, and can't be a subtask already (one level deep keeps the
 * board and the recurrence/review flows sane). Returns an error string or
 * null when valid.
 */
export async function validateParentTodo(
  projectId: string,
  parentTodoId: string,
  selfId?: string,
): Promise<string | null> {
  if (selfId && parentTodoId === selfId) {
    return "A todo cannot be its own parent";
  }
  const parent = await AppDataSource.getRepository(Todo).findOneBy({
    id: parentTodoId,
  });
  if (!parent || parent.projectId !== projectId) {
    return "Parent todo not found in this project";
  }
  if (parent.parentTodoId) {
    return "Subtasks cannot have their own subtasks";
  }
  return null;
}

projectsRouter.get("/projects/:pSlug/todos", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const level = await findProjectAccess(p, actorOf(req));
  if (!level) return res.status(403).json({ error: "No access to that project" });
  const todos = await AppDataSource.getRepository(Todo).find({
    where: { projectId: p.id },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  res.json({
    project: { ...p, myAccessLevel: level },
    todos: await hydrateTodos(cid, todos),
  });
});

const createTodoSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  status: z.enum(STATUSES as [TodoStatus, ...TodoStatus[]]).optional(),
  priority: z.enum(PRIORITIES as [TodoPriority, ...TodoPriority[]]).optional(),
  assigneeEmployeeId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  reviewerEmployeeId: z.string().uuid().nullable().optional(),
  reviewerUserId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  recurrence: z.enum(RECURRENCES as [TodoRecurrence, ...TodoRecurrence[]]).optional(),
  parentTodoId: z.string().uuid().nullable().optional(),
});

projectsRouter.post(
  "/projects/:pSlug/todos",
  validateBody(createTodoSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (!(await hasProjectAccess(p, actorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }
    const body = req.body as z.infer<typeof createTodoSchema>;

    // Unassigned work tends to sit forever — when the caller doesn't
    // mention an assignee at all, the creator owns it. An explicit `null`
    // still means "leave it unassigned".
    const assigneeEmployeeId = body.assigneeEmployeeId ?? null;
    let assigneeUserId = body.assigneeUserId ?? null;
    if (
      body.assigneeEmployeeId === undefined &&
      body.assigneeUserId === undefined &&
      req.userId
    ) {
      assigneeUserId = req.userId;
    }

    const assigneeErr = await validateAssignees(
      cid,
      assigneeEmployeeId,
      assigneeUserId,
      p,
    );
    if (assigneeErr) return res.status(400).json({ error: assigneeErr });
    const reviewerErr = await validateReviewers(
      cid,
      body.reviewerEmployeeId,
      body.reviewerUserId,
      p,
    );
    if (reviewerErr) return res.status(400).json({ error: reviewerErr });

    if (body.parentTodoId) {
      const parentErr = await validateParentTodo(p.id, body.parentTodoId);
      if (parentErr) return res.status(400).json({ error: parentErr });
    }

    // Bump the per-project sequence atomically-ish. SQLite + better-sqlite3
    // is synchronous so the read-then-write here is safe within a request;
    // if this ever moves to Postgres with concurrent writes, switch to
    // `UPDATE ... RETURNING`.
    const projRepo = AppDataSource.getRepository(Project);
    p.todoCounter += 1;
    await projRepo.save(p);

    const status = body.status ?? "todo";
    // Place new todo at the bottom of its column so drag-to-reorder works.
    const last = await AppDataSource.getRepository(Todo).findOne({
      where: { projectId: p.id, status },
      order: { sortOrder: "DESC" },
    });
    const sortOrder = (last?.sortOrder ?? 0) + 1000;

    const t = AppDataSource.getRepository(Todo).create({
      projectId: p.id,
      number: p.todoCounter,
      title: body.title,
      description: body.description ?? "",
      status,
      priority: body.priority ?? "none",
      assigneeEmployeeId,
      assigneeUserId,
      reviewerEmployeeId: body.reviewerEmployeeId ?? null,
      reviewerUserId: body.reviewerUserId ?? null,
      createdById: req.userId ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      sortOrder,
      completedAt: status === "done" ? new Date() : null,
      recurrence: body.recurrence ?? "none",
      recurrenceParentId: null,
      parentTodoId: body.parentTodoId ?? null,
    });
    await AppDataSource.getRepository(Todo).save(t);
    void dispatchTodoCreated(cid, t.id).catch((err) => {
      console.error(`[pipelines] task event failed for ${t.id}:`, err);
    });

    // Assigning to an AI employee is the "go" signal — start a work session
    // in the background instead of letting the todo sit until a routine or a
    // chat happens to look at it. Fire-and-forget; all guards live in the
    // service.
    if (t.assigneeEmployeeId) {
      void kickoffAssignedTodo({
        companyId: cid,
        todoId: t.id,
        employeeId: t.assigneeEmployeeId,
      }).catch((err) => {
        console.error("[todos] kickoff failed", err);
      });
    }

    const [hydrated] = await hydrateTodos(cid, [t]);
    res.json(hydrated);
  },
);

async function loadTodo(cid: string, tid: string) {
  const t = await AppDataSource.getRepository(Todo).findOneBy({ id: tid });
  if (!t) return null;
  const p = await AppDataSource.getRepository(Project).findOneBy({
    id: t.projectId,
    companyId: cid,
  });
  if (!p) return null;
  return { todo: t, project: p };
}

const patchTodoSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  status: z.enum(STATUSES as [TodoStatus, ...TodoStatus[]]).optional(),
  priority: z.enum(PRIORITIES as [TodoPriority, ...TodoPriority[]]).optional(),
  assigneeEmployeeId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  reviewerEmployeeId: z.string().uuid().nullable().optional(),
  reviewerUserId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().optional(),
  recurrence: z.enum(RECURRENCES as [TodoRecurrence, ...TodoRecurrence[]]).optional(),
  parentTodoId: z.string().uuid().nullable().optional(),
});

projectsRouter.patch("/todos/:tid", validateBody(patchTodoSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  if (!(await hasProjectAccess(found.project, actorOf(req), "write"))) {
    return res.status(403).json({ error: "No access to that project" });
  }
  const body = req.body as z.infer<typeof patchTodoSchema>;
  const t = found.todo;
  const prevAssigneeEmployeeId = t.assigneeEmployeeId;

  // Apply assignee + reviewer changes together so we can validate "only one
  // kind at a time" against the resulting state, and clear the other side
  // when one is set to a non-null value.
  const nextAssigneeEmp =
    body.assigneeEmployeeId !== undefined ? body.assigneeEmployeeId : t.assigneeEmployeeId;
  const nextAssigneeUser =
    body.assigneeUserId !== undefined ? body.assigneeUserId : t.assigneeUserId;
  const effectiveAssigneeEmp = body.assigneeUserId ? null : nextAssigneeEmp;
  const effectiveAssigneeUser = body.assigneeEmployeeId ? null : nextAssigneeUser;
  const assigneeErr = await validateAssignees(
    cid,
    effectiveAssigneeEmp,
    effectiveAssigneeUser,
    found.project,
  );
  if (assigneeErr) return res.status(400).json({ error: assigneeErr });

  const nextReviewerEmp =
    body.reviewerEmployeeId !== undefined ? body.reviewerEmployeeId : t.reviewerEmployeeId;
  const nextReviewerUser =
    body.reviewerUserId !== undefined ? body.reviewerUserId : t.reviewerUserId;
  const effectiveReviewerEmp = body.reviewerUserId ? null : nextReviewerEmp;
  const effectiveReviewerUser = body.reviewerEmployeeId ? null : nextReviewerUser;
  const reviewerErr = await validateReviewers(
    cid,
    effectiveReviewerEmp,
    effectiveReviewerUser,
    found.project,
  );
  if (reviewerErr) return res.status(400).json({ error: reviewerErr });

  if (body.title !== undefined) t.title = body.title;
  if (body.description !== undefined) t.description = body.description;
  if (body.priority !== undefined) t.priority = body.priority;
  if (body.assigneeEmployeeId !== undefined) {
    t.assigneeEmployeeId = body.assigneeEmployeeId;
    if (body.assigneeEmployeeId) t.assigneeUserId = null;
  }
  if (body.assigneeUserId !== undefined) {
    t.assigneeUserId = body.assigneeUserId;
    if (body.assigneeUserId) t.assigneeEmployeeId = null;
  }
  if (body.reviewerEmployeeId !== undefined) {
    t.reviewerEmployeeId = body.reviewerEmployeeId;
    if (body.reviewerEmployeeId) t.reviewerUserId = null;
  }
  if (body.reviewerUserId !== undefined) {
    t.reviewerUserId = body.reviewerUserId;
    if (body.reviewerUserId) t.reviewerEmployeeId = null;
  }
  if (body.dueAt !== undefined) t.dueAt = body.dueAt ? new Date(body.dueAt) : null;
  if (body.sortOrder !== undefined) t.sortOrder = body.sortOrder;
  if (body.recurrence !== undefined) t.recurrence = body.recurrence;
  if (body.parentTodoId !== undefined) {
    if (body.parentTodoId) {
      const parentErr = await validateParentTodo(t.projectId, body.parentTodoId, t.id);
      if (parentErr) return res.status(400).json({ error: parentErr });
      const childCount = await AppDataSource.getRepository(Todo).countBy({
        parentTodoId: t.id,
      });
      if (childCount > 0) {
        return res
          .status(400)
          .json({ error: "A todo with subtasks cannot become a subtask" });
      }
    }
    t.parentTodoId = body.parentTodoId;
  }
  let justCompleted = false;
  let justEnteredReview = false;
  if (body.status !== undefined) {
    const prev = t.status;
    t.status = body.status;
    if (body.status === "done" && prev !== "done") {
      t.completedAt = new Date();
      justCompleted = true;
    }
    if (body.status !== "done" && prev === "done") t.completedAt = null;
    if (body.status === "in_review" && prev !== "in_review") {
      justEnteredReview = true;
    }
  }

  await AppDataSource.getRepository(Todo).save(t);

  // Notify the human reviewer when work first enters their queue. Skip if
  // the reviewer is themselves the one moving the card (no self-pings) or
  // if the reviewer is an AI employee — bots don't get a bell.
  if (justEnteredReview && t.reviewerUserId && t.reviewerUserId !== req.userId) {
    void notifyTodoReviewRequested({
      companyId: cid,
      todo: t,
      project: found.project,
      actorUserId: req.userId ?? null,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[projects] notify review requested failed:", e);
    });
  }

  // If a recurring todo was just completed, spawn the next instance so the
  // work reappears on the list when it's next due. We anchor the next dueAt
  // to the completed todo's dueAt (when present) so a weekly report that
  // was due Monday stays due on Mondays; otherwise anchor to now.
  if (justCompleted && t.recurrence !== "none") {
    await spawnNextRecurrence(found.project, t);
  }

  // Handing the todo to an AI employee (fresh assignment or reassignment) is
  // the "go" signal — start a work session in the background. Same seam as
  // todo creation; all eligibility guards live in the service.
  if (t.assigneeEmployeeId && t.assigneeEmployeeId !== prevAssigneeEmployeeId) {
    void kickoffAssignedTodo({
      companyId: cid,
      todoId: t.id,
      employeeId: t.assigneeEmployeeId,
    }).catch((err) => {
      console.error("[todos] kickoff failed", err);
    });
  }

  const [hydrated] = await hydrateTodos(cid, [t]);
  res.json(hydrated);
});

async function spawnNextRecurrence(project: Project, completed: Todo): Promise<void> {
  const anchor = completed.dueAt ?? new Date();
  const nextDue = nextOccurrence(anchor, completed.recurrence);
  if (!nextDue) return;

  const projRepo = AppDataSource.getRepository(Project);
  project.todoCounter += 1;
  await projRepo.save(project);

  const todoRepo = AppDataSource.getRepository(Todo);
  const last = await todoRepo.findOne({
    where: { projectId: project.id, status: "todo" },
    order: { sortOrder: "DESC" },
  });
  const sortOrder = (last?.sortOrder ?? 0) + 1000;

  const next = todoRepo.create({
    projectId: project.id,
    number: project.todoCounter,
    title: completed.title,
    description: completed.description,
    status: "todo",
    priority: completed.priority,
    assigneeEmployeeId: completed.assigneeEmployeeId,
    assigneeUserId: completed.assigneeUserId,
    reviewerEmployeeId: completed.reviewerEmployeeId,
    reviewerUserId: completed.reviewerUserId,
    createdById: completed.createdById,
    dueAt: nextDue,
    sortOrder,
    completedAt: null,
    recurrence: completed.recurrence,
    recurrenceParentId: completed.recurrenceParentId ?? completed.id,
    parentTodoId: completed.parentTodoId,
  });
  await todoRepo.save(next);
  void dispatchTodoCreated(project.companyId, next.id).catch((err) => {
    console.error(`[pipelines] task event failed for ${next.id}:`, err);
  });
}

projectsRouter.delete("/todos/:tid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  if (!(await hasProjectAccess(found.project, actorOf(req), "write"))) {
    return res.status(403).json({ error: "No access to that project" });
  }
  // Subtasks are parts of their parent — they go with it, comments and all.
  const todoRepo = AppDataSource.getRepository(Todo);
  const children = await todoRepo.find({
    where: { parentTodoId: found.todo.id },
    select: ["id"],
  });
  const ids = [found.todo.id, ...children.map((c) => c.id)];
  await AppDataSource.getRepository(TodoComment).delete({ todoId: In(ids) });
  await todoRepo.delete({ id: In(ids) });
  res.json({ ok: true });
});

// ----- Comments -----

type HydratedComment = TodoComment & {
  author:
    | { kind: "human"; id: string; name: string; email: string | null }
    | { kind: "ai"; id: string; name: string; slug: string; role: string }
    | null;
};

/**
 * Attach author info (human Member or AI Employee) so the UI can render an
 * avatar + name without extra fetches.
 */
async function hydrateComments(
  cid: string,
  comments: TodoComment[],
): Promise<HydratedComment[]> {
  const userIds = [
    ...new Set(comments.map((c) => c.authorUserId).filter((x): x is string => !!x)),
  ];
  const empIds = [
    ...new Set(
      comments.map((c) => c.authorEmployeeId).filter((x): x is string => !!x),
    ),
  ];
  const [users, emps] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    empIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds), companyId: cid },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const empById = new Map(emps.map((e) => [e.id, e]));
  return comments.map((c) => {
    let author: HydratedComment["author"] = null;
    if (c.authorUserId) {
      const u = userById.get(c.authorUserId);
      if (u) author = { kind: "human", id: u.id, name: u.name, email: u.email };
    } else if (c.authorEmployeeId) {
      const e = empById.get(c.authorEmployeeId);
      if (e) author = { kind: "ai", id: e.id, name: e.name, slug: e.slug, role: e.role };
    }
    return { ...c, author };
  });
}

projectsRouter.get("/todos/:tid/comments", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  if (!(await hasProjectAccess(found.project, actorOf(req), "read"))) {
    return res.status(403).json({ error: "No access to that project" });
  }
  const comments = await AppDataSource.getRepository(TodoComment).find({
    where: { todoId: found.todo.id },
    order: { createdAt: "ASC" },
  });
  res.json(await hydrateComments(cid, comments));
});

const createCommentSchema = z.object({
  body: z.string().min(1).max(10_000),
  /** When set, the mentioned AI employee is invoked and their reply is posted. */
  mentionEmployeeId: z.string().uuid().nullable().optional(),
});

projectsRouter.post(
  "/todos/:tid/comments",
  validateBody(createCommentSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const found = await loadTodo(cid, req.params.tid);
    if (!found) return res.status(404).json({ error: "Not found" });
    if (!(await hasProjectAccess(found.project, actorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }
    const body = req.body as z.infer<typeof createCommentSchema>;
    const commentRepo = AppDataSource.getRepository(TodoComment);

    // Validate mention target belongs to this company.
    let mentionEmp: AIEmployee | null = null;
    if (body.mentionEmployeeId) {
      mentionEmp = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: body.mentionEmployeeId,
        companyId: cid,
      });
      if (!mentionEmp) return res.status(400).json({ error: "Invalid mention" });
      // A mention hands the employee the todo and the whole thread as context,
      // so it has to clear the same bar as reading the project. Without this,
      // @-mentioning is a side door into a project the employee is denied at
      // every other one.
      if (
        !(await hasProjectAccess(
          found.project,
          { kind: "ai", id: mentionEmp.id },
          "read",
        ))
      ) {
        return res
          .status(400)
          .json({ error: "That AI employee doesn't have access to this project" });
      }
    }

    // 1. Save the human comment.
    const human = await commentRepo.save(
      commentRepo.create({
        todoId: found.todo.id,
        authorUserId: req.userId ?? null,
        authorEmployeeId: null,
        body: body.body,
        pending: false,
      }),
    );

    // 2. If an AI employee was mentioned, create a pending placeholder so the
    //    client can render a "typing" row immediately, then kick off the chat
    //    call in the background. The placeholder is filled in (or marked
    //    errored) once the CLI returns.
    let pending: TodoComment | null = null;
    if (mentionEmp) {
      pending = await commentRepo.save(
        commentRepo.create({
          todoId: found.todo.id,
          authorUserId: null,
          authorEmployeeId: mentionEmp.id,
          body: "",
          pending: true,
        }),
      );
      // Fire-and-forget. Errors are captured onto the comment so the UI
      // surfaces them instead of silently hanging.
      void respondAsEmployee(cid, found.todo.id, pending.id, mentionEmp.id).catch(
        (err) => {
          console.error("[todo-comments] AI reply failed", err);
        },
      );
    }

    const toReturn = pending ? [human, pending] : [human];
    res.json(await hydrateComments(cid, toReturn));
  },
);

projectsRouter.delete("/comments/:cmtId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(TodoComment);
  const cmt = await repo.findOneBy({ id: req.params.cmtId });
  if (!cmt) return res.status(404).json({ error: "Not found" });
  // Comment must belong to a todo in this company.
  const found = await loadTodo(cid, cmt.todoId);
  if (!found) return res.status(404).json({ error: "Not found" });
  if (!(await hasProjectAccess(found.project, actorOf(req), "write"))) {
    return res.status(403).json({ error: "No access to that project" });
  }
  // Only the human author may delete their own comment. AI comments can be
  // cleared by any member (treating them as transient thread noise).
  if (cmt.authorUserId && cmt.authorUserId !== req.userId) {
    return res.status(403).json({ error: "Not your comment" });
  }
  await repo.delete({ id: cmt.id });
  res.json({ ok: true });
});

/**
 * Build chat context from the todo + thread so far, run the AI, and write
 * the reply back onto the pending comment row.
 */
async function respondAsEmployee(
  companyId: string,
  todoId: string,
  pendingCommentId: string,
  employeeId: string,
): Promise<void> {
  const commentRepo = AppDataSource.getRepository(TodoComment);
  const todoRepo = AppDataSource.getRepository(Todo);
  const projRepo = AppDataSource.getRepository(Project);

  const todo = await todoRepo.findOneBy({ id: todoId });
  if (!todo) return;
  const project = await projRepo.findOneBy({ id: todo.projectId });
  if (!project) return;

  // All prior comments on this todo (excluding the pending one).
  const thread = await commentRepo.find({
    where: { todoId },
    order: { createdAt: "ASC" },
  });
  const history: ChatTurn[] = [];
  // Opening synthetic turn: frames the todo so the model knows what we're
  // talking about, regardless of whether it has memory of prior threads.
  const header =
    `You are collaborating on **${project.key}-${todo.number}: ${todo.title}** ` +
    `(status: ${todo.status}, priority: ${todo.priority}).` +
    (todo.description ? `\n\nDescription:\n${todo.description}` : "");
  history.push({ role: "user", content: header });

  let latestHumanBody = "";
  for (const c of thread) {
    if (c.id === pendingCommentId) continue;
    if (c.pending) continue;
    if (c.authorEmployeeId === employeeId) {
      history.push({ role: "assistant", content: c.body });
    } else {
      history.push({ role: "user", content: c.body });
      if (c.authorUserId) latestHumanBody = c.body;
    }
  }
  // Last human message becomes the "new message" passed to chatWithEmployee;
  // pop it off history so it isn't duplicated.
  let message = latestHumanBody;
  if (message && history[history.length - 1]?.content === message) {
    history.pop();
  } else if (!message) {
    message = "Please weigh in on this todo.";
  }

  const result = await chatWithEmployee(companyId, employeeId, message, history);
  const reply = result.reply || "(no reply)";

  const pending = await commentRepo.findOneBy({ id: pendingCommentId });
  if (!pending) return;
  pending.body = reply;
  pending.pending = false;
  await commentRepo.save(pending);
}

async function notifyTodoReviewRequested(args: {
  companyId: string;
  todo: Todo;
  project: Project;
  actorUserId: string | null;
}): Promise<void> {
  const { companyId, todo, project, actorUserId } = args;
  if (!todo.reviewerUserId) return;
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return;
  const actor = actorUserId
    ? await AppDataSource.getRepository(User).findOneBy({ id: actorUserId })
    : null;
  const actorName = actor?.name || actor?.email || "Someone";
  const ref = `${project.key}-${todo.number}`;
  await createNotification({
    companyId,
    userId: todo.reviewerUserId,
    kind: "todo_review_requested",
    title: `${actorName} requested your review on ${ref}`,
    body: todo.title,
    link: `/c/${company.slug}/tasks/p/${project.slug}`,
    actorKind: actor ? "user" : "system",
    actorId: actor?.id ?? null,
    entityKind: "todo",
    entityId: todo.id,
  });
}
