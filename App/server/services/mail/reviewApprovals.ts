import crypto from "node:crypto";
import { In, IsNull, LessThan, Like, type EntityManager } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { Conversation } from "../../db/entities/Conversation.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { JournalEntry } from "../../db/entities/JournalEntry.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { parseAddressList } from "../../lib/emailAddress.js";
import { withSerializedTransaction } from "../../db/transactions.js";
import { redactApprovalSummary } from "../approvalRedaction.js";
import { recordAudit } from "../audit.js";
import { notifyApprovalPending } from "../notifications.js";
import {
  makeResourceAttachmentResolver,
  resourceAttachmentSpecsSchema,
  type ResourceAttachmentSpec,
} from "../resourceAttachments.js";
import {
  mailReplyContext,
  replyAllRecipientsFromContext,
  sendMailMessage,
  type MailActionDependencies,
} from "./actions.js";
import { assertRecipientsAllowed } from "./suppression.js";
import { CANONICAL_LABELS } from "./mailbox/types.js";
import { columnHasLabel } from "./store.js";

const reviewStepSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

const mailReviewAttachmentSchema = z
  .object({
    spec: resourceAttachmentSpecsSchema.element,
    filename: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentBase64: z.string().max(5_000_000),
  })
  .strict();

const mailReviewPayloadSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().uuid(),
    // Null is a fresh outbound compose. Existing rows always carry a thread
    // and continue to parse unchanged.
    threadId: z.string().uuid().nullable(),
    mailHandoverId: z.string().uuid().nullable(),
    context: z.string().trim().min(1).max(4_000),
    workSummary: z.string().trim().max(8_000),
    steps: z.array(reviewStepSchema).max(12),
    attachments: z.array(mailReviewAttachmentSchema).max(10).default([]),
    /** Preserve the authenticated Member's Finance ceiling when attachment
     * Grants are checked again immediately before send. Old rows predate the
     * ceiling and therefore retain their historical employee-only behavior. */
    financeAccessLimit: z.enum(["none", "read", "full"]).default("full"),
    draft: z
      .object({
        to: z.string().trim().max(2_000),
        cc: z.string().trim().max(2_000),
        bcc: z.string().trim().max(2_000),
        subject: z.string().trim().min(1).max(1_000),
        bodyText: z.string().trim().min(1).max(200_000),
      })
      .strict(),
    threading: z
      .object({
        inReplyTo: z.string().nullable(),
        references: z.string().nullable(),
      })
      .strict()
      .default({ inReplyTo: null, references: null }),
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    /** Inbound-only evidence is separate from full thread freshness: a
     * successful outbound mirror must not look like a new customer request. */
    inboundEvidenceVersion: z.literal(1).default(1),
    inboundEvidenceFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    /** Exact outbound message identity for fresh-compose dedupe. */
    messageFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    origin: z
      .object({
        routineId: z.string().uuid().nullable(),
        runId: z.string().uuid().nullable(),
        conversationId: z.string().uuid().nullable(),
      })
      .strict()
      .default({ routineId: null, runId: null, conversationId: null }),
    dedupeKey: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type MailReviewPayload = z.infer<typeof mailReviewPayloadSchema>;
export type MailReviewStep = z.infer<typeof reviewStepSchema>;

class MailReviewSourceError extends Error {
  override name = "MailReviewSourceError";
}

function staleMailReviewSourceError(error: unknown): boolean {
  return (
    error instanceof MailReviewSourceError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError
  );
}

