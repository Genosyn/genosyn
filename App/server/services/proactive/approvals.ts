import crypto from "node:crypto";
import { In, IsNull, LessThan, Like } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { withSerializedTransaction } from "../../db/transactions.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { JournalEntry } from "../../db/entities/JournalEntry.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import type { MailHandoverMode } from "../../db/entities/MailHandover.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { User } from "../../db/entities/User.js";
import { CHAT_HARD_TIMEOUT_MS, chatWithEmployee } from "../chat.js";
import { redactApprovalSummary } from "../approvalRedaction.js";
import { recordAudit } from "../audit.js";
import { handoverDeliveryMode } from "../mail/handoverPrompt.js";
import { handoverGrantError } from "../mail/handovers.js";
import { CANONICAL_LABELS } from "../mail/mailbox/types.js";
import { columnHasLabel } from "../mail/store.js";
import { notifyApprovalPending } from "../notifications.js";
import { workBlocked } from "../standdowns.js";
import { runWorkSummary } from "../runWorkSummary.js";
import type { StartRunOptions } from "../runner.js";

const originSchema = z.object({
  routineId: z.string().nullish(),
  runId: z.string().nullish(),
  conversationId: z.string().nullish(),
  mailThreadId: z.string().nullish(),
  mailAccountId: z.string().nullish(),
  mailHandoverId: z.string().nullish(),
  mailDeliveryMode: z.enum(["draft", "reply", "triage", "review"]).nullish(),
  selfReviewOnly: z.boolean().optional(),
});

/** Supplied by the token, never from the model's tool arguments. */
export type ProactiveWorkOrigin = z.infer<typeof originSchema>;

const payloadSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  context: z.string().min(1).max(4_000),
  plan: z.string().min(1).max(8_000),
  origin: originSchema,
  sourceFingerprint: z.string().min(1),
  dedupeKey: z.string().min(1),
  /** Server-observed customer evidence for mail-backed work. Kept separate
   * from full thread freshness so our own SENT mirror cannot re-arm work. */
  inboundEvidenceFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type ProactiveWorkPayload = z.infer<typeof payloadSchema>;

export function parseProactiveWorkPayload(value: string | null): ProactiveWorkPayload {
  return payloadSchema.parse(JSON.parse(value || "null"));
}

/** Only the human-readable report from this kind may cross the Approval API. */
export function proactiveWorkOutcomeSummary(approval: Approval): string | null {
  if (approval.kind !== "proactive_work" || !approval.resultJson) return null;
  try {
    const result: unknown = JSON.parse(approval.resultJson);
    const summary =
      result && typeof result === "object" && "summary" in result ? result.summary : null;
    return typeof summary === "string"
      ? (redactApprovalSummary(summary) ?? "").slice(0, 12_000)
      : null;
  } catch {
    return null;
  }
}

