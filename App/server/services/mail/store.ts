import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { headerValue, parseAddress, type GmailMessage } from "./gmailClient.js";
import { toMailboxMessage } from "./mailbox/gmail.js";
import type { Mailbox, MailboxLabel, MailboxMessage } from "./mailbox/types.js";
import { createRevenueDocumentCandidatesForMessage } from "../revenue/documentCapture.js";

/**
 * The local-mirror write path shared by both sync engines and the
 * write-through actions: upsert normalized messages into MailMessage rows,
 * keep MailThread rollups consistent, and mirror the label catalog.
 *
 * Nothing here knows which provider produced a message. Each adapter hands
 * over a {@link MailboxMessage} — bodies already extracted, labels already
 * mapped into the canonical set — and this module writes rows.
 */

/** Cap on each stored body variant. Bigger than any email a human writes;
 * protects the DB from megabyte marketing blasts. */
const BODY_CAP = 512 * 1024;

// ---------- Label-string encoding ----------
// Label ids are stored space-delimited with sentinel spaces (" INBOX UNREAD ")
// so `LIKE '% INBOX %'` answers membership on both sqlite and postgres.

export function labelIdsToColumn(ids: string[]): string {
  const clean = ids.map((s) => s.trim()).filter(Boolean);
  return clean.length > 0 ? ` ${clean.join(" ")} ` : "";
}

export function columnToLabelIds(col: string): string[] {
  return col.split(/\s+/).filter(Boolean);
}

