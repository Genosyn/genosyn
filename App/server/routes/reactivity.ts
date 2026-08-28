import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineTrigger } from "../db/entities/RoutineTrigger.js";
import { LIVE_SYNC_KINDS } from "../db/subscribers/resourceChangeSubscriber.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  RoutineTriggerError,
  assertValidTriggerKind,
  listTriggersForRoutine,
  normalizeMinInterval,
} from "../services/routineTriggers.js";
import { WakeupError, cancelWakeup, listWakeups } from "../services/wakeups.js";
import {
  WorkstreamError,
  closeWorkstream,
  getWorkstream,
  listWorkstreams,
  serializeWorkstream,
} from "../services/workstreams.js";
import {
  InitiativeError,
  acceptInitiative,
  declineInitiative,
  getInitiative,
  listInitiatives,
  serializeInitiative,
} from "../services/initiatives.js";

/**
 * M54's human surface in one router: Triggers on a Routine, an employee's
 * Wakeups, Workstreams, and the Initiatives queue. Reads are member-level
 * throughout; every mutation is admin-gated — each one either creates or
 * cancels future employee-authority work, the same class of act as editing
 * a Routine.
 */
export const reactivityRouter = Router({ mergeParams: true });
reactivityRouter.use(requireAuth);
reactivityRouter.use(requireCompanyMember);
reactivityRouter.use(
  onRoutePaths(
    ["/routine-triggers", "/wakeups", "/workstreams", "/initiatives"],
    requireCompanyRoleForMutations("admin"),
  ),
);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const idParams = (key: string) =>
  z.object({ cid: z.string().uuid(), [key]: z.string().uuid() }).strict();

function fail(res: import("express").Response, err: unknown): void {
  if (
    err instanceof RoutineTriggerError ||
    err instanceof WakeupError ||
    err instanceof WorkstreamError ||
    err instanceof InitiativeError
  ) {
    res.status(400).json({ error: err.message });
    return;
  }
  throw err;
}

// ----- Triggers -----

async function loadCompanyRoutine(cid: string, rid: string) {
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: rid });
  if (!routine) return null;
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
    companyId: cid,
  });
  return employee ? routine : null;
}

function serializeTrigger(t: RoutineTrigger) {
  return {
    id: t.id,
    routineId: t.routineId,
    kind: t.kind,
    scopeId: t.scopeId,
    minIntervalSec: t.minIntervalSec,
    enabled: t.enabled,
    lastFiredAt: t.lastFiredAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

reactivityRouter.get(
  "/routine-triggers/routine/:rid",
  validateParams(idParams("rid")),
  async (req, res) => {
    const routine = await loadCompanyRoutine(req.params.cid, req.params.rid);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const triggers = await listTriggersForRoutine(req.params.cid, routine.id);
    res.json({ kinds: LIVE_SYNC_KINDS, triggers: triggers.map(serializeTrigger) });
  },
);

const createTriggerSchema = z.object({
  routineId: z.string().uuid(),
  kind: z.string().min(1).max(60),
  scopeId: z.string().uuid().nullable().optional(),
  minIntervalSec: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .optional(),
});

reactivityRouter.post(
  "/routine-triggers",
  validateParams(companyParamsSchema),
  validateBody(createTriggerSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof createTriggerSchema>;
    try {
      assertValidTriggerKind(body.kind);
      const routine = await loadCompanyRoutine(cid, body.routineId);
      if (!routine) return res.status(404).json({ error: "Routine not found" });
      const repo = AppDataSource.getRepository(RoutineTrigger);
      const trigger = await repo.save(
        repo.create({
          companyId: cid,
          routineId: routine.id,
          kind: body.kind,
          scopeId: body.scopeId ?? null,
          minIntervalSec: normalizeMinInterval(body.minIntervalSec),
        }),
      );
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "routine.trigger.create",
        targetType: "routine",
        targetId: routine.id,
        targetLabel: routine.name,
        metadata: { kind: trigger.kind, scopeId: trigger.scopeId },
      });
      res.json(serializeTrigger(trigger));
    } catch (err) {
      fail(res, err);
    }
  },
);

const patchTriggerSchema = z.object({
  enabled: z.boolean().optional(),
  minIntervalSec: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .optional(),
  scopeId: z.string().uuid().nullable().optional(),
});

reactivityRouter.patch(
  "/routine-triggers/:tid",
  validateParams(idParams("tid")),
  validateBody(patchTriggerSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof patchTriggerSchema>;
    const repo = AppDataSource.getRepository(RoutineTrigger);
    const trigger = await repo.findOneBy({ id: req.params.tid, companyId: cid });
    if (!trigger) return res.status(404).json({ error: "Trigger not found" });
    if (body.enabled !== undefined) trigger.enabled = body.enabled;
    if (body.minIntervalSec !== undefined) {
      trigger.minIntervalSec = normalizeMinInterval(body.minIntervalSec);
    }
    if (body.scopeId !== undefined) trigger.scopeId = body.scopeId;
    res.json(serializeTrigger(await repo.save(trigger)));
  },
);

