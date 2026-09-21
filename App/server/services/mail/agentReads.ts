import { AppDataSource } from "../../db/datasource.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import type { MailThread } from "../../db/entities/MailThread.js";
import { summarizeMailAttachments } from "./attachments.js";
import { readMailBody, type MailBodyReadOptions } from "./bodyRead.js";
import { columnToLabelIds } from "./store.js";

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
