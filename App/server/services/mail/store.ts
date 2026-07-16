import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import {
  extractBodies,
  headerValue,
  parseAddress,
  listDrafts,
  type GmailLabel,
  type GmailMessage,
} from "./gmailClient.js";

/**
 * The local-mirror write path shared by the sync engine and the
 * write-through actions: upsert Gmail messages into MailMessage rows,
 * keep MailThread rollups consistent, and mirror the label catalog.
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
 * Upsert one full-format Gmail message. Creates the containing MailThread
 * shell when this is the first message we see for the conversation; callers
 * batch `recomputeThread` afterwards to refresh the rollup.
 */
export async function upsertGmailMessage(
  account: MailAccount,
  gm: GmailMessage,
): Promise<UpsertResult> {
  const msgRepo = AppDataSource.getRepository(MailMessage);
  const thread = await ensureThreadShell(account, gm.threadId);

  const headers = gm.payload?.headers;
  const bodies = extractBodies(gm.payload);
  const from = parseAddress(headerValue(headers, "From"));
  const sentAtMs = Number(gm.internalDate ?? "0");

  let row = await msgRepo.findOneBy({
    accountId: account.id,
    gmailMessageId: gm.id,
  });
  const created = !row;
  if (!row) {
    row = msgRepo.create({
      companyId: account.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: gm.id,
      gmailThreadId: gm.threadId,
    });
  }
  row.threadId = thread.id;
  row.gmailThreadId = gm.threadId;
  row.fromName = from.name;
  row.fromEmail = from.email;
  row.toEmails = headerValue(headers, "To");
  row.ccEmails = headerValue(headers, "Cc");
  row.bccEmails = headerValue(headers, "Bcc");
  row.subject = headerValue(headers, "Subject");
  row.snippet = gm.snippet ?? "";
  row.bodyText = truncate(bodies.text, BODY_CAP);
  row.bodyHtml = truncate(bodies.html, BODY_CAP);
  row.labelIds = labelIdsToColumn(gm.labelIds ?? []);
  row.sentAt = sentAtMs > 0 ? new Date(sentAtMs) : null;
  row.messageIdHeader = headerValue(headers, "Message-ID");
  row.referencesHeader = headerValue(headers, "References");
  row.inReplyToHeader = headerValue(headers, "In-Reply-To");
  row.attachmentsJson = JSON.stringify(bodies.attachments);
  row.sizeEstimate = gm.sizeEstimate ?? 0;
  await msgRepo.save(row);
  return { row, created };
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

async function ensureThreadShell(
  account: MailAccount,
  gmailThreadId: string,
): Promise<MailThread> {
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
  const nonDrafts = messages.filter(
    (m) => !columnHasLabel(m.labelIds, "DRAFT"),
  );
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
function summarizeParticipants(
  account: MailAccount,
  messages: MailMessage[],
): string {
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

/** Mirror the Gmail label catalog: upsert everything present, delete rows
 * whose label disappeared upstream. */
export async function syncLabels(
  account: MailAccount,
  labels: GmailLabel[],
): Promise<void> {
  const repo = AppDataSource.getRepository(MailLabel);
  const existing = await repo.find({ where: { accountId: account.id } });
  const byGmailId = new Map(existing.map((l) => [l.gmailLabelId, l]));
  const seen = new Set<string>();
  for (const gl of labels) {
    seen.add(gl.id);
    const row =
      byGmailId.get(gl.id) ??
      repo.create({
        companyId: account.companyId,
        accountId: account.id,
        gmailLabelId: gl.id,
      });
    row.name = gl.name;
    row.labelType = gl.type === "system" ? "system" : "user";
    row.color = gl.color?.backgroundColor ?? "";
    await repo.save(row);
  }
  for (const l of existing) {
    if (!seen.has(l.gmailLabelId)) await repo.delete({ id: l.id });
  }
}

// ---------- Draft-id mapping ----------

/**
 * Gmail draft ids live in a separate namespace from message ids, and we need
 * them to edit / send / discard. One drafts.list pass maps them onto the
 * mirrored messages; rows whose draft disappeared (sent or discarded
 * elsewhere) get the id cleared.
 */
export async function refreshDraftIds(
  account: MailAccount,
  token: string,
): Promise<void> {
  const drafts = await listDrafts(token);
  const byMessageId = new Map<string, string>();
  for (const d of drafts) {
    if (d.message?.id) byMessageId.set(d.message.id, d.id);
  }
  const repo = AppDataSource.getRepository(MailMessage);
  const local = await repo
    .createQueryBuilder("m")
    .where("m.accountId = :aid", { aid: account.id })
    .andWhere("(m.gmailDraftId != '' OR m.labelIds LIKE :draft)", {
      draft: "% DRAFT %",
    })
    .getMany();
  for (const row of local) {
    const draftId = byMessageId.get(row.gmailMessageId) ?? "";
    if (row.gmailDraftId !== draftId) {
      row.gmailDraftId = draftId;
      await repo.save(row);
    }
  }
}
