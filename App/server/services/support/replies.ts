import { In, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { SupportArticle } from "../../db/entities/SupportArticle.js";
import { SupportDraft } from "../../db/entities/SupportDraft.js";
import { SupportEvent } from "../../db/entities/SupportEvent.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import type { SupportJob } from "../../db/entities/SupportJob.js";
import { SupportMessage } from "../../db/entities/SupportMessage.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { SUPPORT_CHAT_EMAIL_DELAY_MS } from "../../../shared/supportChat.js";
import {
  DEFAULT_SUPPORT_ACKNOWLEDGEMENT,
  SUPPORT_LIMITS,
  SUPPORT_PRIORITY_RANK,
  type SupportCitation,
  type SupportSettableStatus,
} from "../../../shared/support.js";
import { verifyQuote } from "../dataRooms/retrieval.js";
import { sendMailMessage, type MailActionDependencies } from "../mail/actions.js";
import type { Mailbox } from "../mail/mailbox/types.js";
import type { MimeMailbox } from "../mail/mime.js";
import { isSuppressed, SuppressedRecipientError } from "../mail/suppression.js";
import { PolicyBlockedRecipientError } from "../companyPolicies.js";
import {
  announceTicket,
  auditTicket,
  parseJsonArray,
  patchTicket,
  recordTicketEvent,
  requesterDisplay,
  requireTicket,
  type SupportActor,
} from "./access.js";
import { appendChatRow, chatFactsFor, visitorReachable } from "./chatVisitors.js";
import { chatSenderName } from "./chatWidgets.js";
import { SupportConflictError, SupportNotFoundError, SupportValidationError } from "./errors.js";
import { takeTicketNumber } from "./intake.js";
import { ownAddressesFor, watchedAddresses } from "./inboxes.js";
import { bareSubject, isNoReplyAddress, plainTextToHtml, untaggedAddress } from "./mailSignals.js";
import { enqueueSupportJob, type SupportJobOutcome } from "./queue.js";
import { disclosureOf, getSupportSettings } from "./settings.js";
import { linkRequester, nextSlaDue, statusFields, targetsFrom } from "./tickets.js";

/**
 * Everything Support says to a customer goes through here. An email goes on through
 * the mailbox's own send path (`sendMailMessage`), which is where the do-not-email
 * list and the company's Policies are checked. So there is no way to reach a
 * customer by mail that skips them, and the sent copy sits in the mailbox's Sent
 * folder like any other email. A reply on a Chat widget ticket is written to the
 * conversation that visitor's token reads, and reaches a mailbox only as the email
 * of what they did not read, once they confirmed an address (`chatEmail.ts`).
 */

let mailboxForTests: ((account: MailAccount) => Promise<Mailbox>) | null = null;

/** Replace the mailbox a send goes through in a test. Null restores the real one. */
export function setSupportMailboxForTests(
  factory: ((account: MailAccount) => Promise<Mailbox>) | null,
): void {
  mailboxForTests = factory;
}

function dependencies(): MailActionDependencies {
  return mailboxForTests ? { mailbox: mailboxForTests } : {};
}

/** RFC 3834: software wrote this, so the other side's auto-responder should stay quiet. */
const AUTOMATIC_HEADERS = {
  "Auto-Submitted": "auto-replied",
  "X-Auto-Response-Suppress": "All",
};

/** The same, for mail that answers nobody's message: confirming an address. */
const GENERATED_HEADERS = {
  "Auto-Submitted": "auto-generated",
  "X-Auto-Response-Suppress": "All",
};

/** The mailbox a reply on this ticket goes through. */
async function mailboxFor(
  ticket: Pick<SupportTicket, "accountId" | "companyId">,
  inbox: SupportInbox | null,
): Promise<MailAccount> {
  const repo = AppDataSource.getRepository(MailAccount);
  const account =
    (ticket.accountId
      ? await repo.findOneBy({ id: ticket.accountId, companyId: ticket.companyId })
      : null) ??
    (inbox ? await repo.findOneBy({ id: inbox.accountId, companyId: ticket.companyId }) : null);
  if (!account) {
    throw new SupportConflictError(
      "The mailbox behind this ticket was disconnected. Connect it again under Support → Settings.",
      "no_mailbox",
    );
  }
  return account;
}

/**
 * Who a reply is from. The inbox's own choice wins; otherwise the address the
 * customer wrote to, when that is an alias on someone's mailbox, so an email to
 * support@ is answered by support@ and not by the person whose inbox watches it.
 */
export function replyFrom(
  ticket: Pick<SupportTicket, "matchedAddress">,
  inbox: Pick<SupportInbox, "fromAddress" | "fromName"> | null,
  account: Pick<MailAccount, "address" | "senderName">,
): MimeMailbox | undefined {
  const mailbox = account.address.toLowerCase();
  const chosen =
    inbox?.fromAddress ||
    (ticket.matchedAddress && untaggedAddress(ticket.matchedAddress) !== untaggedAddress(mailbox)
      ? ticket.matchedAddress
      : "");
  const name = inbox?.fromName || account.senderName;
  if (!chosen && !inbox?.fromName) return undefined;
  return { address: chosen || account.address, name };
}

/**
 * A chat was written to no address, so email about it goes out under the first one the
 * inbox watches, and not as the person whose mailbox happens to hold that inbox.
 */
function chatSender(inbox: SupportInbox | null): { matchedAddress: string } {
  return { matchedAddress: inbox ? (watchedAddresses(inbox)[0] ?? "") : "" };
}

/** Plain words with the inbox's signature, and the AI's line when it sent this alone. */
function composeBody(args: {
  body: string;
  inbox: Pick<SupportInbox, "signature"> | null;
  disclosure?: string;
}): string {
  const parts = [args.body.trim()];
  const signature = args.inbox?.signature.trim();
  if (signature) parts.push(signature);
  if (args.disclosure?.trim()) parts.push(args.disclosure.trim());
  return parts.join("\n\n");
}

function recipientsCc(ticket: SupportTicket, ownAddresses: readonly string[], cc?: string[]) {
  const own = new Set(ownAddresses.map(untaggedAddress));
  const list = cc ?? parseJsonArray<string>(ticket.ccJson);
  return [
    ...new Set(
      list
        .map((address) => normalizeEmail(address))
        .filter((address): address is string => Boolean(address))
        .filter(
          (address) => !own.has(untaggedAddress(address)) && address !== ticket.requesterEmail,
        ),
    ),
  ];
}

function deliveryError(error: unknown): Error {
  if (error instanceof SuppressedRecipientError || error instanceof PolicyBlockedRecipientError) {
    return new SupportConflictError(error.message, "blocked_recipient");
  }
  const message = error instanceof Error ? error.message : "The mail server refused this message.";
  return new SupportConflictError(`This reply did not go out: ${message}`, "delivery_failed");
}

/** Record a sent email on its ticket; a sync pass that saw it first has made the row already. */
async function recordSentMessage(args: {
  ticket: SupportTicket;
  account: MailAccount;
  sent: MailMessage;
  kind: SupportMessage["kind"];
  text: string;
  actor: SupportActor;
  sentByAi?: boolean;
  draftId?: string | null;
  citations?: SupportCitation[];
}): Promise<SupportMessage> {
  const repo = AppDataSource.getRepository(SupportMessage);
  const authored = {
    kind: args.kind,
    // A sync pass that saw this first may have written it for a visitor's widget,
    // not knowing the server was emailing them what the widget already shows.
    chatVisitorId: null,
    chatSeq: null,
    authorUserId: args.actor.kind === "user" ? args.actor.userId : null,
    authorEmployeeId: args.actor.kind === "ai" ? args.actor.employeeId : null,
    sentByAi: args.sentByAi ?? false,
    draftId: args.draftId ?? null,
    citationsJson: JSON.stringify(args.citations ?? []),
    cleanText: args.text,
  };
  const fields = {
    companyId: args.ticket.companyId,
    ticketId: args.ticket.id,
    accountId: args.account.id,
    gmailMessageId: args.sent.gmailMessageId,
    messageIdHeader: args.sent.messageIdHeader,
    inReplyToHeader: args.sent.inReplyToHeader,
    referencesHeader: args.sent.referencesHeader,
    fromName: args.sent.fromName,
    fromEmail: args.sent.fromEmail.toLowerCase(),
    toEmails: args.sent.toEmails,
    ccEmails: args.sent.ccEmails,
    subject: args.sent.subject,
    // We sent it just now. A mail server's own stamp can run behind the customer's
    // message it answers, and the conversation must read in the order it happened.
    sentAt: new Date(),
    bodyText: args.sent.bodyText,
    bodyHtml: args.sent.bodyHtml,
    attachmentsJson: args.sent.attachmentsJson || "[]",
    ...authored,
  };
  const existing = await repo.findOneBy({
    accountId: args.account.id,
    gmailMessageId: args.sent.gmailMessageId,
  });
  if (existing) {
    await repo.update({ id: existing.id }, authored);
    return repo.findOneByOrFail({ id: existing.id });
  }
  try {
    return await repo.save(repo.create(fields));
  } catch (error) {
    const raced = await repo.findOneBy({
      accountId: args.account.id,
      gmailMessageId: args.sent.gmailMessageId,
    });
    if (!raced) throw error;
    await repo.update({ id: raced.id }, authored);
    return repo.findOneByOrFail({ id: raced.id });
  }
}

async function creditCitedArticles(
  companyId: string,
  citations: readonly SupportCitation[],
): Promise<void> {
  const ids = [...new Set(citations.map((citation) => citation.articleId))];
  const now = new Date();
  for (const id of ids) {
    await AppDataSource.getRepository(SupportArticle)
      .createQueryBuilder()
      .update(SupportArticle)
      // Being quoted is not an edit: an Article's "edited" date stays its own.
      .set({
        citedCount: () => '"citedCount" + 1',
        lastCitedAt: now,
        updatedAt: () => '"updatedAt"',
      })
      .where('id = :id AND "companyId" = :companyId', { id, companyId })
      .execute();
  }
}

/**
 * A message that joined the conversation after the one the author last saw. By
 * the order they reached this ticket, since a mail server's clock is its own: the
 * row before them in that order is the one they answered.
 */
async function newerMessageThan(
  ticketId: string,
  basedOnMessageId: string,
): Promise<SupportMessage | null> {
  const spoken = await AppDataSource.getRepository(SupportMessage).find({
    where: { ticketId, kind: In(["customer", "reply"]) },
    select: { id: true, kind: true, createdAt: true, sentAt: true },
    order: { createdAt: "ASC", sentAt: "ASC" },
  });
  const seen = spoken.findIndex((message) => message.id === basedOnMessageId);
  // The author's message is gone, merged away: nothing to compare with.
  if (seen < 0) return null;
  return spoken[seen + 1] ?? null;
}

export type TicketReplyInput = {
  companyId: string;
  ticketId: string;
  body: string;
  actor: SupportActor;
  /** Replaces the people kept on the reply. Omitted keeps the ticket's own. */
  cc?: string[];
  /** Files staged through the mailbox's attachment route. */
  attachmentIds?: string[];
  /** What the ticket should become. Omitted waits on the customer. */
  status?: SupportSettableStatus;
  /** The AI draft this began as. */
  draftId?: string | null;
  /** The newest message the author saw; a newer one refuses the send. */
  basedOnMessageId?: string | null;
  /** Send despite a newer message. Only a person who has seen the warning sets it. */
  force?: boolean;
  /** No person pressed Send. Adds the AI's disclosure and the automatic headers. */
  automatic?: boolean;
};

/** Send a reply on a ticket and bring the ticket up to date. */
export async function sendTicketReply(
  input: TicketReplyInput,
): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  const ticket = await requireTicket(input.companyId, input.ticketId);
  const body = input.body.trim();
  if (!body) throw new SupportValidationError("Write something to send.");
  if (body.length > SUPPORT_LIMITS.replyChars) {
    throw new SupportValidationError("That reply is too long to send.");
  }
  if (ticket.mergedIntoId) {
    throw new SupportConflictError("This ticket was merged into another. Reply there.", "merged");
  }
  if (ticket.status === "spam") {
    throw new SupportConflictError("Mark this ticket as not spam before replying.", "spam");
  }
  if (input.basedOnMessageId && !input.force) {
    const newer = await newerMessageThan(ticket.id, input.basedOnMessageId);
    if (newer) {
      throw new SupportConflictError(
        newer.kind === "customer"
          ? `${requesterDisplay(ticket)} wrote again while you were replying. Read it before sending.`
          : "Someone else replied while you were writing. Read it before sending.",
        "stale",
      );
    }
  }
  const inbox = ticket.inboxId
    ? await AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId })
    : null;
  const settings = await getSupportSettings(ticket.companyId);
  const { draft, citations } = await draftBehind(ticket, input);
  if (ticket.chatVisitorId) {
    return sendChatReply({ input, ticket, inbox, settings, body, draft, citations });
  }
  if (!ticket.requesterEmail) {
    throw new SupportConflictError("This ticket has no customer address to reply to.");
  }
  const account = await mailboxFor(ticket, inbox);
  const thread = ticket.gmailThreadId
    ? await AppDataSource.getRepository(MailThread).findOneBy({
        accountId: account.id,
        gmailThreadId: ticket.gmailThreadId,
      })
    : null;
  const ownAddresses = await ownAddressesFor(account);
  const cc = recipientsCc(ticket, ownAddresses, input.cc);
  const text = composeBody({
    body,
    inbox,
    disclosure: input.automatic ? disclosureOf(settings) : undefined,
  });

  let sent: MailMessage;
  try {
    sent = await sendMailMessage(
      account,
      {
        to: ticket.requesterEmail,
        cc: cc.join(", ") || undefined,
        // With a live conversation the mail layer takes its subject and threading.
        subject: thread ? undefined : `Re: ${bareSubject(ticket.subject)}`,
        bodyText: text,
        bodyHtml: plainTextToHtml(text),
        attachmentIds: input.attachmentIds,
        from: replyFrom(ticket, inbox, account),
        ...(input.automatic ? { extraHeaders: AUTOMATIC_HEADERS } : {}),
      },
      thread,
      dependencies(),
    );
  } catch (error) {
    throw deliveryError(error);
  }

  // Authorship on the mirror row, so the Email section says who wrote it too.
  await AppDataSource.getRepository(MailMessage).update(
    { id: sent.id },
    {
      createdByUserId: input.actor.kind === "user" ? input.actor.userId : null,
      createdByEmployeeId: input.actor.kind === "ai" ? input.actor.employeeId : null,
    },
  );

  const message = await recordSentMessage({
    ticket,
    account,
    sent,
    kind: "reply",
    text: body,
    actor: input.actor,
    sentByAi: input.automatic,
    draftId: draft?.id ?? null,
    citations,
  });
  return settleReply({
    input,
    ticket,
    settings,
    body,
    draft,
    citations,
    message,
    mail: { gmailThreadId: sent.gmailThreadId, accountId: account.id },
  });
}

