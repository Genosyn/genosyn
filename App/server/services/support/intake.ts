import { In, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { SupportDraft } from "../../db/entities/SupportDraft.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import { SupportJob } from "../../db/entities/SupportJob.js";
import { SupportMessage } from "../../db/entities/SupportMessage.js";
import { SupportSettings } from "../../db/entities/SupportSettings.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import {
  SUPPORT_MAX_IMPORT_TICKETS,
  SUPPORT_PRIORITY_RANK,
  ticketReference,
} from "../../../shared/support.js";
import { parseAddressList } from "../../lib/emailAddress.js";
import { hasBlockedSender } from "../mail/blockedSenders.js";
import type { GmailHeader } from "../mail/gmailClient.js";
import { mailboxForAccount } from "../mail/mailbox/index.js";
import { columnHasLabel } from "../mail/store.js";
import { createNotifications } from "../notifications.js";
import {
  announceTicket,
  parseJsonArray,
  patchTicket,
  recordTicketEvent,
  requesterDisplay,
} from "./access.js";
import { appendChatRow } from "./chatVisitors.js";
import { activeInboxesFor, matchInbox, ownAddressesFor } from "./inboxes.js";
import {
  bareSubject,
  classifyAutomatedMail,
  cleanEmailText,
  deliveryAddresses,
  isNoReplyAddress,
  resolveRequester,
  untaggedAddress,
  type AutomatedVerdict,
} from "./mailSignals.js";
import { enqueueSupportJob, type SupportJobOutcome } from "./queue.js";
import { getSupportSettings } from "./settings.js";
import { liveTicket, linkRequester, nextSlaDue, statusFields, targetsFrom } from "./tickets.js";
import { queueTicketWork } from "./work.js";

/**
 * How mail becomes tickets.
 *
 * The mailbox's sync engines keep mirroring exactly as they always have; this
 * module reads what they mirrored and is told about it at two moments. An
 * arrival (`noteInboundMail`, from the mail automation outbox) may open a ticket.
 * Any other message on a conversation a ticket already holds (`noteMirroredMail`,
 * after each sync pass) joins it — a reply someone sent from Gmail itself, say.
 * Both only queue an `intake` job, so a slow mail server or a bug here can never
 * hold mail back, and the job is safe to repeat: `(accountId, gmailMessageId)` on
 * `SupportMessage` means one email is captured once.
 *
 * What a customer writes is untrusted from here on. Nothing in this module reads
 * its meaning; the words are stored and handed, as data, to the AI's restricted
 * turn. The only decisions made here are about the envelope.
 */

/** Delay before an AI turn, so three quick emails become one read. */
const WORK_DELAY_MS = 8_000;
/** A message this recent is answered as live mail, even if an import pass found it. */
const FRESH_MS = 60 * 60_000;
/** How often an import looks again while its mailbox is still coming in. */
const IMPORT_RECHECK_MS = 60_000;
/** Imported tickets an AI Employee drafts for, newest first. */
const IMPORT_WORK_LIMIT = 50;
const MIRRORED_MESSAGE_LIMIT = 2_000;
const LOOKUP_CHUNK = 200;

export type LiveHeaderReader = (
  account: MailAccount,
  message: Pick<MailMessage, "gmailMessageId">,
) => Promise<GmailHeader[]>;

async function readLiveHeaders(
  account: MailAccount,
  message: Pick<MailMessage, "gmailMessageId">,
): Promise<GmailHeader[]> {
  const mailbox = await mailboxForAccount(account);
  return mailbox.getMessageHeaders(message.gmailMessageId);
}

let headerReader: LiveHeaderReader = readLiveHeaders;

/** Replace the read of a message's live headers in a test. Null restores the real one. */
export function setSupportHeaderReaderForTests(reader: LiveHeaderReader | null): void {
  headerReader = reader ?? readLiveHeaders;
}

// ── Being told about mail ───────────────────────────────────────────────────

/** A message just arrived. Cheap for a mailbox with no Support inbox: one indexed read. */
export async function noteInboundMail(message: MailMessage): Promise<void> {
  const inbox = await AppDataSource.getRepository(SupportInbox).findOne({
    where: { accountId: message.accountId },
    select: { id: true },
  });
  if (!inbox) return;
  await enqueueSupportJob({ companyId: message.companyId, kind: "intake", targetId: message.id });
}