/** Structured, redacted fields for the chronological Decision-stack card. */
export function proactiveWorkReviewDetails(approval: Approval) {
  if (approval.kind !== "proactive_work") return null;
  const payload = parseProactiveWorkPayload(approval.payloadJson);
  return {
    kind: "work" as const,
    revision: workReviewRevision(payload),
    context: redactApprovalSummary(payload.context) ?? "",
    plan: redactApprovalSummary(payload.plan) ?? "",
    source: {
      routineId: payload.origin.routineId ?? null,
      runId: payload.origin.runId ?? null,
      conversationId: payload.origin.conversationId ?? null,
      mailThreadId: payload.origin.mailThreadId ?? null,
      mailAccountId: payload.origin.mailAccountId ?? null,
      mailHandoverId: payload.origin.mailHandoverId ?? null,
    },
  };
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function workReviewRevision(payload: ProactiveWorkPayload): string {
  return (
    payload.revision ??
    digest([
      payload.title,
      payload.context,
      payload.plan,
      payload.origin,
      payload.sourceFingerprint,
    ])
  );
}

function reviewText(value: string, limit: number, name: string): string {
  const text = (redactApprovalSummary(value) ?? "").trim();
  if (!text || text.length > limit) throw new Error(`${name} must contain 1–${limit} characters.`);
  return text;
}

type SourceFingerprintOptions = {
  /** Rows queued before Decision-stack email reviews shipped used the old
   * handover delivery name and did not snapshot message evidence. */
  legacyPayload?: boolean;
};

/** Expected live-source invalidation. Infrastructure failures deliberately use
 * their original error type so reconciliation cannot mistake an unavailable
 * database for evidence that a human's pending review became stale. */
class ProactiveWorkSourceInvalidError extends Error {}

function invalidSource(message: string): ProactiveWorkSourceInvalidError {
  return new ProactiveWorkSourceInvalidError(message);
}

function grantModeForDelivery(mode: ProactiveWorkOrigin["mailDeliveryMode"]): MailHandoverMode {
  if (mode === "reply") return "reply";
  if (mode === "triage") return "triage";
  // Both the old draft ceiling and the new in-stack review ceiling require a
  // draft Grant. `handoverGrantError` intentionally speaks handover modes.
  return "draft";
}

async function semanticMailEvidence(
  threadId: string,
): Promise<{ all: unknown[]; inbound: unknown[] }> {
  const messages = await AppDataSource.getRepository(MailMessage).find({ where: { threadId } });
  const semantic = messages
    .filter((message) => !columnHasLabel(message.labelIds, CANONICAL_LABELS.draft))
    .sort((left, right) => {
      const leftTime = (left.sentAt ?? left.createdAt).getTime();
      const rightTime = (right.sentAt ?? right.createdAt).getTime();
      return (
        leftTime - rightTime ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id)
      );
    })
    .map((message) => ({
      sent: columnHasLabel(message.labelIds, CANONICAL_LABELS.sent),
      evidence: [
        message.id,
        message.gmailMessageId,
        message.gmailThreadId,
        message.messageIdHeader,
        message.referencesHeader,
        message.inReplyToHeader,
        message.sentAt?.toISOString() ?? null,
        message.fromName,
        message.fromEmail,
        message.toEmails,
        message.ccEmails,
        message.bccEmails,
        message.subject,
        message.bodyText,
        message.bodyHtml,
        message.attachmentsJson,
        message.sizeEstimate,
      ],
    }));
  return {
    all: semantic.map((message) => message.evidence),
    inbound: semantic.filter((message) => !message.sent).map((message) => message.evidence),
  };
}

async function legacyMailEvidenceChanged(
  origin: ProactiveWorkOrigin,
  requestedAt: Date,
): Promise<boolean> {
  if (!origin.mailThreadId) return false;
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { threadId: origin.mailThreadId },
  });
  return messages.some(
    (message) =>
      !columnHasLabel(message.labelIds, CANONICAL_LABELS.draft) &&
      Math.max(message.createdAt.getTime(), message.updatedAt.getTime()) > requestedAt.getTime(),
  );
}

async function legacyInboundEvidenceChanged(
  origin: ProactiveWorkOrigin,
  requestedAt: Date,
): Promise<boolean> {
  if (!origin.mailThreadId) return false;
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { threadId: origin.mailThreadId },
  });
  return messages.some(
    (message) =>
      !columnHasLabel(message.labelIds, CANONICAL_LABELS.draft) &&
      !columnHasLabel(message.labelIds, CANONICAL_LABELS.sent) &&
      // A label-only sync (read, star, archive) updates `updatedAt` without
      // adding customer evidence. Legacy rows have no inbound fingerprint, so
      // only a newly mirrored inbound row can safely re-arm terminal work.
      message.createdAt.getTime() > requestedAt.getTime(),
  );
}

async function mailInboundEvidenceFingerprint(
  companyId: string,
  origin: ProactiveWorkOrigin,
): Promise<string | null> {
  if (!origin.mailThreadId) return null;
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: origin.mailThreadId,
    companyId,
  });
  if (!thread) throw new Error("The source mailbox or email thread is no longer active.");
  const evidence = await semanticMailEvidence(thread.id);
  return digest([thread.id, thread.accountId, thread.gmailThreadId, evidence.inbound]);
}

