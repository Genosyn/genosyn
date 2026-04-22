import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo, TodoPriority, TodoRecurrence, TodoStatus } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { User } from "../db/entities/User.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { ChatTurn, chatWithEmployee } from "../services/chat.js";

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
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId: cid },
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
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId: cid },
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

projectsRouter.get("/projects/:pSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  res.json(p);
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
});

projectsRouter.patch(
  "/projects/:pSlug",
  validateBody(patchProjectSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    const body = req.body as z.infer<typeof patchProjectSchema>;
    if (body.name !== undefined) p.name = body.name;
    if (body.description !== undefined) p.description = body.description;
    if (body.key !== undefined) p.key = body.key.toUpperCase();
    await AppDataSource.getRepository(Project).save(p);
    res.json(p);
  },
);

projectsRouter.delete("/projects/:pSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  await AppDataSource.getRepository(Todo).delete({ projectId: p.id });
  await AppDataSource.getRepository(Project).delete({ id: p.id });
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
): Promise<string | null> {
  if (employeeId && userId) {
    return `Cannot set both an AI employee and a human as ${label} at the same time`;
  }
  if (employeeId) {
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: employeeId,
      companyId: cid,
    });
    if (!emp) return `Invalid ${label}`;
  }
  if (userId) {
    const mem = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: cid,
      userId,
    });
    if (!mem) return `Invalid ${label}`;
  }
  return null;
}

async function validateAssignees(
  cid: string,
  assigneeEmployeeId: string | null | undefined,
  assigneeUserId: string | null | undefined,
): Promise<string | null> {
  return validatePersonPair(cid, assigneeEmployeeId, assigneeUserId, "assignee");
}

async function validateReviewers(
  cid: string,
  reviewerEmployeeId: string | null | undefined,
  reviewerUserId: string | null | undefined,
): Promise<string | null> {
  return validatePersonPair(cid, reviewerEmployeeId, reviewerUserId, "reviewer");
}

projectsRouter.get("/projects/:pSlug/todos", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProjectBySlug(cid, req.params.pSlug);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const todos = await AppDataSource.getRepository(Todo).find({
    where: { projectId: p.id },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  res.json({ project: p, todos: await hydrateTodos(cid, todos) });
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
});

projectsRouter.post(
  "/projects/:pSlug/todos",
  validateBody(createTodoSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    const body = req.body as z.infer<typeof createTodoSchema>;

    const assigneeErr = await validateAssignees(
      cid,
      body.assigneeEmployeeId,
      body.assigneeUserId,
    );
    if (assigneeErr) return res.status(400).json({ error: assigneeErr });
    const reviewerErr = await validateReviewers(
      cid,
      body.reviewerEmployeeId,
      body.reviewerUserId,
    );
    if (reviewerErr) return res.status(400).json({ error: reviewerErr });

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
      assigneeEmployeeId: body.assigneeEmployeeId ?? null,
      assigneeUserId: body.assigneeUserId ?? null,
      reviewerEmployeeId: body.reviewerEmployeeId ?? null,
      reviewerUserId: body.reviewerUserId ?? null,
      createdById: req.userId ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      sortOrder,
      completedAt: status === "done" ? new Date() : null,
      recurrence: body.recurrence ?? "none",
      recurrenceParentId: null,
    });
    await AppDataSource.getRepository(Todo).save(t);
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
});

projectsRouter.patch("/todos/:tid", validateBody(patchTodoSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof patchTodoSchema>;
  const t = found.todo;

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
  let justCompleted = false;
  if (body.status !== undefined) {
    const prev = t.status;
    t.status = body.status;
    if (body.status === "done" && prev !== "done") {
      t.completedAt = new Date();
      justCompleted = true;
    }
    if (body.status !== "done" && prev === "done") t.completedAt = null;
  }

  await AppDataSource.getRepository(Todo).save(t);

  // If a recurring todo was just completed, spawn the next instance so the
  // work reappears on the list when it's next due. We anchor the next dueAt
  // to the completed todo's dueAt (when present) so a weekly report that
  // was due Monday stays due on Mondays; otherwise anchor to now.
  if (justCompleted && t.recurrence !== "none") {
    await spawnNextRecurrence(found.project, t);
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
  });
  await todoRepo.save(next);
}

projectsRouter.delete("/todos/:tid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  await AppDataSource.getRepository(TodoComment).delete({ todoId: found.todo.id });
  await AppDataSource.getRepository(Todo).delete({ id: found.todo.id });
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
