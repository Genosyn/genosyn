import crypto from "node:crypto";

import { IsNull, MoreThan, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { SupportChatVisitor } from "../../db/entities/SupportChatVisitor.js";
import { SupportChatWidget } from "../../db/entities/SupportChatWidget.js";
import { SupportMessage } from "../../db/entities/SupportMessage.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import {
  SUPPORT_CHAT_LIMITS,
  SUPPORT_CHAT_TOKEN_DAYS,
  SUPPORT_CHAT_VISITOR_LABEL,
  type ChatConversationPage,
  type ChatEmailStatus,
  type ChatMessageFrom,
  type ChatWidgetMessage,
} from "../../../shared/supportChat.js";
import { announceTicket, recordTicketEvent } from "./access.js";

/**
 * Who a Chat widget visitor is, and everything their token reaches.
 *
 * A visitor is a stranger holding a token. The token is 32 random bytes, handed out
 * once and kept only as a hash, and it opens the rows stamped with this visitor's
 * id: that stamp, and not any lookup through a ticket, is the boundary, so what
 * happens to a ticket (a note, a draft, a reassignment) can't put anything new in
 * front of a browser. Every read in this module starts from a visitor a token
 * proved, and asks for `chatVisitorId = theirs`.
 */

const TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60_000;
/** How stale `lastSeenAt` may run: a poll is not worth a write, and a month is in days. */
const SEEN_GRANULARITY_MS = 60 * 60_000;

export function hashChatToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function chatTokenLapsed(
  visitor: Pick<SupportChatVisitor, "lastSeenAt">,
  now = new Date(),
): boolean {
  return now.getTime() - visitor.lastSeenAt.getTime() > SUPPORT_CHAT_TOKEN_DAYS * DAY_MS;
}

/** A new visitor and the one copy of their token there will ever be. */
export async function mintVisitor(args: {
  widget: Pick<SupportChatWidget, "id" | "companyId">;
}): Promise<{ visitor: SupportChatVisitor; token: string }> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const repo = AppDataSource.getRepository(SupportChatVisitor);
  const visitor = await repo.save(
    repo.create({
      companyId: args.widget.companyId,
      widgetId: args.widget.id,
      tokenHash: hashChatToken(token),
      lastSeenAt: new Date(),
    }),
  );
  return { visitor, token };
}

/**
 * The visitor a token belongs to, on this widget only. A token from another widget,
 * one that was ended and one that has lapsed all come back null, the same as a guess.
 */
export async function visitorForToken(
  widget: Pick<SupportChatWidget, "id">,
  token: string,
  now = new Date(),
): Promise<SupportChatVisitor | null> {
  const repo = AppDataSource.getRepository(SupportChatVisitor);
  const visitor = await repo.findOneBy({ tokenHash: hashChatToken(token), widgetId: widget.id });
  if (!visitor || chatTokenLapsed(visitor, now)) return null;
  if (now.getTime() - visitor.lastSeenAt.getTime() > SEEN_GRANULARITY_MS) {
    await repo.update({ id: visitor.id }, { lastSeenAt: now });
    visitor.lastSeenAt = now;
  }
  return visitor;
}

/** Nothing opens this conversation again. The ticket stays, as the company's record. */
export async function endVisitor(
  visitor: Pick<SupportChatVisitor, "id" | "name">,
): Promise<void> {
  await AppDataSource.getRepository(SupportChatVisitor).update(
    { id: visitor.id },
    { tokenHash: null },
  );
  const ticket = await AppDataSource.getRepository(SupportTicket).findOne({
    where: { chatVisitorId: visitor.id, mergedIntoId: IsNull() },
    order: { number: "DESC" },
    select: { id: true, companyId: true },
  });
  if (!ticket) return;
  await recordTicketEvent({
    ticket,
    kind: "chat_ended",
    actor: { kind: "customer", name: visitor.name || SUPPORT_CHAT_VISITOR_LABEL },
  });
  announceTicket(ticket);
}

/** The next place in a visitor's conversation, under their row's lock until the caller commits. */
export async function takeChatSeq(
  manager: import("typeorm").EntityManager,
  visitorId: string,
): Promise<number> {
  await manager
    .createQueryBuilder()
    .update(SupportChatVisitor)
    .set({ lastSeq: () => '"lastSeq" + 1' })
    .where("id = :id", { id: visitorId })
    .execute();
  const visitor = await manager.findOneByOrFail(SupportChatVisitor, { id: visitorId });
  return visitor.lastSeq;
}

type ChatRowFields = Partial<SupportMessage> &
  Pick<SupportMessage, "companyId" | "ticketId" | "kind" | "sentAt">;

/** Write a row this visitor may read. Every line of their conversation comes through here. */
export async function appendChatRow(args: {
  visitorId: string;
  fields: ChatRowFields;
}): Promise<SupportMessage> {
  return AppDataSource.transaction(async (manager) => {
    const chatSeq = await takeChatSeq(manager, args.visitorId);
    const repo = manager.getRepository(SupportMessage);
    return repo.save(repo.create({ ...args.fields, chatVisitorId: args.visitorId, chatSeq }));
  });
}