/** Recheck the standing source so old reviews cannot authorize a changed instruction. */
async function sourceFingerprint(
  companyId: string,
  employeeId: string,
  origin: ProactiveWorkOrigin,
  options: SourceFingerprintOptions = {},
): Promise<string> {
  if (!origin.routineId && !origin.mailHandoverId && !origin.mailThreadId)
    throw invalidSource("A work review needs its original Routine or email source.");
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw invalidSource("The AI Employee is no longer in this company.");
  if (origin.selfReviewOnly)
    throw invalidSource("An own-work review may only stage a Revision proposal.");
  if (workBlocked(companyId, { employeeId, routineId: origin.routineId ?? undefined }).blocked)
    throw invalidSource("This work is under a Standdown.");
  const source: unknown[] = [employeeId];
  if (origin.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: origin.routineId,
      employeeId,
    });
    if (!routine || !routine.enabled)
      throw invalidSource("The source Routine was disabled or removed.");
    if (routine.selfReviewOnly)
      throw invalidSource("The source Routine is limited to its own review.");
    if (
      origin.runId &&
      !(await AppDataSource.getRepository(Run).existsBy({
        id: origin.runId,
        routineId: routine.id,
      }))
    )
      throw invalidSource("The source Run does not belong to this Routine.");
    if (
      routine.mailDeliveryMode != null &&
      origin.mailDeliveryMode !== "draft" &&
      origin.mailDeliveryMode !== "triage" &&
      origin.mailDeliveryMode !== "review"
    )
      throw invalidSource(
        "The source Routine's Decision-stack review restriction must be preserved.",
      );
    source.push({
      routineId: routine.id,
      body: routine.body,
      modelId: routine.modelId,
      mailDeliveryMode: routine.mailDeliveryMode,
      selfReviewOnly: routine.selfReviewOnly,
    });
  }
  if (origin.mailHandoverId) {
    const handover = await AppDataSource.getRepository(MailHandover).findOneBy({
      id: origin.mailHandoverId,
      companyId,
      employeeId,
    });
    if (!handover || handover.threadId !== origin.mailThreadId)
      throw invalidSource("The original email handover is no longer available.");
    const currentDeliveryMode = handoverDeliveryMode(handover.mode, handover.sourceKind);
    const legacyDraftMode =
      options.legacyPayload &&
      currentDeliveryMode === "review" &&
      origin.mailDeliveryMode === "draft";
    if (currentDeliveryMode !== origin.mailDeliveryMode && !legacyDraftMode)
      throw invalidSource("The email handover's delivery restriction must be preserved.");
    if (handover.sourceKind === "rule") {
      const rule = handover.ruleId
        ? await AppDataSource.getRepository(MailRule).findOneBy({
            id: handover.ruleId,
            companyId,
            accountId: handover.accountId,
            enabled: true,
          })
        : null;
      let actions: unknown;
      try {
        actions = JSON.parse(rule?.actionsJson || "[]");
      } catch {
        actions = [];
      }
      if (
        !Array.isArray(actions) ||
        !actions.some(
          (action: Record<string, unknown>) =>
            action.type === "handToEmployee" &&
            action.employeeId === employeeId &&
            action.mode === handover.mode &&
            action.instruction === handover.instruction,
        )
      )
        throw invalidSource(
          "The email rule was disabled, removed, or changed. Review fresh work instead.",
        );
    }
    const error = await handoverGrantError(
      employeeId,
      handover.accountId,
      handover.mode,
      handover.sourceKind,
    );
    if (error) throw invalidSource(error);
    source.push({
      handoverId: handover.id,
      ruleId: handover.ruleId,
      sourceKind: handover.sourceKind,
      instruction: handover.instruction,
      mode: handover.mode,
    });
  }
  if (origin.mailThreadId) {
    const thread = await AppDataSource.getRepository(MailThread).findOneBy({
      id: origin.mailThreadId,
      companyId,
    });
    const account = thread
      ? await AppDataSource.getRepository(MailAccount).findOneBy({
          id: thread.accountId,
          companyId,
          status: "active",
        })
      : null;
    if (!thread || !account)
      throw invalidSource("The source mailbox or email thread is no longer active.");
    if (origin.mailAccountId && origin.mailAccountId !== account.id) {
      throw invalidSource("The source email thread moved to a different mailbox.");
    }
    const error = await handoverGrantError(
      employeeId,
      account.id,
      grantModeForDelivery(origin.mailDeliveryMode),
    );
    if (error) throw invalidSource(error);
    source.push(
      options.legacyPayload
        ? { threadId: thread.id, accountId: account.id }
        : {
            threadId: thread.id,
            accountId: account.id,
            messages: (await semanticMailEvidence(thread.id)).all,
          },
    );
  }
  return digest(source);
}