/** The AI draft a reply began as, and what it quoted. */
async function draftBehind(
  ticket: SupportTicket,
  input: TicketReplyInput,
): Promise<{ draft: SupportDraft | null; citations: SupportCitation[] }> {
  if (!input.draftId) return { draft: null, citations: [] };
  const draft = await AppDataSource.getRepository(SupportDraft).findOneBy({
    id: input.draftId,
    ticketId: ticket.id,
  });
  return { draft, citations: draft ? parseJsonArray<SupportCitation>(draft.citationsJson) : [] };
}

/**
 * Write a reply into a Chat widget conversation. No mailbox: this works with the
 * mailbox disconnected, and what goes to the visitor is only their conversation. The
 * AI's disclosure line is part of what is stored and shown, as it is part of what an
 * email says, so no client can leave it out. The signature stays with the emails: a
 * signature under every chat line is not what the owners wrote it for.
 */
async function sendChatReply(args: {
  input: TicketReplyInput;
  ticket: SupportTicket;
  inbox: SupportInbox | null;
  settings: Awaited<ReturnType<typeof getSupportSettings>>;
  body: string;
  draft: SupportDraft | null;
  citations: SupportCitation[];
}): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  const { input, ticket, inbox, settings, body, draft, citations } = args;
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    throw new SupportValidationError("A chat reply cannot carry files. Remove them to send it.");
  }
  if (input.cc && input.cc.length > 0) {
    throw new SupportValidationError("A chat reply reaches only the visitor. Remove the cc.");
  }
  const facts = await chatFactsFor(ticket);
  if (!visitorReachable(facts)) {
    throw new SupportConflictError(
      "This visitor can no longer be reached: the chat ended or the widget is off, and they confirmed no email address.",
      "unreachable",
    );
  }
  const text = composeBody({
    body,
    inbox: null,
    disclosure: input.automatic ? disclosureOf(settings) : undefined,
  });
  const message = await appendChatRow({
    visitorId: ticket.chatVisitorId as string,
    fields: {
      companyId: ticket.companyId,
      ticketId: ticket.id,
      kind: "reply",
      fromName: await chatSenderName(ticket.companyId, inbox),
      subject: ticket.subject,
      authorUserId: input.actor.kind === "user" ? input.actor.userId : null,
      authorEmployeeId: input.actor.kind === "ai" ? input.actor.employeeId : null,
      sentByAi: Boolean(input.automatic),
      draftId: draft?.id ?? null,
      citationsJson: JSON.stringify(citations),
      sentAt: new Date(),
      bodyText: text,
      cleanText: body,
    },
  });
  const settled = await settleReply({
    input,
    ticket,
    settings,
    body,
    draft,
    citations,
    message,
    mail: null,
  });
  // If they have left by then, this is how the answer reaches them.
  if (facts.visitor?.email) {
    await enqueueSupportJob({
      companyId: ticket.companyId,
      kind: "chat_email",
      targetId: ticket.id,
      ticketId: ticket.id,
      delayMs: SUPPORT_CHAT_EMAIL_DELAY_MS,
    });
  }
  return settled;
}

