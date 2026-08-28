import { Router } from "express";
import { z } from "zod";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  GoalError,
  createGoal,
  deleteGoal,
  getGoal,
  listGoals,
  refreshGoalValue,
  reportGoalProgress,
  serializeGoal,
  updateGoal,
} from "../services/goals.js";

/**
 * Goals (M51). Reads are member-level — a Goal is the company's shared
 * direction and every Member may see where it stands. Mutations are
 * admin-gated: humans set intent, and which humans is the same call as who
 * may re-file the company's Routines.
 */
export const goalsRouter = Router({ mergeParams: true });
goalsRouter.use(requireAuth);
goalsRouter.use(requireCompanyMember);
goalsRouter.use(onRoutePaths(["/goals"], requireCompanyRoleForMutations("admin")));

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const goalParamsSchema = z.object({ cid: z.string().uuid(), gid: z.string().uuid() }).strict();

const metricValue = z.number().finite();

const createSchema = z.object({
  title: z.string().min(1).max(140),
  description: z.string().max(4_000).optional(),
  parentGoalId: z.string().uuid().nullable().optional(),
  ownerEmployeeId: z.string().uuid().nullable().optional(),
  metricKind: z.enum(["manual", "chart"]).optional(),
  chartId: z.string().uuid().nullable().optional(),
  startValue: metricValue.nullable().optional(),
  targetValue: metricValue,
  currentValue: metricValue.nullable().optional(),
  direction: z.enum(["increase_to", "decrease_to"]).optional(),
  unit: z.string().max(20).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

const patchSchema = createSchema.partial().extend({
  status: z.enum(["active", "achieved", "missed", "archived"]).optional(),
});

const progressSchema = z.object({ value: metricValue });

function failGoal(res: import("express").Response, err: unknown): void {
  if (!(err instanceof GoalError)) throw err;
  res.status(400).json({ error: err.message });
}

goalsRouter.get("/goals", validateParams(companyParamsSchema), async (req, res) => {
  const goals = await listGoals(req.params.cid);
  res.json(goals.map(serializeGoal));
});

goalsRouter.get("/goals/:gid", validateParams(goalParamsSchema), async (req, res) => {
  const goal = await getGoal(req.params.cid, req.params.gid);
  if (!goal) return res.status(404).json({ error: "Goal not found" });
  res.json(serializeGoal(goal));
});

goalsRouter.post(
  "/goals",
  validateParams(companyParamsSchema),
  validateBody(createSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof createSchema>;
    try {
      const goal = await createGoal(cid, body, req.userId ?? null);
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "goal.create",
        targetType: "goal",
        targetId: goal.id,
        targetLabel: goal.title,
        metadata: { metricKind: goal.metricKind, targetValue: goal.targetValue },
      });
      res.json(serializeGoal(goal));
    } catch (err) {
      failGoal(res, err);
    }
  },
);

goalsRouter.patch(
  "/goals/:gid",
  validateParams(goalParamsSchema),
  validateBody(patchSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof patchSchema>;
    try {
      const goal = await updateGoal(cid, req.params.gid, body);
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "goal.update",
        targetType: "goal",
        targetId: goal.id,
        targetLabel: goal.title,
        metadata: { fields: Object.keys(body) },
      });
      res.json(serializeGoal(goal));
    } catch (err) {
      failGoal(res, err);
    }
  },
);

goalsRouter.delete("/goals/:gid", validateParams(goalParamsSchema), async (req, res) => {
  const cid = req.params.cid;
  try {
    const goal = await deleteGoal(cid, req.params.gid);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "goal.delete",
      targetType: "goal",
      targetId: goal.id,
      targetLabel: goal.title,
    });
    res.json({ ok: true });
  } catch (err) {
    failGoal(res, err);
  }
});

goalsRouter.post(
  "/goals/:gid/progress",
  validateParams(goalParamsSchema),
  validateBody(progressSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof progressSchema>;
    try {
      const goal = await reportGoalProgress(cid, req.params.gid, body.value);
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "goal.progress",
        targetType: "goal",
        targetId: goal.id,
        targetLabel: goal.title,
        metadata: { value: body.value },
      });
      res.json(serializeGoal(goal));
    } catch (err) {
      failGoal(res, err);
    }
  },
);

goalsRouter.post("/goals/:gid/refresh", validateParams(goalParamsSchema), async (req, res) => {
  const cid = req.params.cid;
  try {
    const goal = await getGoal(cid, req.params.gid);
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    const refreshed = await refreshGoalValue(goal);
    res.json(serializeGoal(refreshed));
  } catch (err) {
    failGoal(res, err);
  }
});