/**
 * A sync pass finished: anything it mirrored onto a conversation a ticket holds
 * belongs on that ticket. Never throws, because a bug here must not stop mail
 * arriving.
 */
export async function noteMirroredMail(account: MailAccount, since: Date): Promise<void> {
  try {
    const inbox = await AppDataSource.getRepository(SupportTicket).findOne({
      where: { accountId: account.id },
      select: { id: true },
    });
    if (!inbox) return;
    const rows = await AppDataSource.getRepository(MailMessage).find({
      where: { accountId: account.id, createdAt: MoreThanOrEqual(since) },
      select: { id: true, gmailThreadId: true },
      take: MIRRORED_MESSAGE_LIMIT,
    });
    if (rows.length === 0) return;
    const threads = [...new Set(rows.map((row) => row.gmailThreadId))];
    const tracked = new Set<string>();
    for (let index = 0; index < threads.length; index += LOOKUP_CHUNK) {
      const found = await AppDataSource.getRepository(SupportTicket).find({
        where: {
          accountId: account.id,
          gmailThreadId: In(threads.slice(index, index + LOOKUP_CHUNK)),
        },
        select: { id: true, gmailThreadId: true },
      });
      for (const ticket of found) if (ticket.gmailThreadId) tracked.add(ticket.gmailThreadId);
    }
    for (const row of rows) {
      if (!tracked.has(row.gmailThreadId)) continue;
      await enqueueSupportJob({ companyId: account.companyId, kind: "intake", targetId: row.id });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[support] could not read the sync pass of mailbox ${account.id}:`, error);
  }
}

/**
 * Whether this email is Support's to read, so the mailbox's own AI analysis need
 * not read it too: one read per email, not two model calls for one customer.
 * Uses only what the mirror holds, and answers false on anything unexpected.
 */
export async function messageBelongsToSupport(
  account: MailAccount,
  message: MailMessage,
): Promise<boolean> {
  const inboxes = await activeInboxesFor(account.id);
  if (inboxes.length === 0) return false;
  const ticket = await AppDataSource.getRepository(SupportTicket).findOne({
    where: { accountId: account.id, gmailThreadId: message.gmailThreadId },
    select: { id: true },
  });
  if (ticket) return true;
  return Boolean(
    matchInbox(
      inboxes,
      deliveryAddresses({
        to: message.toEmails,
        cc: message.ccEmails,
        bcc: message.bccEmails,
      }),
      account.address,
    ),
  );
}

// ── Capturing one message ───────────────────────────────────────────────────

export type CaptureResult =
  | { outcome: "ignored"; reason: string }
  | { outcome: "existing"; ticketId: string }
  | { outcome: "appended"; ticketId: string; kind: SupportMessage["kind"] }
  | { outcome: "created"; ticketId: string };

type CaptureOptions = {
  /** Importing history: no AI, no acknowledgement, no notifications from here. */
  quiet?: boolean;
  source?: "email" | "import";
  now?: Date;
};

function sentAtOf(message: MailMessage): Date {
  return message.sentAt ?? message.createdAt;
}

function attachmentsFor(message: MailMessage): string {
  return message.attachmentsJson || "[]";
}

/** The ticket on this conversation, or the one its reply headers point to. */
async function ticketForMessage(
  account: MailAccount,
  message: MailMessage,
): Promise<SupportTicket | null> {
  const repo = AppDataSource.getRepository(SupportTicket);
  const byThread = await repo.findOneBy({
    accountId: account.id,
    gmailThreadId: message.gmailThreadId,
  });
  if (byThread) return liveTicket(byThread);
  // A reply can land on a new conversation when a client breaks the thread or
  // the subject changed. Its own headers still say what it answers.
  const ids = [message.inReplyToHeader, ...message.referencesHeader.split(/\s+/)]
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (ids.length === 0) return null;
  const earlier = await AppDataSource.getRepository(SupportMessage).findOne({
    where: { companyId: account.companyId, messageIdHeader: In(ids) },
    select: { id: true, ticketId: true },
  });
  if (!earlier) return null;
  const ticket = await repo.findOneBy({ id: earlier.ticketId });
  return ticket ? liveTicket(ticket) : null;
}

/** Everyone a customer's message was also sent to, minus the company and the customer. */
function colleaguesOn(
  message: MailMessage,
  ownAddresses: readonly string[],
  requesterEmail: string,
): string[] {
  const own = new Set(ownAddresses.map(untaggedAddress));
  const all = [
    ...parseAddressList(message.toEmails).addresses,
    ...parseAddressList(message.ccEmails).addresses,
  ];
  const fromEmail = message.fromEmail.toLowerCase();
  return [
    ...new Set(
      all
        .map((address) => address.toLowerCase())
        .filter(
          (address) =>
            !own.has(untaggedAddress(address)) &&
            address !== requesterEmail &&
            address !== fromEmail &&
            !isNoReplyAddress(address),
        ),
    ),
  ];
}

type MessageFields = Partial<SupportMessage> &
  Pick<SupportMessage, "companyId" | "ticketId" | "kind" | "sentAt">;

/** Keep one email. `chatVisitorId` also lets that visitor's widget show it. */
async function insertMessage(
  fields: MessageFields,
  chatVisitorId: string | null = null,
): Promise<SupportMessage | null> {
  const repo = AppDataSource.getRepository(SupportMessage);
  try {
    if (chatVisitorId) return await appendChatRow({ visitorId: chatVisitorId, fields });
    return await repo.save(repo.create(fields));
  } catch (error) {
    // Lost a race to capture the same email: the unique index did its job.
    if (
      fields.accountId &&
      fields.gmailMessageId &&
      (await repo.findOneBy({ accountId: fields.accountId, gmailMessageId: fields.gmailMessageId }))
    ) {
      return null;
    }
    throw error;
  }
}

function messageFieldsFrom(
  account: MailAccount,
  message: MailMessage,
  ticketId: string,
  kind: SupportMessage["kind"],
  automatedKind: string,
): MessageFields {
  return {
    companyId: account.companyId,
    ticketId,
    kind,
    automatedKind,
    accountId: account.id,
    gmailMessageId: message.gmailMessageId,
    messageIdHeader: message.messageIdHeader,
    inReplyToHeader: message.inReplyToHeader,
    referencesHeader: message.referencesHeader,
    fromName: message.fromName,
    fromEmail: message.fromEmail.toLowerCase(),
    toEmails: message.toEmails,
    ccEmails: message.ccEmails,
    subject: message.subject,
    sentAt: sentAtOf(message),
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    cleanText: cleanEmailText(message.bodyText || message.snippet),
    attachmentsJson: attachmentsFor(message),
    authorUserId: message.createdByUserId,
    authorEmployeeId: message.createdByEmployeeId,
  };
}

/** The next number in this company's sequence. Only ever inside the ticket's own transaction. */
async function takeTicketNumber(
  manager: import("typeorm").EntityManager,
  companyId: string,
): Promise<number> {
  await manager
    .createQueryBuilder()
    .update(SupportSettings)
    .set({ nextTicketNumber: () => '"nextTicketNumber" + 1' })
    .where('"companyId" = :companyId', { companyId })
    .execute();
  const settings = await manager.findOneByOrFail(SupportSettings, { companyId });
  return settings.nextTicketNumber - 1;
}

export { takeTicketNumber };

async function openTicket(args: {
  account: MailAccount;
  inbox: SupportInbox;
  message: MailMessage;
  matchedAddress: string;
  requester: { email: string; name: string };
  ownAddresses: string[];
  verdict: AutomatedVerdict;
  options: CaptureOptions;
}): Promise<SupportTicket | null> {
  const { account, inbox, message, requester, options, verdict } = args;
  const settings = await getSupportSettings(account.companyId);
  const now = options.now ?? new Date();
  const sentAt = sentAtOf(message);
  const live = options.source !== "import" || now.getTime() - sentAt.getTime() < FRESH_MS;
  const spam = verdict?.kind === "bulk";
  const clocks = live && !spam ? targetsFrom({ settings, priority: "normal", from: sentAt }) : null;
  const link = await linkRequester(account.companyId, requester.email);
  const status = spam ? ("spam" as const) : ("new" as const);
  const actionable = !spam;
  const cc = colleaguesOn(message, args.ownAddresses, requester.email);
  const subject = bareSubject(message.subject) || "(no subject)";
  try {
    const ticket = await AppDataSource.transaction(async (manager) => {
      const number = await takeTicketNumber(manager, account.companyId);
      const repo = manager.getRepository(SupportTicket);
      const saved = await repo.save(
        repo.create({
          companyId: account.companyId,
          number,
          inboxId: inbox.id,
          accountId: account.id,
          gmailThreadId: message.gmailThreadId,
          status,
          actionable,
          priority: "normal",
          priorityRank: SUPPORT_PRIORITY_RANK.normal,
          subject,
          requesterEmail: requester.email,
          requesterName: requester.name,
          matchedAddress: args.matchedAddress,
          customerId: link.customerId,
          contactId: link.contactId,
          messageCount: 1,
          lastActivityAt: sentAt > now ? now : sentAt,
          lastCustomerMessageAt: sentAt,
          firstResponseDueAt: clocks?.firstResponseDue ?? null,
          responseDueAt: clocks?.firstResponseDue ?? null,
          resolutionDueAt: clocks?.resolutionDue ?? null,
          slaDueAt: nextSlaDue({
            actionable,
            slaEnabled: settings.slaEnabled,
            responseDueAt: clocks?.firstResponseDue ?? null,
            resolutionDueAt: clocks?.resolutionDue ?? null,
          }),
          source: options.source ?? "email",
          ccJson: JSON.stringify(cc),
          spamReason: spam ? (verdict?.reason ?? "") : "",
        }),
      );
      const messages = manager.getRepository(SupportMessage);
      await messages.save(
        messages.create(
          messageFieldsFrom(account, message, saved.id, "customer", verdict?.kind ?? ""),
        ),
      );
      return saved;
    });
    await recordTicketEvent({
      ticket,
      kind: "created",
      actor: { kind: "customer", name: requester.name || requester.email },
      data: { address: args.matchedAddress, source: options.source ?? "email" },
    });
    announceTicket(ticket);
    return ticket;
  } catch (error) {
    // Another message on this conversation, or a retry of this one, opened it first.
    const existing = await AppDataSource.getRepository(SupportTicket).findOneBy({
      accountId: account.id,
      gmailThreadId: message.gmailThreadId,
    });
    if (existing) return null;
    throw error;
  }
}

export async function afterOpened(
  ticket: SupportTicket,
  inbox: SupportInbox,
  verdict: AutomatedVerdict,
): Promise<void> {
  if (verdict) return;
  await queueTicketWork(ticket, { delayMs: WORK_DELAY_MS });
  if (inbox.acknowledge) {
    await enqueueSupportJob({
      companyId: ticket.companyId,
      kind: "acknowledge",
      targetId: ticket.id,
      ticketId: ticket.id,
    });
  }
}

/** A customer wrote again on a ticket. */
async function appendCustomerMessage(args: {
  account: MailAccount;
  ticket: SupportTicket;
  message: MailMessage;
  ownAddresses: string[];
  verdict: AutomatedVerdict;
  options: CaptureOptions;
}): Promise<CaptureResult> {
  const { account, ticket, message, verdict, options } = args;
  const noPerson = verdict?.kind === "bounce" || verdict?.kind === "auto_reply";
  // A visitor who confirmed this address reads their own emails in the widget too.
  // Only theirs: From is spoofable, and nobody else's words belong in front of them.
  const forVisitor =
    !noPerson && message.fromEmail.toLowerCase() === ticket.requesterEmail
      ? ticket.chatVisitorId
      : null;
  const row = await insertMessage(
    messageFieldsFrom(
      account,
      message,
      ticket.id,
      noPerson ? "automated" : "customer",
      verdict?.kind ?? "",
    ),
    forVisitor,
  );
  if (!row) return { outcome: "existing", ticketId: ticket.id };
  const now = options.now ?? new Date();
  const sentAt = sentAtOf(message);
  const activityAt = sentAt > now ? now : sentAt;

  if (noPerson) {
    // Software answered. Worth knowing when a reply did not arrive, and never a
    // reason to answer it: that is how two autoresponders end up in a loop.
    if (verdict?.kind === "bounce") {
      await patchTicket(ticket, {
        needsHuman: true,
        aiHandoffReason: "A reply to this customer could not be delivered.",
        lastActivityAt: activityAt,
      });
      await recordTicketEvent({
        ticket,
        kind: "delivery_failed",
        actor: { kind: "system" },
        data: { reason: verdict.reason },
      });
    } else {
      announceTicket(ticket);
    }
    return { outcome: "appended", ticketId: ticket.id, kind: "automated" };
  }

  await noteCustomerWrote({
    ticket,
    sentAt,
    now,
    cc: colleaguesOn(message, args.ownAddresses, ticket.requesterEmail),
    verdict,
    quiet: options.quiet,
  });
  return { outcome: "appended", ticketId: ticket.id, kind: "customer" };
}

/**
 * What a customer writing again means for a ticket, however it reached us: its
 * clocks and status, whoever holds it, and the AI Employee's next read. Their words
 * are already on the conversation by now.
 */
export async function noteCustomerWrote(args: {
  ticket: SupportTicket;
  sentAt: Date;
  now: Date;
  cc?: readonly string[];
  verdict?: AutomatedVerdict;
  /** Importing history: no AI and no notifications from here. */
  quiet?: boolean;
  /** Tell whoever holds it. A burst of chat lines is one thing to hear about. */
  notify?: boolean;
}): Promise<void> {
  const { ticket, sentAt, now, verdict } = args;
  const activityAt = sentAt > now ? now : sentAt;
  const settings = await getSupportSettings(ticket.companyId);
  const cc = new Set(parseJsonArray<string>(ticket.ccJson));
  for (const address of args.cc ?? []) cc.add(address);
  const fields: Partial<SupportTicket> = {
    messageCount: ticket.messageCount + 1,
    lastCustomerMessageAt: sentAt,
    lastActivityAt: activityAt,
    aiHandled: false,
    draftReady: false,
    ccJson: JSON.stringify([...cc]),
  };
  const responseDue =
    ticket.responseDueAt ??
    targetsFrom({ settings, priority: ticket.priority, from: sentAt }).firstResponseDue;
  fields.responseDueAt = responseDue;
  const reopening = ticket.status !== "new" && ticket.status !== "open" && ticket.status !== "spam";
  if (reopening) {
    Object.assign(
      fields,
      statusFields({
        ticket: { ...ticket, responseDueAt: responseDue },
        status: "open",
        now,
        settings,
      }),
    );
    fields.draftReady = false;
    fields.aiHandled = false;
  } else {
    fields.slaDueAt = nextSlaDue({
      actionable: ticket.actionable,
      slaEnabled: settings.slaEnabled,
      responseDueAt: responseDue,
      resolutionDueAt: ticket.resolutionDueAt,
    });
  }
  await AppDataSource.getRepository(SupportDraft).update(
    { ticketId: ticket.id, status: "ready" },
    { status: "superseded" },
  );
  await patchTicket(ticket, fields);
  if (reopening) {
    await recordTicketEvent({
      ticket,
      kind: "reopened",
      actor: { kind: "customer", name: requesterDisplay(ticket) },
      data: { from: ticket.status },
    });
  }
  if (args.quiet) return;
  if (ticket.assigneeUserId && args.notify !== false) {
    await createNotifications([
      {
        companyId: ticket.companyId,
        userId: ticket.assigneeUserId,
        kind: "support_customer_replied",
        title: `${requesterDisplay(ticket)} replied on ${ticketReference(ticket.number)}`,
        body: ticket.subject,
        link: `/support/tickets/${ticket.id}`,
        actorKind: "system",
        entityKind: "support_ticket",
        entityId: ticket.id,
      },
    ]);
  }
  if (ticket.status !== "spam" && !verdict) {
    await queueTicketWork(
      { ...ticket, status: reopening ? "open" : ticket.status },
      { delayMs: WORK_DELAY_MS },
    );
  }
}

/** The company wrote on a ticket from outside Genosyn: from Gmail, or an AI Employee's send_mail. */
async function appendOutsideReply(args: {
  account: MailAccount;
  ticket: SupportTicket;
  message: MailMessage;
  options: CaptureOptions;
}): Promise<CaptureResult> {
  const { account, ticket, message, options } = args;
  const row = await insertMessage(
    messageFieldsFrom(account, message, ticket.id, "reply", ""),
    ticket.chatVisitorId,
  );
  if (!row) return { outcome: "existing", ticketId: ticket.id };
  const now = options.now ?? new Date();
  const sentAt = sentAtOf(message);
  const settings = await getSupportSettings(ticket.companyId);
  const fields: Partial<SupportTicket> = {
    messageCount: ticket.messageCount + 1,
    lastAgentMessageAt: sentAt,
    lastActivityAt: sentAt > now ? now : sentAt,
    firstRespondedAt: ticket.firstRespondedAt ?? sentAt,
    responseDueAt: null,
    aiHandled: false,
    draftReady: false,
  };
  if (ticket.actionable) {
    Object.assign(
      fields,
      statusFields({
        ticket: { ...ticket, responseDueAt: null },
        status: "waiting",
        now,
        settings,
      }),
    );
    fields.draftReady = false;
  }
  await AppDataSource.getRepository(SupportDraft).update(
    { ticketId: ticket.id, status: "ready" },
    { status: "superseded" },
  );
  await patchTicket(ticket, fields);
  return { outcome: "appended", ticketId: ticket.id, kind: "reply" };
}

/**
 * Take one mirrored email: onto its ticket, into a new one, or nowhere. `headers`
 * are the message's live headers, or empty when they could not be read, which is
 * why every rule that reads them also works from what the mirror holds.
 */
export async function captureMessage(args: {
  account: MailAccount;
  message: MailMessage;
  headers: readonly GmailHeader[];
  options?: CaptureOptions;
}): Promise<CaptureResult> {
  const { account, message, headers } = args;
  const options = args.options ?? {};
  const already = await AppDataSource.getRepository(SupportMessage).findOne({
    where: { accountId: account.id, gmailMessageId: message.gmailMessageId },
    select: { id: true, ticketId: true },
  });
  if (already) return { outcome: "existing", ticketId: already.ticketId };
  if (columnHasLabel(message.labelIds, "DRAFT")) return { outcome: "ignored", reason: "draft" };

  const ownAddresses = await ownAddressesFor(account);
  const requester = resolveRequester({
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    headers: [...headers],
    ownAddresses,
  });
  const fromUs = columnHasLabel(message.labelIds, "SENT") || !requester;
  const ticket = await ticketForMessage(account, message);
  const verdict = fromUs
    ? null
    : classifyAutomatedMail({
        fromEmail: message.fromEmail,
        subject: message.subject,
        headers,
        ownAddresses,
      });

  if (ticket) {
    if (fromUs) return appendOutsideReply({ account, ticket, message, options });
    return appendCustomerMessage({ account, ticket, message, ownAddresses, verdict, options });
  }
  if (fromUs) return { outcome: "ignored", reason: "sent by the company" };

  const inboxes = await activeInboxesFor(account.id);
  const match = matchInbox(
    inboxes,
    deliveryAddresses({
      to: message.toEmails,
      cc: message.ccEmails,
      bcc: message.bccEmails,
      headers,
    }),
    account.address,
  );
  if (!match) return { outcome: "ignored", reason: "not addressed to a watched address" };
  if (sentAtOf(message) < match.inbox.watchFrom) {
    return { outcome: "ignored", reason: "older than this inbox watches" };
  }
  // Software telling the company something is not a customer asking.
  if (verdict?.kind === "bounce" || verdict?.kind === "auto_reply") {
    return { outcome: "ignored", reason: verdict.reason };
  }
  if (columnHasLabel(message.labelIds, "SPAM") || columnHasLabel(message.labelIds, "TRASH")) {
    return { outcome: "ignored", reason: "in the mailbox's spam or trash" };
  }
  if (await hasBlockedSender(account, message)) {
    return { outcome: "ignored", reason: "from a blocked sender" };
  }
  const opened = await openTicket({
    account,
    inbox: match.inbox,
    message,
    matchedAddress: match.matchedAddress,
    requester: requester as NonNullable<typeof requester>,
    ownAddresses,
    verdict,
    options,
  });
  if (!opened) {
    // Lost the race: the message belongs on the ticket that won.
    return captureMessage(args);
  }
  if (!options.quiet) await afterOpened(opened, match.inbox, verdict);
  return { outcome: "created", ticketId: opened.id };
}

export async function runIntakeJob(
  job: Pick<SupportJob, "targetId" | "attempts">,
): Promise<SupportJobOutcome> {
  const message = await AppDataSource.getRepository(MailMessage).findOneBy({ id: job.targetId });
  if (!message) return { outcome: "done" };
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({
    id: message.accountId,
  });
  if (!account) return { outcome: "done" };
  let headers: GmailHeader[] = [];
  try {
    headers = await headerReader(account, message);
  } catch (error) {
    // A mail server having a moment is worth waiting out, but a ticket is worth
    // more than its headers: on the last try it opens from what the mirror holds.
    if (job.attempts < 3) {
      return {
        outcome: "retry",
        cause: "error",
        detail: `Could not read this email's headers: ${(error as Error).message}`.slice(0, 400),
      };
    }
  }
  await captureMessage({ account, message, headers });
  return { outcome: "done" };
}