/** Bring a ticket up to date with the reply it just sent, whichever way it went. */
async function settleReply(args: {
  input: TicketReplyInput;
  ticket: SupportTicket;
  settings: Awaited<ReturnType<typeof getSupportSettings>>;
  body: string;
  draft: SupportDraft | null;
  citations: SupportCitation[];
  message: SupportMessage;
  /** The email conversation it went on. Null for a reply in the Chat widget. */
  mail: { gmailThreadId: string; accountId: string } | null;
}): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  const { input, ticket, settings, body, draft, citations, message, mail } = args;
  const now = new Date();
  const current = await requireTicket(ticket.companyId, ticket.id);
  const nextStatus = input.status ?? "waiting";
  const fields: Partial<SupportTicket> = {
    ...statusFields({
      ticket: { ...current, responseDueAt: null },
      status: nextStatus,
      now,
      settings,
    }),
    messageCount: current.messageCount + 1,
    lastAgentMessageAt: now,
    lastActivityAt: now,
    firstRespondedAt: current.firstRespondedAt ?? now,
    responseDueAt: null,
    draftReady: false,
    needsHuman: false,
    aiHandoffReason: "",
    aiHandled: Boolean(input.automatic),
    aiReplyCount: current.aiReplyCount + (input.automatic ? 1 : 0),
    ...(mail ?? {}),
  };
  await patchTicket(ticket, fields);

  await AppDataSource.getRepository(SupportDraft).update(
    { ticketId: ticket.id, status: "ready" },
    { status: "superseded" },
  );
  if (draft) {
    await AppDataSource.getRepository(SupportDraft).update(
      { id: draft.id },
      {
        status: "sent",
        sentMessageId: message.id,
        editedBeforeSend: normalizedWords(draft.body) !== normalizedWords(body),
        decidedByUserId: input.actor.kind === "user" ? input.actor.userId : null,
        decidedAt: now,
      },
    );
  }
  if (citations.length > 0) await creditCitedArticles(ticket.companyId, citations);
  if (input.automatic) {
    await recordTicketEvent({ ticket, kind: "ai_replied", actor: input.actor });
  }
  if (current.status !== nextStatus) {
    await recordTicketEvent({
      ticket,
      kind: "status_changed",
      actor: input.actor,
      data: { from: current.status, to: nextStatus },
    });
  }
  await auditTicket(input.actor, ticket, "reply", {
    messageId: message.id,
    automatic: Boolean(input.automatic),
  });
  return { ticket: await requireTicket(ticket.companyId, ticket.id), message };
}

