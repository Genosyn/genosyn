import { In, Like } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { Decision } from "../../db/entities/Decision.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import { columnHasLabel } from "./store.js";
import {
  isInboundReviewMessage,
  mailReviewEmployee,
  type MailReviewEmployee,
} from "./reviewStatus.js";

export type MailReviewEventKind =
  | "received"
  | "review_started"
  | "review_completed"
  | "review_failed"
  | "handover_queued"
  | "handover_started"
  | "handover_completed"
  | "handover_failed"
  | "decision"
  | "draft"
  | "sent"
  | "quote"
  | "approval"
  | "action";
export type MailReviewEvent = {
  id: string;
  kind: MailReviewEventKind;
  occurredAt: string;
  title: string;
  description: string | null;
  employee: MailReviewEmployee | null;
  href: string | null;
  status: "complete" | "running" | "pending" | "failed";
};
export type MailReviewTimeline = { events: MailReviewEvent[]; truncated: boolean };
const SOURCE_LIMIT = 500;
const EVENT_LIMIT = 250;

const AUDIT_ACTIONS: Record<
  string,
  { kind: MailReviewEventKind; title: string; finance?: boolean }
> = {
  "mail.handover.create": { kind: "handover_queued", title: "Assigned to an AI Employee" },
  "mail.handover.retry": { kind: "handover_queued", title: "AI review queued again" },
  "mail.handover.started": { kind: "handover_started", title: "AI Employee started reviewing" },
  "mail.handover.complete": {
    kind: "handover_completed",
    title: "AI Employee finished this review",
  },
  "mail.handover.fail": { kind: "handover_failed", title: "AI Employee could not finish" },
  "mail.analysis.started": { kind: "review_started", title: "AI review started" },
  "mail.analysis.completed": { kind: "review_completed", title: "Email reviewed" },
  "mail.analysis.failed": { kind: "review_failed", title: "AI review could not finish" },
  "finance.estimate.create": { kind: "quote", title: "Quote created", finance: true },
  "finance.estimate.update": { kind: "quote", title: "Quote updated", finance: true },
  "finance.estimate.issue": { kind: "quote", title: "Quote issued", finance: true },
  "finance.estimate.send": { kind: "quote", title: "Quote emailed", finance: true },
  "finance.invoice.create": { kind: "action", title: "Invoice created", finance: true },
  "mail.draft.create": { kind: "draft", title: "Email draft created" },
  "mail.draft.update": { kind: "draft", title: "Email draft updated" },
  "mail.draft.send": { kind: "sent", title: "Email sent" },
  "mail.send": { kind: "sent", title: "Email sent" },
  "mail.thread.update": { kind: "action", title: "Email filing updated" },
  "mail.thread.action": { kind: "action", title: "Email filing updated" },
  "mail.analysis.create_estimate": { kind: "quote", title: "Quote created", finance: true },
  "mail.analysis.create_invoice": { kind: "action", title: "Invoice created", finance: true },
  "mail.analysis.unsubscribe": { kind: "action", title: "Unsubscribed from sender" },
  "mail.analysis.thread_action": { kind: "action", title: "Email filing updated" },
  "note.create": { kind: "action", title: "Note created" },
  "note.update": { kind: "action", title: "Note updated" },
  "revenue.follow_up.create": { kind: "action", title: "Follow-up created" },
  "revenue.follow_up.update": { kind: "action", title: "Follow-up updated" },
  "workstream.create": { kind: "action", title: "Workstream created" },
  "workstream.update": { kind: "action", title: "Workstream updated" },
  "revenue.contact.create": { kind: "action", title: "Contact created" },
  "revenue.contact.update": { kind: "action", title: "Contact updated" },
  "revenue.deal.create": { kind: "action", title: "Deal created" },
  "revenue.deal.update": { kind: "action", title: "Deal updated" },
  "revenue.activity.create": { kind: "action", title: "Activity added" },
};

