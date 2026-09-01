import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { parseAddressList } from "../../lib/emailAddress.js";
import { broadcastToCompany } from "../realtime.js";
import { fetchMailAttachmentsBytes } from "./attachments.js";
import { mailboxForAccount } from "./mailbox/index.js";
import { CANONICAL_LABELS, type Mailbox } from "./mailbox/types.js";
import type { MimeAttachment, MimeFields } from "./mime.js";
import { readAttachments, releaseAttachments } from "./outbox.js";
import { assertRecipientsAllowed } from "./suppression.js";
import {
  columnHasLabel,
  recomputeThread,
  updateMessageLabels,
  upsertMailMessage,
} from "./store.js";

/**
 * Write-through mailbox actions. Every mutation talks to the mail server
 * FIRST, then refreshes the affected slice of the local mirror — never the
 * other way around, so an upstream failure leaves the mirror untouched and
 * the caller sees the real error. This is what "two-way sync" means for
 * actions originating in Genosyn; inbound changes ride the sync engines.
 *
 * Shared by the human HTTP routes and the AI MCP tools, so both surfaces
 * behave identically — and, since 1.166, by Gmail and IMAP mailboxes alike.
 * Everything provider-shaped lives behind the {@link Mailbox} interface in
 * `mailbox/`; this file says *what* should happen and never *how*.
 */

export type ThreadAction =
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar"
  | "archive"
  | "moveToInbox"
  | "trash"
  | "untrash"
  | "applyLabel"
  | "removeLabel";

/**
 * The two pieces of outside world this file touches, in the same seam shape
 * `attachments.ts` and `unsubscribe.ts` already use. Production omits it and
 * gets the account's real mailbox and the real WebSocket fan-out.
 *
 * Both halves exist because the invariants that live *here* are invisible
 * downstream. Whether `star` reached the server as one `setFlagged` call or as
 * a Gmail label edit leaves no trace in the mirror, and neither does whether a
 * 50-thread bulk run broadcast once or fifty times — the only place to observe
 * either is at the boundary the call crosses.
 */
export type MailActionDependencies = {
  mailbox?: (account: MailAccount) => Promise<Mailbox>;
  notify?: (account: MailAccount) => void;
};

export async function performThreadAction(
  account: MailAccount,
  thread: MailThread,
  action: ThreadAction,
  opts: { labelId?: string; labelName?: string; silent?: boolean } = {},
  dependencies: MailActionDependencies = {},
): Promise<void> {
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  const ref = thread.gmailThreadId;
  switch (action) {
    case "markRead":
      await mailbox.setRead(ref, true);
      break;
    case "markUnread":
      await mailbox.setRead(ref, false);
      break;
    case "star":
      await mailbox.setFlagged(ref, true);
      break;
    case "unstar":
      await mailbox.setFlagged(ref, false);
      break;
    case "archive":
      await mailbox.archive(ref);
      break;
    case "moveToInbox":
      await mailbox.moveToInbox(ref);
      break;
    case "trash":
      await mailbox.trash(ref);
      break;
    case "untrash":
      await mailbox.untrash(ref);
      break;
    case "applyLabel": {
      const label = await resolveLabel(account, mailbox, opts, { createIfMissing: true });
      await mailbox.applyLabel(ref, label.gmailLabelId);
      break;
    }
    case "removeLabel": {
      const label = await resolveLabel(account, mailbox, opts, { createIfMissing: false });
      await mailbox.removeLabel(ref, label.gmailLabelId);
      break;
    }
  }
  await refreshThreadFromMailbox(account, mailbox, ref);
  if (!opts.silent) (dependencies.notify ?? notifyMailChanged)(account);
}

/**
 * Threads per bulk request. Each one costs an upstream mutation plus a
 * re-read, so a few hundred in a single request would outlive any proxy
 * timeout — the client chunks instead, which also lets it show progress.
 */
export const MAX_BULK_THREAD_IDS = 50;

export type BulkThreadResult = {
  succeeded: string[];
  skipped: { id: string; reason: string }[];
};