reactivityRouter.delete(
  "/routine-triggers/:tid",
  validateParams(idParams("tid")),
  async (req, res) => {
    const cid = req.params.cid;
    const repo = AppDataSource.getRepository(RoutineTrigger);
    const trigger = await repo.findOneBy({ id: req.params.tid, companyId: cid });
    if (!trigger) return res.status(404).json({ error: "Trigger not found" });
    await repo.delete({ id: trigger.id, companyId: cid });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "routine.trigger.delete",
      targetType: "routine",
      targetId: trigger.routineId,
      metadata: { kind: trigger.kind },
    });
    res.json({ ok: true });
  },
);

// ----- Wakeups -----

reactivityRouter.get(
  "/wakeups/employee/:eid",
  validateParams(idParams("eid")),
  async (req, res) => {
    const wakeups = await listWakeups(req.params.cid, req.params.eid);
    res.json(
      wakeups.map((w) => ({
        id: w.id,
        employeeId: w.employeeId,
        at: w.at.toISOString(),
        brief: w.brief,
        status: w.status,
        firedAt: w.firedAt?.toISOString() ?? null,
        outcomeNote: w.outcomeNote,
        createdAt: w.createdAt.toISOString(),
      })),
    );
  },
);

reactivityRouter.post(
  "/wakeups/:wid/cancel",
  validateParams(idParams("wid")),
  async (req, res) => {
    const cancelled = await cancelWakeup(req.params.cid, req.params.wid, {
      userId: req.userId ?? null,
    });
    if (!cancelled) return res.status(409).json({ error: "That wakeup is not pending" });
    res.json({ ok: true });
  },
);

// ----- Workstreams -----

reactivityRouter.get("/workstreams", validateParams(companyParamsSchema), async (req, res) => {
  const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId : undefined;
  const rows = await listWorkstreams(req.params.cid, { employeeId });
  res.json(rows.map(serializeWorkstream));
});

reactivityRouter.get(
  "/workstreams/:wid",
  validateParams(idParams("wid")),
  async (req, res) => {
    const workstream = await getWorkstream(req.params.cid, req.params.wid);
    if (!workstream) return res.status(404).json({ error: "Workstream not found" });
    res.json(serializeWorkstream(workstream));
  },
);

const closeWorkstreamSchema = z.object({
  status: z.enum(["done", "abandoned"]),
  reason: z.string().min(1).max(2_000),
});

reactivityRouter.post(
  "/workstreams/:wid/close",
  validateParams(idParams("wid")),
  validateBody(closeWorkstreamSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof closeWorkstreamSchema>;
    try {
      const closed = await closeWorkstream({
        companyId: req.params.cid,
        workstreamId: req.params.wid,
        status: body.status,
        reason: body.reason,
        userId: req.userId ?? null,
      });
      res.json(serializeWorkstream(closed));
    } catch (err) {
      fail(res, err);
    }
  },
);

// ----- Initiatives -----

reactivityRouter.get("/initiatives", validateParams(companyParamsSchema), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status && !["pending", "accepted", "declined"].includes(status)) {
    return res.status(400).json({ error: "Unknown status filter" });
  }
  const rows = await listInitiatives(
    req.params.cid,
    status as "pending" | "accepted" | "declined" | undefined,
  );
  res.json(rows.map(serializeInitiative));
});

const reviewSchema = z.object({ note: z.string().max(2_000).optional() });

reactivityRouter.post(
  "/initiatives/:iid/accept",
  validateParams(idParams("iid")),
  validateBody(reviewSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof reviewSchema>;
    const initiative = await getInitiative(req.params.cid, req.params.iid);
    if (!initiative) return res.status(404).json({ error: "Initiative not found" });
    try {
      const accepted = await acceptInitiative(initiative, {
        userId: req.userId ?? null,
        note: body.note ?? null,
      });
      res.json(serializeInitiative(accepted));
    } catch (err) {
      fail(res, err);
    }
  },
);

reactivityRouter.post(
  "/initiatives/:iid/decline",
  validateParams(idParams("iid")),
  validateBody(reviewSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof reviewSchema>;
    const initiative = await getInitiative(req.params.cid, req.params.iid);
    if (!initiative) return res.status(404).json({ error: "Initiative not found" });
    try {
      const declined = await declineInitiative(initiative, {
        userId: req.userId ?? null,
        note: body.note ?? null,
      });
      res.json(serializeInitiative(declined));
    } catch (err) {
      fail(res, err);
    }
  },
);
