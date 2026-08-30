import { Router } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  MAX_CHECKS_PER_ROUTINE,
  MAX_CHECK_NAME_LENGTH,
  MAX_CHECK_TIMEOUT_SEC,
  MIN_CHECK_TIMEOUT_SEC,
  RoutineCheckError,
  commandChecksAvailable,
  createCheck,
  deleteCheck,
  getCheck,
  listChecks,
  parseEffectSpec,
  reorderChecks,
  resolveCheckRoutine,
  serializeCheck,
  serializeCheckResult,
  updateCheck,
} from "../services/routineChecks.js";
import { RUN_EFFECT_ROW_CAP, countEffects, runEffects } from "../services/runEffects.js";

/**
 * **Checks** on a Routine, and the evidence one Run produced.
 *
 * A separate router rather than more handlers in `routes/routines.ts` because
 * the two halves answer different questions: that file is CRUD over the work
 * an employee is asked to do, and this one is the bar that work has to clear
 * plus the record of whether it did.
 *
 * Reads are member-level, mutations are admin-gated — the same split every
 * Routine surface uses, and here it carries the load-bearing rule from
 * `services/routineChecks.ts`: **the graded party cannot author the bar.**
 * There is no MCP tool that creates, edits, deletes or reorders a Check, so
 * this router is the only way one changes, and it demands a human admin
 * session. The employee is shown its Routine's Checks in the brief; reading
 * the bar is not authoring it.
 */
export const routineChecksRouter = Router({ mergeParams: true });
routineChecksRouter.use(requireAuth);
routineChecksRouter.use(requireCompanyMember);
routineChecksRouter.use(onRoutePaths(["/routines"], requireCompanyRoleForMutations("admin")));

const routineParamsSchema = z.object({ cid: z.string().uuid(), rid: z.string().uuid() }).strict();
const checkParamsSchema = z
  .object({ cid: z.string().uuid(), rid: z.string().uuid(), checkId: z.string().uuid() })
  .strict();
const runParamsSchema = z.object({ cid: z.string().uuid(), runId: z.string().uuid() }).strict();

function fail(res: import("express").Response, err: unknown): void {
  if (err instanceof RoutineCheckError) {
    res.status(400).json({ error: err.message });
    return;
  }
  throw err;
}

/**
 * The company hop, as a 404 rather than a 400.
 *
 * `resolveCheckRoutine` refuses an unknown *and* a foreign Routine with the
 * same `RoutineCheckError`, which is exactly right for the service — a caller
 * outside this company must not be able to tell the two apart. At the HTTP
 * boundary that one error means "no such Routine here", which is a 404; every
 * other `RoutineCheckError` is the Member getting the Check itself wrong,
 * which is a 400.
 */
async function loadRoutine(companyId: string, routineId: string): Promise<Routine | null> {
  try {
    return await resolveCheckRoutine(companyId, routineId);
  } catch (err) {
    if (err instanceof RoutineCheckError) return null;
    throw err;
  }
}

/** A Run, scoped through its Routine's employee the same way. */
async function loadRun(companyId: string, runId: string): Promise<Run | null> {
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: runId });
  if (!run) return null;
  return (await loadRoutine(companyId, run.routineId)) ? run : null;
}

/* --------------------------------------------------------------- the bar */

routineChecksRouter.get(
  "/routines/:rid/checks",
  validateParams(routineParamsSchema),
  async (req, res) => {
    const routine = await loadRoutine(req.params.cid, req.params.rid);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const checks = await listChecks(routine.id, req.params.cid);
    // `commandChecks` travels with the list so the editor can grey out the
    // kind it cannot offer and say why, instead of accepting a Check that
    // `createCheck` will refuse a moment later.
    res.json({
      checks: checks.map(serializeCheck),
      commandChecks: commandChecksAvailable(),
      max: MAX_CHECKS_PER_ROUTINE,
    });
  },
);

/**
 * An `effect` spec is stored as JSON text, so its shape is checked here with
 * the very reader the runner will later use — same schema, same refusals, no
 * drift — and the issue lands on `spec` rather than arriving as a sentence
 * about a field the form cannot highlight. `createCheck` re-validates anyway:
 * it has callers other than this route, and the boundary is a convenience for
 * the client, never the authority.
 */
function checkEffectSpec(kind: string | undefined, spec: string | undefined, ctx: z.RefinementCtx) {
  if (kind !== "effect" || spec === undefined) return;
  try {
    parseEffectSpec(spec);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["spec"],
      message: err instanceof Error ? err.message : "This check's definition could not be read.",
    });
  }
}

const timeoutSchema = z.number().int().min(MIN_CHECK_TIMEOUT_SEC).max(MAX_CHECK_TIMEOUT_SEC);

const createCheckSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CHECK_NAME_LENGTH),
    kind: z.enum(["command", "effect"]),
    spec: z.string().min(1),
    required: z.boolean().optional(),
    enabled: z.boolean().optional(),
    timeoutSec: timeoutSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => checkEffectSpec(value.kind, value.spec, ctx));

routineChecksRouter.post(
  "/routines/:rid/checks",
  validateParams(routineParamsSchema),
  validateBody(createCheckSchema),
  async (req, res) => {
    const routine = await loadRoutine(req.params.cid, req.params.rid);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const body = req.body as z.infer<typeof createCheckSchema>;
    try {
      const check = await createCheck({
        companyId: req.params.cid,
        routineId: routine.id,
        name: body.name,
        kind: body.kind,
        spec: body.spec,
        required: body.required,
        enabled: body.enabled,
        timeoutSec: body.timeoutSec,
        createdById: req.user!.id,
      });
      await recordAudit({
        companyId: req.params.cid,
        actorUserId: req.userId ?? null,
        action: "routine_check.create",
        targetType: "routine_check",
        targetId: check.id,
        targetLabel: check.name,
        metadata: { routineId: routine.id, kind: check.kind, required: check.required },
      });
      res.json(serializeCheck(check));
    } catch (err) {
      fail(res, err);
    }
  },
);

const patchCheckSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CHECK_NAME_LENGTH).optional(),
    kind: z.enum(["command", "effect"]).optional(),
    spec: z.string().min(1).optional(),
    required: z.boolean().optional(),
    enabled: z.boolean().optional(),
    timeoutSec: timeoutSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => checkEffectSpec(value.kind, value.spec, ctx));

routineChecksRouter.patch(
  "/routines/:rid/checks/:checkId",
  validateParams(checkParamsSchema),
  validateBody(patchCheckSchema),
  async (req, res) => {
    const routine = await loadRoutine(req.params.cid, req.params.rid);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const existing = await getCheck(req.params.cid, req.params.checkId);
    if (!existing || existing.routineId !== routine.id) {
      return res.status(404).json({ error: "Check not found" });
    }
    const body = req.body as z.infer<typeof patchCheckSchema>;
    try {
      const check = await updateCheck(existing, body);
      await recordAudit({
        companyId: req.params.cid,
        actorUserId: req.userId ?? null,
        action: "routine_check.update",
        targetType: "routine_check",
        targetId: check.id,
        targetLabel: check.name,
        metadata: { routineId: routine.id, changed: Object.keys(body) },
      });
      res.json(serializeCheck(check));
    } catch (err) {
      fail(res, err);
    }
  },
);

routineChecksRouter.delete(
  "/routines/:rid/checks/:checkId",
  validateParams(checkParamsSchema),
  async (req, res) => {
    const routine = await loadRoutine(req.params.cid, req.params.rid);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const existing = await getCheck(req.params.cid, req.params.checkId);
    if (!existing || existing.routineId !== routine.id) {
      return res.status(404).json({ error: "Check not found" });
    }
    await deleteCheck(existing);
    await recordAudit({
      companyId: req.params.cid,
      actorUserId: req.userId ?? null,
      action: "routine_check.delete",
      targetType: "routine_check",
      targetId: existing.id,
      targetLabel: existing.name,
      metadata: { routineId: routine.id, kind: existing.kind },
    });
    res.json({ ok: true });
  },
);

const reorderSchema = z
  .object({ orderedIds: z.array(z.string().uuid()).max(MAX_CHECKS_PER_ROUTINE) })
  .strict();

routineChecksRouter.post(
  "/routines/:rid/checks/reorder",
  validateParams(routineParamsSchema),
  validateBody(reorderSchema),
  async (req, res) => {
    const routine = await loadRoutine(req.params.cid, req.params.rid);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const body = req.body as z.infer<typeof reorderSchema>;
    try {
      await reorderChecks(routine.id, body.orderedIds);
      await recordAudit({
        companyId: req.params.cid,
        actorUserId: req.userId ?? null,
        action: "routine_check.reorder",
        targetType: "routine",
        targetId: routine.id,
        targetLabel: routine.name,
        metadata: { orderedIds: body.orderedIds },
      });
      const checks = await listChecks(routine.id, req.params.cid);
      res.json({ checks: checks.map(serializeCheck) });
    } catch (err) {
      fail(res, err);
    }
  },
);

/* ---------------------------------------------------------- the evidence */

/**
 * Every check result this Run recorded, oldest attempt first.
 *
 * Deliberately the whole history rather than only the newest attempt: a Run
 * that failed a check, was told about it, and passed on the retry is a
 * different story from one that passed first time, and collapsing the two
 * would hide the remediation loop that M58 exists to make visible.
 */
routineChecksRouter.get(
  "/routines/runs/:runId/checks",
  validateParams(runParamsSchema),
  async (req, res) => {
    const run = await loadRun(req.params.cid, req.params.runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const results = await AppDataSource.getRepository(RunCheckResult).find({
      where: { runId: run.id, companyId: req.params.cid },
      order: { attempt: "ASC", createdAt: "ASC" },
    });
    res.json({ results: results.map(serializeCheckResult) });
  },
);

const effectsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(RUN_EFFECT_ROW_CAP).default(RUN_EFFECT_ROW_CAP),
  })
  .strict();

/**
 * What one Run actually changed, from the server's own ledger.
 *
 * **Not behind `requireCompanyFeature("auditLog")`, and that asymmetry is
 * deliberate.** Browsing the company's whole history is the paid feature
 * (M56): it is an investigation tool, it spans every Run and every Member, and
 * charging for it is a defensible product line. Reading what *one* Run did is
 * a different thing entirely — it is the only account of that Run the model
 * did not write, and the milestone's whole argument is that a Run's outcome
 * means nothing without it. A Community install that can see "completed" but
 * not "and here is what it changed" is back in the position M58 exists to end,
 * so putting this evidence behind a plan would sell the fix for the problem
 * while shipping the problem.
 */
routineChecksRouter.get(
  "/routines/runs/:runId/effects",
  validateParams(runParamsSchema),
  validateQuery(effectsQuerySchema),
  async (req, res) => {
    const run = await loadRun(req.params.cid, req.params.runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const { limit } = req.query as unknown as z.infer<typeof effectsQuerySchema>;
    const [effects, total] = await Promise.all([
      runEffects(run.id, { companyId: req.params.cid, limit }),
      countEffects(run.id),
    ]);
    res.json({
      effects: effects.map((e) => ({
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        targetLabel: e.targetLabel,
        at: e.at.toISOString(),
      })),
      total,
    });
  },
);