function normalizedWords(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Send an AI draft, as written or edited, under one claim so a double-click sends once. */
export async function sendDraft(args: {
  companyId: string;
  ticketId: string;
  draftId: string;
  body?: string;
  cc?: string[];
  attachmentIds?: string[];
  status?: SupportSettableStatus;
  basedOnMessageId?: string | null;
  force?: boolean;
  actor: SupportActor;
}): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  const repo = AppDataSource.getRepository(SupportDraft);
  const draft = await repo.findOneBy({ id: args.draftId, ticketId: args.ticketId });
  if (!draft || draft.companyId !== args.companyId) {
    throw new SupportNotFoundError("Draft not found");
  }
  const claim = await repo
    .createQueryBuilder()
    .update(SupportDraft)
    .set({ status: "sending" })
    .where("id = :id", { id: draft.id })
    .andWhere("status = :ready", { ready: "ready" })
    .execute();
  if (claim.affected !== 1) {
    throw new SupportConflictError("This draft was already sent or replaced.", "draft_gone");
  }
  try {
    return await sendTicketReply({
      companyId: args.companyId,
      ticketId: args.ticketId,
      body: args.body ?? draft.body,
      cc: args.cc,
      attachmentIds: args.attachmentIds,
      status: args.status,
      draftId: draft.id,
      basedOnMessageId: args.basedOnMessageId,
      force: args.force,
      actor: args.actor,
    });
  } catch (error) {
    await repo.update({ id: draft.id }, { status: "ready" });
    throw error;
  }
}

