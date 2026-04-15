import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Project } from "../db/entities/Project.js";
import { Todo, TodoPriority, TodoStatus } from "../db/entities/Todo.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";

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
  const counts = new Map<string, { total: number; open: number }>();
  for (const t of todos) {
    const c = counts.get(t.projectId) ?? { total: 0, open: 0 };
    c.total += 1;
    if (t.status !== "done" && t.status !== "cancelled") c.open += 1;
    counts.set(t.projectId, c);
  }
  res.json(
    projects.map((p) => ({
      ...p,
      totalTodos: counts.get(p.id)?.total ?? 0,
      openTodos: counts.get(p.id)?.open ?? 0,
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

/**
 * Shape returned to the client. Includes the assignee's display info so the
 * board view can render avatars without a second fetch.
 */
async function hydrateTodos(cid: string, todos: Todo[]) {
  const ids = [
    ...new Set(todos.map((t) => t.assigneeEmployeeId).filter((x): x is string => !!x)),
  ];
  const emps = ids.length
    ? await AppDataSource.getRepository(AIEmployee).find({
        where: { id: In(ids), companyId: cid },
      })
    : [];
  const byId = new Map(emps.map((e) => [e.id, e]));
  return todos.map((t) => {
    const e = t.assigneeEmployeeId ? byId.get(t.assigneeEmployeeId) : null;
    return {
      ...t,
      assignee: e
        ? { id: e.id, name: e.name, slug: e.slug, role: e.role }
        : null,
    };
  });
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
  dueAt: z.string().datetime().nullable().optional(),
});

projectsRouter.post(
  "/projects/:pSlug/todos",
  validateBody(createTodoSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProjectBySlug(cid, req.params.pSlug);
    if (!p) return res.status(404).json({ error: "Project not found" });
    const body = req.body as z.infer<typeof createTodoSchema>;

    if (body.assigneeEmployeeId) {
      const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: body.assigneeEmployeeId,
        companyId: cid,
      });
      if (!emp) return res.status(400).json({ error: "Invalid assignee" });
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
      assigneeEmployeeId: body.assigneeEmployeeId ?? null,
      createdById: req.userId ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      sortOrder,
      completedAt: status === "done" ? new Date() : null,
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
  dueAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().optional(),
});

projectsRouter.patch("/todos/:tid", validateBody(patchTodoSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof patchTodoSchema>;
  const t = found.todo;

  if (body.assigneeEmployeeId) {
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.assigneeEmployeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Invalid assignee" });
  }

  if (body.title !== undefined) t.title = body.title;
  if (body.description !== undefined) t.description = body.description;
  if (body.priority !== undefined) t.priority = body.priority;
  if (body.assigneeEmployeeId !== undefined) t.assigneeEmployeeId = body.assigneeEmployeeId;
  if (body.dueAt !== undefined) t.dueAt = body.dueAt ? new Date(body.dueAt) : null;
  if (body.sortOrder !== undefined) t.sortOrder = body.sortOrder;
  if (body.status !== undefined) {
    const prev = t.status;
    t.status = body.status;
    if (body.status === "done" && prev !== "done") t.completedAt = new Date();
    if (body.status !== "done" && prev === "done") t.completedAt = null;
  }

  await AppDataSource.getRepository(Todo).save(t);
  const [hydrated] = await hydrateTodos(cid, [t]);
  res.json(hydrated);
});

projectsRouter.delete("/todos/:tid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadTodo(cid, req.params.tid);
  if (!found) return res.status(404).json({ error: "Not found" });
  await AppDataSource.getRepository(Todo).delete({ id: found.todo.id });
  res.json({ ok: true });
});