export function columnHasLabel(col: string, labelId: string): boolean {
  return col.includes(` ${labelId} `);
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… [truncated]` : s;
}

// ---------- Message upsert ----------

export type UpsertResult = { row: MailMessage; created: boolean };

/**
 * Upsert one normalized message. Creates the containing MailThread shell when
 * this is the first message we see for the conversation; callers batch
 * `recomputeThread` afterwards to refresh the rollup.
 *
 * Bodies on an existing row are kept whenever the incoming representation is
 * incomplete — either because the caller said so (`preserveRichContent`) or
 * because the message itself reports `hasBodies: false`, which is what a Gmail
 * `metadata` fetch after a timeout and an IMAP header-only pass both produce.
 * A degraded re-read therefore updates a message's flags without blanking mail
 * that was imported in full an hour ago.
 *
 * Reading `hasBodies` here rather than trusting the flag alone is deliberate:
 * a future caller that forgets it would otherwise destroy every body it
 * touched, silently, and the loss would not surface until a full re-read that
 * may never come. A caller holding a *complete* representation can still blank
 * a body, which is the case where blanking is the correct answer.
 */
export async function upsertMailMessage(
  account: MailAccount,
  message: MailboxMessage,
  options: { preserveRichContent?: boolean } = {},
): Promise<UpsertResult> {
  const msgRepo = AppDataSource.getRepository(MailMessage);
  const thread = await ensureThreadShell(account, message.threadRef);

  const headers = message.headers;
  const from = parseAddress(headerValue(headers, "From"));

  let row = await msgRepo.findOneBy({
    accountId: account.id,
    gmailMessageId: message.ref,
  });
  const created = !row;
  if (!row) {
    row = msgRepo.create({
      companyId: account.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: message.ref,
      gmailThreadId: message.threadRef,
    });
  }
  row.threadId = thread.id;
  row.gmailThreadId = message.threadRef;
  row.fromName = from.name;
  row.fromEmail = from.email;
  row.toEmails = headerValue(headers, "To");
  row.ccEmails = headerValue(headers, "Cc");
  row.bccEmails = headerValue(headers, "Bcc");
  row.subject = headerValue(headers, "Subject");
  row.snippet = message.snippet;
  const partial = options.preserveRichContent || !message.hasBodies;
  if (!partial || created) {
    row.bodyText = truncate(message.bodyText, BODY_CAP);
    row.bodyHtml = truncate(message.bodyHtml, BODY_CAP);
    row.attachmentsJson = JSON.stringify(message.attachments);
  }
  row.labelIds = labelIdsToColumn(message.labelIds);
  row.sentAt = message.sentAt;
  row.messageIdHeader = headerValue(headers, "Message-ID");
  row.referencesHeader = headerValue(headers, "References");
  row.inReplyToHeader = headerValue(headers, "In-Reply-To");
  row.sizeEstimate = message.sizeEstimate;
  // Only the adapter that produced a location knows one; Gmail sends "" and
  // must not clear a location an IMAP row is relying on.
  if (message.location) row.providerLocation = message.location;
  await msgRepo.save(row);
  const bodies = { attachments: message.attachments };
  if (bodies.attachments.length > 0) {
    try {
      await createRevenueDocumentCandidatesForMessage(account.companyId, row);
    } catch (error) {
      console.error(`[revenue-document-capture] ${row.id}: ${(error as Error).message}`);
    }
  }
  return { row, created };
}

/**
 * Upsert a Gmail message. A thin wrapper over {@link upsertMailMessage} kept
 * because the Gmail sync engine deals in `GmailMessage` end to end and there
 * is no reason to make every call site normalize by hand.
 */
export async function upsertGmailMessage(
  account: MailAccount,
  gm: GmailMessage,
  options: { preserveRichContent?: boolean } = {},
): Promise<UpsertResult> {
  // `preserveRichContent` is exactly the caller saying "this is a metadata
  // fetch", which is the same fact `hasBodies` carries.
  return upsertMailMessage(account, toMailboxMessage(gm, !options.preserveRichContent), options);
}

/** Update only the label set of an already-mirrored message. Used by the
 * incremental sync for label-change history records — the body is already
 * local, so a minimal-format fetch is enough. */
export async function updateMessageLabels(
  account: MailAccount,
  gmailMessageId: string,
  labelIds: string[],
): Promise<MailMessage | null> {
  const repo = AppDataSource.getRepository(MailMessage);
  const row = await repo.findOneBy({ accountId: account.id, gmailMessageId });
  if (!row) return null;
  row.labelIds = labelIdsToColumn(labelIds);
  await repo.save(row);
  return row;
}

export async function deleteMessageByGmailId(
  account: MailAccount,
  gmailMessageId: string,
): Promise<string | null> {
  const repo = AppDataSource.getRepository(MailMessage);
  const row = await repo.findOneBy({ accountId: account.id, gmailMessageId });
  if (!row) return null;
  await repo.delete({ id: row.id });
  return row.gmailThreadId;
}

async function ensureThreadShell(account: MailAccount, gmailThreadId: string): Promise<MailThread> {
  const repo = AppDataSource.getRepository(MailThread);
  const existing = await repo.findOneBy({
    accountId: account.id,
    gmailThreadId,
  });
  if (existing) return existing;
  return repo.save(
    repo.create({
      companyId: account.companyId,
      accountId: account.id,
      gmailThreadId,
    }),
  );
}

// ---------- Thread rollup ----------

/**
 * Recompute one thread's denormalized rollup from its member messages.
 * Deletes the thread row when its last message is gone.
 */
export async function recomputeThread(
  account: MailAccount,
  gmailThreadId: string,
): Promise<MailThread | null> {
  const threadRepo = AppDataSource.getRepository(MailThread);
  const msgRepo = AppDataSource.getRepository(MailMessage);
  const thread = await threadRepo.findOneBy({
    accountId: account.id,
    gmailThreadId,
  });
  if (!thread) return null;

  const messages = await msgRepo.find({
    where: { threadId: thread.id },
    order: { sentAt: "ASC" },
  });
  if (messages.length === 0) {
    await threadRepo.delete({ id: thread.id });
    return null;
  }

  const labelUnion = new Set<string>();
  let unread = false;
  let hasAttachments = false;
  const nonDrafts = messages.filter((m) => !columnHasLabel(m.labelIds, "DRAFT"));
  const visible = nonDrafts.length > 0 ? nonDrafts : messages;
  for (const m of messages) {
    for (const id of columnToLabelIds(m.labelIds)) labelUnion.add(id);
    if (columnHasLabel(m.labelIds, "UNREAD") && !columnHasLabel(m.labelIds, "DRAFT")) {
      unread = true;
    }
    if (m.attachmentsJson !== "[]") hasAttachments = true;
  }

  const newest = visible[visible.length - 1];
  const oldest = visible[0];
  thread.subject = oldest.subject || newest.subject;
  thread.snippet = newest.snippet;
  thread.participants = summarizeParticipants(account, visible);
  thread.labelIds = labelIdsToColumn(Array.from(labelUnion));
  thread.unread = unread;
  thread.messageCount = nonDrafts.length;
  thread.hasAttachments = hasAttachments;
  thread.lastMessageAt = newest.sentAt;
  await threadRepo.save(thread);
  return thread;
}

/** "Ada Lovelace, billing@acme.com +2" — counterparties first, self elided
 * unless the thread is all self (then fall back to who it was sent to). */
function summarizeParticipants(account: MailAccount, messages: MailMessage[]): string {
  const self = account.address.toLowerCase();
  const seen = new Map<string, string>();
  for (const m of messages) {
    const email = m.fromEmail.toLowerCase();
    if (!email || email === self) continue;
    if (!seen.has(email)) seen.set(email, m.fromName || m.fromEmail);
  }
  if (seen.size === 0) {
    const newest = messages[messages.length - 1];
    const first = newest.toEmails.split(",")[0]?.trim();
    if (first) {
      const parsed = parseAddress(first);
      seen.set(parsed.email || first, parsed.name || parsed.email || first);
    } else {
      seen.set(self, "me");
    }
  }
  const names = Array.from(seen.values());
  const head = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${head} +${names.length - 3}` : head;
}