export function parseMailReviewPayload(value: string | null): MailReviewPayload {
  return mailReviewPayloadSchema.parse(JSON.parse(value || "null"));
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function byteDigest(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reviewText(value: string, limit: number, label: string): string {
  const text = (redactApprovalSummary(value) ?? "").trim();
  if (!text || text.length > limit) {
    throw new Error(`${label} must contain 1–${limit} characters.`);
  }
  return text;
}

function validateReviewRecipients(draft: { to: string; cc: string; bcc: string }): void {
  const fields = [
    ["To", draft.to],
    ["Cc", draft.cc],
    ["Bcc", draft.bcc],
  ] as const;
  let addressCount = 0;
  for (const [label, value] of fields) {
    const parsed = parseAddressList(value);
    if (parsed.invalid.length > 0) {
      throw new Error(`${label} contains an invalid email address: ${parsed.invalid[0]}`);
    }
    addressCount += parsed.addresses.length;
  }
  if (addressCount === 0) {
    throw new Error("Add at least one valid recipient before saving this email.");
  }
}

async function semanticThreadEvidence(
  manager: EntityManager,
  threadId: string,
): Promise<{ all: unknown[]; inbound: unknown[] }> {
  const messages = await manager.getRepository(MailMessage).find({ where: { threadId } });
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

async function reviewSource(args: {
  companyId: string;
  employeeId: string;
  accountId?: string | null;
  threadId?: string | null;
  mailHandoverId?: string | null;
  routineId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  manager?: EntityManager;
}): Promise<{
  account: MailAccount;
  thread: MailThread | null;
  recipients: { to: string; cc: string } | null;
  threading: { inReplyTo: string | null; references: string | null };
  fingerprint: string;
  inboundEvidenceFingerprint: string;
}> {
  const manager = args.manager ?? AppDataSource.manager;
  const employee = await manager.getRepository(AIEmployee).findOneBy({
    id: args.employeeId,
    companyId: args.companyId,
  });
  if (!employee) throw new MailReviewSourceError("The AI Employee is no longer in this company.");
  if (args.runId && !args.routineId) {
    throw new MailReviewSourceError("The source Run is missing its Routine.");
  }
  const originEvidence: unknown[] = [];
  if (args.routineId) {
    const routine = await manager.getRepository(Routine).findOneBy({
      id: args.routineId,
      employeeId: args.employeeId,
      enabled: true,
    });
    if (!routine) {
      throw new MailReviewSourceError("The source Routine was disabled or removed.");
    }
    const run = args.runId
      ? await manager.getRepository(Run).findOneBy({
          id: args.runId,
          routineId: routine.id,
        })
      : null;
    if (args.runId && !run) {
      throw new MailReviewSourceError("The source Run no longer belongs to this Routine.");
    }
    // A Routine is standing automatic authority, not merely a display link.
    // Revisions to the instruction or its server-owned ceilings invalidate a
    // pending email, while ordinary Run progress remains snapshotted.
    originEvidence.push({
      routineId: routine.id,
      body: routine.body,
      mailDeliveryMode: routine.mailDeliveryMode,
      selfReviewOnly: routine.selfReviewOnly,
      runId: run?.id ?? null,
    });
  }
  if (args.conversationId) {
    const conversation = await manager.getRepository(Conversation).findOneBy({
      id: args.conversationId,
      employeeId: args.employeeId,
    });
    if (!conversation) {
      throw new MailReviewSourceError("The source conversation is no longer available.");
    }
    // Titles and archive state are presentation choices. The source identity
    // and employee binding are the authority that must survive until Send.
    originEvidence.push({
      conversationId: conversation.id,
      employeeId: conversation.employeeId,
    });
  }
  const thread = args.threadId
    ? await manager.getRepository(MailThread).findOneBy({
        id: args.threadId,
        companyId: args.companyId,
      })
    : null;
  if (args.threadId && !thread) {
    throw new MailReviewSourceError("The source email thread is no longer available.");
  }
  if (thread && args.accountId && thread.accountId !== args.accountId) {
    throw new MailReviewSourceError("The selected mailbox does not own this email thread.");
  }
  const accountId = thread?.accountId ?? args.accountId;
  const account = accountId
    ? await manager.getRepository(MailAccount).findOneBy({
        id: accountId,
        companyId: args.companyId,
        status: "active",
      })
    : null;
  if (!account) {
    throw new MailReviewSourceError("Choose an active mailbox for this email review.");
  }
  const connection = await manager.getRepository(IntegrationConnection).findOneBy({
    id: account.connectionId,
    companyId: args.companyId,
    status: "connected",
  });
  const expectedConnectionProvider = account.provider === "imap" ? "imap" : "google";
  if (!connection || connection.provider !== expectedConnectionProvider) {
    throw new MailReviewSourceError(
      `The Connection behind ${account.address} is no longer connected to this mailbox. Reconnect it before reviewing this email.`,
    );
  }
  if (!thread && args.mailHandoverId) {
    throw new MailReviewSourceError("A fresh email cannot claim an email-thread handover.");
  }
  const grant = await manager.getRepository(EmployeeMailAccountGrant).findOneBy({
    employeeId: args.employeeId,
    accountId: account.id,
  });
  // The employee is proposing words for a human to send. Draft access is the
  // right ceiling: pressing Send is the owner/admin's explicit authority, not
  // an upgrade to the employee's standing Grant.
  if (!grant || MAIL_ACCESS_RANK[grant.accessLevel] < MAIL_ACCESS_RANK.draft) {
    throw new MailReviewSourceError(
      `Draft access to ${account.address} is required before this email can be reviewed.`,
    );
  }
  const reply = thread ? await mailReplyContext(thread, manager) : null;
  const recipients = reply ? await replyAllRecipientsFromContext(account, reply) : null;
  if (thread && !`${recipients?.to ?? ""} ${recipients?.cc ?? ""}`.trim()) {
    throw new MailReviewSourceError("The source email no longer has a recipient for this reply.");
  }
  let handoverAuthority: unknown = null;
  if (args.mailHandoverId) {
    const handover = await manager.getRepository(MailHandover).findOneBy({
      id: args.mailHandoverId,
      companyId: args.companyId,
      employeeId: args.employeeId,
      accountId: account.id,
      threadId: thread!.id,
    });
    if (!handover) {
      throw new MailReviewSourceError("The source email handover is no longer available.");
    }
    if (handover.sourceKind === "rule") {
      const rule = handover.ruleId
        ? await manager.getRepository(MailRule).findOneBy({
            id: handover.ruleId,
            companyId: args.companyId,
            accountId: account.id,
            enabled: true,
          })
        : null;
      let configured = false;
      try {
        const actions: unknown = JSON.parse(rule?.actionsJson || "[]");
        configured =
          Array.isArray(actions) &&
          actions.some(
            (action: Record<string, unknown>) =>
              action.type === "handToEmployee" &&
              action.employeeId === args.employeeId &&
              action.mode === handover.mode &&
              action.instruction === handover.instruction,
          );
      } catch {
        configured = false;
      }
      if (!configured) {
        throw new MailReviewSourceError(
          "The email rule changed after this reply was prepared. Review a fresh reply instead.",
        );
      }
    }
    handoverAuthority = {
      id: handover.id,
      ruleId: handover.ruleId,
      sourceKind: handover.sourceKind,
      mode: handover.mode,
      instruction: handover.instruction,
    };
  }
  const threadEvidence = thread
    ? await semanticThreadEvidence(manager, thread.id)
    : { all: [], inbound: [] };
  const accountEvidence = [
    account.id,
    account.connectionId,
    account.provider,
    account.status,
    account.address,
  ];
  const connectionEvidence = [
    connection.id,
    connection.provider,
    connection.authMode,
    connection.status,
    connection.accountHint,
  ];
  // Delivery authority belongs in the full freshness fingerprint. The
  // terminal-card fingerprint intentionally keeps only stable mailbox
  // identity so reconnecting the same mailbox cannot re-arm an already sent
  // or discarded customer reply without new inbound evidence.
  const stableAccountIdentity = [
    account.id,
    account.connectionId,
    account.provider,
    account.address,
  ];
  const stableThreadIdentity = [thread?.id ?? null, thread?.gmailThreadId ?? null];
  const threadIdentity = [...stableThreadIdentity, thread?.subject ?? null];
  const fingerprintEvidence: unknown[] = [
    accountEvidence,
    connectionEvidence,
    grant.id,
    threadIdentity,
    threadEvidence.all,
    handoverAuthority,
  ];
  // Keep legacy/manual reviews byte-for-byte compatible. Only a review that
  // explicitly names a server-bound origin depends on that live origin.
  if (originEvidence.length > 0) fingerprintEvidence.push(originEvidence);
  return {
    account,
    thread,
    recipients,
    threading: {
      inReplyTo: reply?.inReplyTo ?? null,
      references: reply?.references ?? null,
    },
    fingerprint: digest(fingerprintEvidence),
    inboundEvidenceFingerprint: digest([
      stableAccountIdentity,
      stableThreadIdentity,
      threadEvidence.inbound,
    ]),
  };
}

function defaultReplySubject(subject: string): string {
  const trimmed = subject.trim() || "(no subject)";
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

async function prepareAttachments(args: {
  companyId: string;
  employeeId: string;
  financeAccessLimit?: "none" | "read" | "full";
  specs?: ResourceAttachmentSpec[];
}) {
  const specs = resourceAttachmentSpecsSchema.parse(args.specs ?? []);
  if (specs.length === 0) return [];
  const resolved = await makeResourceAttachmentResolver({
    companyId: args.companyId,
    employeeId: args.employeeId,
    financeAccessLimit: args.financeAccessLimit,
  })(specs);
  return resolved.map((attachment, index) => ({
    spec: specs[index],
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.content.length,
    sha256: byteDigest(attachment.content),
    contentBase64: attachment.content.toString("base64"),
  }));
}

function reviewedAttachmentBytes(payload: MailReviewPayload) {
  return payload.attachments.map((reviewed) => {
    const content = Buffer.from(reviewed.contentBase64, "base64");
    if (content.length !== reviewed.sizeBytes || byteDigest(content) !== reviewed.sha256) {
      throw new Error("The reviewed attachment snapshot is damaged.");
    }
    return { filename: reviewed.filename, mimeType: reviewed.contentType, content };
  });
}

async function revalidateAttachmentAuthority(
  approval: Approval,
  payload: MailReviewPayload,
): Promise<void> {
  const specs = payload.attachments.map((attachment) => attachment.spec);
  if (specs.length === 0) return;
  const current = await makeResourceAttachmentResolver({
    companyId: approval.companyId,
    employeeId: approval.employeeId,
    financeAccessLimit: payload.financeAccessLimit,
  })(specs);
  if (current.length !== payload.attachments.length) {
    throw new Error("The reviewed attachment set changed before sending.");
  }
  current.forEach((attachment, index) => {
    const reviewed = payload.attachments[index];
    if (!reviewed) throw new Error("The reviewed attachment snapshot is missing.");
    const resourceChanged =
      "resourceSlug" in reviewed.spec &&
      (reviewed.spec.format ?? "original") !== "pdf" &&
      (attachment.filename !== reviewed.filename ||
        attachment.contentType !== reviewed.contentType ||
        attachment.content.length !== reviewed.sizeBytes ||
        byteDigest(attachment.content) !== reviewed.sha256);
    if (resourceChanged) {
      throw new Error(
        "An attachment changed after this email was prepared. Review a fresh copy before sending.",
      );
    }
  });
}

/**
 * Queue an exact email for a human. A thread produces a reply; account +
 * recipients produces a fresh compose. This stores only Approval data: it
 * does not create a MailMessage and never writes to Gmail/IMAP Drafts.
 */
export async function createMailReviewApproval(args: {
  companyId: string;
  employeeId: string;
  accountId?: string | null;
  threadId?: string | null;
  mailHandoverId?: string | null;
  routineId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  context: string;
  workSummary?: string;
  steps?: MailReviewStep[];
  attachments?: ResourceAttachmentSpec[];
  financeAccessLimit?: "none" | "read" | "full";
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText: string;
}): Promise<{ approval: Approval; created: boolean }> {
  if (!args.threadId && !args.accountId) {
    throw new Error("Choose a mailbox for a fresh email review.");
  }
  if (!args.threadId && !args.subject?.trim()) {
    throw new Error("Subject is required for a fresh email review.");
  }
  const context = reviewText(args.context, 4_000, "What happened");
  const workSummary = (redactApprovalSummary(args.workSummary ?? "") ?? "").trim().slice(0, 8_000);
  const steps = z
    .array(reviewStepSchema)
    .max(12)
    .parse(args.steps ?? [])
    .map((step) => ({
      title: reviewText(step.title, 160, "Step title"),
      detail: step.detail ? reviewText(step.detail, 1_000, "Step detail") : undefined,
    }));
  const attachments = await prepareAttachments({
    companyId: args.companyId,
    employeeId: args.employeeId,
    financeAccessLimit: args.financeAccessLimit,
    specs: args.attachments,
  });
  const bodyText = reviewText(args.bodyText, 200_000, "Email body");
  const origin = {
    routineId: args.routineId ?? null,
    runId: args.runId ?? null,
    conversationId: args.conversationId ?? null,
  };

  const result = await withSerializedTransaction(async (manager) => {
    if (AppDataSource.options.type === "postgres") {
      // Every reply for one source serializes on the shared thread row, not on
      // an employee. That makes two employees racing the same customer email
      // converge on one Send button. Fresh composes serialize per mailbox.
      const lockRepo = args.threadId
        ? manager.getRepository(MailThread)
        : manager.getRepository(MailAccount);
      const locked = await lockRepo.findOne({
        where: { id: args.threadId ?? args.accountId!, companyId: args.companyId },
        lock: { mode: "pessimistic_write" },
      });
      if (!locked) {
        throw new Error(
          args.threadId
            ? "The source email thread is no longer available."
            : "Choose an active mailbox for this email review.",
        );
      }
    }
    const source = await reviewSource({ ...args, manager });
    const subject = reviewText(
      args.subject?.trim() || defaultReplySubject(source.thread?.subject ?? ""),
      1_000,
      "Subject",
    );
    const draft = source.thread
      ? {
          to: source.recipients!.to,
          cc: source.recipients!.cc,
          bcc: "",
          subject,
          bodyText,
        }
      : {
          to: args.to?.trim() ?? "",
          cc: args.cc?.trim() ?? "",
          bcc: args.bcc?.trim() ?? "",
          subject,
          bodyText,
        };
    validateReviewRecipients(draft);
    const messageFingerprint = digest([source.account.id, draft, attachments]);
    // The revision includes the server-bound work origin. Duplicate calls in
    // one Run converge, while a later scheduled Run may legitimately propose
    // the same recurring fresh email again after a confirmed prior send.
    const dedupeKey = digest([
      source.thread?.id ?? null,
      origin,
      context,
      workSummary,
      steps,
      messageFingerprint,
    ]);
    const repo = manager.getRepository(Approval);
    // Attachment snapshots can make a payload several megabytes. Narrow in
    // the database before parsing so one review never loads every unrelated
    // company email into process memory. UUID and SHA-256 values contain no
    // LIKE wildcards, and compact JSON.stringify output makes these exact
    // field fragments portable across SQLite and Postgres text columns.
    const candidatePayload = source.thread
      ? Like(`%"threadId":"${source.thread.id}"%`)
      : Like(`%"messageFingerprint":"${messageFingerprint}"%`);
    const active = await repo.find({
      where: {
        companyId: args.companyId,
        kind: "mail_send",
        // A confirmed or unverified send whose source has not changed must
        // also suppress another card. Otherwise a missing mirror refresh could
        // turn one provider acceptance into a duplicate customer email.
        status: In(["pending", "executing", "approved", "execution_failed", "rejected"]),
        payloadJson: candidatePayload,
      },
      select: { id: true },
      order: { requestedAt: "DESC" },
    });
    for (const listed of active) {
      const candidate = await repo.findOneBy({
        id: listed.id,
        companyId: args.companyId,
        kind: "mail_send",
        status: In(["pending", "executing", "approved", "execution_failed", "rejected"]),
        payloadJson: candidatePayload,
      });
      if (!candidate) continue;
      let previous: MailReviewPayload;
      try {
        previous = parseMailReviewPayload(candidate.payloadJson);
      } catch {
        continue;
      }
      const sourceThreadId = source.thread?.id ?? null;
      const sameReply = sourceThreadId !== null && previous.threadId === sourceThreadId;
      const previousMessageFingerprint =
        previous.messageFingerprint ??
        digest([previous.accountId, previous.draft, previous.attachments]);
      const sameFreshMessage =
        !source.thread &&
        previous.threadId === null &&
        previous.accountId === source.account.id &&
        previousMessageFingerprint === messageFingerprint;
      if (!sameReply && !sameFreshMessage) continue;
      // An in-flight send is never replaced, even if new mail arrived or the
      // proposing employee's Grant changed while the provider call is live.
      if (candidate.status === "executing") {
        return { approval: candidate, created: false };
      }
      if (candidate.status === "execution_failed") {
        // A known pre-provider refusal is safe to prepare again. Attempted
        // delivery is terminal: for a reply, wait for new inbound evidence;
        // for a fresh compose, the exact same message stays suppressed.
        if (mailReviewDeliveryStatus(candidate) === "not_sent") continue;
        if (!sameReply) return { approval: candidate, created: false };
        const inboundUnchanged = previous.inboundEvidenceFingerprint
          ? previous.inboundEvidenceFingerprint === source.inboundEvidenceFingerprint
          : true;
        if (inboundUnchanged) return { approval: candidate, created: false };
        continue;
      }
      if (candidate.status === "approved" || candidate.status === "rejected") {
        if (sameReply) {
          const inboundUnchanged = previous.inboundEvidenceFingerprint
            ? previous.inboundEvidenceFingerprint === source.inboundEvidenceFingerprint
            : true;
          if (inboundUnchanged) return { approval: candidate, created: false };
          continue;
        }
        if (candidate.status === "rejected") {
          // With no inbound source, Discard is the only durable evidence that
          // this exact message should not be re-armed automatically.
          return { approval: candidate, created: false };
        }
        if (JSON.stringify(previous.origin) === JSON.stringify(origin)) {
          return { approval: candidate, created: false };
        }
        continue;
      }

      // Only pending rows reach source revalidation. Recheck using the
      // candidate's own employee and handover, not the employee racing it.
      let candidateCurrent = false;
      try {
        const candidateSource = await reviewSource({
          companyId: args.companyId,
          employeeId: candidate.employeeId,
          accountId: previous.accountId,
          threadId: previous.threadId,
          mailHandoverId: previous.mailHandoverId,
          routineId: previous.origin.routineId,
          runId: previous.origin.runId,
          conversationId: previous.origin.conversationId,
          manager,
        });
        candidateCurrent =
          candidateSource.account.id === previous.accountId &&
          candidateSource.fingerprint === previous.sourceFingerprint;
      } catch (error) {
        if (!staleMailReviewSourceError(error)) throw error;
        candidateCurrent = false;
      }
      if (!candidateCurrent) {
        const expired = await repo.update(
          {
            id: candidate.id,
            companyId: args.companyId,
            status: "pending",
            payloadJson: candidate.payloadJson!,
          },
          { status: "expired" },
        );
        if (expired.affected !== 1) {
          // A concurrent human may have claimed the row after our read. Never
          // create a replacement beside an executing send.
          const current = await repo.findOneBy({
            id: candidate.id,
            companyId: args.companyId,
          });
          if (current?.status === "executing") {
            return { approval: current, created: false };
          }
          if (current?.status === "pending") return { approval: current, created: false };
        }
        continue;
      }
      // Replies are company/thread unique across employees. Fresh composes
      // dedupe only when the reviewed payload and mailbox are exact matches.
      return { approval: candidate, created: false };
    }
    const payloadResult = mailReviewPayloadSchema.safeParse({
      version: 1,
      accountId: source.account.id,
      threadId: source.thread?.id ?? null,
      mailHandoverId: args.mailHandoverId ?? null,
      context,
      workSummary,
      steps,
      attachments,
      financeAccessLimit: args.financeAccessLimit ?? "full",
      draft,
      threading: source.threading,
      sourceFingerprint: source.fingerprint,
      inboundEvidenceVersion: 1,
      inboundEvidenceFingerprint: source.inboundEvidenceFingerprint,
      messageFingerprint,
      origin,
      dedupeKey,
    });
    if (!payloadResult.success) {
      throw new Error(
        "The exact email review is too large or invalid to store safely. Attach fewer files or shorten the message.",
      );
    }
    const payload = payloadResult.data;
    const approval = await repo.save(
      repo.create({
        companyId: args.companyId,
        employeeId: args.employeeId,
        kind: "mail_send",
        routineId: args.routineId ?? "",
        title: `${source.thread ? "Reply" : "Email"} to ${draft.to || draft.cc || draft.bcc}`.slice(
          0,
          200,
        ),
        summary: context,
        payloadJson: JSON.stringify(payload),
        resultJson: null,
        errorMessage: null,
        status: "pending",
      }),
    );
    return { approval, created: true };
  });

  if (result.created) {
    const details = mailReviewDetails(result.approval);
    await recordAudit({
      companyId: args.companyId,
      actorEmployeeId: args.employeeId,
      action: "mail.review.request",
      targetType: "approval",
      targetId: result.approval.id,
      targetLabel: result.approval.title ?? "Email review",
      runId: details?.source.runId ?? null,
      conversationId: details?.source.conversationId ?? null,
      metadata: {
        accountId: details?.source.accountId ?? null,
        threadId: details?.source.threadId ?? null,
        routineId: details?.source.routineId ?? null,
      },
    });
    void notifyApprovalPending(result.approval).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[mail-review] notification failed for ${result.approval.id}:`, error);
    });
  }
  return result;
}

/** Safe, redacted fields for the owner/admin review UI. */
export function mailReviewDetails(approval: Approval) {
  if (approval.kind !== "mail_send") return null;
  const payload = parseMailReviewPayload(approval.payloadJson);
  const redact = (value: string) => redactApprovalSummary(value) ?? "";
  return {
    kind: "mail" as const,
    revision: payload.dedupeKey,
    context: redact(payload.context),
    workSummary: redact(payload.workSummary),
    steps: payload.steps.map((step) => ({
      title: redact(step.title),
      detail: step.detail ? redact(step.detail) : null,
    })),
    attachments: payload.attachments.map(({ filename, contentType, sizeBytes }, index) => ({
      index,
      filename,
      contentType,
      sizeBytes,
    })),
    source: {
      accountId: payload.accountId,
      threadId: payload.threadId,
      mailHandoverId: payload.mailHandoverId,
      routineId: payload.origin.routineId,
      runId: payload.origin.runId,
      conversationId: payload.origin.conversationId,
    },
    draft: {
      to: payload.draft.to,
      cc: payload.draft.cc,
      bcc: payload.draft.bcc,
      subject: payload.draft.subject,
      bodyText: payload.draft.bodyText,
    },
  };
}

/** Exact snapshotted bytes an owner/admin can inspect before sending. */
export function mailReviewAttachment(approval: Approval, index: number) {
  if (approval.kind !== "mail_send" || !Number.isInteger(index) || index < 0) return null;
  const attachment = parseMailReviewPayload(approval.payloadJson).attachments[index];
  if (!attachment) return null;
  const content = Buffer.from(attachment.contentBase64, "base64");
  if (content.length !== attachment.sizeBytes || byteDigest(content) !== attachment.sha256) {
    throw new Error("The reviewed attachment snapshot is damaged.");
  }
  return {
    filename: attachment.filename,
    contentType: attachment.contentType,
    content,
  };
}

export function mailReviewOutcome(approval: Approval): {
  sentMessageId: string | null;
  providerMessageRef: string;
  sentAt: string;
} | null {
  if (approval.kind !== "mail_send" || !approval.resultJson) return null;
  try {
    const parsed = JSON.parse(approval.resultJson) as Record<string, unknown>;
    const sentMessageId = typeof parsed.sentMessageId === "string" ? parsed.sentMessageId : null;
    const providerMessageRef =
      typeof parsed.providerMessageRef === "string" ? parsed.providerMessageRef : sentMessageId;
    return providerMessageRef && typeof parsed.sentAt === "string"
      ? { sentMessageId, providerMessageRef, sentAt: parsed.sentAt }
      : null;
  } catch {
    return null;
  }
}

export type MailReviewDeliveryStatus = "sent" | "not_sent" | "unverified";

/** Separate a known pre-send refusal from a provider call whose outcome may
 * be ambiguous. The distinction is durable so restart reconciliation and UI
 * history never imply delivery when Genosyn knows none was attempted. */
export function mailReviewDeliveryStatus(approval: Approval): MailReviewDeliveryStatus | null {
  if (approval.kind !== "mail_send") return null;
  if (mailReviewOutcome(approval)) return "sent";
  if (approval.resultJson) {
    try {
      const result = JSON.parse(approval.resultJson) as Record<string, unknown>;
      if (result.deliveryStatus === "not_sent") return "not_sent";
      if (result.deliveryStatus === "attempting") return "unverified";
    } catch {
      // Malformed or legacy results have no trustworthy delivery proof.
    }
  }
  return approval.status === "execution_failed" || approval.status === "approved"
    ? "unverified"
    : null;
}

type MailReviewDraftUpdate = {
  companyId: string;
  approvalId: string;
  expectedRevision: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText?: string;
};

async function updateMailReviewDraft(
  args: MailReviewDraftUpdate & {
    actorUserId?: string;
    actorEmployeeId?: string;
    conversationId?: string;
    expectedEmployeeId?: string;
    expectedThreadId?: string | null;
    expectedMailHandoverId?: string | null;
  },
): Promise<Approval | null> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = await repo.findOneBy({
    id: args.approvalId,
    companyId: args.companyId,
    kind: "mail_send",
    status: "pending",
    ...(args.expectedEmployeeId ? { employeeId: args.expectedEmployeeId } : {}),
  });
  if (!approval) return null;
  const payload = parseMailReviewPayload(approval.payloadJson);
  if (payload.dedupeKey !== args.expectedRevision) return null;
  if (
    (args.expectedThreadId !== undefined && payload.threadId !== args.expectedThreadId) ||
    (args.expectedMailHandoverId !== undefined &&
      payload.mailHandoverId !== args.expectedMailHandoverId)
  ) {
    return null;
  }
  const source = await reviewSource({
    companyId: approval.companyId,
    employeeId: approval.employeeId,
    accountId: payload.accountId,
    threadId: payload.threadId,
    mailHandoverId: payload.mailHandoverId,
    routineId: payload.origin.routineId,
    runId: payload.origin.runId,
    conversationId: payload.origin.conversationId,
  });
  if (source.account.id !== payload.accountId || source.fingerprint !== payload.sourceFingerprint) {
    throw new Error(
      payload.threadId
        ? "The email thread changed after this reply was prepared. Review a fresh reply instead."
        : "The mailbox or its authority changed after this email was prepared. Review a fresh email instead.",
    );
  }
  const draft = {
    to: args.to === undefined ? payload.draft.to : args.to.trim(),
    cc: args.cc === undefined ? payload.draft.cc : args.cc.trim(),
    bcc: args.bcc === undefined ? payload.draft.bcc : args.bcc.trim(),
    subject:
      args.subject === undefined
        ? payload.draft.subject
        : reviewText(args.subject, 1_000, "Subject"),
    bodyText:
      args.bodyText === undefined
        ? payload.draft.bodyText
        : reviewText(args.bodyText, 200_000, "Email body"),
  };
  validateReviewRecipients(draft);
  const messageFingerprint = digest([payload.accountId, draft, payload.attachments]);
  const nextPayload: MailReviewPayload = {
    ...payload,
    draft,
    messageFingerprint,
    dedupeKey: digest([
      payload.threadId,
      payload.origin,
      payload.context,
      payload.workSummary,
      payload.steps,
      messageFingerprint,
    ]),
  };
  const updated = await repo.update(
    {
      id: approval.id,
      companyId: args.companyId,
      kind: "mail_send",
      status: "pending",
      payloadJson: approval.payloadJson!,
    },
    {
      payloadJson: JSON.stringify(nextPayload),
      title:
        `${payload.threadId ? "Reply" : "Email"} to ${draft.to || draft.cc || draft.bcc}`.slice(
          0,
          200,
        ),
    },
  );
  if (updated.affected !== 1) return null;
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    actorEmployeeId: args.actorEmployeeId,
    action: "mail.review.edit",
    targetType: "approval",
    targetId: approval.id,
    targetLabel: approval.title ?? "Email review",
    conversationId: args.conversationId,
    metadata: {
      employeeId: approval.employeeId,
      accountId: payload.accountId,
      threadId: payload.threadId,
    },
  });
  return repo.findOneByOrFail({ id: approval.id, companyId: args.companyId });
}

/** Human edits stay inside the Approval payload and therefore outside Gmail. */
export async function updateMailReviewApproval(
  args: MailReviewDraftUpdate & { userId: string; conversationId?: string },
): Promise<Approval | null> {
  return updateMailReviewDraft({ ...args, actorUserId: args.userId });
}

/** The proposing employee may revise its own pending words, but never send them. */
export async function reviseMailReviewApproval(
  args: MailReviewDraftUpdate & {
    employeeId: string;
    actorUserId?: string;
    conversationId?: string;
    expectedThreadId?: string | null;
    expectedMailHandoverId?: string | null;
  },
): Promise<Approval | null> {
  return updateMailReviewDraft({
    ...args,
    actorUserId: args.actorUserId,
    actorEmployeeId: args.actorUserId ? undefined : args.employeeId,
    expectedEmployeeId: args.employeeId,
    expectedThreadId: args.expectedThreadId,
    expectedMailHandoverId: args.expectedMailHandoverId,
  });
}

/** Send the exact reviewed payload; no provider draft exists before this call. */
export async function executeMailReviewApproval(
  approval: Approval,
  dependencies: MailActionDependencies = {},
): Promise<void> {
  if (approval.kind !== "mail_send" || approval.status !== "executing") {
    throw new Error("This email review has not been approved for sending.");
  }
  let payload: MailReviewPayload;
  let currentSource: Awaited<ReturnType<typeof reviewSource>>;
  let attachments: { filename: string; mimeType: string; content: Buffer }[];
  try {
    if (!approval.decidedByUserId) throw new Error("The approving Member is missing.");
    const membership = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: approval.companyId,
      userId: approval.decidedByUserId,
    });
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw new Error("An owner or admin must still have access to send this email.");
    }
    payload = parseMailReviewPayload(approval.payloadJson);
    validateReviewRecipients(payload.draft);
    const source = await reviewSource({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      accountId: payload.accountId,
      threadId: payload.threadId,
      mailHandoverId: payload.mailHandoverId,
      routineId: payload.origin.routineId,
      runId: payload.origin.runId,
      conversationId: payload.origin.conversationId,
    });
    if (
      source.account.id !== payload.accountId ||
      source.fingerprint !== payload.sourceFingerprint
    ) {
      throw new Error(
        payload.threadId
          ? "The email thread changed after this reply was prepared. Review a fresh reply before sending."
          : "The mailbox or its authority changed after this email was prepared. Review a fresh email before sending.",
      );
    }
    attachments = reviewedAttachmentBytes(payload);
    currentSource = await reviewSource({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      accountId: payload.accountId,
      threadId: payload.threadId,
      mailHandoverId: payload.mailHandoverId,
      routineId: payload.origin.routineId,
      runId: payload.origin.runId,
      conversationId: payload.origin.conversationId,
    });
    if (
      currentSource.account.id !== payload.accountId ||
      currentSource.fingerprint !== payload.sourceFingerprint
    ) {
      throw new Error(
        payload.threadId
          ? "The email thread or its authority changed while this reply was being prepared. Review a fresh reply before sending."
          : "The mailbox or its authority changed while this email was being prepared. Review a fresh email before sending.",
      );
    }
    // Run the shared suppression and Policy gates before delivery becomes
    // ambiguous. `sendMailMessage` repeats them at its mandatory choke.
    await assertRecipientsAllowed(approval.companyId, payload.draft);
  } catch (error) {
    await AppDataSource.getRepository(Approval).update(
      { id: approval.id, companyId: approval.companyId, status: "executing" },
      { resultJson: JSON.stringify({ deliveryStatus: "not_sent" }) },
    );
    throw error;
  }

  // Persist the known-safe state first. The shared send boundary changes it
  // immediately before the provider call, after local setup has succeeded.
  const markedNotSent = await AppDataSource.getRepository(Approval).update(
    { id: approval.id, companyId: approval.companyId, status: "executing" },
    { resultJson: JSON.stringify({ deliveryStatus: "not_sent" }) },
  );
  if (markedNotSent.affected !== 1) {
    throw new Error("The email review changed before Genosyn prepared delivery.");
  }
  const acceptance: { providerMessageRef?: string; sentAt?: string } = {};
  let sentMessageId: string | null = null;
  try {
    const sent = await sendMailMessage(
      currentSource.account,
      {
        to: payload.draft.to,
        cc: payload.draft.cc || undefined,
        bcc: payload.draft.bcc || undefined,
        subject: payload.draft.subject,
        bodyText: payload.draft.bodyText,
        attachments,
        reviewedThreading: {
          inReplyTo: payload.threading.inReplyTo ?? undefined,
          references: payload.threading.references ?? undefined,
        },
      },
      currentSource.thread,
      {
        ...dependencies,
        onSendAttempt: async () => {
          // Mailbox acquisition and MIME assembly happen after the earlier
          // preflight. Close that setup window immediately before the provider
          // call: new inbound evidence, a revoked Grant/account, a Suppression,
          // or a company Policy change must still stop this exact send.
          await dependencies.onSendAttempt?.();
          await revalidateAttachmentAuthority(approval, payload);
          const finalMembership = await AppDataSource.getRepository(Membership).findOneBy({
            companyId: approval.companyId,
            userId: approval.decidedByUserId!,
          });
          if (!finalMembership || !["owner", "admin"].includes(finalMembership.role)) {
            throw new Error("An owner or admin must still have access to send this email.");
          }
          const finalSource = await reviewSource({
            companyId: approval.companyId,
            employeeId: approval.employeeId,
            accountId: payload.accountId,
            threadId: payload.threadId,
            mailHandoverId: payload.mailHandoverId,
            routineId: payload.origin.routineId,
            runId: payload.origin.runId,
            conversationId: payload.origin.conversationId,
          });
          if (
            finalSource.account.id !== payload.accountId ||
            finalSource.fingerprint !== payload.sourceFingerprint
          ) {
            throw new Error(
              payload.threadId
                ? "The email thread or its authority changed immediately before sending. Review a fresh reply instead."
                : "The mailbox or its authority changed immediately before sending. Review a fresh email instead.",
            );
          }
          await assertRecipientsAllowed(approval.companyId, payload.draft);
          const markedAttempting = await AppDataSource.getRepository(Approval).update(
            { id: approval.id, companyId: approval.companyId, status: "executing" },
            {
              resultJson: JSON.stringify({ deliveryStatus: "attempting" }),
              decidedAt: new Date(),
            },
          );
          if (markedAttempting.affected !== 1) {
            throw new Error("The email review changed before Genosyn contacted the mailbox.");
          }
        },
        onSendAccepted: async (message) => {
          acceptance.providerMessageRef = message.ref;
          acceptance.sentAt = (message.sentAt ?? new Date()).toISOString();
          await AppDataSource.getRepository(Approval).update(
            { id: approval.id, companyId: approval.companyId, status: "executing" },
            {
              resultJson: JSON.stringify({
                providerMessageRef: acceptance.providerMessageRef,
                sentAt: acceptance.sentAt,
              }),
            },
          );
          await dependencies.onSendAccepted?.(message);
        },
      },
    );
    sentMessageId = sent.id;
  } catch (error) {
    if (!acceptance.providerMessageRef || !acceptance.sentAt) throw error;
    // eslint-disable-next-line no-console
    console.error(
      `[mail-review] provider accepted ${approval.id}, but refreshing the local mirror failed:`,
      error,
    );
  }
  const providerMessageRef = acceptance.providerMessageRef;
  const sentAt = acceptance.sentAt;
  if (!providerMessageRef || !sentAt) {
    throw new Error("The mailbox did not confirm that this reviewed email was accepted.");
  }
  try {
    await AppDataSource.getRepository(Approval).update(
      { id: approval.id, companyId: approval.companyId, status: "executing" },
      { resultJson: JSON.stringify({ sentMessageId, providerMessageRef, sentAt }) },
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[mail-review] send outcome failed for ${approval.id}:`, error);
  }
  try {
    await recordAudit({
      companyId: approval.companyId,
      actorUserId: approval.decidedByUserId,
      action: "mail.review.send",
      targetType: sentMessageId ? "mail_message" : "mail_provider_message",
      targetId: sentMessageId ?? providerMessageRef,
      targetLabel: payload.draft.subject,
      runId: payload.origin.runId,
      conversationId: payload.origin.conversationId,
      metadata: {
        approvalId: approval.id,
        employeeId: approval.employeeId,
        accountId: payload.accountId,
        threadId: payload.threadId,
      },
    });
  } catch (error) {
    // The provider already accepted the message. Audit repair must not turn a
    // successful send into an ambiguous, retryable-looking failure.
    // eslint-disable-next-line no-console
    console.error(`[mail-review] send audit failed for ${approval.id}:`, error);
  }
  try {
    await AppDataSource.getRepository(JournalEntry).save(
      AppDataSource.getRepository(JournalEntry).create({
        employeeId: approval.employeeId,
        kind: "system",
        title: `Sent reviewed email: "${payload.draft.subject}"`,
        body: payload.threadId
          ? `A company owner or admin reviewed and sent your proposed reply on email thread ${payload.threadId}.`
          : `A company owner or admin reviewed and sent your proposed email from mailbox ${payload.accountId}.`,
        routineId: null,
        runId: null,
        authorUserId: approval.decidedByUserId,
      }),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[mail-review] send journal failed for ${approval.id}:`, error);
  }
}

const MAIL_REVIEW_STALE_EXECUTION_MS = 60 * 60_000;

/**
 * A process can disappear after the decision CAS but before its finalizer.
 * A durable provider receipt is enough to finalize success. Without one,
 * delivery is unknowable, so fail terminally and preserve whatever result was
 * recorded. Retrying here would risk sending the reviewed email twice.
 */
export async function reconcileMailReviewApprovals(
  companyId: string,
  now = new Date(),
): Promise<void> {
  const repo = AppDataSource.getRepository(Approval);
  // The Decision stack is also a freshness boundary. Remove cards whose
  // source or delivery authority is already known to be stale instead of
  // inviting a Member to press Send only to discover that at execution time.
  const pending = await repo.find({
    where: {
      companyId,
      kind: "mail_send",
      status: "pending",
    },
    select: { id: true },
  });
  for (const listed of pending) {
    const row = await repo.findOneBy({
      id: listed.id,
      companyId,
      kind: "mail_send",
      status: "pending",
    });
    if (!row) continue;
    let current = false;
    let threadId: string | null = null;
    try {
      const payload = parseMailReviewPayload(row.payloadJson);
      threadId = payload.threadId;
      const source = await reviewSource({
        companyId,
        employeeId: row.employeeId,
        accountId: payload.accountId,
        threadId: payload.threadId,
        mailHandoverId: payload.mailHandoverId,
        routineId: payload.origin.routineId,
        runId: payload.origin.runId,
        conversationId: payload.origin.conversationId,
      });
      current =
        source.account.id === payload.accountId && source.fingerprint === payload.sourceFingerprint;
    } catch (error) {
      if (!staleMailReviewSourceError(error)) throw error;
      current = false;
    }
    if (current) continue;
    await repo.update(
      {
        id: row.id,
        companyId,
        kind: "mail_send",
        status: "pending",
        payloadJson: row.payloadJson === null ? IsNull() : row.payloadJson,
      },
      {
        status: "expired",
        errorMessage: threadId
          ? "This email review is no longer current. Its source, thread, or delivery authority changed. Prepare a fresh reply."
          : "This email review is no longer current. Its source or mailbox authority changed. Prepare a fresh email.",
      },
    );
  }

  const stale = {
    companyId,
    kind: "mail_send" as const,
    status: "executing" as const,
    decidedAt: LessThan(new Date(now.getTime() - MAIL_REVIEW_STALE_EXECUTION_MS)),
  };
  if (!(await repo.existsBy(stale))) return;
  const rows = await repo.find({ where: stale, select: { id: true } });
  for (const listed of rows) {
    const row = await repo.findOneBy({ id: listed.id, ...stale });
    if (!row) continue;
    const accepted = mailReviewOutcome(row);
    const deliveryStatus = mailReviewDeliveryStatus(row);
    await repo.update(
      {
        id: row.id,
        companyId,
        kind: "mail_send",
        status: "executing",
        resultJson: row.resultJson === null ? IsNull() : row.resultJson,
      },
      accepted
        ? { status: "approved", errorMessage: null }
        : {
            status: "execution_failed",
            errorMessage:
              deliveryStatus === "not_sent"
                ? "The reviewed email stopped before Genosyn contacted the mailbox. It was not sent. Review the source before preparing another email."
                : "The reviewed email stopped reporting during delivery. Its send outcome is unverified and it was not retried. Check the source before preparing another email.",
          },
    );
  }
}

export async function recordMailReviewRejection(approval: Approval): Promise<void> {
  const payload = parseMailReviewPayload(approval.payloadJson);
  await AppDataSource.getRepository(JournalEntry).save(
    AppDataSource.getRepository(JournalEntry).create({
      employeeId: approval.employeeId,
      kind: "system",
      title: `${payload.threadId ? "Email reply" : "Email"} discarded: "${payload.draft.subject}"`,
      body: `A company owner or admin discarded this proposed ${payload.threadId ? "reply" : "email"}. Nothing was saved to the mailbox or sent.`,
      routineId: null,
      runId: null,
      authorUserId: approval.decidedByUserId,
    }),
  );
}