export async function discardDraft(args: {
  companyId: string;
  ticketId: string;
  draftId: string;
  actor: SupportActor;
}): Promise<void> {
  const repo = AppDataSource.getRepository(SupportDraft);
  const draft = await repo.findOneBy({ id: args.draftId, ticketId: args.ticketId });
  if (!draft || draft.companyId !== args.companyId) {
    throw new SupportNotFoundError("Draft not found");
  }
  if (draft.status !== "ready") return;
  await repo.update(
    { id: draft.id },
    {
      status: "discarded",
      decidedByUserId: args.actor.kind === "user" ? args.actor.userId : null,
      decidedAt: new Date(),
    },
  );
  const ticket = await requireTicket(args.companyId, args.ticketId);
  await patchTicket(ticket, { draftReady: false });
  await auditTicket(args.actor, ticket, "draft_discarded", { draftId: draft.id });
}

/**
 * A reply an AI Employee's own tool wrote, waiting for a Member to send. Its quotes
 * are held to the same rule as the restricted turn's: found word for word in the
 * Article, or dropped.
 */
export async function draftReplyAsEmployee(args: {
  companyId: string;
  ticketId: string;
  employeeId: string;
  body: string;
  citations?: Array<{ articleId: string; quote: string }>;
  note?: string;
}): Promise<{ draft: SupportDraft; dropped: number }> {
  const ticket = await requireTicket(args.companyId, args.ticketId);
  if (ticket.mergedIntoId || ticket.status === "spam") {
    throw new SupportConflictError("This ticket cannot take a draft as it stands.");
  }
  const requested = args.citations ?? [];
  const articles = requested.length
    ? await AppDataSource.getRepository(SupportArticle).find({
        where: {
          companyId: args.companyId,
          status: "published",
          id: In([...new Set(requested.map((citation) => citation.articleId))]),
        },
      })
    : [];
  const byId = new Map(articles.map((article) => [article.id, article]));
  const citations: SupportCitation[] = [];
  let dropped = 0;
  for (const citation of requested) {
    const article = byId.get(citation.articleId);
    if (!article || !verifyQuote(citation.quote, [article.body])) {
      dropped += 1;
      continue;
    }
    citations.push({ articleId: article.id, title: article.title, quote: citation.quote });
  }
  const newest = await AppDataSource.getRepository(SupportMessage)
    .createQueryBuilder("m")
    .where("m.ticketId = :ticketId", { ticketId: ticket.id })
    .andWhere("m.kind = :kind", { kind: "customer" })
    .orderBy("m.sentAt", "DESC")
    .getOne();
  const repo = AppDataSource.getRepository(SupportDraft);
  await repo.update({ ticketId: ticket.id, status: "ready" }, { status: "superseded" });
  const draft = await repo.save(
    repo.create({
      companyId: ticket.companyId,
      ticketId: ticket.id,
      status: "ready",
      employeeId: args.employeeId,
      basedOnMessageId: newest?.id ?? null,
      answerable: citations.length > 0,
      confidence: "medium",
      topicKey: ticket.topicKey,
      body: args.body,
      citationsJson: JSON.stringify(citations),
      note: args.note ?? "",
      holdReasonsJson: JSON.stringify([
        "Written by an AI Employee's own tools, for a person to send.",
      ]),
    }),
  );
  await patchTicket(ticket, { draftReady: true, lastActivityAt: new Date() });
  const actor: SupportActor = { kind: "ai", employeeId: args.employeeId };
  await recordTicketEvent({ ticket, kind: "ai_drafted", actor });
  await auditTicket(actor, ticket, "draft", { draftId: draft.id });
  return { draft, dropped };
}