function jsonObject(value: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Bounded, company-scoped evidence. No model narration is converted to an action. */
export async function mailReviewTimeline(args: {
  account: MailAccount;
  thread: MailThread;
  messages: MailMessage[];
  analyses: MailInboundAnalysis[];
  handovers: MailHandover[];
  canReadFinance: boolean;
  canReviewApprovals: boolean;
}): Promise<MailReviewTimeline> {
  const { account, thread, canReadFinance, canReviewApprovals } = args;
  if (thread.accountId !== account.id || thread.companyId !== account.companyId)
    return { events: [], truncated: false };
  const companyId = account.companyId;
  const scoped = <T extends { companyId: string; accountId: string; threadId: string }>(
    rows: T[],
  ) =>
    rows.filter(
      (row) =>
        row.companyId === companyId && row.accountId === account.id && row.threadId === thread.id,
    );
  const messages = scoped(args.messages);
  const messageIds = new Set(messages.map((message) => message.id));
  const analyses = scoped(args.analyses).filter((analysis) => messageIds.has(analysis.messageId));
  const handovers = scoped(args.handovers);
  const handoverById = new Map(handovers.map((handover) => [handover.id, handover]));
  const [decisions, approvalRows, auditRows] = await Promise.all([
    AppDataSource.getRepository(Decision).find({
      where: { companyId, mailThreadId: thread.id },
      order: { createdAt: "DESC", id: "DESC" },
      take: SOURCE_LIMIT + 1,
    }),
    AppDataSource.getRepository(Approval).find({
      where: {
        companyId,
        kind: In(["mail_send", "proactive_work"]),
        payloadJson: Like(`%${thread.id}%`),
      },
      order: { requestedAt: "DESC", id: "DESC" },
      take: SOURCE_LIMIT + 1,
    }),
    AppDataSource.getRepository(AuditEvent).find({
      where: [
        {
          companyId,
          action: In(Object.keys(AUDIT_ACTIONS)),
          metadataJson: Like(`%${thread.id}%`),
        },
        ...(handovers.length
          ? [
              {
                companyId,
                action: In(
                  Object.keys(AUDIT_ACTIONS).filter((action) =>
                    action.startsWith("mail.handover."),
                  ),
                ),
                targetType: "mail_handover",
                targetId: In(handovers.map((handover) => handover.id)),
              },
            ]
          : []),
      ],
      order: { createdAt: "DESC", id: "DESC" },
      take: SOURCE_LIMIT + 1,
    }),
  ]);
  const audits = auditRows.slice(0, SOURCE_LIMIT).filter((row) => {
    const meta = jsonObject(row.metadataJson);
    if (row.action.startsWith("mail.handover.")) {
      const handover =
        row.targetType === "mail_handover" && row.targetId ? handoverById.get(row.targetId) : null;
      return !!handover && (!row.actorEmployeeId || row.actorEmployeeId === handover.employeeId);
    }
    if (meta?.mailThreadId !== thread.id) return false;
    if (
      ["mail.analysis.started", "mail.analysis.completed", "mail.analysis.failed"].includes(
        row.action,
      ) &&
      (row.targetType !== "mail_inbound_analysis" ||
        typeof meta.messageId !== "string" ||
        !messageIds.has(meta.messageId))
    )
      return false;
    if (meta.mailHandoverId != null) {
      const handover =
        typeof meta.mailHandoverId === "string" ? handoverById.get(meta.mailHandoverId) : null;
      if (!handover || (row.actorEmployeeId && handover.employeeId !== row.actorEmployeeId))
        return false;
    }
    // A bare string in unrelated metadata is never evidence of attribution.
    return !!row.actorEmployeeId || !!row.actorUserId;
  });
  const approvals = approvalRows.slice(0, SOURCE_LIMIT).filter((approval) => {
    const payload = jsonObject(approval.payloadJson);
    const origin =
      approval.kind === "proactive_work" && payload?.origin && typeof payload.origin === "object"
        ? (payload.origin as Record<string, unknown>)
        : payload;
    const originThread = approval.kind === "mail_send" ? origin?.threadId : origin?.mailThreadId;
    const originAccount = approval.kind === "mail_send" ? origin?.accountId : origin?.mailAccountId;
    if (originThread !== thread.id || (originAccount != null && originAccount !== account.id))
      return false;
    const handoverId = origin?.mailHandoverId;
    if (handoverId != null) {
      const handover = typeof handoverId === "string" ? handoverById.get(handoverId) : null;
      if (!handover || handover.employeeId !== approval.employeeId) return false;
    }
    return true;
  });
  const employeeIds = [
    ...new Set(
      [
        ...analyses.map((row) => row.employeeId),
        ...handovers.map((row) => row.employeeId),
        ...decisions.map((row) => row.employeeId),
        ...approvals.map((row) => row.employeeId),
        ...audits.map((row) => row.actorEmployeeId),
        ...messages.map((row) => row.createdByEmployeeId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const estimateIds = audits
    .filter((row) => row.targetType === "estimate" && row.targetId)
    .map((row) => row.targetId!);
  const invoiceIds = audits
    .filter((row) => row.targetType === "invoice" && row.targetId)
    .map((row) => row.targetId!);
  const [employeeRows, estimates, invoices] = await Promise.all([
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { companyId, id: In(employeeIds) },
          select: ["id", "companyId", "name", "slug", "avatarKey"],
        })
      : [],
    canReadFinance && estimateIds.length
      ? AppDataSource.getRepository(Estimate).find({
          where: { companyId, id: In(estimateIds) },
          select: ["id", "slug", "number"],
        })
      : [],
    canReadFinance && invoiceIds.length
      ? AppDataSource.getRepository(Invoice).find({
          where: { companyId, id: In(invoiceIds) },
          select: ["id", "slug", "number"],
        })
      : [],
  ]);
  const employees = new Map(
    employeeRows.map((employee) => [employee.id, mailReviewEmployee(employee)]),
  );
  const estimateById = new Map(estimates.map((estimate) => [estimate.id, estimate]));
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const reviewedSends = approvals
    .filter((approval) => approval.kind === "mail_send" && approval.status === "approved")
    .map((approval) => jsonObject(approval.resultJson));
  const events: MailReviewEvent[] = [];
  const add = (
    id: string,
    kind: MailReviewEventKind,
    at: Date,
    title: string,
    options: Partial<Pick<MailReviewEvent, "description" | "href" | "status">> & {
      employeeId?: string | null;
    } = {},
  ) => {
    events.push({
      id,
      kind,
      occurredAt: at.toISOString(),
      title,
      description: options.description ?? null,
      employee: options.employeeId ? (employees.get(options.employeeId) ?? null) : null,
      href: options.href ?? null,
      status: options.status ?? "complete",
    });
  };
  for (const message of messages) {
    if (isInboundReviewMessage(message, account)) {
      add(`received:${message.id}`, "received", message.createdAt, "Email received", {
        description: (message.fromName || message.fromEmail).slice(0, 200),
      });
    } else if (message.createdByEmployeeId) {
      const draft = !!message.gmailDraftId || columnHasLabel(message.labelIds, "DRAFT");
      const sent = columnHasLabel(message.labelIds, "SENT");
      const audited = audits.some(
        (row) =>
          row.targetId === message.id &&
          AUDIT_ACTIONS[row.action]?.kind === (draft ? "draft" : "sent"),
      );
      const reviewedSend =
        sent &&
        reviewedSends.some(
          (result) =>
            result?.sentMessageId === message.id ||
            (typeof result?.providerMessageRef === "string" &&
              result.providerMessageRef === message.gmailMessageId),
        );
      if (!audited && !reviewedSend && (draft || sent))
        add(
          `message:${message.id}:${draft ? "draft" : "sent"}`,
          draft ? "draft" : "sent",
          draft ? message.createdAt : (message.sentAt ?? message.createdAt),
          draft ? "Email draft created" : "Email sent",
          { employeeId: message.createdByEmployeeId },
        );
    }
  }
  for (const analysis of analyses) {
    const attempts = audits.filter(
      (audit) =>
        audit.targetId === analysis.id &&
        ["mail.analysis.started", "mail.analysis.completed", "mail.analysis.failed"].includes(
          audit.action,
        ),
    );
    const started = attempts.find((audit) => audit.action === "mail.analysis.started");
    if (!started || (analysis.status === "running" && started.createdAt < analysis.updatedAt))
      add(
        `analysis:${analysis.id}:started`,
        "review_started",
        analysis.status === "running" ? analysis.updatedAt : analysis.createdAt,
        "AI review started",
        {
          employeeId: analysis.employeeId,
          status: analysis.status === "running" ? "running" : "complete",
        },
      );
    if (
      analysis.status !== "running" &&
      analysis.finishedAt &&
      !attempts.some(
        (audit) =>
          audit.action !== "mail.analysis.started" && audit.createdAt >= analysis.finishedAt!,
      )
    )
      add(
        `analysis:${analysis.id}:finished`,
        analysis.status === "succeeded" ? "review_completed" : "review_failed",
        analysis.finishedAt,
        analysis.status === "succeeded" ? "Email reviewed" : "AI review could not finish",
        {
          employeeId: analysis.employeeId,
          description:
            analysis.status === "succeeded"
              ? "The email was reviewed. Suggested next steps are shown separately below."
              : "Review this email again to retry.",
          status: analysis.status === "succeeded" ? "complete" : "failed",
        },
      );
  }
  for (const handover of handovers) {
    const attempts = audits.filter(
      (audit) => audit.targetType === "mail_handover" && audit.targetId === handover.id,
    );
    if (!attempts.some((audit) => audit.action === "mail.handover.create"))
      add(
        `handover:${handover.id}:queued`,
        "handover_queued",
        handover.createdAt,
        "Assigned to an AI Employee",
        {
          employeeId: handover.employeeId,
          status: handover.status === "pending" ? "pending" : "complete",
        },
      );
    if (
      handover.startedAt &&
      !attempts.some(
        (audit) =>
          audit.action === "mail.handover.started" && audit.createdAt >= handover.startedAt!,
      )
    )
      add(
        `handover:${handover.id}:started`,
        "handover_started",
        handover.startedAt,
        "AI Employee started reviewing",
        {
          employeeId: handover.employeeId,
          status: handover.status === "running" ? "running" : "complete",
        },
      );
    if (
      handover.finishedAt &&
      (handover.status === "completed" || handover.status === "failed") &&
      !attempts.some(
        (audit) =>
          ["mail.handover.complete", "mail.handover.fail"].includes(audit.action) &&
          audit.createdAt >= handover.finishedAt!,
      )
    )
      add(
        `handover:${handover.id}:finished`,
        handover.status === "completed" ? "handover_completed" : "handover_failed",
        handover.finishedAt,
        handover.status === "completed"
          ? "AI Employee finished this review"
          : "AI Employee could not finish",
        {
          employeeId: handover.employeeId,
          description:
            handover.status === "completed"
              ? "Recorded actions appear in this timeline."
              : "Open the handover below to review the issue and retry.",
          status: handover.status === "completed" ? "complete" : "failed",
        },
      );
  }
  for (const decision of decisions.slice(0, SOURCE_LIMIT)) {
    add(
      `decision:${decision.id}:created`,
      "decision",
      decision.createdAt,
      "Decision added to the stack",
      {
        employeeId: decision.employeeId,
        description: redactSensitiveText(decision.title).slice(0, 240),
        href: `/decisions#decision-${decision.id}`,
        status: decision.status === "pending" ? "pending" : "complete",
      },
    );
    if (decision.decidedAt)
      add(
        `decision:${decision.id}:answered`,
        "decision",
        decision.decidedAt,
        decision.status === "decided" ? "Decision answered" : "Decision closed",
        { href: `/decisions#decision-${decision.id}` },
      );
  }
  for (const approval of approvals) {
    const email = approval.kind === "mail_send";
    const href = canReviewApprovals ? `/decisions#review-${approval.id}` : null;
    add(
      `approval:${approval.id}:requested`,
      email ? "draft" : "approval",
      approval.requestedAt,
      email ? "Reply prepared for review" : "Work submitted for approval",
      {
        employeeId: approval.employeeId,
        href,
        description: email
          ? "Saved in Genosyn's Decision stack for an owner or admin to review. Nothing was sent at this step."
          : "A concrete plan was added to the Decision stack for an owner or admin.",
        status: approval.status === "pending" ? "pending" : "complete",
      },
    );
    if (approval.decidedAt) {
      const failed = approval.status === "execution_failed";
      const rejected = approval.status === "rejected" || approval.status === "expired";
      if (!email) {
        // decidedAt is the human's approval/claim time. Work may finish much
        // later; its current outcome cannot be dated as though it happened then.
        add(
          `approval:${approval.id}:outcome`,
          "approval",
          approval.decidedAt,
          rejected ? "Work approval closed" : "Work approved",
          {
            href,
            employeeId: approval.employeeId,
            description: rejected
              ? null
              : failed
                ? "Current status: the approved work could not finish."
                : approval.status === "executing"
                  ? "Current status: the approved work is running."
                  : "Current status: the approved work has finished.",
            status: failed ? "failed" : approval.status === "executing" ? "running" : "complete",
          },
        );
        continue;
      }
      const outcome = jsonObject(approval.resultJson);
      const acceptedAt =
        approval.status === "approved" && typeof outcome?.sentAt === "string"
          ? new Date(outcome.sentAt)
          : null;
      // An approval's status records the privileged operation's outcome. A
      // proposal or an in-progress approval is never represented as a send.
      add(
        `approval:${approval.id}:outcome`,
        approval.status === "approved" ? "sent" : "approval",
        acceptedAt && !Number.isNaN(acceptedAt.getTime()) ? acceptedAt : approval.decidedAt,
        failed
          ? "Reply delivery failed"
          : rejected
            ? "Reply review closed"
            : approval.status === "executing"
              ? "Reply delivery started"
              : "Reviewed reply sent",
        {
          href,
          employeeId: approval.employeeId,
          status: failed ? "failed" : approval.status === "executing" ? "running" : "complete",
        },
      );
    }
  }
  for (const audit of audits) {
    const spec = AUDIT_ACTIONS[audit.action];
    if (audit.action.startsWith("mail.handover.")) {
      const handover = audit.targetId ? handoverById.get(audit.targetId) : null;
      const latestQueued = !audits.some(
        (row) =>
          row.targetId === audit.targetId &&
          row.action === "mail.handover.retry" &&
          row.createdAt > audit.createdAt,
      );
      add(`action:${audit.id}`, spec.kind, audit.createdAt, spec.title, {
        employeeId: handover?.employeeId,
        status:
          spec.kind === "handover_failed"
            ? "failed"
            : spec.kind === "handover_queued" && handover?.status === "pending" && latestQueued
              ? "pending"
              : spec.kind === "handover_started" &&
                  handover?.status === "running" &&
                  handover.startedAt &&
                  audit.createdAt >= handover.startedAt
                ? "running"
                : "complete",
      });
      continue;
    }
    if (["review_started", "review_completed", "review_failed"].includes(spec.kind)) {
      const analysis = analyses.find((row) => row.id === audit.targetId);
      add(`action:${audit.id}`, spec.kind, audit.createdAt, spec.title, {
        employeeId: audit.actorEmployeeId,
        status:
          spec.kind === "review_failed"
            ? "failed"
            : spec.kind === "review_started" &&
                analysis?.status === "running" &&
                audit.createdAt >= analysis.updatedAt
              ? "running"
              : "complete",
        description: spec.kind === "review_failed" ? "Review this email again to retry." : null,
      });
      continue;
    }
    const estimate = audit.targetId ? estimateById.get(audit.targetId) : null;
    const invoice = audit.targetId ? invoiceById.get(audit.targetId) : null;
    const metadata = jsonObject(audit.metadataJson);
    const generatedPath =
      typeof metadata?.resultPath === "string" &&
      /^\/finance\/(estimates|invoices)\/[a-z0-9-]+(?:\/edit)?$/.test(metadata.resultPath)
        ? metadata.resultPath
        : null;
    add(`action:${audit.id}`, spec.kind, audit.createdAt, spec.title, {
      employeeId: audit.actorEmployeeId,
      description:
        spec.finance && !canReadFinance
          ? "Details are available to Members with Finance access."
          : estimate?.number
            ? `Estimate ${estimate.number}`
            : invoice?.number
              ? `Invoice ${invoice.number}`
              : audit.actorUserId
                ? "Confirmed by a Member."
                : null,
      href:
        spec.finance && canReadFinance
          ? estimate
            ? `/finance/estimates/${encodeURIComponent(estimate.slug)}`
            : invoice
              ? `/finance/invoices/${encodeURIComponent(invoice.slug)}`
              : generatedPath
          : null,
    });
  }
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return {
    events: events.slice(-EVENT_LIMIT),
    truncated:
      events.length > EVENT_LIMIT ||
      decisions.length > SOURCE_LIMIT ||
      approvalRows.length > SOURCE_LIMIT ||
      auditRows.length > SOURCE_LIMIT,
  };
}
