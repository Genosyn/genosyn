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
  readBrowserActionPayload,
  redactApprovalSummary,
  rejectPendingApproval,
} from "../services/approvals.js";

/**
 * Human-in-the-loop inbox. Decisions are browser-session-only, admin-level,
 * recently authenticated actions. The service layer owns the atomic
 * pending-to-terminal transition so duplicate requests never replay a side
 * effect.
 */
export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(requireAuth);
approvalsRouter.use(requireCompanyMember);

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

function isVaultCaptureApproval(approval: Approval): boolean {
  if (approval.kind !== "browser_action") return false;
  try {
    const payload = JSON.parse(approval.payloadJson || "{}") as { action?: unknown };
    return payload.action === "vault_capture";
  } catch {
    return false;
  }
}

function vaultCaptureApprovalExpired(approval: Approval): boolean {
  if (!isVaultCaptureApproval(approval)) return false;
  try {
    const payload = readBrowserActionPayload(approval);
    return typeof payload.expiresAt !== "string" || Date.parse(payload.expiresAt) <= Date.now();
  } catch {
    return true;
  }
}

async function loadApproval(companyId: string, approvalId: string): Promise<Approval | null> {
  return AppDataSource.getRepository(Approval).findOneBy({
    id: approvalId,
    companyId,
  });
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

    const routineIds = [
      ...new Set(
        approvals.filter((a) => a.kind === "routine" && a.routineId).map((a) => a.routineId),
      ),
    ];
    const employeeIds = [...new Set(approvals.map((a) => a.employeeId).filter(Boolean))];
    const routines = routineIds.length
      ? await AppDataSource.getRepository(Routine).find({ where: { id: In(routineIds) } })
      : [];
    const employees = employeeIds.length
      ? await AppDataSource.getRepository(AIEmployee).find({ where: { id: In(employeeIds) } })
      : [];
    const routineById = new Map(routines.map((routine) => [routine.id, routine]));
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));

    res.json(
      approvals
        .filter(
          (approval) =>
            !isVaultCaptureApproval(approval) ||
            req.companyRole === "owner" ||
            req.companyRole === "admin",
        )
        .map((approval) => {
          const routine = approval.routineId
            ? (routineById.get(approval.routineId) ?? null)
            : null;
          const employee = approval.employeeId
            ? (employeeById.get(approval.employeeId) ?? null)
            : null;
          return {
            ...approvalResponse(approval),
            routine: routine
              ? { id: routine.id, name: routine.name, slug: routine.slug }
              : null,
            employee: employee
              ? { id: employee.id, name: employee.name, slug: employee.slug }
              : null,
          };
        }),
    );
  },
);

approvalsRouter.post("/approvals/:id/approve", ...approvalDecisionGuards, async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  const approval = await loadApproval(cid, id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  if (vaultCaptureApprovalExpired(approval)) {
    if (approval.status === "pending") {
      await AppDataSource.getRepository(Approval).update(
        { id: approval.id, companyId: cid, status: "pending" },
        { status: "expired" },
      );
    }
    return res.status(409).json({ error: "Vault capture approval expired" });
  }
  if (
    isVaultCaptureApproval(approval) &&
    req.companyRole !== "owner" &&
    req.companyRole !== "admin"
  ) {
    return res.status(403).json({
      error: "Only a company owner or admin can approve saving a browser password to Vault",
    });
  }

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
  const approval = await loadApproval(cid, id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  if (
    isVaultCaptureApproval(approval) &&
    req.companyRole !== "owner" &&
    req.companyRole !== "admin"
  ) {
    return res.status(403).json({
      error: "Only a company owner or admin can decide a Vault capture request",
    });
  }

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
