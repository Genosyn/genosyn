import { Router } from "express";
import { z } from "zod";

import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  StanddownError,
  activeStanddownFor,
  getStanddown,
  liftStanddown,
  listStanddowns,
  placeStanddown,
  serializeStanddown,
} from "../services/standdowns.js";

/**
 * The stop button's HTTP surface (M58) — place a **Standdown**, lift it, and
 * read the one that is currently in force.
 *
 * Reads are member-level: everybody in the company is entitled to know that
 * the AI work they depend on has stopped and why, and the banner that says so
 * renders for every Member. Placing and lifting are admin-gated, the same bar
 * as editing a Routine, because both directions change what the whole roster
 * is allowed to do.
 *
 * ## There is deliberately no MCP tool here, in either direction
 *
 * Every other surface in this codebase that a human can drive eventually grows
 * a governed tool so an AI Employee can drive it too. This one must not, and
 * the two directions fail differently:
 *
 *  - **Placing** — an employee that can stand itself down can take the company
 *    offline as a plausible-sounding response to almost anything, and the
 *    breaker already covers the case where an employee's own failures should
 *    stop it. There is no work an employee needs to do that requires stopping
 *    the roster.
 *  - **Lifting** — this is the one that actually matters. A Standdown is the
 *    instrument a human reaches for when they no longer trust what the AI is
 *    doing. If the thing being stopped can un-stop itself, the instrument is
 *    decorative. Resuming work is a human decision, made by a human, recorded
 *    against a human's id.
 *
 * `services/standdowns.ts` states the same rule at the service layer and
 * `Standdown`'s entity JSDoc states it at the data layer. It is written down
 * three times on purpose: a tool added here would look like an oversight being
 * corrected rather than a boundary being crossed.
 */
export const standdownsRouter = Router({ mergeParams: true });
standdownsRouter.use(requireAuth);
standdownsRouter.use(requireCompanyMember);
standdownsRouter.use(onRoutePaths(["/standdowns"], requireCompanyRoleForMutations("admin")));

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const standdownParamsSchema = z.object({ cid: z.string().uuid(), id: z.string().uuid() }).strict();

/** A stop nobody explained is a stop nobody can safely lift. Mirrors the service. */
const REASON_MAX = 2_000;

function fail(res: import("express").Response, err: unknown): void {
  if (err instanceof StanddownError) {
    res.status(400).json({ error: err.message });
    return;
  }
  throw err;
}

/**
 * `?active=true` narrows to what is in force; omitting it returns the history.
 *
 * Spelled as a two-value enum rather than `z.coerce.boolean()` because
 * coercion reads `"false"` as a non-empty string and therefore as `true` —
 * which on this endpoint would silently answer the opposite question.
 */
const listQuerySchema = z
  .object({
    active: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  })
  .strict();

standdownsRouter.get(
  "/standdowns",
  validateParams(companyParamsSchema),
  validateQuery(listQuerySchema),
  async (req, res) => {
    const { active } = req.query as unknown as z.infer<typeof listQuerySchema>;
    const rows = await listStanddowns(req.params.cid, { active });
    res.json({ standdowns: rows.map(serializeStanddown) });
  },
);

/**
 * The banner's query: is anything stopping *this* work right now.
 *
 * Answered from the enforcement cache rather than the table, so what the
 * banner shows and what the dispatch loop enforces cannot disagree — a banner
 * that reads a row the predicate has not yet indexed would tell a Member work
 * is stopped while it is still running, or the reverse.
 */
const activeQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    routineId: z.string().uuid().optional(),
  })
  .strict();

standdownsRouter.get(
  "/standdowns/active",
  validateParams(companyParamsSchema),
  validateQuery(activeQuerySchema),
  (req, res) => {
    const { employeeId, routineId } = req.query as unknown as z.infer<typeof activeQuerySchema>;
    const standdown = activeStanddownFor(req.params.cid, { employeeId, routineId });
    res.json({ standdown: standdown ? serializeStanddown(standdown) : null });
  },
);

/**
 * A `company` standdown covers everything and names nothing; the narrower two
 * are meaningless without a target. Refused here rather than only in the
 * service so the form gets an issue on the field that is wrong.
 */
const placeSchema = z
  .object({
    scope: z.enum(["company", "employee", "routine"]),
    scopeId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(1).max(REASON_MAX),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasScopeId = value.scopeId !== undefined && value.scopeId !== null;
    if (value.scope === "company" && hasScopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "A company standdown covers everything and names nothing",
      });
    }
    if (value.scope !== "company" && !hasScopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: `A ${value.scope} standdown must name its target`,
      });
    }
  });

standdownsRouter.post(
  "/standdowns",
  validateParams(companyParamsSchema),
  validateBody(placeSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof placeSchema>;
    try {
      const standdown = await placeStanddown({
        companyId: req.params.cid,
        scope: body.scope,
        scopeId: body.scopeId ?? null,
        reason: body.reason,
        // Always `human` from this router. The `breaker` source is written by
        // the runner and by nothing else; letting a request claim it would put
        // a human's stop on record as an automatic one.
        source: "human",
        placedByUserId: req.user!.id,
      });
      res.json(serializeStanddown(standdown));
    } catch (err) {
      fail(res, err);
    }
  },
);

const liftSchema = z.object({ reason: z.string().max(REASON_MAX).optional() }).strict();

/**
 * Lifting is 404 for a standdown this company does not have and for one that
 * is already lifted, because from the caller's side those are the same fact:
 * there is no active standdown at that id to act on. The service's conditional
 * claim is what makes a genuine race safe — it records one lift, one audit row
 * and one journal entry — and this check is what stops a second deliberate
 * press from reading as success.
 */
standdownsRouter.post(
  "/standdowns/:id/lift",
  validateParams(standdownParamsSchema),
  validateBody(liftSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof liftSchema>;
    const standdown = await getStanddown(req.params.cid, req.params.id);
    if (!standdown || standdown.liftedAt) {
      return res.status(404).json({ error: "No active standdown with that id" });
    }
    try {
      const lifted = await liftStanddown({
        standdown,
        userId: req.user!.id,
        reason: body.reason,
      });
      res.json(serializeStanddown(lifted));
    } catch (err) {
      fail(res, err);
    }
  },
);
