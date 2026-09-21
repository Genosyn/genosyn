import { AppDataSource } from "../../db/datasource.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import type { MailAccount } from "../../db/entities/MailAccount.js";
import type { MailThread } from "../../db/entities/MailThread.js";
import { createHash } from "node:crypto";
import { summarizeMailAttachments } from "./attachments.js";
import { readMailBody, type MailBodyReadOptions } from "./bodyRead.js";
import { columnToLabelIds } from "./store.js";
import { mailboxForAccount, type Mailbox } from "./mailbox/index.js";

/** The caller checks the mailbox Read Grant before an upstream read. */
export async function readMailMessageForAgent(
  account: MailAccount,
  message: MailMessage,
  options: MailBodyReadOptions & { source?: "mirror" | "mailbox" } = {},
  mailbox?: Pick<Mailbox, "getMessage">,
) {
  if (account.id !== message.accountId || account.companyId !== message.companyId) {
    throw new Error("Message does not belong to this mailbox");
  }
  const local = serializeMailMessageForAgent(message, options);
  if (options.source !== "mailbox") return local;
  const upstream = await (mailbox ?? (await mailboxForAccount(account))).getMessage(
    message.gmailMessageId,
  );
  if (upstream.ref !== message.gmailMessageId)
    throw new Error("The mailbox returned a different message");
  if (!upstream.hasBodies)
    throw new Error(
      "The mailbox did not return a full body. The local excerpt remains available with source: mirror.",
    );
  return {
    bodyVersion: createHash("sha256").update(upstream.bodyText).digest("hex"),
    ...local,
    bodySource: "mailbox",
    ...readMailBody(upstream.bodyText, { ...options, sourceComplete: true }),
    sourceNote:
      "Read directly from the mailbox without the local ingest cap. Keep source and includeQuoted unchanged when paging; restart at offset 0 if bodyVersion changes. No mail flags or stored bodies are changed.",
  };
}

export function serializeMailMessageForAgent(m: MailMessage, options: MailBodyReadOptions = {}) {
  return {
    messageId: m.id,
    isDraft: m.gmailDraftId !== "",
    from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
    to: m.toEmails,
    cc: m.ccEmails,
    subject: m.subject,
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    labels: columnToLabelIds(m.labelIds),
    bodySource: m.bodyText ? "bodyText" : "snippet",
    ...readMailBody(m.bodyText || m.snippet, {
      ...options,
      sourceComplete: !!m.bodyText && !m.bodyText.endsWith("\n… [truncated]"),
    }),
    attachments: summarizeMailAttachments(m.attachmentsJson),
    ...(!m.bodyText || m.bodyText.endsWith("\n… [truncated]")
      ? {
          sourceNote:
            "For the original body, call get_mail_message with source: mailbox and includeQuoted: true. Upstream availability and current mailbox access still apply.",
        }
      : {}),
  };
}

/** The caller checks the mailbox Grant before handing the thread to this service. */
export async function readMailThreadForAgent(
  thread: MailThread,
  options: MailBodyReadOptions & { messageLimit?: number; messageOffset?: number } = {},
) {
  const limit = options.messageLimit ?? 5;
  const offset = options.messageOffset ?? 0;
  const [messages, total] = await AppDataSource.getRepository(MailMessage).findAndCount({
    where: { threadId: thread.id, accountId: thread.accountId, companyId: thread.companyId },
    // Explicit null ordering behaves identically on SQLite and Postgres. A
    // draft without a sent date is the newest item, followed by stable IDs.
    order: { sentAt: { direction: "DESC", nulls: "FIRST" }, id: "DESC" },
    skip: offset,
    take: limit,
  });
  // Even a caller requesting twenty messages cannot multiply the body budget.
  const maxBodyChars = Math.min(
    options.maxBodyChars ?? 4_000,
    Math.floor(40_000 / Math.max(1, messages.length)),
  );
  const nextOffset = offset + messages.length < total ? offset + messages.length : null;
  return {
    coverage: {
      source: "local_mailbox_mirror",
      totalMessages: total,
      returnedMessages: messages.length,
      messageOffset: offset,
      nextMessageOffset: nextOffset,
      hasMore: nextOffset !== null,
      complete: offset === 0 && nextOffset === null,
      selectionOrder: "newest_first",
      returnedOrder: "oldest_first",
      maxBodyCharsPerMessage: maxBodyChars,
      note: "Coverage describes synced messages only. Bodies have separate coverage; use get_mail_message for a body continuation. Keep filters unchanged when paging; live mailbox changes can shift offsets.",
    },
    messages: messages
      .reverse()
      .map((message) => serializeMailMessageForAgent(message, { ...options, maxBodyChars })),
  };
}