/** A note is for the company's people and never reaches the customer. */
export async function addTicketNote(args: {
  companyId: string;
  ticketId: string;
  body: string;
  actor: SupportActor;
}): Promise<SupportMessage> {
  const ticket = await requireTicket(args.companyId, args.ticketId);
  const body = args.body.trim();
  if (!body) throw new SupportValidationError("Write something to add.");
  if (body.length > SUPPORT_LIMITS.noteChars)
    throw new SupportValidationError("That note is too long.");
  const repo = AppDataSource.getRepository(SupportMessage);
  const message = await repo.save(
    repo.create({
      companyId: ticket.companyId,
      ticketId: ticket.id,
      kind: "note",
      authorUserId: args.actor.kind === "user" ? args.actor.userId : null,
      authorEmployeeId: args.actor.kind === "ai" ? args.actor.employeeId : null,
      sentAt: new Date(),
      bodyText: body,
      cleanText: body,
    }),
  );
  await patchTicket(ticket, { lastActivityAt: new Date() });
  await auditTicket(args.actor, ticket, "note", { messageId: message.id });
  return message;
}

export type StartTicketInput = {
  companyId: string;
  inboxId: string;
  requesterEmail: string;
  requesterName?: string;
  subject: string;
  body: string;
  cc?: string[];
  /** Email the customer now. Off records a request that came some other way, as a note. */
  send: boolean;
  attachmentIds?: string[];
  actor: SupportActor;
};

/**
 * Open a ticket from the company's side: writing to a customer first, or
 * recording something they said on a call.
 */
