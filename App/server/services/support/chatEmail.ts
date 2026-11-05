import crypto from "node:crypto";

import { IsNull, MoreThan, Not } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { SupportChatVisitor } from "../../db/entities/SupportChatVisitor.js";
import { SupportChatWidget } from "../../db/entities/SupportChatWidget.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import type { SupportJob } from "../../db/entities/SupportJob.js";
import { SupportMessage } from "../../db/entities/SupportMessage.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  SUPPORT_CHAT_EMAIL_LINK_HOURS,
  SUPPORT_CHAT_LIMITS,
  type ChatEmailConfirmation,
  type ChatEmailStatus,
} from "../../../shared/supportChat.js";
import { isSuppressed } from "../mail/suppression.js";
import { getPublicUrl } from "../publicUrl.js";
import { patchTicket, recordTicketEvent, requesterDisplay } from "./access.js";
import { mayConfirmRecipient } from "./chatThrottle.js";
import { hashChatToken } from "./chatVisitors.js";
import type { LiveWidget } from "./chatWidgets.js";
import { SupportNotFoundError, SupportValidationError } from "./errors.js";
import { ownAddressesForInbox } from "./inboxes.js";
import { isNoReplyAddress, untaggedAddress } from "./mailSignals.js";
import { enqueueSupportJob, type SupportJobOutcome } from "./queue.js";
import { sendAutomatedMessage, sendFixedEmail } from "./replies.js";
import { linkRequester } from "./tickets.js";

/**
 * How a Chat widget visitor gets an answer after leaving the page.
 *
 * Anyone can type anyone's address, and an AI Employee that answered whatever address
 * it was given would be a way to send a stranger mail from the company's own mailbox.
 * So a typed address is only a claim. It earns one email in fixed words, with nothing
 * in it the visitor wrote, not even their name, linking to a page where a person presses
 * Confirm: mail scanners follow every link, so loading the page proves nothing. Only
 * then does it become the Ticket's requester, match a Customer, or receive a reply.
 *
 * Replies are always written to the conversation. What a confirmed visitor has not read
 * after a couple of minutes goes by email, and answering that email joins the ticket
 * through its thread like any other mail. No link in those emails opens the conversation:
 * the email already holds the reply, and one more bearer credential in a mailbox would
 * buy nothing.
 *
 * Every answer to a visitor is the same whether the address is on the do-not-email list,
 * was recently asked about, or is fine, so this can't be used to learn which is which.
 */

const TOKEN_BYTES = 32;
const LINK_MS = SUPPORT_CHAT_EMAIL_LINK_HOURS * 60 * 60_000;
/** The replies one email carries; anything older they can read in the widget. */
const EMAIL_REPLIES = 20;
const TICKETS_TO_UPDATE = 50;

const RESUME_NOTE = "You can answer this email, or carry on in the chat on our website.";

/**
 * Ask for replies at an address. Refuses only what is visible in the address itself;
 * anything to do with who it belongs to is decided later, out of the visitor's sight.
 */
export async function requestChatEmail(args: {
  live: LiveWidget;
  visitor: SupportChatVisitor;
  email: string;
  name?: string;
}): Promise<ChatEmailStatus> {
  const { live, visitor } = args;
  // The address parser takes what mail allows. This one came from a stranger's browser,
  // and a control character has no business in an address, nor Postgres in storing a NUL.
  const address = hasControlCharacter(args.email) ? null : normalizeEmail(args.email);
  if (!address) throw new SupportValidationError("That does not look like an email address.");
  if (isNoReplyAddress(address)) {
    throw new SupportValidationError("That address does not take replies. Try another one.");
  }
  const own = new Set((await ownAddressesForInbox(live.inbox)).map(untaggedAddress));
  if (own.has(untaggedAddress(address))) {
    throw new SupportValidationError("That is our own address. Try yours.");
  }
  const name = cleanVisitorName(args.name ?? visitor.name);
  if (name !== visitor.name) await nameVisitor(visitor, name);
  // Already theirs: nothing to prove again, and no reason to send anything.
  if (visitor.email === address) {
    await AppDataSource.getRepository(SupportChatVisitor).update(
      { id: visitor.id },
      { pendingEmail: "", pendingEmailTokenHash: null, pendingEmailSentAt: null },
    );
    return { state: "confirmed", address };
  }
  // A new request replaces the last. An earlier link stops working here, not at its expiry.
  await AppDataSource.getRepository(SupportChatVisitor).update(
    { id: visitor.id },
    { pendingEmail: address, pendingEmailTokenHash: null, pendingEmailSentAt: null },
  );
  await enqueueSupportJob({
    companyId: visitor.companyId,
    kind: "chat_confirm",
    targetId: visitor.id,
  });
  return { state: "pending", address };
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function cleanVisitorName(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUPPORT_CHAT_LIMITS.nameChars);
}