/**
 * Apply one action to many threads.
 *
 * Neither backend exposes a batch endpoint for this, so it is an honest
 * server-side loop rather than a pretend bulk call. Two things keep it safe at
 * size: each item is isolated, so one thread the server rejects cannot abort
 * the rest of the run; and the realtime broadcast fires once at the end
 * instead of once per thread, which would otherwise make every connected
 * client refetch N times.
 */
export async function bulkThreadAction(
  account: MailAccount,
  threads: MailThread[],
  action: ThreadAction,
  opts: { labelId?: string; labelName?: string } = {},
  dependencies: MailActionDependencies = {},
): Promise<BulkThreadResult> {
  const succeeded: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const thread of threads) {
    try {
      await performThreadAction(account, thread, action, { ...opts, silent: true }, dependencies);
      succeeded.push(thread.id);
    } catch (err) {
      skipped.push({
        id: thread.id,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  if (succeeded.length > 0) (dependencies.notify ?? notifyMailChanged)(account);
  return { succeeded, skipped };
}

/** Look a label up by id or (case-insensitive) name; optionally create a
 * user label upstream when the name is new — that's how AI categorize flows
 * mint their taxonomy on first use. */
async function resolveLabel(
  account: MailAccount,
  mailbox: Mailbox,
  opts: { labelId?: string; labelName?: string },
  { createIfMissing }: { createIfMissing: boolean },
): Promise<MailLabel> {
  const repo = AppDataSource.getRepository(MailLabel);
  if (opts.labelId) {
    const byId =
      (await repo.findOneBy({ accountId: account.id, id: opts.labelId })) ??
      (await repo.findOneBy({
        accountId: account.id,
        gmailLabelId: opts.labelId,
      }));
    if (byId) return byId;
    throw new Error("Label not found");
  }
  const name = (opts.labelName ?? "").trim();
  if (!name) throw new Error("labelId or labelName is required");
  const all = await repo.find({ where: { accountId: account.id } });
  const existing = all.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  if (!createIfMissing) throw new Error(`Label "${name}" not found`);
  const created = await mailbox.createLabel(name);
  return repo.save(
    repo.create({
      companyId: account.companyId,
      accountId: account.id,
      gmailLabelId: created.ref,
      name: created.name,
      labelType: created.labelType,
      color: created.color,
    }),
  );
}

// ---------- Compose / reply ----------

export type ComposeFields = {
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  /** Tokens for files staged via the outbox before send/draft (human uploads). */
  attachmentIds?: string[];
  /** Pre-resolved attachment bytes (AI employees, whose files come from
   *  Resources / rendered invoices rather than the staging outbox). Takes
   *  precedence over `attachmentIds`; the two are never mixed on one call. */
  attachments?: MimeAttachment[];
};

/**
 * Who authored a message Genosyn creates. Mirrors {@link MailMessage}'s
 * `createdBy*` columns: a human Member **or** an AI Employee, never both, plus
 * the Run/Routine when an employee wrote it while executing one. Kept separate
 * from {@link ComposeFields} because it never reaches the MIME composer — it is
 * provenance on our mirror row, not part of the email.
 */
export type MailAuthorship = {
  userId?: string | null;
  employeeId?: string | null;
  routineId?: string | null;
  runId?: string | null;
};

/** Stamp authorship onto a freshly-ingested row. Mutates; caller saves. */
function applyAuthorship(row: MailMessage, author: MailAuthorship): void {
  row.createdByUserId = author.userId ?? null;
  row.createdByEmployeeId = author.employeeId ?? null;
  row.createdByRoutineId = author.routineId ?? null;
  row.createdByRunId = author.runId ?? null;
}

/**
 * Carry authorship across a row swap. A draft gets a new identity when it is
 * edited or sent, so the replacement row must inherit who wrote it —
 * otherwise editing an AI-written draft would silently orphan it from its
 * Routine. Mutates; caller saves.
 */
function carryAuthorship(from: MailMessage, to: MailMessage): void {
  to.createdByUserId = from.createdByUserId;
  to.createdByEmployeeId = from.createdByEmployeeId;
  to.createdByRoutineId = from.createdByRoutineId;
  to.createdByRunId = from.createdByRunId;
}

/** Reply-threading headers + default subject, derived from the newest
 * non-draft message of the thread. */
async function replyContext(thread: MailThread): Promise<{
  subject: string;
  inReplyTo?: string;
  references?: string;
  defaultTo: string;
  defaultCcPool: string;
}> {
  const msgRepo = AppDataSource.getRepository(MailMessage);
  const messages = await msgRepo.find({
    where: { threadId: thread.id },
    order: { sentAt: "DESC" },
  });
  const last = messages.find((m) => !columnHasLabel(m.labelIds, CANONICAL_LABELS.draft));
  if (!last) {
    return {
      subject: thread.subject,
      defaultTo: "",
      defaultCcPool: "",
    };
  }
  const subject = /^re:/i.test(last.subject)
    ? last.subject
    : `Re: ${last.subject}`;
  const references = [last.referencesHeader, last.messageIdHeader]
    .filter(Boolean)
    .join(" ");
  return {
    subject,
    inReplyTo: last.messageIdHeader || undefined,
    references: references || undefined,
    // Use the canonical address rather than rebuilding `Display Name <email>`.
    // A name containing a comma must be RFC-quoted; handing the address alone
    // to the composer is both unambiguous and immune to malformed source names.
    defaultTo: last.fromEmail,
    defaultCcPool: [last.toEmails, last.ccEmails].filter(Boolean).join(", "),
  };
}

/** Everyone on the last message except the mailbox itself — the reply-all set. */
export async function replyAllRecipients(
  account: MailAccount,
  thread: MailThread,
): Promise<{ to: string; cc: string }> {
  const ctx = await replyContext(thread);
  const self = account.address.toLowerCase();
  const recipientEmails = (value: string) =>
    parseAddressList(value).addresses.filter((email) => email !== self);

  // The original sender goes in To — unless the last message was one the
  // mailbox itself sent (then defaultTo is our own address, which we drop and
  // let the cc pool carry the real recipients).
  const toList = recipientEmails(ctx.defaultTo);
  const cc = recipientEmails(ctx.defaultCcPool).filter(
    (email) => !toList.includes(email),
  );
  let to = toList;
  if (to.length === 0 && cc.length > 0) {
    to = [cc.shift()!]; // promote one cc into To so there's always a recipient
  }
  return { to: to.join(", "), cc: cc.join(", ") };
}

/**
 * Send a message — fresh compose when `thread` is null, reply on the thread
 * otherwise. Returns the mirrored sent message.
 */
export async function sendMailMessage(
  account: MailAccount,
  fields: ComposeFields,
  thread: MailThread | null,
  dependencies: MailActionDependencies = {},
): Promise<MailMessage> {
  // The do-not-email gate. Deliberately here rather than in the callers: every
  // compose path — a human pressing Send, an AI employee calling `send_mail`,
  // a sequence step — funnels through this function, so there is no way to
  // send that skips the check. See services/mail/suppression.ts.
  await assertRecipientsAllowed(account.companyId, fields);
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  const mime = await composeMime(account, fields, thread);
  const sent = await mailbox.sendMessage({ mime, thread: thread?.gmailThreadId });
  releaseAttachments(account.id, fields.attachmentIds ?? []);
  const { row } = await upsertMailMessage(account, sent);
  await recomputeThread(account, sent.threadRef);
  (dependencies.notify ?? notifyMailChanged)(account);
  return row;
}

/** Create a draft (reply draft when `thread` is set). Returns the mirrored
 * draft message row, `gmailDraftId` populated. */
export async function createMailDraft(
  account: MailAccount,
  fields: ComposeFields,
  thread: MailThread | null,
  author: MailAuthorship = {},
  dependencies: MailActionDependencies = {},
): Promise<MailMessage> {
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  const mime = await composeMime(account, fields, thread);
  const draft = await mailbox.createDraft({ mime, thread: thread?.gmailThreadId });
  releaseAttachments(account.id, fields.attachmentIds ?? []);
  const { row } = await upsertMailMessage(account, draft.message);
  row.gmailDraftId = draft.draftRef;
  applyAuthorship(row, author);
  await AppDataSource.getRepository(MailMessage).save(row);
  await recomputeThread(account, draft.message.threadRef);
  (dependencies.notify ?? notifyMailChanged)(account);
  return row;
}

/** Update-only knobs. See {@link UpdateDraftOptions.keepAttachmentIndexes} —
 *  an edit rebuilds the whole MIME, so surviving files are opt-in. */
export type UpdateDraftOptions = {
  /**
   * Positional indexes of the draft's existing attachments to carry over,
   * numbered the same way the download route numbers them. An edit replaces
   * the draft with whatever MIME we hand over, so anything left out of this
   * list is dropped from the draft. Omit it (or pass `[]`) to keep none —
   * callers that supply the full file set themselves, like the employee's
   * `edit_mail_draft` tool, want exactly that.
   */
  keepAttachmentIndexes?: number[];
};

/**
 * Replace a draft's content. Both backends give the updated draft a new
 * identity — Gmail reissues the message id, IMAP appends a new message and
 * expunges the old one — so the old mirror row is dropped and the fresh one
 * ingested.
 */
export async function updateMailDraft(
  account: MailAccount,
  draftRow: MailMessage,
  fields: ComposeFields,
  opts: UpdateDraftOptions = {},
  dependencies: MailActionDependencies = {},
): Promise<MailMessage> {
  if (!draftRow.gmailDraftId) throw new Error("Not a draft");
  // Pull the kept files down before touching the server: if a download fails the
  // draft is still whole, whereas a half-written replacement would have lost
  // them for good.
  const carried = (
    await fetchMailAttachmentsBytes(
      account,
      draftRow,
      opts.keepAttachmentIndexes ?? [],
      // Same mailbox, so the same seam: an override that only reached the
      // draft call would have the edit read its old files from one server and
      // write the replacement to another.
      dependencies.mailbox ? { mailbox: dependencies.mailbox } : undefined,
    )
  ).map(({ meta, bytes }) => ({
    filename: meta.filename || "attachment",
    mimeType: meta.mimeType || "application/octet-stream",
    content: bytes,
  }));
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: draftRow.threadId,
  });
  const mime = await composeMime(account, fields, thread, carried);
  // Ingest the replacement FIRST, then drop the old row — so a failure
  // fetching the new message can't leave the draft missing from the mirror.
  // Both backends reissue the message's identity on update, so the old row
  // usually differs; only delete it when it isn't the row we just upserted.
  const draft = await mailbox.updateDraft({
    draftRef: draftRow.gmailDraftId,
    mime,
    thread: thread?.gmailThreadId,
  });
  releaseAttachments(account.id, fields.attachmentIds ?? []);
  const { row } = await upsertMailMessage(account, draft.message);
  row.gmailDraftId = draft.draftRef;
  carryAuthorship(draftRow, row);
  await AppDataSource.getRepository(MailMessage).save(row);
  if (row.id !== draftRow.id) {
    await AppDataSource.getRepository(MailMessage).delete({ id: draftRow.id });
  }
  await recomputeThread(account, draft.message.threadRef);
  (dependencies.notify ?? notifyMailChanged)(account);
  return row;
}

/**
 * Send an existing draft. Returns the mirrored sent message.
 *
 * `silent` suppresses the realtime broadcast so a bulk run can fire one
 * `mail.updated` at the end instead of one per draft — a 200-draft batch would
 * otherwise stampede every connected client with 200 refreshes.
 */
export async function sendMailDraft(
  account: MailAccount,
  draftRow: MailMessage,
  opts: { silent?: boolean } = {},
  dependencies: MailActionDependencies = {},
): Promise<MailMessage> {
  if (!draftRow.gmailDraftId) throw new Error("Not a draft");
  // The second send path, and the one bulk send drives. A draft may have been
  // written days before it is approved, and the recipient can have
  // unsubscribed in between — so the gate is re-run here at send time, not
  // inherited from whenever the draft was composed.
  await assertRecipientsAllowed(account.companyId, {
    to: draftRow.toEmails,
    cc: draftRow.ccEmails,
    bcc: draftRow.bccEmails,
  });
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  // Ingest the sent message before removing the draft row, so a failure
  // reading it back doesn't vanish the message from the mirror — it went out
  // either way.
  const sent = await mailbox.sendDraft(draftRow.gmailDraftId);
  const { row } = await upsertMailMessage(account, sent);
  // The sent copy is not a draft, and on IMAP it is not even a different row:
  // the copy filed in Sent carries the draft's own `Message-ID`, so it upserts
  // onto the draft's row rather than a new one and the delete below is skipped.
  // Without this the row keeps a handle to a draft that has been expunged, and
  // a message that has already gone out sits in Drafts forever, failing every
  // bulk send. A no-op on Gmail, where the row is always new.
  row.gmailDraftId = "";
  // Keep provenance on the sent copy — "this went out because the Weekly
  // Outreach routine wrote it" is worth as much in Sent as it was in Drafts.
  carryAuthorship(draftRow, row);
  await AppDataSource.getRepository(MailMessage).save(row);
  if (row.id !== draftRow.id) {
    await AppDataSource.getRepository(MailMessage).delete({ id: draftRow.id });
  }
  await recomputeThread(account, sent.threadRef);
  if (!opts.silent) (dependencies.notify ?? notifyMailChanged)(account);
  return row;
}

/** Discard a draft everywhere. `silent` — see {@link sendMailDraft}. */
export async function discardMailDraft(
  account: MailAccount,
  draftRow: MailMessage,
  opts: { silent?: boolean } = {},
  dependencies: MailActionDependencies = {},
): Promise<void> {
  if (!draftRow.gmailDraftId) throw new Error("Not a draft");
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  await mailbox.deleteDraft(draftRow.gmailDraftId);
  await AppDataSource.getRepository(MailMessage).delete({ id: draftRow.id });
  await recomputeThread(account, draftRow.gmailThreadId);
  if (!opts.silent) (dependencies.notify ?? notifyMailChanged)(account);
}

/**
 * Build the raw MIME for a send/draft call.
 *
 * `carried` is bytes already on the message being replaced (draft edits) and
 * always leads the attachment list, so an edit that adds a file appends to
 * what was there rather than reordering it.
 *
 * Staged uploads are *read* here and released by the caller once the message
 * has actually left. Composing can fail after this point — an expired
 * credential, a mail server that refuses the send — and a person retrying a
 * failed send must not find their attachments gone.
 */
async function composeMime(
  account: MailAccount,
  fields: ComposeFields,
  thread: MailThread | null,
  carried: MimeAttachment[] = [],
): Promise<MimeFields> {
  let subject = fields.subject ?? "";
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let to = fields.to;
  if (thread) {
    const ctx = await replyContext(thread);
    if (!subject) subject = ctx.subject;
    inReplyTo = ctx.inReplyTo;
    references = ctx.references;
    if (!to) to = ctx.defaultTo;
  }
  if (!to) throw new Error("Recipient (to) is required");
  const added =
    fields.attachments && fields.attachments.length > 0
      ? fields.attachments
      : fields.attachmentIds && fields.attachmentIds.length > 0
        ? readAttachments(account.id, fields.attachmentIds)
        : [];
  const all = [...carried, ...added];
  const attachments = all.length > 0 ? all : undefined;
  return {
    to,
    cc: fields.cc || undefined,
    bcc: fields.bcc || undefined,
    subject,
    bodyText: fields.bodyText,
    bodyHtml: fields.bodyHtml || undefined,
    inReplyTo,
    references,
    attachments,
  };
}

// ---------- Refresh helpers ----------

/** Re-read a conversation's label state after a mutation. */
async function refreshThreadFromMailbox(
  account: MailAccount,
  mailbox: Mailbox,
  threadRef: string,
): Promise<void> {
  for (const message of await mailbox.readThreadState(threadRef)) {
    await updateMessageLabels(account, message.ref, message.labelIds);
  }
  await recomputeThread(account, threadRef);
}

export function notifyMailChanged(account: MailAccount): void {
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
  });
}