export async function startTicket(input: StartTicketInput): Promise<SupportTicket> {
  const inbox = await AppDataSource.getRepository(SupportInbox).findOneBy({
    id: input.inboxId,
    companyId: input.companyId,
  });
  if (!inbox) throw new SupportNotFoundError("Support inbox not found");
  const requesterEmail = normalizeEmail(input.requesterEmail);
  if (!requesterEmail) throw new SupportValidationError("That customer address is not valid.");
  const subject = input.subject.trim();
  if (!subject) throw new SupportValidationError("A ticket needs a subject.");
  const body = input.body.trim();
  if (!body) throw new SupportValidationError("Write something first.");
  const settings = await getSupportSettings(input.companyId);
  const link = await linkRequester(input.companyId, requesterEmail);
  const now = new Date();
  const clocks = targetsFrom({ settings, priority: "normal", from: now });
  const ticket = await AppDataSource.transaction(async (manager) => {
    const number = await takeTicketNumber(manager, input.companyId);
    const repo = manager.getRepository(SupportTicket);
    return repo.save(
      repo.create({
        companyId: input.companyId,
        number,
        inboxId: inbox.id,
        accountId: inbox.accountId,
        gmailThreadId: null,
        status: "open",
        actionable: true,
        priority: "normal",
        priorityRank: SUPPORT_PRIORITY_RANK.normal,
        subject,
        requesterEmail,
        requesterName: (input.requesterName ?? "").trim(),
        matchedAddress: "",
        customerId: link.customerId,
        contactId: link.contactId,
        lastActivityAt: now,
        firstResponseDueAt: clocks.firstResponseDue,
        resolutionDueAt: clocks.resolutionDue,
        responseDueAt: clocks.firstResponseDue,
        slaDueAt: nextSlaDue({
          actionable: true,
          slaEnabled: settings.slaEnabled,
          responseDueAt: clocks.firstResponseDue,
          resolutionDueAt: clocks.resolutionDue,
        }),
        source: "manual",
        createdByUserId: input.actor.kind === "user" ? input.actor.userId : null,
        createdByEmployeeId: input.actor.kind === "ai" ? input.actor.employeeId : null,
        ccJson: JSON.stringify(input.cc ?? []),
      }),
    );
  });
  await recordTicketEvent({
    ticket,
    kind: "created",
    actor: input.actor,
    data: { source: "manual" },
  });
  await auditTicket(input.actor, ticket, "create");
  if (input.send) {
    try {
      await sendTicketReply({
        companyId: ticket.companyId,
        ticketId: ticket.id,
        body,
        attachmentIds: input.attachmentIds,
        actor: input.actor,
      });
    } catch (error) {
      // Nothing left the building, so nothing should stay behind either.
      await AppDataSource.getRepository(SupportEvent).delete({ ticketId: ticket.id });
      await AppDataSource.getRepository(SupportTicket).delete({ id: ticket.id });
      announceTicket(ticket);
      throw error;
    }
  } else {
    await addTicketNote({
      companyId: ticket.companyId,
      ticketId: ticket.id,
      body,
      actor: input.actor,
    });
  }
  return requireTicket(ticket.companyId, ticket.id);
}

/**
 * Send an email the server decided on: the acknowledgement, the request for a
 * rating. It joins the conversation as `automated`, carries RFC 3834's headers,
 * and changes nothing about where the ticket stands. Returns false, quietly,
 * for a recipient it must not write to.
 */
export async function sendAutomatedMessage(args: {
  ticket: SupportTicket;
  body: string;
  /** What to keep on the ticket, when the email holds something it should not. */
  storedBody?: string;
  /** The subject, where "Re:" the ticket's would repeat words a stranger chose. */
  subject?: string;
}): Promise<boolean> {
  const { ticket } = args;
  if (!ticket.requesterEmail || isNoReplyAddress(ticket.requesterEmail)) return false;
  if (await isSuppressed(ticket.companyId, ticket.requesterEmail)) return false;
  const inbox = ticket.inboxId
    ? await AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId })
    : null;
  const account = await mailboxFor(ticket, inbox);
  const thread = ticket.gmailThreadId
    ? await AppDataSource.getRepository(MailThread).findOneBy({
        accountId: account.id,
        gmailThreadId: ticket.gmailThreadId,
      })
    : null;
  const text = composeBody({ body: args.body, inbox });
  const sent = await sendMailMessage(
    account,
    {
      to: ticket.requesterEmail,
      subject: thread ? undefined : (args.subject ?? `Re: ${bareSubject(ticket.subject)}`),
      bodyText: text,
      bodyHtml: plainTextToHtml(text),
      from: replyFrom(ticket.chatVisitorId ? chatSender(inbox) : ticket, inbox, account),
      extraHeaders: AUTOMATIC_HEADERS,
    },
    thread,
    dependencies(),
  );
  const stored = args.storedBody ?? args.body;
  const message = await recordSentMessage({
    ticket,
    account,
    sent,
    kind: "automated",
    text: stored,
    actor: { kind: "system" },
  });
  if (args.storedBody !== undefined) {
    // A link meant only for the customer is not kept on the ticket.
    await AppDataSource.getRepository(SupportMessage).update(
      { id: message.id },
      { bodyText: composeBody({ body: stored, inbox }), bodyHtml: "" },
    );
  }
  await patchTicket(ticket, { gmailThreadId: sent.gmailThreadId, accountId: account.id });
  return true;
}