/** A name is only ever a label. Their open tickets take it so a Member has something to call them. */
async function nameVisitor(visitor: SupportChatVisitor, name: string): Promise<void> {
  await AppDataSource.getRepository(SupportChatVisitor).update({ id: visitor.id }, { name });
  visitor.name = name;
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: { chatVisitorId: visitor.id, status: Not("closed"), mergedIntoId: IsNull() },
    select: { id: true, companyId: true },
    take: TICKETS_TO_UPDATE,
  });
  for (const ticket of tickets) await patchTicket(ticket, { requesterName: name });
}

/** Send the one confirmation. Quiet on every outcome: nobody is told which it was. */
export async function runChatConfirmJob(
  job: Pick<SupportJob, "targetId">,
): Promise<SupportJobOutcome> {
  const repo = AppDataSource.getRepository(SupportChatVisitor);
  const visitor = await repo.findOneBy({ id: job.targetId });
  if (!visitor?.pendingEmail || visitor.pendingEmailSentAt) return { outcome: "done" };
  const widget = await AppDataSource.getRepository(SupportChatWidget).findOneBy({
    id: visitor.widgetId,
  });
  const inbox = widget
    ? await AppDataSource.getRepository(SupportInbox).findOneBy({ id: widget.inboxId })
    : null;
  if (!widget?.enabled || !inbox) return { outcome: "done" };
  const address = visitor.pendingEmail;
  if (await isSuppressed(visitor.companyId, address)) return { outcome: "done" };
  if (!(await mayConfirmRecipient(visitor.companyId, address))) return { outcome: "done" };

  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  // Stamped first, and only if they did not change it meanwhile: at most one email.
  const claim = await repo
    .createQueryBuilder()
    .update(SupportChatVisitor)
    .set({ pendingEmailTokenHash: hashChatToken(token), pendingEmailSentAt: new Date() })
    .where('id = :id AND "pendingEmail" = :address AND "pendingEmailSentAt" IS NULL', {
      id: visitor.id,
      address,
    })
    .execute();
  if (claim.affected !== 1) return { outcome: "done" };
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: visitor.companyId });
  const companyName = company?.name ?? "our support team";
  const link = `${getPublicUrl()}/support-chat/confirm/${encodeURIComponent(token)}`;
  try {
    await sendFixedEmail({
      inbox,
      to: address,
      subject: `Confirm your email address for ${companyName}`,
      body: [
        `Someone asked for replies from ${companyName} to be sent to this address.`,
        `If that was you, confirm it here: ${link}`,
        "If it was not, ignore this email and nothing more will be sent.",
      ].join("\n\n"),
    });
  } catch (error) {
    // The widget says only that it is waiting; they can ask again, within the limits.
    // eslint-disable-next-line no-console
    console.warn(`[support] could not send a chat confirmation for ${visitor.id}:`, error);
  }
  return { outcome: "done" };
}

async function confirmationFor(token: string): Promise<SupportChatVisitor | null> {
  return AppDataSource.getRepository(SupportChatVisitor).findOneBy({
    pendingEmailTokenHash: hashChatToken(token),
  });
}

function linkExpired(visitor: Pick<SupportChatVisitor, "pendingEmailSentAt">): boolean {
  const sent = visitor.pendingEmailSentAt?.getTime() ?? 0;
  return Date.now() - sent > LINK_MS;
}

/** What the page behind the link shows. It holds the address it was sent to, and nothing else. */
export async function lookupChatEmailConfirmation(
  token: string,
): Promise<ChatEmailConfirmation | null> {
  const visitor = await confirmationFor(token);
  if (!visitor) return null;
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: visitor.companyId });
  return {
    companyName: company?.name ?? "",
    address: visitor.pendingEmail,
    state: linkExpired(visitor) ? "expired" : "ready",
  };
}

/**
 * A person pressed Confirm. From here the address is the requester of this visitor's
 * open tickets, and whatever they missed in the meantime is on its way.
 */