// ── Importing ───────────────────────────────────────────────────────────────

/**
 * Conversations a pass has already read, by inbox, so a mailbox importing for hours
 * is not read through again every minute: a conversation is looked at again only when
 * it gains a message. Only a saving: after a restart the next pass reads them once.
 */
const importSeen = new Map<string, Set<string>>();

/**
 * Bring a new inbox's recent mail in, and keep looking while its mailbox is still
 * importing — mail that arrives during an import is not marked as new on IMAP, so
 * it would otherwise wait for the import to finish. Safe to run any number of
 * times; only what is new becomes anything. An AI Employee drafts for the newest
 * tickets still owed an answer, and nothing imported goes out on its own.
 */
export async function runImportJob(job: Pick<SupportJob, "targetId">): Promise<SupportJobOutcome> {
  const inbox = await AppDataSource.getRepository(SupportInbox).findOneBy({ id: job.targetId });
  if (!inbox) {
    importSeen.delete(job.targetId);
    return { outcome: "done" };
  }
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({ id: inbox.accountId });
  if (!account) {
    importSeen.delete(inbox.id);
    return { outcome: "failed", detail: "The mailbox behind this inbox was disconnected." };
  }
  if (inbox.status === "paused") return { outcome: "again", delayMs: 5 * IMPORT_RECHECK_MS };
  const threads = await AppDataSource.getRepository(MailThread).find({
    where: { accountId: account.id, lastMessageAt: MoreThanOrEqual(inbox.watchFrom) },
    order: { lastMessageAt: "DESC" },
    take: SUPPORT_MAX_IMPORT_TICKETS * 2,
    select: { id: true, gmailThreadId: true, messageCount: true },
  });
  const inboxes = await activeInboxesFor(account.id);
  let created = 0;
  const touched: string[] = [];
  const seen = importSeen.get(inbox.id) ?? new Set<string>();
  importSeen.set(inbox.id, seen);
  for (const thread of threads) {
    if (created >= SUPPORT_MAX_IMPORT_TICKETS) break;
    const seenKey = `${thread.id}:${thread.messageCount}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    const messages = await AppDataSource.getRepository(MailMessage).find({
      where: { threadId: thread.id },
      order: { sentAt: "ASC" },
    });
    for (const message of messages) {
      const opensOrJoins =
        (await AppDataSource.getRepository(SupportTicket).findOne({
          where: { accountId: account.id, gmailThreadId: message.gmailThreadId },
          select: { id: true },
        })) !== null ||
        matchInbox(
          inboxes,
          deliveryAddresses({
            to: message.toEmails,
            cc: message.ccEmails,
            bcc: message.bccEmails,
          }),
          account.address,
        ) !== null;
      if (!opensOrJoins) continue;
      const already = await AppDataSource.getRepository(SupportMessage).findOne({
        where: { accountId: account.id, gmailMessageId: message.gmailMessageId },
        select: { id: true },
      });
      if (already) continue;
      let headers: GmailHeader[] = [];
      try {
        headers = await headerReader(account, message);
      } catch {
        // History is best-effort: import from what the mirror holds.
      }
      const result = await captureMessage({
        account,
        message,
        headers,
        options: { quiet: true, source: "import" },
      });
      if (result.outcome === "created") {
        created += 1;
        touched.push(result.ticketId);
      } else if (result.outcome === "appended") {
        touched.push(result.ticketId);
      }
    }
  }
  if (created > 0) {
    await AppDataSource.getRepository(SupportInbox).update(
      { id: inbox.id },
      { importedCount: inbox.importedCount + created },
    );
  }
  // Tickets reached in an import pass owe their first AI read from here, newest first.
  const fresh = [...new Set(touched)];
  if (fresh.length > 0) {
    const tickets = await AppDataSource.getRepository(SupportTicket).find({
      where: { id: In(fresh.slice(0, LOOKUP_CHUNK)), actionable: true },
      order: { lastActivityAt: "DESC" },
      take: IMPORT_WORK_LIMIT,
    });
    for (const ticket of tickets) await queueTicketWork(ticket);
  }
  if (!account.backfilledAt) return { outcome: "again", delayMs: IMPORT_RECHECK_MS };
  importSeen.delete(inbox.id);
  await AppDataSource.getRepository(SupportInbox).update(
    { id: inbox.id },
    { importStatus: "done" },
  );
  return { outcome: "done" };
}