/**
 * The same note, in the widget instead of a mailbox. No cooldown: that stops two
 * mail systems acknowledging each other, and a person typed this. It joins the
 * visitor's conversation as an automatic line, which no AI turn reads.
 */
async function acknowledgeInChat(ticket: SupportTicket): Promise<SupportJobOutcome> {
  const inbox = ticket.inboxId
    ? await AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId })
    : null;
  if (!inbox?.acknowledge || !ticket.chatVisitorId) return { outcome: "done" };
  await recordTicketEvent({ ticket, kind: "acknowledged", actor: { kind: "system" } });
  const text = (inbox.acknowledgementBody ?? DEFAULT_SUPPORT_ACKNOWLEDGEMENT).trim();
  await appendChatRow({
    visitorId: ticket.chatVisitorId,
    fields: {
      companyId: ticket.companyId,
      ticketId: ticket.id,
      kind: "automated",
      fromName: await chatSenderName(ticket.companyId, inbox),
      subject: ticket.subject,
      sentAt: new Date(),
      bodyText: text,
      cleanText: text,
    },
  });
  return { outcome: "done" };
}

/**
 * One email in fixed words, from an inbox's mailbox, on no ticket: asking someone to
 * confirm their address. It goes through the mailbox's own send path like every
 * other email, so the do-not-email list and Policies apply.
 */
export async function sendFixedEmail(args: {
  inbox: SupportInbox;
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const { inbox } = args;
  const account = await mailboxFor({ accountId: null, companyId: inbox.companyId }, inbox);
  await sendMailMessage(
    account,
    {
      to: args.to,
      subject: args.subject,
      bodyText: args.body,
      bodyHtml: plainTextToHtml(args.body),
      from: replyFrom(chatSender(inbox), inbox, account),
      extraHeaders: GENERATED_HEADERS,
    },
    null,
    dependencies(),
  );
}

/** How soon the same address may be acknowledged again: what ends an acknowledgement loop. */
const ACKNOWLEDGE_COOLDOWN_MS = 60 * 60_000;

export async function runAcknowledgeJob(
  job: Pick<SupportJob, "companyId" | "targetId">,
): Promise<SupportJobOutcome> {
  const ticket = await AppDataSource.getRepository(SupportTicket).findOneBy({
    id: job.targetId,
    companyId: job.companyId,
  });
  if (!ticket || ticket.status === "spam") return { outcome: "done" };
  const events = AppDataSource.getRepository(SupportEvent);
  if (await events.findOneBy({ ticketId: ticket.id, kind: "acknowledged" })) {
    return { outcome: "done" };
  }
  // Someone has already answered, so a "we got your email" would read strangely.
  if (ticket.firstRespondedAt) return { outcome: "done" };
  if (ticket.chatVisitorId) return acknowledgeInChat(ticket);
  // Tickets rather than a join: ids and the column pointing at them are different
  // types on Postgres.
  const theirs = await AppDataSource.getRepository(SupportTicket).find({
    where: { companyId: ticket.companyId, requesterEmail: ticket.requesterEmail },
    select: { id: true },
    order: { createdAt: "DESC" },
    take: 100,
  });
  const recent = await AppDataSource.getRepository(SupportEvent).count({
    where: {
      ticketId: In(theirs.map((row) => row.id)),
      kind: "acknowledged",
      createdAt: MoreThanOrEqual(new Date(Date.now() - ACKNOWLEDGE_COOLDOWN_MS)),
    },
  });
  if (recent > 0) return { outcome: "done" };
  const inbox = ticket.inboxId
    ? await AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId })
    : null;
  if (!inbox?.acknowledge) return { outcome: "done" };
  // Recorded first: this email goes out at most once, even if the process dies now.
  await recordTicketEvent({ ticket, kind: "acknowledged", actor: { kind: "system" } });
  try {
    await sendAutomatedMessage({
      ticket,
      body: inbox.acknowledgementBody ?? DEFAULT_SUPPORT_ACKNOWLEDGEMENT,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[support] could not acknowledge ticket ${ticket.id}:`, error);
  }
  return { outcome: "done" };
}