export async function confirmChatEmail(token: string): Promise<ChatEmailConfirmation> {
  const visitor = await confirmationFor(token);
  if (!visitor) throw new SupportNotFoundError("This link is no longer valid.");
  const page = await lookupChatEmailConfirmation(token);
  if (!page || page.state === "expired") {
    throw new SupportValidationError("This link has expired. Ask again from the chat.");
  }
  const address = visitor.pendingEmail;
  await AppDataSource.getRepository(SupportChatVisitor).update(
    { id: visitor.id },
    {
      email: address,
      emailConfirmedAt: new Date(),
      pendingEmail: "",
      pendingEmailTokenHash: null,
      pendingEmailSentAt: null,
    },
  );
  const link = await linkRequester(visitor.companyId, address);
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: { chatVisitorId: visitor.id, status: Not("closed"), mergedIntoId: IsNull() },
    take: TICKETS_TO_UPDATE,
  });
  for (const ticket of tickets) {
    await patchTicket(ticket, {
      requesterEmail: address,
      customerId: ticket.customerId ?? link.customerId,
      contactId: ticket.contactId ?? link.contactId,
    });
    await recordTicketEvent({
      ticket,
      kind: "chat_email_confirmed",
      actor: { kind: "customer", name: requesterDisplay({ ...ticket, requesterEmail: address }) },
      data: { address },
    });
    await enqueueSupportJob({
      companyId: ticket.companyId,
      kind: "chat_email",
      targetId: ticket.id,
      ticketId: ticket.id,
    });
  }
  return { companyName: page.companyName, address, state: "confirmed" };
}

/**
 * Email what a confirmed visitor has not read. Stamped before it goes, like every
 * automatic email here: at most once, and a failure tells a person rather than trying
 * again, since the reply is safe in the conversation either way.
 */
export async function runChatEmailJob(
  job: Pick<SupportJob, "companyId" | "targetId">,
): Promise<SupportJobOutcome> {
  const ticket = await AppDataSource.getRepository(SupportTicket).findOneBy({
    id: job.targetId,
    companyId: job.companyId,
  });
  if (!ticket?.chatVisitorId || ticket.status === "spam") return { outcome: "done" };
  const visitors = AppDataSource.getRepository(SupportChatVisitor);
  const visitor = await visitors.findOneBy({ id: ticket.chatVisitorId });
  if (!visitor?.email || ticket.requesterEmail !== visitor.email) return { outcome: "done" };
  const seen = Math.max(visitor.readSeq, visitor.emailedSeq);
  const unread = await AppDataSource.getRepository(SupportMessage).find({
    where: {
      chatVisitorId: visitor.id,
      ticketId: ticket.id,
      kind: "reply",
      // A reply that came from the mailbox reached their inbox by itself.
      gmailMessageId: IsNull(),
      chatSeq: MoreThan(seen),
    },
    order: { chatSeq: "ASC" },
    take: EMAIL_REPLIES,
  });
  const last = unread[unread.length - 1];
  if (!last?.chatSeq) return { outcome: "done" };
  const claim = await visitors
    .createQueryBuilder()
    .update(SupportChatVisitor)
    .set({ emailedSeq: last.chatSeq })
    .where('id = :id AND "emailedSeq" < :seq', { id: visitor.id, seq: last.chatSeq })
    .execute();
  if (claim.affected !== 1) return { outcome: "done" };
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: ticket.companyId });
  try {
    const sent = await sendAutomatedMessage({
      ticket,
      // Not "Re:" the ticket: its subject is whatever a stranger's first line said.
      subject: `Your chat with ${company?.name ?? "our support team"}`,
      body: [unread.map((row) => row.bodyText).join("\n\n"), RESUME_NOTE].join("\n\n"),
      storedBody:
        unread.length === 1
          ? "Emailed them the reply they had not read in the chat."
          : `Emailed them the ${unread.length} replies they had not read in the chat.`,
    });
    // The do-not-email list or an address that takes no replies: a person should know
    // their answer is sitting unread, whoever said to stop.
    if (!sent) {
      await recordTicketEvent({
        ticket,
        kind: "delivery_failed",
        actor: { kind: "system" },
        data: { reason: "This address does not take email from us." },
      });
    }
  } catch (error) {
    await recordTicketEvent({
      ticket,
      kind: "delivery_failed",
      actor: { kind: "system" },
      data: { reason: error instanceof Error ? error.message.slice(0, 300) : "The mail server refused it." },
    });
  }
  return { outcome: "done" };
}