async function storedSourceStillMatches(
  companyId: string,
  employeeId: string,
  payload: ProactiveWorkPayload,
  requestedAt: Date,
): Promise<boolean> {
  const legacyPayload = payload.revision === undefined;
  if (legacyPayload && (await legacyMailEvidenceChanged(payload.origin, requestedAt))) return false;
  return (
    (await sourceFingerprint(companyId, employeeId, payload.origin, { legacyPayload })) ===
    payload.sourceFingerprint
  );
}

async function currentOriginForRevision(
  companyId: string,
  employeeId: string,
  origin: ProactiveWorkOrigin,
): Promise<ProactiveWorkOrigin> {
  let current = origin;
  if (origin.mailThreadId && !origin.mailAccountId) {
    const thread = await AppDataSource.getRepository(MailThread).findOneBy({
      id: origin.mailThreadId,
      companyId,
    });
    if (!thread) throw new Error("The source mailbox or email thread is no longer active.");
    current = { ...current, mailAccountId: thread.accountId };
  }
  if (!current.mailHandoverId || current.mailDeliveryMode !== "draft") return current;
  const handover = await AppDataSource.getRepository(MailHandover).findOneBy({
    id: current.mailHandoverId,
    companyId,
    employeeId,
  });
  return handover && handoverDeliveryMode(handover.mode, handover.sourceKind) === "review"
    ? { ...current, mailDeliveryMode: "review" }
    : current;
}

