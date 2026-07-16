import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { broadcastToCompany } from "../realtime.js";
import { accessTokenForAccount } from "./accounts.js";
import {
  buildMime,
  createDraft as apiCreateDraft,
  createLabel as apiCreateLabel,
  deleteDraft as apiDeleteDraft,
  getMessage,
  getThread,
  modifyThread,
  sendDraft as apiSendDraft,
  sendMessage as apiSendMessage,
  trashThread,
  untrashThread,
  updateDraft as apiUpdateDraft,
  parseAddress,
} from "./gmailClient.js";
import { drainAttachments } from "./outbox.js";
import {
  columnHasLabel,
  recomputeThread,
  updateMessageLabels,
  upsertGmailMessage,
} from "./store.js";

/**
 * Write-through mailbox actions. Every mutation talks to the Gmail API
 * FIRST, then refreshes the affected slice of the local mirror — never the
 * other way around, so a Gmail failure leaves the mirror untouched and the
 * caller sees the real error. This is what "two-way sync" means for actions
 * originating in Genosyn; inbound changes ride the history sync.
 *
 * Shared by the human HTTP routes and the AI MCP tools, so both surfaces
 * behave identically.
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

export async function performThreadAction(
  account: MailAccount,
  thread: MailThread,
  action: ThreadAction,
  opts: { labelId?: string; labelName?: string } = {},
): Promise<void> {
  const token = await accessTokenForAccount(account);
  const gtid = thread.gmailThreadId;
  switch (action) {
    case "markRead":
      await modifyThread(token, gtid, [], ["UNREAD"]);
      break;
    case "markUnread":
      await modifyThread(token, gtid, ["UNREAD"], []);
      break;
    case "star":
      await modifyThread(token, gtid, ["STARRED"], []);
      break;
    case "unstar":
      await modifyThread(token, gtid, [], ["STARRED"]);
      break;
    case "archive":
      await modifyThread(token, gtid, [], ["INBOX"]);
      break;
    case "moveToInbox":
      await modifyThread(token, gtid, ["INBOX"], []);
      break;
    case "trash":
      await trashThread(token, gtid);
      break;
    case "untrash":
      await untrashThread(token, gtid);
      break;
    case "applyLabel": {
      const label = await resolveLabel(account, token, opts, {
        createIfMissing: true,
      });
      await modifyThread(token, gtid, [label.gmailLabelId], []);
      break;
    }
    case "removeLabel": {
      const label = await resolveLabel(account, token, opts, {
        createIfMissing: false,
      });
      await modifyThread(token, gtid, [], [label.gmailLabelId]);
      break;
    }
  }
  await refreshThreadFromApi(account, token, gtid);
  notifyMailChanged(account);
}

/** Look a label up by id or (case-insensitive) name; optionally create a
 * user label upstream when the name is new — that's how AI categorize flows
 * mint their taxonomy on first use. */
