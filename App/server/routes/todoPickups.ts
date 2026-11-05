import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import type { Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { hasProjectAccess, type ProjectActor } from "../services/projects.js";
import {
  followTodoPickup,
  listTodoPickups,
  loadTodoPickup,
  readTodoPickupActivity,
  requestTodoPickup,
  stopTodoPickup,
} from "../services/todoPickups.js";

/**
 * What a person sees of an AI Employee working a Todo: the session running or
 * queued, its steps as they may see them, a live stream of it, Start now and
 * Stop (`services/todoPickups.ts`).
 *
 * Every route answers only for a Todo in a Project the caller can open, and one
 * they can't reads as missing. What each reader sees of the steps is
 * `shared/turnActivityAccess.ts`'s rule, as in a Workspace room: the Member whose
 * authority it ran under sees everything, others the steps, and a session under
 * the employee's own authority shows in full to any Member who can open the
 * Todo, as its Run transcripts do.
 *
 * Steps and their stream need a signed-in browser session, and so does Start
 * now, which starts AI work under the caller's authority. The list says only
 * who is working and how it stands, and Stop starts nothing, so an API key may
 * use both.
 */
export const todoPickupsRouter = Router({ mergeParams: true });
todoPickupsRouter.use(requireAuth);
todoPickupsRouter.use(requireCompanyMember);

const todoParamsSchema = z.object({ cid: z.string().uuid(), tid: z.string().uuid() });
const pickupParamsSchema = todoParamsSchema.extend({ pickupId: z.string().uuid() });
const activityQuerySchema = z.object({
  /** The last ordinal the reader already holds; 0 reads from the start. */
  after: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1_000).optional().default(500),
});
const streamQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional().default(0),
});
const noBodySchema = z.object({}).strict();

function actorOf(req: Request): ProjectActor {
  return { kind: "user", id: req.userId!, role: (req as Request & { role: Role }).role };
}

/** The Todo, when this caller may reach it at this level. Answers the refusal itself. */
async function reachableTodo(
  req: Request,
  res: Response,
  cid: string,
  tid: string,
  level: "read" | "write",
): Promise<{ todo: Todo; project: Project } | null> {
  const todo = await AppDataSource.getRepository(Todo).findOneBy({ id: tid });
  const project = todo
    ? await AppDataSource.getRepository(Project).findOneBy({ id: todo.projectId, companyId: cid })
    : null;
  if (!todo || !project) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (!(await hasProjectAccess(project, actorOf(req), level))) {
    res.status(403).json({ error: "No access to that project" });
    return null;
  }
  return { todo, project };
}

/** Who is working this Todo now, how it stands, and its recent sessions. */
todoPickupsRouter.get(
  "/todos/:tid/pickups",
  validateParams(todoParamsSchema),
  async (req, res) => {
    const { cid, tid } = req.params as z.infer<typeof todoParamsSchema>;
    if (!(await reachableTodo(req, res, cid, tid, "read"))) return;
    res.json(await listTodoPickups({ companyId: cid, todoId: tid, viewerUserId: req.userId! }));
  },
);

/**
 * Start now: send this Todo's AI assignee back to it under the caller's
 * authority. For a Todo that sat in `todo` after a blocked pass, or one assigned
 * before its AI Employee had a model.
 */
todoPickupsRouter.post(
  "/todos/:tid/pickups",
  requireBrowserSession,
  validateParams(todoParamsSchema),
  validateBody(noBodySchema),
  async (req, res) => {
    const { cid, tid } = req.params as z.infer<typeof todoParamsSchema>;
    const found = await reachableTodo(req, res, cid, tid, "write");
    if (!found) return;
    if (!found.todo.assigneeEmployeeId) {
      return res.status(400).json({ error: "Assign an AI Employee first" });
    }
    const outcome = await requestTodoPickup({
      companyId: cid,
      todoId: tid,
      employeeId: found.todo.assigneeEmployeeId,
      trigger: "start_now",
      authority: {
        kind: "member",
        userId: req.userId!,
        sessionVersion: req.session!.sessionVersion!,
      },
      byMember: true,
    });
    if (!outcome.started) {
      const refusal: Record<typeof outcome.reason, string> = {
        gone: "That Todo is gone",
        not_assigned: "Assign an AI Employee first",
        closed: "This Todo is finished. Reopen it first.",
        no_access: "That AI Employee can't open this Project",
        no_model: "That AI Employee has no AI Model connected",
        too_deep: "This Todo has passed the limit on AI hand-offs",
        capped: "This Todo has reached its limit of automatic sessions today",
      };
      return res.status(400).json({ error: refusal[outcome.reason] });
    }
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "todo.pickup.start",
      targetType: "todo",
      targetId: tid,
      targetLabel: `${found.project.key}-${found.todo.number}: ${found.todo.title}`,
    });
    res.json(await listTodoPickups({ companyId: cid, todoId: tid, viewerUserId: req.userId! }));
  },
);