function fromOf(message: SupportMessage): ChatMessageFrom {
  if (message.kind === "customer") return "visitor";
  if (message.kind === "automated") return "system";
  return message.sentByAi ? "ai" : "team";
}

/**
 * One row as a visitor reads it. Nothing else about the row, its ticket or who wrote
 * it leaves here: no number, status, Member, citation or draft. A chat row's
 * `bodyText` is what the server composed, the AI's disclosure line included, so no
 * client can leave that out. A row that came by mail has quoted history in it, and
 * shows its new words alone.
 */
export function chatMessageView(message: SupportMessage): ChatWidgetMessage {
  return {
    seq: message.chatSeq ?? 0,
    clientId: message.kind === "customer" ? message.chatClientId : null,
    from: fromOf(message),
    name: message.fromName,
    text: message.gmailMessageId
      ? message.cleanText || message.bodyText
      : message.bodyText || message.cleanText,
    at: message.sentAt.toISOString(),
  };
}

export function chatEmailStatus(
  visitor: Pick<SupportChatVisitor, "email" | "pendingEmail">,
): ChatEmailStatus {
  if (visitor.pendingEmail) return { state: "pending", address: visitor.pendingEmail };
  if (visitor.email) return { state: "confirmed", address: visitor.email };
  return { state: "none", address: "" };
}

/** A page of this visitor's conversation after a place in it. */
export async function readConversation(args: {
  visitor: SupportChatVisitor;
  after: number;
}): Promise<ChatConversationPage> {
  const { visitor, after } = args;
  const limit = SUPPORT_CHAT_LIMITS.pageMessages;
  const rows = await AppDataSource.getRepository(SupportMessage).find({
    where: { chatVisitorId: visitor.id, chatSeq: MoreThan(after) },
    order: { chatSeq: "ASC" },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    messages: page.map(chatMessageView),
    hasMore: rows.length > limit,
    nextAfter: page.length > 0 ? (page[page.length - 1].chatSeq ?? after) : after,
    readSeq: visitor.readSeq,
    email: chatEmailStatus(visitor),
  };
}

/** How far the visitor has read. Only ever forward, and never past what exists. */
export async function markConversationRead(
  visitor: Pick<SupportChatVisitor, "id" | "lastSeq" | "readSeq">,
  seq: number,
): Promise<number> {
  const through = Math.min(seq, visitor.lastSeq);
  if (through <= visitor.readSeq) return visitor.readSeq;
  await AppDataSource.getRepository(SupportChatVisitor)
    .createQueryBuilder()
    .update(SupportChatVisitor)
    .set({ readSeq: through })
    .where("id = :id AND \"readSeq\" < :through", { id: visitor.id, through })
    .execute();
  return through;
}

/** The AI's automatic replies to this visitor in the last day, for its per-customer limit. */
export async function countAutoRepliesToVisitor(visitorId: string): Promise<number> {
  return AppDataSource.getRepository(SupportMessage).count({
    where: {
      chatVisitorId: visitorId,
      sentByAi: true,
      sentAt: MoreThanOrEqual(new Date(Date.now() - DAY_MS)),
    },
  });
}

export type ChatTicketFacts = {
  visitor: SupportChatVisitor | null;
  widget: SupportChatWidget | null;
};

export async function chatFactsFor(
  ticket: Pick<SupportTicket, "chatVisitorId" | "companyId">,
): Promise<ChatTicketFacts> {
  if (!ticket.chatVisitorId) return { visitor: null, widget: null };
  const visitor = await AppDataSource.getRepository(SupportChatVisitor).findOneBy({
    id: ticket.chatVisitorId,
    companyId: ticket.companyId,
  });
  const widget = visitor
    ? await AppDataSource.getRepository(SupportChatWidget).findOneBy({
        id: visitor.widgetId,
        companyId: ticket.companyId,
      })
    : null;
  return { visitor, widget };
}

/**
 * Whether a reply on this ticket can reach anyone: by a widget their token still
 * opens, or by an address they confirmed. Writing to nobody would read as an answer
 * on the ticket and be none.
 */
export function visitorReachable(facts: ChatTicketFacts, now = new Date()): boolean {
  const { visitor, widget } = facts;
  if (!visitor) return false;
  if (visitor.email) return true;
  return Boolean(widget?.enabled && visitor.tokenHash && !chatTokenLapsed(visitor, now));
}

/** A row the widget shows as written for this visitor came through chat, not by mail. */
export function isChatRow(
  message: Pick<SupportMessage, "chatVisitorId" | "gmailMessageId">,
): boolean {
  return Boolean(message.chatVisitorId) && !message.gmailMessageId;
}

/** What the people working a ticket see about its visitor. */
export function chatTicketView(facts: ChatTicketFacts, now = new Date()) {
  const { visitor, widget } = facts;
  if (!visitor) return null;
  return {
    widgetEnabled: Boolean(widget?.enabled),
    reachable: visitorReachable(facts, now),
    ended: !visitor.tokenHash,
    email: visitor.email,
    /** Typed and not confirmed: anyone can type anyone's address. */
    unconfirmedEmail: visitor.pendingEmail,
    lastSeenAt: visitor.lastSeenAt.toISOString(),
  };
}