async function resolveLabel(
  account: MailAccount,
  token: string,
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
  const created = await apiCreateLabel(token, name);
  return repo.save(
    repo.create({
      companyId: account.companyId,
      accountId: account.id,
      gmailLabelId: created.id,
      name: created.name,
      labelType: "user",
      color: "",
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
  /** Tokens for files staged via the outbox before send/draft. */
  attachmentIds?: string[];
};

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
  const last = messages.find((m) => !columnHasLabel(m.labelIds, "DRAFT"));
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
  const from = last.fromName
    ? `${last.fromName} <${last.fromEmail}>`
    : last.fromEmail;
  return {
    subject,
    inReplyTo: last.messageIdHeader || undefined,
    references: references || undefined,
    defaultTo: from,
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
  const notSelf = (addr: string) =>
    parseAddress(addr).email.toLowerCase() !== self;
  const splitAddrs = (v: string) =>
    v.split(",").map((s) => s.trim()).filter(Boolean);

  // The original sender goes in To — unless the last message was one the
  // mailbox itself sent (then defaultTo is our own address, which we drop and
  // let the cc pool carry the real recipients).
  const toList = splitAddrs(ctx.defaultTo).filter(notSelf);
  const cc = splitAddrs(ctx.defaultCcPool).filter(notSelf);
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
): Promise<MailMessage> {
  const token = await accessTokenForAccount(account);
  const mime = await composeMime(account, fields, thread);
  const sent = await apiSendMessage(token, mime.raw, thread?.gmailThreadId);
  const full = await getMessage(token, sent.id, "full");
  const { row } = await upsertGmailMessage(account, full);
  await recomputeThread(account, full.threadId);
  notifyMailChanged(account);
  return row;
}

/** Create a draft (reply draft when `thread` is set). Returns the mirrored
 * draft message row, `gmailDraftId` populated. */
export async function createMailDraft(
  account: MailAccount,
  fields: ComposeFields,
  thread: MailThread | null,
): Promise<MailMessage> {
  const token = await accessTokenForAccount(account);
  const mime = await composeMime(account, fields, thread);
  const draft = await apiCreateDraft(token, mime.raw, thread?.gmailThreadId);
  const messageId = draft.message?.id;
  if (!messageId) throw new Error("Gmail did not return the draft message");
  const full = await getMessage(token, messageId, "full");
  const { row } = await upsertGmailMessage(account, full);
  row.gmailDraftId = draft.id;
  await AppDataSource.getRepository(MailMessage).save(row);
  await recomputeThread(account, full.threadId);
  notifyMailChanged(account);
  return row;
}

/**
 * Replace a draft's content. Gmail assigns the updated draft a NEW message
 * id, so the old mirror row is dropped and the fresh one ingested.
 */
export async function updateMailDraft(
  account: MailAccount,
  draftRow: MailMessage,
  fields: ComposeFields,
): Promise<MailMessage> {
  if (!draftRow.gmailDraftId) throw new Error("Not a draft");
  const token = await accessTokenForAccount(account);
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: draftRow.threadId,
  });
  const mime = await composeMime(account, fields, thread);
  const draft = await apiUpdateDraft(
    token,
    draftRow.gmailDraftId,
    mime.raw,
    thread?.gmailThreadId,
  );
  const messageId = draft.message?.id;
  if (!messageId) throw new Error("Gmail did not return the draft message");
  // Ingest the replacement FIRST, then drop the old row — so a failure
  // fetching the new message can't leave the draft missing from the mirror.
  // Gmail reissues the message id on update, so the old row usually differs;
  // only delete it when it isn't the row we just upserted.
  const full = await getMessage(token, messageId, "full");
  const { row } = await upsertGmailMessage(account, full);
  row.gmailDraftId = draft.id;
  await AppDataSource.getRepository(MailMessage).save(row);
  if (row.id !== draftRow.id) {
    await AppDataSource.getRepository(MailMessage).delete({ id: draftRow.id });
  }
  await recomputeThread(account, full.threadId);
  notifyMailChanged(account);
  return row;
}

/** Send an existing draft. Returns the mirrored sent message. */
export async function sendMailDraft(
  account: MailAccount,
  draftRow: MailMessage,
): Promise<MailMessage> {
  if (!draftRow.gmailDraftId) throw new Error("Not a draft");
  const token = await accessTokenForAccount(account);
  const sent = await apiSendDraft(token, draftRow.gmailDraftId);
  // Ingest the sent message before removing the draft row, so a fetch failure
  // doesn't vanish the message from the mirror (Gmail still sent it).
  const full = await getMessage(token, sent.id, "full");
  const { row } = await upsertGmailMessage(account, full);
  if (row.id !== draftRow.id) {
    await AppDataSource.getRepository(MailMessage).delete({ id: draftRow.id });
  }
  await recomputeThread(account, full.threadId);
  notifyMailChanged(account);
  return row;
}

/** Discard a draft everywhere. */
export async function discardMailDraft(
  account: MailAccount,
  draftRow: MailMessage,
): Promise<void> {
  if (!draftRow.gmailDraftId) throw new Error("Not a draft");
  const token = await accessTokenForAccount(account);
  await apiDeleteDraft(token, draftRow.gmailDraftId);
  await AppDataSource.getRepository(MailMessage).delete({ id: draftRow.id });
  await recomputeThread(account, draftRow.gmailThreadId);
  notifyMailChanged(account);
}

async function composeMime(
  account: MailAccount,
  fields: ComposeFields,
  thread: MailThread | null,
): Promise<{ raw: string }> {
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
  const attachments =
    fields.attachmentIds && fields.attachmentIds.length > 0
      ? drainAttachments(account.id, fields.attachmentIds)
      : undefined;
  return {
    raw: buildMime({
      to,
      cc: fields.cc || undefined,
      bcc: fields.bcc || undefined,
      subject,
      bodyText: fields.bodyText,
      bodyHtml: fields.bodyHtml || undefined,
      inReplyTo,
      references,
      attachments,
    }),
  };
}

// ---------- Refresh helpers ----------

/** Re-read a thread's label state (minimal format) after a modify call. */
async function refreshThreadFromApi(
  account: MailAccount,
  token: string,
  gmailThreadId: string,
): Promise<void> {
  const minimal = await getThread(token, gmailThreadId, "minimal");
  for (const gm of minimal.messages ?? []) {
    await updateMessageLabels(account, gm.id, gm.labelIds ?? []);
  }
  await recomputeThread(account, gmailThreadId);
}

function notifyMailChanged(account: MailAccount): void {
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
  });
}
