import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { listApprovalInbox, proactiveWorkRunId } from "../services/approvalInbox.js";
import {
  proactiveWorkOutcomeSummary,
  proactiveWorkReviewDetails,
  reconcileProactiveWorkApprovals,
} from "../services/proactive/approvals.js";
import {
  mailReviewDetails,
  mailReviewAttachment,
  mailReviewDeliveryStatus,
  mailReviewOutcome,
  reconcileMailReviewApprovals,
  updateMailReviewApproval,
} from "../services/mail/reviewApprovals.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import {
  approvePendingApproval,
  isVaultCaptureApproval,
  readBrowserActionPayload,
  redactApprovalSummary,
  rejectPendingApproval,
} from "../services/approvals.js";

/**
 * Human-in-the-loop inbox. Approval decisions are browser-session-only,
 * admin-level actions. The service layer owns the atomic pending-to-terminal
 * transition so duplicate requests never replay a side effect.
 */
export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(requireAuth);
approvalsRouter.use(requireCompanyMember);

const approvalDecisionGuards = [requireBrowserSession, requireCompanyRole("admin")];
const approvalReviewReadGuards = [requireBrowserSession, requireCompanyRole("admin")];

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
    ...(approval.kind === "proactive_work"
      ? {
          review: proactiveWorkReviewDetails(approval),
          outcomeSummary: proactiveWorkOutcomeSummary(approval),
          outcomeRunId: proactiveWorkRunId(approval),
        }
      : approval.kind === "mail_send"
        ? {
            review: mailReviewDetails(approval),
            mailOutcome: mailReviewOutcome(approval),
            mailDeliveryStatus: mailReviewDeliveryStatus(approval),
          }
        : {}),
    errorMessage: approval.errorMessage
      ? approval.kind === "proactive_work"
        ? "The approved work could not finish. Review its reported outcome and any linked Run before requesting another attempt. It will not restart automatically."
        : approval.kind === "mail_send"
          ? mailReviewDeliveryStatus(approval) === "not_sent"
            ? "The reviewed email was not sent. Its source, access, attachment, recipients, or Policy changed before delivery. Review the source before preparing another email."
            : "Genosyn could not confirm whether the reviewed email completed. It was not retried. Check the source before preparing another email."
          : "The approved action failed. Review the server logs for details."
      : null,
    status: approval.status,
    requestedAt: approval.requestedAt,
    decidedAt: approval.decidedAt,
    decidedByUserId: approval.decidedByUserId,
  };
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

/**
 * These kinds need their replay payload or result to build the safe response.
 * Browser actions are included only for the Vault-capture visibility check.
 * Hydrate them serially at the list boundary; never retain a stack of raw
 * attachment snapshots while shaping the response.
 */
function inboxRowNeedsHydration(approval: Approval): boolean {
  return (
    approval.kind === "proactive_work" ||
    approval.kind === "mail_send" ||
    approval.kind === "browser_action"
  );
}

const approvalListQuerySchema = z
  .object({
    kind: z.enum(["proactive_work", "mail_send", "decision_stack", "other"]).optional(),
  })
  .strict();

const approvalParamsSchema = z
  .object({
    cid: z.string().uuid(),
    id: z.string().uuid(),
  })
  .strict();

approvalsRouter.get(
  "/approvals",
  requireBrowserSession,
  requireCompanyRole("admin"),
  validateQuery(approvalListQuerySchema),
  async (req, res) => {
    const { cid } = req.params as Record<string, string>;
    await Promise.all([reconcileProactiveWorkApprovals(cid), reconcileMailReviewApprovals(cid)]);
    const { kind } = req.query as z.infer<typeof approvalListQuerySchema>;
    const approvals = await listApprovalInbox(cid, kind);

    const routineIds = [...new Set(approvals.filter((a) => a.routineId).map((a) => a.routineId))];
    const employeeIds = [...new Set(approvals.map((a) => a.employeeId).filter(Boolean))];
    const routines = routineIds.length
      ? await AppDataSource.getRepository(Routine).find({ where: { id: In(routineIds) } })
      : [];
    const employees = employeeIds.length
      ? await AppDataSource.getRepository(AIEmployee).find({ where: { id: In(employeeIds) } })
      : [];
    const routineById = new Map(routines.map((routine) => [routine.id, routine]));
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));

    const response: Array<Record<string, unknown>> = [];
    for (const listed of approvals) {
      const approval = inboxRowNeedsHydration(listed) ? await loadApproval(cid, listed.id) : listed;
      // A row may be deleted between the lightweight list and this hydration.
      if (!approval) continue;
      if (
        isVaultCaptureApproval(approval) &&
        req.companyRole !== "owner" &&
        req.companyRole !== "admin"
      ) {
        continue;
      }
      const routine = approval.routineId ? (routineById.get(approval.routineId) ?? null) : null;
      const employee = approval.employeeId ? (employeeById.get(approval.employeeId) ?? null) : null;
      response.push({
        ...approvalResponse(approval),
        routine: routine ? { id: routine.id, name: routine.name, slug: routine.slug } : null,
        employee: employee ? { id: employee.id, name: employee.name, slug: employee.slug } : null,
      });
    }
    res.json(response);
  },
);

/**
 * Resolve one Decision-stack review by its durable link. The combined inbox
 * intentionally bounds history, but a discussion link must keep working after
 * that review falls beyond the newest page.
 */
