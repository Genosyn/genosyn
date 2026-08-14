import { Router } from "express";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
  requireRecentAuthentication,
} from "../middleware/auth.js";
import {
  approvePendingApproval,
  redactApprovalSummary,
  rejectPendingApproval,
} from "../services/approvals.js";

/**
 * Human-in-the-loop inbox. Two kinds today:
 *
 *   * `routine` — cron tick for a routine marked `requiresApproval`
 *   * `lightning_payment` — Lightning payment over the Connection's
 *                            `requireApprovalAboveSats` threshold
 *
 * Approve dispatches to the right execute path in `services/approvals.ts`;
 * reject only stamps the row + writes a journal entry.
 */
export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(requireAuth);
approvalsRouter.use(requireCompanyMember);

// A privileged human decision, not a generic company write: a leaked API key
// must not be enough to release a payment or guarded external action.
const approvalDecisionGuards = [
  requireBrowserSession,
  requireCompanyRole("admin"),
  requireRecentAuthentication({ requireSecondFactor: true }),
];

/**
 * Provider replay arguments and results can contain third-party credentials or
 * private data. They never belong in an HTTP response; raw provider failures
 * stay server-side as well.
 */
function approvalResponse(approval: Approval) {
  return {
    id: approval.id,
    companyId: approval.companyId,
    kind: approval.kind,
    routineId: approval.routineId,
    employeeId: approval.employeeId,
    // Legacy rows may predate creation-time sanitization.
    title: redactApprovalSummary(approval.title),
    summary: redactApprovalSummary(approval.summary),
    errorMessage: approval.errorMessage
      ? "The approved action failed. Review the server logs for details."
      : null,
    status: approval.status,
    requestedAt: approval.requestedAt,
    decidedAt: approval.decidedAt,
    decidedByUserId: approval.decidedByUserId,
  };
}

approvalsRouter.get(
  "/approvals",
  requireBrowserSession,
  requireCompanyRole("admin"),
  async (req, res) => {
    const { cid } = req.params as Record<string, string>;
    const approvals = await AppDataSource.getRepository(Approval).find({
      where: { companyId: cid },
      order: { requestedAt: "DESC" },
      take: 200,
    });

    // Routine kind needs the routine name; both kinds need the employee
    // name. Hydrate in two batched queries so the inbox renders without
    // an N+1 round-trip.
    const routineIds = [
      ...new Set(
        approvals.filter((a) => a.kind === "routine" && a.routineId).map((a) => a.routineId),
      ),
    ];
    const empIds = [...new Set(approvals.map((a) => a.employeeId).filter(Boolean))];
    const routines = routineIds.length
      ? await AppDataSource.getRepository(Routine).find({
          where: { id: In(routineIds) },
        })
      : [];
    const emps = empIds.length
      ? await AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds) },
        })
      : [];
    const rById = new Map(routines.map((r) => [r.id, r]));
    const eById = new Map(emps.map((e) => [e.id, e]));

    res.json(
      approvals.map((a) => {
        const r = a.routineId ? (rById.get(a.routineId) ?? null) : null;
        const e = a.employeeId ? (eById.get(a.employeeId) ?? null) : null;
        return {
          ...approvalResponse(a),
          routine: r ? { id: r.id, name: r.name, slug: r.slug } : null,
          employee: e ? { id: e.id, name: e.name, slug: e.slug } : null,
        };
      }),
    );
  },
);

approvalsRouter.post("/approvals/:id/approve", ...approvalDecisionGuards, async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  const result = await approvePendingApproval({
    companyId: cid,
    approvalId: id,
    userId: req.userId!,
  });
  if (result.outcome === "not_found") return res.status(404).json({ error: "Not found" });
  if (result.outcome === "conflict") {
    return res.status(409).json({ error: `Approval already ${result.approval.status}` });
  }
  res.json({
    ...approvalResponse(result.approval),
    executeError: result.sideEffectError
      ? "The approved action failed. Review the server logs for details."
      : undefined,
  });
});

approvalsRouter.post("/approvals/:id/reject", ...approvalDecisionGuards, async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  const result = await rejectPendingApproval({
    companyId: cid,
    approvalId: id,
    userId: req.userId!,
  });
  if (result.outcome === "not_found") return res.status(404).json({ error: "Not found" });
  if (result.outcome === "conflict") {
    return res.status(409).json({ error: `Approval already ${result.approval.status}` });
  }
  res.json({
    ...approvalResponse(result.approval),
    recordError: result.sideEffectError
      ? "The rejection was recorded, but its journal entry could not be written."
      : undefined,
  });
});