// ---------- Labels ----------

/** Mirror the mailbox's label catalog: upsert everything present, delete rows
 * whose label disappeared upstream. */
export async function syncLabels(account: MailAccount, labels: MailboxLabel[]): Promise<void> {
  const repo = AppDataSource.getRepository(MailLabel);
  const existing = await repo.find({ where: { accountId: account.id } });
  const byRef = new Map(existing.map((l) => [l.gmailLabelId, l]));
  const seen = new Set<string>();
  for (const label of labels) {
    seen.add(label.ref);
    const row =
      byRef.get(label.ref) ??
      repo.create({
        companyId: account.companyId,
        accountId: account.id,
        gmailLabelId: label.ref,
      });
    row.name = label.name;
    row.labelType = label.labelType;
    row.color = label.color;
    await repo.save(row);
  }
  for (const l of existing) {
    if (!seen.has(l.gmailLabelId)) await repo.delete({ id: l.id });
  }
}

// ---------- Draft-id mapping ----------

/**
 * A draft's handle lives in a different namespace from its message's, on both
 * providers — a Gmail draft id, an IMAP folder-and-UID — and we need it to
 * edit, send or discard. One listing pass maps handles onto the mirrored
 * messages; rows whose draft disappeared (sent or discarded elsewhere) get the
 * handle cleared.
 */
export async function refreshDraftIds(
  account: MailAccount,
  mailbox: Mailbox,
  assertWritable: () => void | Promise<void> = () => {},
): Promise<void> {
  const drafts = await mailbox.listDraftRefs();
  await assertWritable();
  const byMessageId = new Map<string, string>();
  for (const d of drafts) byMessageId.set(d.messageRef, d.draftRef);
  const repo = AppDataSource.getRepository(MailMessage);
  const local = await repo
    .createQueryBuilder("m")
    .where("m.accountId = :aid", { aid: account.id })
    .andWhere("(m.gmailDraftId != '' OR m.labelIds LIKE :draft)", {
      draft: "% DRAFT %",
    })
    .getMany();
  for (const row of local) {
    await assertWritable();
    const draftId = byMessageId.get(row.gmailMessageId) ?? "";
    if (row.gmailDraftId !== draftId) {
      row.gmailDraftId = draftId;
      await repo.save(row);
    }
  }
}
