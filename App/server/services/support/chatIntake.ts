import { IsNull } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import type { SupportChatVisitor } from "../../db/entities/SupportChatVisitor.js";
import { SupportMessage } from "../../db/entities/SupportMessage.js";
import type { SupportSettings } from "../../db/entities/SupportSettings.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { SUPPORT_PRIORITY_RANK } from "../../../shared/support.js";
import { SUPPORT_CHAT_LIMITS, SUPPORT_CHAT_VISITOR_LABEL } from "../../../shared/supportChat.js";
import { emitResourceChange } from "../resourceEvents.js";
import { announceTicket, recordTicketEvent } from "./access.js";
import { takeChatSeq } from "./chatVisitors.js";
import type { LiveWidget } from "./chatWidgets.js";
import { SupportConflictError, SupportValidationError } from "./errors.js";
import { afterOpened, noteCustomerWrote, takeTicketNumber } from "./intake.js";
import { getSupportSettings } from "./settings.js";
import { linkRequester, nextSlaDue, targetsFrom } from "./tickets.js";

/**
 * How a chat message becomes a Ticket. The chat widget's counterpart of `intake.ts`,
 * and like it, this reads nothing a visitor wrote for its meaning: the words are
 * stored and handed, as data, to the AI's restricted turn.
 *
 * It differs from mail in three ways. There is no thread, so a closed ticket's next
 * message opens a new ticket rather than reopening the old one, whose AI reply count
 * and history have nothing to do with a new question. A person is typing, in bursts,
 * through an endpoint anyone can post to: a stranger's fifth line in a minute is one
 * thing to hear about, so only the line that makes a ticket owed tells whoever holds it
 * and wakes a Routine. And an address they typed is not known: a ticket has a requester
 * address only once they confirmed one.
 */

/** Anyone can post this. Postgres refuses a NUL byte in text, so none gets that far. */
function cleanChatText(raw: string): string {
  return raw.replaceAll("\u0000", "").replace(/\r\n?/g, "\n").trim();
}

/** A ticket from chat has no subject line, so it takes the start of what they asked. */
function chatSubject(text: string): string {
  const firstLine = text.split("\n", 1)[0].replace(/\s+/g, " ").trim();
  const limit = SUPPORT_CHAT_LIMITS.subjectChars;
  return firstLine.length > limit ? `${firstLine.slice(0, limit - 1).trimEnd()}…` : firstLine;
}

/** A ticket is owed an answer already: the customer spoke last and it is in the queue. */
function customerIsOwed(
  ticket: Pick<SupportTicket, "actionable" | "lastCustomerMessageAt" | "lastAgentMessageAt">,
): boolean {
  if (!ticket.actionable || !ticket.lastCustomerMessageAt) return false;
  return !ticket.lastAgentMessageAt || ticket.lastCustomerMessageAt > ticket.lastAgentMessageAt;
}

function newChatTicket(args: {
  number: number;
  inboxId: string;
  visitor: SupportChatVisitor;
  subject: string;
  now: Date;
  settings: SupportSettings;
  link: { contactId: string | null; customerId: string | null };
}): Partial<SupportTicket> {
  const { visitor, now, settings } = args;
  const clocks = targetsFrom({ settings, priority: "normal", from: now });
  return {
    companyId: visitor.companyId,
    number: args.number,
    inboxId: args.inboxId,
    accountId: null,
    gmailThreadId: null,
    status: "new",
    actionable: true,
    priority: "normal",
    priorityRank: SUPPORT_PRIORITY_RANK.normal,
    subject: args.subject,
    requesterEmail: visitor.email,
    requesterName: visitor.name,
    customerId: args.link.customerId,
    contactId: args.link.contactId,
    messageCount: 1,
    lastActivityAt: now,
    lastCustomerMessageAt: now,
    firstResponseDueAt: clocks.firstResponseDue,
    responseDueAt: clocks.firstResponseDue,
    resolutionDueAt: clocks.resolutionDue,
    slaDueAt: nextSlaDue({
      actionable: true,
      slaEnabled: settings.slaEnabled,
      responseDueAt: clocks.firstResponseDue,
      resolutionDueAt: clocks.resolutionDue,
    }),
    source: "chat",
    chatVisitorId: visitor.id,
  };
}

