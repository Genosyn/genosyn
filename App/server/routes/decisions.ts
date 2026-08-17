import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { kickoffDecision } from "../services/decisionKickoff.js";
import {
  cancelDecision,
  decideDecision,
  hydrateDecisions,
  listDecisions,
} from "../services/decisions.js";

/**
 * The Decision Stack — questions AI Employees raised for a human.
 *
 * Member-level on purpose, unlike the admin-gated Approvals inbox next door.
 * Answering a decision performs no side effect: it records which option a human
 * picked so the employee can read it and carry on. Anything privileged the
 * employee then does still passes its own gate. See `services/decisions.ts` for
 * the exactly-once claim and the assignee rule.
 */
export const decisionsRouter = Router({ mergeParams: true });
decisionsRouter.use(requireAuth);
decisionsRouter.use(requireCompanyMember);

const listQuerySchema = z
  .object({
    status: z.enum(["pending", "decided", "cancelled", "expired"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const idParamsSchema = z.object({ cid: z.string().min(1), id: z.string().uuid() }).strict();

const decideSchema = z
  .object({
    optionId: z.string().min(1).max(60),
    note: z.string().max(4_000).optional(),
  })
  .strict();

const dismissSchema = z.object({ reason: z.string().max(4_000).optional() }).strict();

decisionsRouter.get("/decisions", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
  }
  const decisions = await listDecisions({
    companyId: cid,
    status: parsed.data.status,
    limit: parsed.data.limit,
  });
  res.json(decisions);
});

decisionsRouter.post(
  "/decisions/:id/decide",
  validateParams(idParamsSchema),
  validateBody(decideSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof decideSchema>;
    const result = await decideDecision({
      companyId: cid,
      decisionId: id,
      userId: req.userId!,
      role: req.companyRole!,
      optionId: body.optionId,
      note: body.note ?? null,
    });
    switch (result.outcome) {
      case "not_found":
        return res.status(404).json({ error: "Not found" });
      case "forbidden":
        return res
          .status(403)
          .json({ error: "This decision was raised for a specific teammate to answer." });
      case "unknown_option":
        return res
          .status(400)
          .json({ error: "That option is not one this decision offers. Reload and try again." });
      case "conflict":
        return res.status(409).json({ error: `Decision is already ${result.decision.status}` });
      case "decided": {
        // Answering is the "go" signal — the employee asked because it was
        // blocked, so start the work session now instead of leaving the answer
        // to be noticed on its next routine tick. Fire-and-forget: the row
        // carries the progress, and every guard lives in the service.
        void kickoffDecision({
          companyId: cid,
          decisionId: result.decision.id,
          requesterUserId: req.userId!,
          requesterSessionVersion: req.session?.sessionVersion ?? null,
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[decisions] pickup failed", err);
        });
        const [dto] = await hydrateDecisions([result.decision]);
        return res.json(dto);
      }
    }
  },
);

decisionsRouter.post(
  "/decisions/:id/dismiss",
  validateParams(idParamsSchema),
  validateBody(dismissSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof dismissSchema>;
    const result = await cancelDecision({
      companyId: cid,
      decisionId: id,
      userId: req.userId!,
      reason: body.reason ?? null,
    });
    if (result.outcome === "not_found") return res.status(404).json({ error: "Not found" });
    if (result.outcome === "conflict") {
      return res.status(409).json({ error: `Decision is already ${result.decision.status}` });
    }
    const [dto] = await hydrateDecisions([result.decision]);
    res.json(dto);
  },
);
