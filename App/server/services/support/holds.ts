import type { SupportTicket } from "../../db/entities/SupportTicket.js";
import {
  SUPPORT_AUTO_REPLY_MAX_AGE_MS,
  SUPPORT_MAX_AI_REPLIES_PER_REQUESTER_PER_DAY,
  SUPPORT_MAX_AI_REPLIES_PER_TICKET,
  SUPPORT_MAX_AUTO_REPLY_CC,
  type SupportConfidence,
  type SupportSentiment,
  type SupportTopic,
} from "../../../shared/support.js";
import { domainOf, isNoReplyAddress } from "./mailSignals.js";

/**
 * Whether a reply may reach a customer with no person looking at it. Server-owned
 * and pure: the model reports what it found, and this decides, so nothing a
 * customer writes can argue its way past a check by talking to the model. Each
 * reason is shown to the Member who reviews the draft instead. The default answer
 * is no, and an empty list is the only yes.
 *
 * Most of this was written for mail, so each check is kept for the Chat widget on
 * purpose or dropped on purpose. Kept, because they have nothing to do with how a
 * reply travels: everything about the answer, the Topic, the sentiment, who holds it,
 * the limits, its age. Dropped, because they are about an address a chat reply does
 * not go to: who else is copied, whether an address takes replies or is on the
 * do-not-email list, and whether the reply address matches the sender. The email of
 * what a visitor did not read goes through `sendAutomatedMessage`, which checks the
 * address for itself. Only a chat can have nobody at the other end, so that is the
 * one check it adds, and "customer" for its daily limit means the visitor rather
 * than an address most visitors never gave.
 */
export type AutoReplyFacts = {
  /** How this reply would reach them: by email, or in the Chat widget. */
  delivery: "mail" | "chat";
  /** On a chat: their widget no longer opens and they confirmed no address. */
  visitorUnreachable: boolean;
  answerable: boolean;
  citationCount: number;
  droppedQuotes: number;
  injectionDetected: boolean;
  confidence: SupportConfidence;
  needsHuman: boolean;
  needsHumanReason: string;
  sentiment: SupportSentiment;
  priority: SupportTicket["priority"];
  topic: SupportTopic | null;
  ticket: Pick<
    SupportTicket,
    "assigneeUserId" | "aiReplyCount" | "requesterEmail" | "source" | "status"
  >;
  /** How many other people a reply would also reach. */
  ccCount: number;
  /** The sender of the message being answered. */
  fromEmail: string;
  /** Software wrote the message being answered: "bulk", "auto_reply" or "bounce". */
  automatedKind: string;
  /** When the customer sent the message being answered. */
  sentAt: Date;
  now: Date;
  repliesToRequesterToday: number;
  autoRepliesFromInboxToday: number;
  inboxDailyLimit: number;
  requesterSuppressed: boolean;
};

export function autoReplyHolds(facts: AutoReplyFacts): string[] {
  const holds: string[] = [];
  if (!facts.answerable) holds.push("The Articles do not fully answer this.");
  if (facts.answerable && facts.citationCount === 0) holds.push("The reply quotes no Article.");
  if (facts.droppedQuotes > 0) {
    holds.push(
      facts.droppedQuotes === 1
        ? "One quote was not found in the Articles and was removed."
        : `${facts.droppedQuotes} quotes were not found in the Articles and were removed.`,
    );
  }
  if (facts.injectionDetected) {
    holds.push("The customer's message tried to instruct the AI Employee.");
  }
  if (facts.confidence !== "high") {
    holds.push(`The AI Employee's confidence was ${facts.confidence}.`);
  }
  if (facts.needsHuman) {
    holds.push(facts.needsHumanReason.trim() || "The AI Employee says this needs a person.");
  }
  if (!facts.topic) {
    holds.push("It fits none of the topics.");
  } else if (!facts.topic.autoReply) {
    holds.push(`Replies on "${facts.topic.name}" wait for a person.`);
  }
  if (facts.priority === "urgent") holds.push("Urgent tickets wait for a person.");
  if (facts.sentiment === "angry") holds.push("The customer sounds angry.");
  if (facts.ticket.assigneeUserId) holds.push("A Member owns this ticket.");
  if (facts.ticket.aiReplyCount >= SUPPORT_MAX_AI_REPLIES_PER_TICKET) {
    holds.push(
      `The AI Employee has already replied ${facts.ticket.aiReplyCount} times on this ticket.`,
    );
  }
  if (facts.repliesToRequesterToday >= SUPPORT_MAX_AI_REPLIES_PER_REQUESTER_PER_DAY) {
    holds.push("This customer has had enough automatic replies today.");
  }
  if (facts.autoRepliesFromInboxToday >= facts.inboxDailyLimit) {
    holds.push(`This inbox reached its limit of ${facts.inboxDailyLimit} automatic replies a day.`);
  }
  if (facts.automatedKind) holds.push("The message looks automated.");
  if (facts.delivery === "mail") {
    if (facts.ccCount > SUPPORT_MAX_AUTO_REPLY_CC) {
      holds.push(
        `${facts.ccCount} other people are copied, and a person should choose who hears back.`,
      );
    }
    if (isNoReplyAddress(facts.ticket.requesterEmail)) {
      holds.push("The customer's address does not take replies.");
    }
    if (facts.requesterSuppressed) holds.push("This address is on the do-not-email list.");
    if (facts.fromEmail && domainOf(facts.fromEmail) !== domainOf(facts.ticket.requesterEmail)) {
      holds.push("The reply address is on a different domain from the sender.");
    }
  }
  if (facts.delivery === "chat" && facts.visitorUnreachable) {
    holds.push("This visitor can no longer be reached, so nobody would read it.");
  }
  if (facts.now.getTime() - facts.sentAt.getTime() > SUPPORT_AUTO_REPLY_MAX_AGE_MS) {
    holds.push("The message waited too long to be answered automatically.");
  }
  if (facts.ticket.source === "import") holds.push("This ticket was imported.");
  return holds;
}