approvalsRouter.get(
  "/approvals/:id",
  ...approvalReviewReadGuards,
  validateParams(approvalParamsSchema),
  async (req, res) => {
    const { cid, id } = req.params as z.infer<typeof approvalParamsSchema>;
    await Promise.all([reconcileProactiveWorkApprovals(cid), reconcileMailReviewApprovals(cid)]);
    const approval = await loadApproval(cid, id);
    if (!approval || (approval.kind !== "proactive_work" && approval.kind !== "mail_send")) {
      return res.status(404).json({ error: "Decision-stack review not found" });
    }
    const [routine, employee] = await Promise.all([
      approval.routineId
        ? AppDataSource.getRepository(Routine).findOneBy({
            id: approval.routineId,
            employeeId: approval.employeeId,
          })
        : null,
      approval.employeeId
        ? AppDataSource.getRepository(AIEmployee).findOneBy({
            id: approval.employeeId,
            companyId: cid,
          })
        : null,
    ]);
    return res.json({
      ...approvalResponse(approval),
      routine: routine ? { id: routine.id, name: routine.name, slug: routine.slug } : null,
      employee: employee ? { id: employee.id, name: employee.name, slug: employee.slug } : null,
    });
  },
);

const editMailReviewSchema = z
  .object({
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    to: z.string().max(2_000).optional(),
    cc: z.string().max(2_000).optional(),
    bcc: z.string().max(2_000).optional(),
    subject: z.string().trim().min(1).max(1_000).optional(),
    bodyText: z.string().trim().min(1).max(200_000).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.to !== undefined ||
      body.cc !== undefined ||
      body.bcc !== undefined ||
      body.subject !== undefined ||
      body.bodyText !== undefined,
    { message: "Change at least one email field." },
  );

const approvalActionSchema = z
  .object({
    reviewRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .default({});

function expectedReviewPayload(
  approval: Approval,
  reviewRevision: string | undefined,
): string | undefined | null {
  const review =
    approval.kind === "mail_send"
      ? mailReviewDetails(approval)
      : approval.kind === "proactive_work"
        ? proactiveWorkReviewDetails(approval)
        : null;
  if (!review) return undefined;
  return reviewRevision === review.revision ? (approval.payloadJson ?? "") : null;
}

approvalsRouter.patch(
  "/approvals/:id/mail-review",
  ...approvalDecisionGuards,
  validateParams(approvalParamsSchema),
  validateBody(editMailReviewSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    try {
      const approval = await updateMailReviewApproval({
        companyId: cid,
        approvalId: id,
        userId: req.userId!,
        ...(req.body as z.infer<typeof editMailReviewSchema>),
      });
      if (!approval) {
        const existing = await loadApproval(cid, id);
        if (!existing || existing.kind !== "mail_send") {
          return res.status(404).json({ error: "Email review not found" });
        }
        if (existing.status === "pending") {
          return res.status(409).json({
            error:
              "This email changed while you were editing it. Refresh and review the latest copy.",
          });
        }
        return res.status(409).json({ error: `Email review is already ${existing.status}` });
      }
      return res.json(approvalResponse(approval));
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Could not update the email review",
      });
    }
  },
);

const mailReviewAttachmentParamsSchema = z
  .object({
    cid: z.string().uuid(),
    id: z.string().uuid(),
    index: z.coerce.number().int().min(0).max(9),
  })
  .strict();

approvalsRouter.get(
  "/approvals/:id/mail-review/attachments/:index",
  ...approvalReviewReadGuards,
  validateParams(mailReviewAttachmentParamsSchema),
  async (req, res) => {
    const { cid, id, index } = req.params as unknown as z.infer<
      typeof mailReviewAttachmentParamsSchema
    >;
    const approval = await loadApproval(cid, id);
    if (!approval || approval.kind !== "mail_send") {
      return res.status(404).json({ error: "Email review not found" });
    }
    try {
      const attachment = mailReviewAttachment(approval, index);
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.attachment(attachment.filename);
      res.type(attachment.contentType);
      return res.send(attachment.content);
    } catch (error) {
      return res.status(409).json({
        error: error instanceof Error ? error.message : "Could not read the attachment",
      });
    }
  },
);

approvalsRouter.post(
  "/approvals/:id/approve",
  ...approvalDecisionGuards,
  validateParams(approvalParamsSchema),
  validateBody(approvalActionSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const approval = await loadApproval(cid, id);
    if (!approval) return res.status(404).json({ error: "Not found" });
    const expectedPayloadJson = expectedReviewPayload(
      approval,
      (req.body as z.infer<typeof approvalActionSchema>).reviewRevision,
    );
    if (expectedPayloadJson === null) {
      return res.status(409).json({
        error: "This review changed. Refresh and read the latest version before approving it.",
      });
    }
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
      expectedPayloadJson,
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
  },
);

approvalsRouter.post(
  "/approvals/:id/reject",
  ...approvalDecisionGuards,
  validateParams(approvalParamsSchema),
  validateBody(approvalActionSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const approval = await loadApproval(cid, id);
    if (!approval) return res.status(404).json({ error: "Not found" });
    const expectedPayloadJson = expectedReviewPayload(
      approval,
      (req.body as z.infer<typeof approvalActionSchema>).reviewRevision,
    );
    if (expectedPayloadJson === null) {
      return res.status(409).json({
        error: "This review changed. Refresh and read the latest version before discarding it.",
      });
    }
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
      expectedPayloadJson,
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
  },
);