/**
 * A visitor wrote. `clientId` is the widget's own id for this message: asked to take
 * the same one twice, this hands back the first and does nothing else, so a retry
 * after a lost response can't double-post it or start another model turn.
 */
export async function receiveVisitorMessage(args: {
  live: LiveWidget;
  visitor: SupportChatVisitor;
  clientId: string;
  text: string;
  now?: Date;
}): Promise<{ message: SupportMessage; replayed: boolean }> {
  const { visitor, clientId } = args;
  const { inbox } = args.live;
  const text = cleanChatText(args.text);
  if (!text) throw new SupportValidationError("Write something to send.");
  if (text.length > SUPPORT_CHAT_LIMITS.messageChars) {
    throw new SupportValidationError("That message is too long. Try splitting it up.");
  }
  const repo = AppDataSource.getRepository(SupportMessage);
  const already = await repo.findOneBy({ chatVisitorId: visitor.id, chatClientId: clientId });
  if (already) return { message: already, replayed: true };
  if (inbox.status !== "active") {
    throw new SupportConflictError("This chat is closed just now.", "closed");
  }

  const settings = await getSupportSettings(visitor.companyId);
  const link = visitor.email
    ? await linkRequester(visitor.companyId, visitor.email)
    : { contactId: null, customerId: null };
  const now = args.now ?? new Date();
  let written: { ticket: SupportTicket; message: SupportMessage; opened: boolean };
  try {
    written = await AppDataSource.transaction(async (manager) => {
      // Taking the sequence first holds the visitor's row, so two messages at once
      // agree on which ticket they belong to.
      const chatSeq = await takeChatSeq(manager, visitor.id);
      const tickets = manager.getRepository(SupportTicket);
      const current = await tickets.findOne({
        where: { chatVisitorId: visitor.id, mergedIntoId: IsNull() },
        // Numbers only go up, and a clock in whole seconds can tie.
        order: { number: "DESC" },
      });
      const opened = !current || current.status === "closed";
      const ticket = opened
        ? await tickets.save(
            tickets.create(
              newChatTicket({
                number: await takeTicketNumber(manager, visitor.companyId),
                inboxId: inbox.id,
                visitor,
                subject: chatSubject(text),
                now,
                settings,
                link,
              }),
            ),
          )
        : current;
      const messages = manager.getRepository(SupportMessage);
      const message = await messages.save(
        messages.create({
          companyId: visitor.companyId,
          ticketId: ticket.id,
          kind: "customer",
          chatVisitorId: visitor.id,
          chatSeq,
          chatClientId: clientId,
          fromName: visitor.name,
          subject: ticket.subject,
          sentAt: now,
          bodyText: text,
          cleanText: text,
        }),
      );
      return { ticket, message, opened };
    });
  } catch (error) {
    // Lost a race to take the same message: the unique index did its job.
    const raced = await repo.findOneBy({ chatVisitorId: visitor.id, chatClientId: clientId });
    if (raced) return { message: raced, replayed: true };
    throw error;
  }

  const { ticket, message, opened } = written;
  if (opened) {
    await recordTicketEvent({
      ticket,
      kind: "created",
      actor: { kind: "customer", name: visitor.name || SUPPORT_CHAT_VISITOR_LABEL },
      data: { source: "chat" },
    });
    announceTicket(ticket);
    emitResourceChange(ticket.companyId, "support_ticket", ticket.id);
    await afterOpened(ticket, inbox, null);
    return { message, replayed: false };
  }
  const owed = customerIsOwed(ticket);
  await noteCustomerWrote({ ticket, sentAt: now, now, notify: !owed });
  // A Trigger on `support_ticket` runs a whole employee turn. Waking one per line
  // would let anyone with a browser keep a Routine running by typing.
  if (!owed && ticket.status !== "spam") {
    emitResourceChange(ticket.companyId, "support_ticket", ticket.id);
  }
  return { message, replayed: false };
}