/** A bounded plan, inert until an admin claims the existing Approval route. */
export async function createProactiveWorkApproval(args: {
  companyId: string;
  employeeId: string;
  title: string;
  context: string;
  plan: string;
  origin: ProactiveWorkOrigin;
}): Promise<Approval> {
  let origin = originSchema.parse(args.origin);
  if (origin.mailThreadId) {
    const thread = await AppDataSource.getRepository(MailThread).findOneBy({
      id: origin.mailThreadId,
      companyId: args.companyId,
    });
    if (!thread) throw new Error("The source mailbox or email thread is no longer active.");
    origin = { ...origin, mailAccountId: thread.accountId };
  }
  const title = reviewText(args.title, 200, "Title");
  const context = reviewText(args.context, 4_000, "Context");
  const plan = reviewText(args.plan, 8_000, "Plan");
  const fingerprint = await sourceFingerprint(args.companyId, args.employeeId, origin);
  const inboundEvidenceFingerprint = await mailInboundEvidenceFingerprint(args.companyId, origin);
  // Run ids change on every poll. The source and concrete proposed plan do not.
  const dedupeKey = digest([origin.routineId ?? null, origin.mailThreadId ?? null, title, plan]);
  const result = await withSerializedTransaction(async (manager) => {
    if (AppDataSource.options.type === "postgres") {
      const locked = origin.mailThreadId
        ? await manager.getRepository(MailThread).findOne({
            where: { id: origin.mailThreadId, companyId: args.companyId },
            lock: { mode: "pessimistic_write" },
          })
        : await manager.getRepository(AIEmployee).findOne({
            where: { id: args.employeeId, companyId: args.companyId },
            lock: { mode: "pessimistic_write" },
          });
      if (!locked) throw new Error("The work review source is no longer available.");
    }
    const repo = manager.getRepository(Approval);
    // Payloads are JSON text on both supported databases. This exact UUID
    // fragment gives mail-backed reviews a portable company/thread scope;
    // every parsed candidate is checked again below before it can suppress.
    const scope = origin.mailThreadId
      ? {
          companyId: args.companyId,
          kind: "proactive_work" as const,
          payloadJson: Like(`%"mailThreadId":"${origin.mailThreadId}"%`),
        }
      : {
          companyId: args.companyId,
          employeeId: args.employeeId,
          kind: "proactive_work" as const,
        };
    const [active, recent] = await Promise.all([
      repo.find({ where: { ...scope, status: In(["pending", "executing"]) } }),
      repo.find({
        where: { ...scope, status: In(["rejected", "approved", "execution_failed"]) },
        order: { requestedAt: "DESC" },
        ...(origin.mailThreadId ? {} : { take: 200 }),
      }),
    ]);
    for (const approval of [...active, ...recent]) {
      let previous: ProactiveWorkPayload;
      try {
        previous = parseProactiveWorkPayload(approval.payloadJson);
      } catch {
        /* A malformed old row cannot authorize or suppress fresh work. */
        continue;
      }
      const sameMailThread =
        origin.mailThreadId !== undefined &&
        origin.mailThreadId !== null &&
        previous.origin.mailThreadId === origin.mailThreadId;
      if (origin.mailThreadId ? !sameMailThread : previous.dedupeKey !== dedupeKey) continue;
      if (approval.status === "executing") return { approval, created: false };
      if (approval.status !== "pending" && sameMailThread) {
        const inboundUnchanged = previous.inboundEvidenceFingerprint
          ? previous.inboundEvidenceFingerprint === inboundEvidenceFingerprint
          : !(await legacyInboundEvidenceChanged(previous.origin, approval.requestedAt));
        if (inboundUnchanged) return { approval, created: false };
        continue;
      }
      if (
        !(await storedSourceStillMatches(
          args.companyId,
          approval.employeeId,
          previous,
          approval.requestedAt,
        ))
      ) {
        if (approval.status === "pending") {
          const expired = await repo.update(
            { id: approval.id, companyId: args.companyId, status: "pending" },
            { status: "expired" },
          );
          if (expired.affected !== 1) {
            const current = await repo.findOneBy({
              id: approval.id,
              companyId: args.companyId,
            });
            if (current?.status === "pending" || current?.status === "executing") {
              return { approval: current, created: false };
            }
          }
        }
        continue;
      }
      if (approval.status === "pending" || previous.context === context) {
        return { approval, created: false };
      }
    }
    const payload: ProactiveWorkPayload = {
      version: 1,
      title,
      context,
      plan,
      origin,
      sourceFingerprint: fingerprint,
      dedupeKey,
      inboundEvidenceFingerprint,
      revision: digest([title, context, plan, origin, fingerprint]),
    };
    const approval = await repo.save(
      repo.create({
        companyId: args.companyId,
        employeeId: args.employeeId,
        kind: "proactive_work",
        routineId: origin.routineId ?? "",
        status: "pending",
        title,
        summary: `${context}\n\nProposed work\n${plan}`,
        payloadJson: JSON.stringify(payload),
      }),
    );
    return { approval, created: true };
  });
  if (result.created) {
    await recordAudit({
      companyId: args.companyId,
      actorEmployeeId: args.employeeId,
      action: "proactive.work_review",
      targetType: "approval",
      targetId: result.approval.id,
      targetLabel: title,
    });
    void notifyApprovalPending(result.approval).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[proactive] notification failed for ${result.approval.id}:`, error);
    });
  }
  return result.approval;
}

/**
 * Revise the proposing employee's own pending plan. The edit is inert and
 * compare-and-set: a Member still has to review the complete replacement plan
 * before it can claim any work.
 */
export async function reviseProactiveWorkApproval(args: {
  companyId: string;
  employeeId: string;
  approvalId: string;
  expectedRevision: string;
  /** Authenticated Member who delegated this edit. Omit for employee-authored revisions. */
  actorUserId?: string;
  /** Restricted review conversation that carried the Member's request, when applicable. */
  conversationId?: string | null;
  title?: string;
  context?: string;
  plan?: string;
}): Promise<Approval | null> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = await repo.findOneBy({
    id: args.approvalId,
    companyId: args.companyId,
    employeeId: args.employeeId,
    kind: "proactive_work",
    status: "pending",
  });
  if (!approval) return null;
  const payload = parseProactiveWorkPayload(approval.payloadJson);
  if (workReviewRevision(payload) !== args.expectedRevision) return null;
  if (
    !(await storedSourceStillMatches(
      args.companyId,
      args.employeeId,
      payload,
      approval.requestedAt,
    ))
  ) {
    throw new Error(
      "The source changed after this work was proposed. Submit a fresh review instead.",
    );
  }
  const origin = await currentOriginForRevision(args.companyId, args.employeeId, payload.origin);
  const fingerprint = await sourceFingerprint(args.companyId, args.employeeId, origin);
  const inboundEvidenceFingerprint = await mailInboundEvidenceFingerprint(args.companyId, origin);
  const title = args.title === undefined ? payload.title : reviewText(args.title, 200, "Title");
  const context =
    args.context === undefined ? payload.context : reviewText(args.context, 4_000, "Context");
  const plan = args.plan === undefined ? payload.plan : reviewText(args.plan, 8_000, "Plan");
  const nextPayload: ProactiveWorkPayload = {
    ...payload,
    title,
    context,
    plan,
    origin,
    sourceFingerprint: fingerprint,
    inboundEvidenceFingerprint,
    dedupeKey: digest([origin.routineId ?? null, origin.mailThreadId ?? null, title, plan]),
    revision: digest([title, context, plan, origin, fingerprint]),
  };
  const updated = await repo.update(
    {
      id: approval.id,
      companyId: args.companyId,
      employeeId: args.employeeId,
      kind: "proactive_work",
      status: "pending",
      payloadJson: approval.payloadJson!,
    },
    {
      title,
      summary: `${context}\n\nProposed work\n${plan}`,
      payloadJson: JSON.stringify(nextPayload),
    },
  );
  if (updated.affected !== 1) return null;
  await recordAudit({
    companyId: args.companyId,
    // A Member-driven edit is the Member's action. Keeping the employee as a
    // second actor would make recordAudit classify the row as AI-authored, so
    // preserve that delegated employee context explicitly in metadata instead.
    actorUserId: args.actorUserId,
    actorEmployeeId: args.actorUserId ? undefined : args.employeeId,
    action: "proactive.work_review.edit",
    targetType: "approval",
    targetId: approval.id,
    targetLabel: title,
    conversationId: args.conversationId,
    metadata: { employeeId: args.employeeId },
  });
  return repo.findOneByOrFail({ id: approval.id, companyId: args.companyId });
}

/** Review history is feedback, never authority for another autonomous action. */
export async function listProactiveWorkReviews(args: { companyId: string; employeeId: string }) {
  await reconcileProactiveWorkApprovals(args.companyId);
  const rows = await AppDataSource.getRepository(Approval).find({
    where: { companyId: args.companyId, employeeId: args.employeeId, kind: "proactive_work" },
    order: { requestedAt: "DESC" },
    take: 20,
  });
  return rows.map((row) => ({
    id: row.id,
    title: redactApprovalSummary(row.title),
    summary: (redactApprovalSummary(row.summary) ?? "").slice(0, 500),
    status: row.status,
    routineId: row.routineId || null,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    outcome:
      row.status === "execution_failed"
        ? "The approved work failed. A Member can inspect the review. Do not restart it automatically."
        : row.status === "rejected"
          ? "A Member declined this work. Do not repeat the proposal without changed evidence."
          : row.status === "pending" || row.status === "executing"
            ? "This work is already waiting or underway. Do not create another proposal for it."
            : "Read the live source to verify the result; this review does not authorize more work.",
  }));
}

/** A lost process cannot leave a spinner indefinitely or replay ambiguous work. */
export async function reconcileProactiveWorkApprovals(companyId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Approval);
  // Do not invite a Member to approve a plan whose Routine, handover, mail
  // evidence, Grant, or Standdown state already changed. The conditional
  // payload match preserves a concurrent human/employee revision, while the
  // executor still repeats the same check at the actual work boundary.
  const pending = await repo.findBy({
    companyId,
    kind: "proactive_work",
    status: "pending",
  });
  for (const row of pending) {
    let current = false;
    let payload: ProactiveWorkPayload | null = null;
    try {
      payload = parseProactiveWorkPayload(row.payloadJson);
    } catch {
      // A malformed payload cannot authorize work and is safe to expire.
    }
    if (payload) {
      try {
        current = await storedSourceStillMatches(
          companyId,
          row.employeeId,
          payload,
          row.requestedAt,
        );
      } catch (error) {
        if (!(error instanceof ProactiveWorkSourceInvalidError)) throw error;
        current = false;
      }
    }
    if (current) continue;
    await repo.update(
      {
        id: row.id,
        companyId,
        kind: "proactive_work",
        status: "pending",
        payloadJson: row.payloadJson === null ? IsNull() : row.payloadJson,
      },
      { status: "expired" },
    );
  }

  const stale = {
    companyId,
    kind: "proactive_work" as const,
    status: "executing" as const,
    // A Routine may still be grading its outcome after its six-hour work budget.
    decidedAt: LessThan(new Date(Date.now() - CHAT_HARD_TIMEOUT_MS - 10 * 60_000)),
  };
  if (!(await repo.existsBy(stale))) return;
  await repo.update(stale, {
    status: "execution_failed",
    errorMessage:
      "The approved work stopped reporting before it finished. Inspect its results before proposing any further action; it will not restart automatically.",
  });
}

function approvedWorkBrief(payload: ProactiveWorkPayload): string {
  return [
    "A company owner or admin reviewed and approved this specific proposed work.",
    `Work: ${payload.title}`,
    `Why it was proposed:\n${payload.context}`,
    `Approved scope:\n${payload.plan}`,
    "Do only the approved scope. First reread the live source and check whether the work is already done or circumstances changed. If the plan is no longer appropriate, stop and report why. Do not treat this approval as standing authority for unrelated or later work. Every existing Grant, company Policy, delivery restriction and action Approval still applies. Checks cannot expand this approved scope: report an unmet Check if satisfying it would require unapproved work.",
    payload.origin.mailThreadId ? `Source email thread: ${payload.origin.mailThreadId}.` : "",
    payload.origin.mailThreadId
      ? "If a customer reply is warranted, do not create a mailbox draft and do not send directly. Use request_mail_review with the exact subject and body, what happened, and the work you actually completed. The reply stays only in the Decision stack until a human edits, sends, or discards it."
      : "",
    "Finish with a short factual report, links to actual results, and anything still requiring a Member. Never describe a queued Repository work session as a completed fix.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The runner verifies persisted proof; a caller cannot claim approval with a trigger label. */
export async function validateProactiveRoutineApproval(
  approvalId: string,
  routine: Routine,
  companyId: string,
) {
  const approval = await AppDataSource.getRepository(Approval).findOneBy({
    id: approvalId,
    companyId,
    employeeId: routine.employeeId,
    routineId: routine.id,
    kind: "proactive_work",
    status: "executing",
  });
  if (!approval || !approval.decidedByUserId)
    throw new Error("This Routine needs its claimed human work approval.");
  const payload = parseProactiveWorkPayload(approval.payloadJson);
  if (payload.origin.routineId !== routine.id)
    throw new Error("The approved plan belongs to a different Routine.");
  const [user, member] = await Promise.all([
    AppDataSource.getRepository(User).findOneBy({ id: approval.decidedByUserId }),
    AppDataSource.getRepository(Membership).findOneBy({
      companyId,
      userId: approval.decidedByUserId,
    }),
  ]);
  if (!user || !member || !["owner", "admin"].includes(member.role))
    throw new Error("The approving owner or admin no longer has authority.");
  if (
    !(await storedSourceStillMatches(companyId, routine.employeeId, payload, approval.requestedAt))
  )
    throw new Error("The source instruction changed after this work was proposed.");
  return { user, payload, brief: approvedWorkBrief(payload) };
}

/** One human-authorized continuation, keeping the original delivery ceiling. */
export async function executeProactiveWorkApproval(
  approval: Approval,
  runChat: typeof chatWithEmployee = chatWithEmployee,
  runApprovedRoutine?: (routine: Routine, options: StartRunOptions) => Promise<Run>,
): Promise<void> {
  if (
    approval.kind !== "proactive_work" ||
    approval.status !== "executing" ||
    !approval.decidedByUserId
  )
    throw new Error("A human must claim this work review before it can start.");
  const payload = parseProactiveWorkPayload(approval.payloadJson);
  if ((payload.origin.routineId ?? "") !== approval.routineId)
    throw new Error("The work review source does not match its Approval.");
  const [member, user] = await Promise.all([
    AppDataSource.getRepository(Membership).findOneBy({
      companyId: approval.companyId,
      userId: approval.decidedByUserId,
    }),
    AppDataSource.getRepository(User).findOneBy({ id: approval.decidedByUserId }),
  ]);
  if (!user || !member || !["owner", "admin"].includes(member.role))
    throw new Error("An owner or admin must still have access to authorize this work.");
  if (
    !(await storedSourceStillMatches(
      approval.companyId,
      approval.employeeId,
      payload,
      approval.requestedAt,
    ))
  )
    throw new Error(
      "The source instruction changed after this work was proposed. Review a fresh proposal.",
    );
  if (payload.origin.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: payload.origin.routineId,
      employeeId: approval.employeeId,
    });
    const run = await (runApprovedRoutine ?? (await import("../runner.js")).runRoutine)(routine, {
      triggerKind: "approval",
      proactiveApprovalId: approval.id,
    });
    const summary = [
      `Run ${run.id}: ${run.status}.`,
      runWorkSummary(run),
      run.checksVerdict ? `Checks: ${run.checksVerdict}.` : "Checks were not verified.",
      run.outcomeNote || "No independent outcome assessment is available.",
    ].join(" ");
    await AppDataSource.getRepository(Approval).update(
      { id: approval.id, status: "executing" },
      {
        resultJson: JSON.stringify({ summary: redactApprovalSummary(summary), runId: run.id }),
      },
    );
    const checksSucceeded = run.checksVerdict === "passed" || run.checksVerdict === "not_run";
    const hasAcceptanceCriteria = routine.acceptanceCriteria.trim().length > 0;
    const outcomeSucceeded =
      run.outcomeVerdict === "achieved" || (!hasAcceptanceCriteria && run.outcomeVerdict === null);
    if (run.status !== "completed" || !checksSucceeded || !outcomeSucceeded)
      throw new Error(
        "The approved Run did not finish with its required Checks and outcome satisfied. Inspect the Run before requesting more work.",
      );
    return;
  }
  const result = await runChat(
    approval.companyId,
    approval.employeeId,
    approvedWorkBrief(payload),
    [],
    {
      requesterUserId: user.id,
      requesterSessionVersion: user.sessionVersion,
      mailThreadId: payload.origin.mailThreadId,
      mailHandoverId: payload.origin.mailHandoverId,
      routineId: payload.origin.routineId,
      // Legacy draft and current review ceilings both return customer-facing
      // email to the Decision stack. Preserve stricter triage (and an explicit
      // reply ceiling) instead of widening every mail-backed plan to compose.
      mailDeliveryMode:
        payload.origin.mailThreadId &&
        (payload.origin.mailDeliveryMode === "draft" ||
          payload.origin.mailDeliveryMode === "review")
          ? "review"
          : payload.origin.mailDeliveryMode,
      selfReviewOnly: payload.origin.selfReviewOnly ?? false,
      proactiveReview: false,
      workloadKey: `proactive-approval:${approval.id}`,
      workloadScope: `proactive-approval:${approval.id}`,
    },
  );
  const summary = (redactApprovalSummary(result.reply) ?? "").slice(0, 12_000);
  await AppDataSource.getRepository(Approval).update(
    { id: approval.id, status: "executing" },
    {
      resultJson: JSON.stringify({ summary }),
    },
  );
  if (result.status !== "ok")
    throw new Error(result.reply || "The approved work could not finish.");
  if (result.stopReason === "max_steps" || result.stopReason === "aborted")
    throw new Error(
      "The approved work stopped before finishing. Inspect its partial results before requesting more work.",
    );
  await AppDataSource.getRepository(JournalEntry).save(
    AppDataSource.getRepository(JournalEntry).create({
      employeeId: approval.employeeId,
      kind: "system",
      title: `Completed approved work: ${payload.title}`,
      body: summary,
      routineId: payload.origin.routineId ?? null,
      runId: null,
      authorUserId: user.id,
    }),
  );
}