/** Stop a session, queued or running. What it already did stays. */
todoPickupsRouter.post(
  "/todos/:tid/pickups/:pickupId/stop",
  validateParams(pickupParamsSchema),
  validateBody(noBodySchema),
  async (req, res) => {
    const { cid, tid, pickupId } = req.params as z.infer<typeof pickupParamsSchema>;
    const found = await reachableTodo(req, res, cid, tid, "write");
    if (!found) return;
    const pickup = await loadTodoPickup(cid, tid, pickupId);
    if (!pickup) return res.status(404).json({ error: "Not found" });
    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: req.userId! },
      select: { id: true, name: true, email: true },
    });
    const stopped = await stopTodoPickup({
      pickup,
      by: { userId: req.userId!, name: user ? user.name || user.email : null },
    });
    if (stopped) {
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "todo.pickup.stop",
        targetType: "todo",
        targetId: tid,
        targetLabel: `${found.project.key}-${found.todo.number}: ${found.todo.title}`,
      });
    }
    res.json({ stopped });
  },
);

/** What the AI Employee did in one session, step by step, as this Member may see it. */
todoPickupsRouter.get(
  "/todos/:tid/pickups/:pickupId/activity",
  requireBrowserSession,
  validateParams(pickupParamsSchema),
  validateQuery(activityQuerySchema),
  async (req, res) => {
    const { cid, tid, pickupId } = req.params as z.infer<typeof pickupParamsSchema>;
    const query = req.query as unknown as z.infer<typeof activityQuerySchema>;
    if (!(await reachableTodo(req, res, cid, tid, "read"))) return;
    const pickup = await loadTodoPickup(cid, tid, pickupId);
    if (!pickup) return res.status(404).json({ error: "Not found" });
    res.json(
      await readTodoPickupActivity({
        pickup,
        viewerUserId: req.userId!,
        after: query.after,
        limit: query.limit,
      }),
    );
  },
);

/**
 * Follow one session live, from the reader's cursor to its end. Server-Sent
 * Events: `turn`, `activity`, `snapshot`, `chunk`, `progress`, `heartbeat`, then
 * `final` (the pickup as it ended) and `done`, the frames `followChatTurn`
 * describes.
 */
todoPickupsRouter.get(
  "/todos/:tid/pickups/:pickupId/activity/stream",
  requireBrowserSession,
  validateParams(pickupParamsSchema),
  validateQuery(streamQuerySchema),
  async (req, res) => {
    const { cid, tid, pickupId } = req.params as z.infer<typeof pickupParamsSchema>;
    const query = req.query as unknown as z.infer<typeof streamQuerySchema>;
    if (!(await reachableTodo(req, res, cid, tid, "read"))) return;
    const pickup = await loadTodoPickup(cid, tid, pickupId);
    if (!pickup) return res.status(404).json({ error: "Not found" });

    let opened = false;
    const writeEvent = (event: string, data: unknown) => {
      if (!opened) {
        opened = true;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
      }
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stop = new AbortController();
    res.on("close", () => stop.abort());
    try {
      await followTodoPickup({
        pickup,
        viewerUserId: req.userId!,
        after: query.after,
        send: writeEvent,
        signal: stop.signal,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[todo-pickups] following pickup ${pickupId} failed`, error);
      if (!opened) return res.status(500).json({ error: "Could not follow this work" });
      writeEvent("error", { message: "Lost track of this work. It continues on the server." });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  },
);
