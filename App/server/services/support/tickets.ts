import { In, IsNull, MoreThan, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { SupportDraft } from "../../db/entities/SupportDraft.js";
import { SupportEvent } from "../../db/entities/SupportEvent.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import { SupportJob } from "../../db/entities/SupportJob.js";
import { SupportMessage } from "../../db/entities/SupportMessage.js";
import type { SupportSettings } from "../../db/entities/SupportSettings.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  SUPPORT_AT_RISK_WINDOW_MS,
  SUPPORT_LIMITS,
  SUPPORT_PRIORITY_RANK,
  SUPPORT_RATING_DELAY_HOURS,
  addBusinessMinutes,
  ticketReference,
  type SupportPriority,
  type SupportSettableStatus,
  type SupportSort,
  type SupportTicketSource,
  type SupportTicketStatus,
  type SupportView,
} from "../../../shared/support.js";
import { tokenize } from "../dataRooms/retrieval.js";
import {
  type KeysetColumn,
  type Page,
  type PageRequest,
  filterFingerprint,
  keysetPage,
} from "../listPaging.js";
import { andWhereTokens, tokenizeQuery } from "../likeSearch.js";
import { performThreadAction } from "../mail/actions.js";
import { companyDomains, isFreeMailDomain } from "../meetings/domains.js";
import { createNotifications } from "../notifications.js";
import { emitResourceChange } from "../resourceEvents.js";
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
import { chatFactsFor, chatTicketView } from "./chatVisitors.js";
import { SupportConflictError, SupportValidationError } from "./errors.js";
import {
  assertEmployeeInCompany,
  assertMemberInCompany,
  businessHoursOf,
  getSupportSettings,
  slaOf,
  topicNamed,
} from "./settings.js";
import {
  serializeTicket,
  peopleFor,
  serializeMessage,
  serializeDraft,
  serializeEvent,
} from "./serialize.js";

/**
 * A ticket's life: its clocks, what each status means for them, the queues it
 * sits in, and everything a Member can change by hand. Every write is a targeted
 * update, because a model turn or a sync may be working the same ticket: nothing
 * here saves a whole copy back over what changed meanwhile.
 */

// ── Clocks ──────────────────────────────────────────────────────────────────

/** The next target running out, for a ticket someone at the company owes. */
export function nextSlaDue(args: {
  actionable: boolean;
  slaEnabled: boolean;
  responseDueAt: Date | null;
  resolutionDueAt: Date | null;
}): Date | null {
  if (!args.actionable || !args.slaEnabled) return null;
  const { responseDueAt, resolutionDueAt } = args;
  if (responseDueAt && resolutionDueAt) {
    return responseDueAt < resolutionDueAt ? responseDueAt : resolutionDueAt;
  }
  return responseDueAt ?? resolutionDueAt ?? null;
}

/** The targets for a priority, from the moment the customer wrote. */
export function targetsFrom(args: {
  settings: Pick<SupportSettings, "slaJson" | "businessHoursJson">;
  priority: SupportPriority;
  from: Date;
}): { firstResponseDue: Date; resolutionDue: Date } {
  const targets = slaOf(args.settings)[args.priority];
  const hours = businessHoursOf(args.settings);
  return {
    firstResponseDue: addBusinessMinutes(args.from, targets.firstResponseMinutes, hours),
    resolutionDue: addBusinessMinutes(args.from, targets.resolutionMinutes, hours),
  };
}

/**
 * What a change of status means for a ticket's other fields. Pure, so what each
 * status does to the clocks is one table a test can read.
 */
export function statusFields(args: {
  ticket: Pick<
    SupportTicket,
    | "status"
    | "reopenCount"
    | "responseDueAt"
    | "resolutionDueAt"
    | "ratingScore"
    | "ratingRequestedAt"
    | "requesterEmail"
  >;
  status: SupportTicketStatus;
  now: Date;
  settings: Pick<SupportSettings, "slaEnabled" | "ratingsEnabled">;
  snoozedUntil?: Date | null;
}): Partial<SupportTicket> {
  const { ticket, status, now, settings } = args;
  const actionable = status === "new" || status === "open";
  const fields: Partial<SupportTicket> = {
    status,
    actionable,
    snoozedUntil: status === "snoozed" ? (args.snoozedUntil ?? null) : null,
    slaDueAt: nextSlaDue({
      actionable,
      slaEnabled: settings.slaEnabled,
      responseDueAt: ticket.responseDueAt,
      resolutionDueAt: ticket.resolutionDueAt,
    }),
  };
  if (status === "solved") {
    fields.solvedAt = now;
    fields.closedAt = null;
    fields.draftReady = false;
    fields.needsHuman = false;
    const askForRating =
      settings.ratingsEnabled &&
      ticket.ratingScore === null &&
      ticket.ratingRequestedAt === null &&
      Boolean(ticket.requesterEmail);
    fields.ratingDueAt = askForRating
      ? new Date(now.getTime() + SUPPORT_RATING_DELAY_HOURS * 60 * 60_000)
      : null;
  } else if (status === "closed") {
    fields.closedAt = now;
    fields.draftReady = false;
    fields.needsHuman = false;
    fields.ratingDueAt = null;
  } else if (status === "spam") {
    fields.draftReady = false;
    fields.needsHuman = false;
    fields.ratingDueAt = null;
  } else {
    fields.solvedAt = null;
    fields.closedAt = null;
    fields.ratingDueAt = null;
    if (ticket.status === "solved" || ticket.status === "closed") {
      fields.reopenCount = ticket.reopenCount + 1;
    }
  }
  return fields;
}

// ── Queues ──────────────────────────────────────────────────────────────────

export const SUPPORT_TICKET_PAGE = { defaultLimit: 40, maxLimit: 100 };

export type TicketListFilters = {
  view?: SupportView;
  status?: SupportTicketStatus;
  priority?: SupportPriority;
  topicKey?: string;
  inboxId?: string;
  assigneeUserId?: string;
  assigneeEmployeeId?: string;
  requesterEmail?: string;
  customerId?: string;
  source?: SupportTicketSource;
  tag?: string;
  q?: string;
  sort?: SupportSort;
};

const NUMBER_QUERY = /^#?(\d{1,9})$/;

function keysFor(view: SupportView | undefined, sort: SupportSort | undefined): KeysetColumn[] {
  if (view === "at_risk") {
    return [
      { column: "t.slaDueAt", direction: "ASC", type: "timestamp" },
      { column: "t.id", direction: "ASC", type: "string" },
    ];
  }
  if (sort === "oldest") {
    return [
      { column: "t.lastActivityAt", direction: "ASC", type: "timestamp" },
      { column: "t.id", direction: "ASC", type: "string" },
    ];
  }
  if (sort === "priority") {
    return [
      { column: "t.priorityRank", direction: "ASC", type: "number" },
      { column: "t.lastActivityAt", direction: "DESC", type: "timestamp" },
      { column: "t.id", direction: "DESC", type: "string" },
    ];
  }
  return [
    { column: "t.lastActivityAt", direction: "DESC", type: "timestamp" },
    { column: "t.id", direction: "DESC", type: "string" },
  ];
}

/** The filters as SQL. The server owns what a view means, for the rail and the list alike. */
function ticketQuery(companyId: string, viewerUserId: string | null, filters: TicketListFilters) {
  const qb = AppDataSource.getRepository(SupportTicket)
    .createQueryBuilder("t")
    .where("t.companyId = :companyId", { companyId })
    .andWhere("t.mergedIntoId IS NULL");
  switch (filters.view) {
    case "inbox":
      qb.andWhere("t.actionable = :yes", { yes: true });
      break;
    case "mine":
      qb.andWhere("t.assigneeUserId = :viewer", { viewer: viewerUserId ?? "" }).andWhere(
        "t.status IN (:...mineStatuses)",
        { mineStatuses: ["new", "open", "waiting", "snoozed"] },
      );
      break;
    case "unassigned":
      qb.andWhere("t.actionable = :yes", { yes: true })
        .andWhere("t.assigneeUserId IS NULL")
        .andWhere("t.assigneeEmployeeId IS NULL");
      break;
    case "review":
      qb.andWhere("t.draftReady = :yes", { yes: true }).andWhere("t.actionable = :yes", {
        yes: true,
      });
      break;
    case "ai":
      qb.andWhere("t.aiHandled = :yes", { yes: true }).andWhere("t.status IN (:...aiStatuses)", {
        aiStatuses: ["waiting", "solved"],
      });
      break;
    case "at_risk":
      qb.andWhere("t.actionable = :yes", { yes: true })
        .andWhere("t.slaDueAt IS NOT NULL")
        .andWhere("t.slaDueAt <= :soon", {
          soon: new Date(Date.now() + SUPPORT_AT_RISK_WINDOW_MS),
        });
      break;
    case "waiting":
      qb.andWhere("t.status = :viewStatus", { viewStatus: "waiting" });
      break;
    case "snoozed":
      qb.andWhere("t.status = :viewStatus", { viewStatus: "snoozed" });
      break;
    case "solved":
      qb.andWhere("t.status IN (:...solvedStatuses)", { solvedStatuses: ["solved", "closed"] });
      break;
    case "spam":
      qb.andWhere("t.status = :viewStatus", { viewStatus: "spam" });
      break;
    case "all":
      qb.andWhere("t.status != :notSpam", { notSpam: "spam" });
      break;
    default:
      break;
  }
  if (filters.status) qb.andWhere("t.status = :status", { status: filters.status });
  if (filters.priority) qb.andWhere("t.priority = :priority", { priority: filters.priority });
  if (filters.topicKey) qb.andWhere("t.topicKey = :topicKey", { topicKey: filters.topicKey });
  if (filters.inboxId) qb.andWhere("t.inboxId = :inboxId", { inboxId: filters.inboxId });
  if (filters.assigneeUserId) {
    qb.andWhere("t.assigneeUserId = :assigneeUserId", { assigneeUserId: filters.assigneeUserId });
  }
  if (filters.assigneeEmployeeId) {
    qb.andWhere("t.assigneeEmployeeId = :assigneeEmployeeId", {
      assigneeEmployeeId: filters.assigneeEmployeeId,
    });
  }
  if (filters.requesterEmail) {
    qb.andWhere("t.requesterEmail = :requesterEmail", {
      requesterEmail: filters.requesterEmail.trim().toLowerCase(),
    });
  }
  if (filters.customerId) {
    qb.andWhere("t.customerId = :customerId", { customerId: filters.customerId });
  }
  if (filters.source) qb.andWhere("t.source = :source", { source: filters.source });
  if (filters.tag) {
    qb.andWhere("t.tagsJson LIKE :tag", { tag: `%${JSON.stringify(filters.tag)}%` });
  }
  const q = filters.q?.trim();
  if (q) {
    const asNumber = NUMBER_QUERY.exec(q);
    if (asNumber) {
      qb.andWhere("t.number = :number", { number: Number(asNumber[1]) });
    } else {
      andWhereTokens(
        qb,
        ["t.subject", "t.requesterEmail", "t.requesterName", "t.aiSummary"],
        tokenizeQuery(q),
      );
    }
  }
  return qb;
}

export async function listTickets(args: {
  companyId: string;
  viewerUserId: string | null;
  filters: TicketListFilters;
  page: PageRequest & { budgetChars?: number };
}): Promise<Page<ReturnType<typeof serializeTicket>>> {
  const { companyId, viewerUserId, filters } = args;
  return keysetPage({
    query: () => ticketQuery(companyId, viewerUserId, filters),
    keys: keysFor(filters.view, filters.sort),
    scope: "support.tickets",
    fingerprint: filterFingerprint(companyId, { ...filters, viewer: viewerUserId }),
    noun: "tickets",
    limits: SUPPORT_TICKET_PAGE,
    page: args.page,
    present: async (tickets) => {
      const people = await peopleFor(tickets);
      return tickets.map((ticket) => serializeTicket(ticket, people));
    },
  });
}

/** What the rail counts. Each is one count on an index that starts with the company. */
export async function ticketCounts(
  companyId: string,
  viewerUserId: string,
): Promise<Partial<Record<SupportView, number>>> {
  const counted: SupportView[] = [
    "inbox",
    "mine",
    "unassigned",
    "review",
    "ai",
    "at_risk",
    "waiting",
    "snoozed",
  ];
  const results = await Promise.all(
    counted.map((view) => ticketQuery(companyId, viewerUserId, { view }).getCount()),
  );
  return Object.fromEntries(counted.map((view, index) => [view, results[index]]));
}

export async function countOpenTicketsByInbox(companyId: string): Promise<Map<string, number>> {
  const rows = await AppDataSource.getRepository(SupportTicket)
    .createQueryBuilder("t")
    .select("t.inboxId", "inboxId")
    .addSelect("COUNT(*)", "count")
    .where("t.companyId = :companyId", { companyId })
    .andWhere("t.actionable = :yes", { yes: true })
    .groupBy("t.inboxId")
    .getRawMany<{ inboxId: string | null; count: string | number }>();
  const counts = new Map<string, number>();
  for (const row of rows) if (row.inboxId) counts.set(row.inboxId, Number(row.count));
  return counts;
}

const AUTO_REPLY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Replies the AI sent on its own among these tickets in the last day. Ticket ids in
 * chunks rather than a join, since ids and the column pointing at them are different
 * types on Postgres, and the set is small: tickets a day's auto-replies touched.
 */
async function autoRepliesAmong(ticketIds: string[]): Promise<number> {
  const since = new Date(Date.now() - AUTO_REPLY_WINDOW_MS);
  let total = 0;
  for (let index = 0; index < ticketIds.length; index += 200) {
    total += await AppDataSource.getRepository(SupportMessage).count({
      where: {
        ticketId: In(ticketIds.slice(index, index + 200)),
        sentByAi: true,
        sentAt: MoreThanOrEqual(since),
      },
    });
  }
  return total;
}

/** Replies the AI sent on its own from this inbox in the last day: its daily limit's count. */
export async function countAutoRepliesToday(inboxId: string): Promise<number> {
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: {
      inboxId,
      aiReplyCount: MoreThan(0),
      lastAgentMessageAt: MoreThanOrEqual(new Date(Date.now() - AUTO_REPLY_WINDOW_MS)),
    },
    select: { id: true },
    take: 20_000,
  });
  return autoRepliesAmong(tickets.map((ticket) => ticket.id));
}

/** The same count for one customer, however many tickets they wrote in on. */
export async function countAutoRepliesToRequester(
  companyId: string,
  requesterEmail: string,
): Promise<number> {
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: { companyId, requesterEmail, aiReplyCount: MoreThan(0) },
    select: { id: true },
    order: { createdAt: "DESC" },
    take: 500,
  });
  return autoRepliesAmong(tickets.map((ticket) => ticket.id));
}

// ── Who is writing ──────────────────────────────────────────────────────────

/**
 * The Contact and Customer this address belongs to, if the company already knows
 * them. Reads only: Support never creates a Contact from an email, for the reason
 * `revenue/mailLink.ts` gives — an inbox is mostly strangers, and a list of the
 * people you sell to stops being worth opening once they are all on it.
 */
export async function linkRequester(
  companyId: string,
  email: string,
): Promise<{ contactId: string | null; customerId: string | null }> {
  const address = normalizeEmail(email);
  if (!address) return { contactId: null, customerId: null };
  const contact = await AppDataSource.getRepository(Contact).findOne({
    where: { companyId, email: address },
    select: { id: true, customerId: true },
  });
  if (contact?.customerId) return { contactId: contact.id, customerId: contact.customerId };
  const customers = AppDataSource.getRepository(Customer);
  const byEmail = await customers.findOne({
    where: { companyId, email: address, archivedAt: IsNull() },
    select: { id: true },
  });
  if (byEmail) return { contactId: contact?.id ?? null, customerId: byEmail.id };
  const domain = address.slice(address.indexOf("@") + 1);
  if (!domain || isFreeMailDomain(domain))
    return { contactId: contact?.id ?? null, customerId: null };
  // A Member writing from the company's own domain is not one of its customers.
  if ((await companyDomains(companyId)).has(domain)) {
    return { contactId: contact?.id ?? null, customerId: null };
  }
  const byDomain = await customers.findOne({
    where: { companyId, domain, archivedAt: IsNull() },
    select: { id: true },
  });
  return { contactId: contact?.id ?? null, customerId: byDomain?.id ?? null };
}

// ── Reading one ─────────────────────────────────────────────────────────────

export async function ticketDetail(companyId: string, ticketId: string) {
  const ticket = await requireTicket(companyId, ticketId);
  const [messages, drafts, events, inbox, jobs, otherTickets, similar] = await Promise.all([
    AppDataSource.getRepository(SupportMessage).find({
      where: { ticketId: ticket.id },
      order: { sentAt: "ASC", createdAt: "ASC" },
    }),
    AppDataSource.getRepository(SupportDraft).find({
      where: { ticketId: ticket.id },
      order: { createdAt: "DESC" },
      take: 20,
    }),
    AppDataSource.getRepository(SupportEvent).find({
      where: { ticketId: ticket.id },
      order: { createdAt: "ASC" },
      take: 500,
    }),
    ticket.inboxId
      ? AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId, companyId })
      : Promise.resolve(null),
    AppDataSource.getRepository(SupportJob).find({
      where: { ticketId: ticket.id, kind: In(["work", "article"]) },
      order: { createdAt: "DESC" },
      take: 4,
    }),
    ticket.requesterEmail
      ? AppDataSource.getRepository(SupportTicket).find({
          where: { companyId, requesterEmail: ticket.requesterEmail },
          order: { createdAt: "DESC" },
          take: 8,
        })
      : Promise.resolve([] as SupportTicket[]),
    similarTickets(ticket),
  ]);
  const [customer, contact, account, employee, chatFacts] = await Promise.all([
    ticket.customerId
      ? AppDataSource.getRepository(Customer).findOneBy({ id: ticket.customerId, companyId })
      : Promise.resolve(null),
    ticket.contactId
      ? AppDataSource.getRepository(Contact).findOneBy({ id: ticket.contactId, companyId })
      : Promise.resolve(null),
    ticket.accountId
      ? AppDataSource.getRepository(MailAccount).findOneBy({ id: ticket.accountId, companyId })
      : Promise.resolve(null),
    inbox?.aiEmployeeId
      ? AppDataSource.getRepository(AIEmployee).findOneBy({ id: inbox.aiEmployeeId, companyId })
      : Promise.resolve(null),
    chatFactsFor(ticket),
  ]);
  const people = await peopleFor([ticket], { messages, drafts });
  const latestWork = jobs.find((job) => job.kind === "work") ?? null;
  return {
    ticket: serializeTicket(ticket, people),
    messages: messages.map((message) => serializeMessage(message, people)),
    drafts: drafts.map((draft) => serializeDraft(draft, people)),
    events: events.map(serializeEvent),
    inbox: inbox
      ? {
          id: inbox.id,
          name: inbox.name,
          aiMode: inbox.aiMode,
          aiEmployeeId: inbox.aiEmployeeId,
          aiEmployeeName: employee?.name ?? null,
          status: inbox.status,
        }
      : null,
    mailbox: account ? { id: account.id, address: account.address } : null,
    chat: chatTicketView(chatFacts),
    work: latestWork
      ? {
          status: latestWork.status,
          error: latestWork.error,
          attempts: latestWork.attempts,
          finishedAt: latestWork.finishedAt?.toISOString() ?? null,
        }
      : null,
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          accountStatus: customer.accountStatus,
          domain: customer.domain,
          annualContractValueCents: customer.annualContractValueCents,
          currency: customer.currency,
        }
      : null,
    contact: contact
      ? {
          id: contact.id,
          name: contact.name,
          title: contact.title,
          doNotContact: contact.doNotContact,
        }
      : null,
    otherTickets: otherTickets
      .filter((other) => other.id !== ticket.id && !other.mergedIntoId)
      .slice(0, 6)
      .map((other) => ({
        id: other.id,
        number: other.number,
        subject: other.subject,
        status: other.status,
        createdAt: other.createdAt.toISOString(),
      })),
    similar,
  };
}

/**
 * Solved tickets that read like this one, for the person answering it. Plain
 * word overlap over subjects and summaries: no model call, nothing to wait for,
 * and it reads no message body. An AI Employee's reply is never built from these,
 * since they hold other customers' words.
 */
export async function similarTickets(
  ticket: Pick<SupportTicket, "id" | "companyId" | "subject" | "aiSummary">,
): Promise<
  Array<{ id: string; number: number; subject: string; status: string; aiSummary: string }>
> {
  const query = new Set(tokenize(`${ticket.subject} ${ticket.aiSummary}`));
  if (query.size === 0) return [];
  const candidates = await AppDataSource.getRepository(SupportTicket).find({
    where: [
      { companyId: ticket.companyId, status: "solved" as const },
      { companyId: ticket.companyId, status: "closed" as const },
    ],
    order: { lastActivityAt: "DESC" },
    take: 400,
    select: { id: true, number: true, subject: true, status: true, aiSummary: true },
  });
  const scored = candidates
    .filter((candidate) => candidate.id !== ticket.id)
    .map((candidate) => {
      const words = new Set(tokenize(`${candidate.subject} ${candidate.aiSummary}`));
      let shared = 0;
      for (const word of query) if (words.has(word)) shared += 1;
      return { candidate, score: shared / Math.max(4, query.size) };
    })
    .filter((entry) => entry.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  return scored.map(({ candidate }) => ({
    id: candidate.id,
    number: candidate.number,
    subject: candidate.subject,
    status: candidate.status,
    aiSummary: candidate.aiSummary.slice(0, 280),
  }));
}

// ── Changing one ────────────────────────────────────────────────────────────

export type TicketPatch = {
  status?: SupportSettableStatus;
  snoozedUntil?: Date | null;
  priority?: SupportPriority;
  topicKey?: string | null;
  tags?: string[];
  assigneeUserId?: string | null;
  assigneeEmployeeId?: string | null;
  subject?: string;
};

function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, SUPPORT_LIMITS.tagChars);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(tag);
  }
  return cleaned.slice(0, SUPPORT_LIMITS.tagsPerTicket);
}

async function supersedeReadyDrafts(ticketId: string): Promise<void> {
  await AppDataSource.getRepository(SupportDraft).update(
    { ticketId, status: "ready" },
    { status: "superseded" },
  );
}

/** Solving a ticket can also archive its conversation in the mailbox, when the inbox says so. */
async function archiveInMailbox(ticket: SupportTicket): Promise<void> {
  if (!ticket.inboxId || !ticket.accountId || !ticket.gmailThreadId) return;
  const inbox = await AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId });
  if (!inbox?.archiveOnSolve) return;
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({
    id: ticket.accountId,
  });
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    accountId: ticket.accountId,
    gmailThreadId: ticket.gmailThreadId,
  });
  if (!account || !thread) return;
  try {
    await performThreadAction(account, thread, "archive");
  } catch (error) {
    // The ticket is solved either way; a mail server that said no is not a failure of that.
    // eslint-disable-next-line no-console
    console.warn(`[support] could not archive the thread of ticket ${ticket.id}:`, error);
  }
}

/** Tell the people a ticket now belongs to. Never the person who just did it. */
async function notifyAssigned(ticket: SupportTicket, userId: string, actor: SupportActor) {
  if (actor.kind === "user" && actor.userId === userId) return;
  await createNotifications([
    {
      companyId: ticket.companyId,
      userId,
      kind: "support_ticket_assigned",
      title: `${ticketReference(ticket.number)} assigned to you: ${ticket.subject || "(no subject)"}`,
      body: requesterDisplay(ticket),
      link: `/support/tickets/${ticket.id}`,
      actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
      actorId: actor.kind === "user" ? actor.userId : actor.kind === "ai" ? actor.employeeId : null,
      entityKind: "support_ticket",
      entityId: ticket.id,
    },
  ]);
}

export async function updateTicket(args: {
  companyId: string;
  ticketId: string;
  patch: TicketPatch;
  actor: SupportActor;
}): Promise<SupportTicket> {
  const { companyId, patch, actor } = args;
  const ticket = await requireTicket(companyId, args.ticketId);
  if (ticket.mergedIntoId) {
    throw new SupportConflictError("This ticket was merged into another. Change that one instead.");
  }
  const settings = await getSupportSettings(companyId);
  const now = new Date();
  const fields: Partial<SupportTicket> = {};
  const events: Array<Parameters<typeof recordTicketEvent>[0]> = [];
  const push = (
    kind: Parameters<typeof recordTicketEvent>[0]["kind"],
    data: Record<string, unknown>,
  ) => events.push({ ticket, kind, actor, data });

  if (patch.status !== undefined && patch.status !== ticket.status) {
    if (patch.status === "snoozed") {
      if (!patch.snoozedUntil || patch.snoozedUntil <= now) {
        throw new SupportValidationError("Choose when this ticket should wake up.");
      }
    }
    Object.assign(
      fields,
      statusFields({
        ticket,
        status: patch.status,
        now,
        settings,
        snoozedUntil: patch.snoozedUntil,
      }),
    );
    push("status_changed", { from: ticket.status, to: patch.status });
  } else if (patch.status === "snoozed" && patch.snoozedUntil) {
    fields.snoozedUntil = patch.snoozedUntil;
  }

  if (patch.priority !== undefined && patch.priority !== ticket.priority) {
    fields.priority = patch.priority;
    fields.priorityRank = SUPPORT_PRIORITY_RANK[patch.priority];
    fields.prioritySource = "member";
    Object.assign(fields, clockFieldsForPriority(ticket, patch.priority, settings, fields));
    push("priority_changed", { from: ticket.priority, to: patch.priority });
  }

  if (patch.topicKey !== undefined && patch.topicKey !== ticket.topicKey) {
    if (patch.topicKey && !topicNamed(settings, patch.topicKey)) {
      throw new SupportValidationError("That topic does not exist.");
    }
    fields.topicKey = patch.topicKey;
    fields.topicSource = "member";
    push("topic_changed", { from: ticket.topicKey, to: patch.topicKey });
  }

  if (patch.tags !== undefined) {
    const tags = cleanTags(patch.tags);
    const before = parseJsonArray<string>(ticket.tagsJson);
    if (JSON.stringify(tags) !== JSON.stringify(before)) {
      fields.tagsJson = JSON.stringify(tags);
      push("tags_changed", { from: before, to: tags });
    }
  }

  if (patch.subject !== undefined && patch.subject.trim() !== ticket.subject) {
    const subject = patch.subject.trim();
    if (!subject) throw new SupportValidationError("A ticket needs a subject.");
    fields.subject = subject;
    push("subject_changed", { from: ticket.subject, to: subject });
  }

  let assignedUserId: string | null = null;
  let assignedEmployee = false;
  if (patch.assigneeUserId !== undefined || patch.assigneeEmployeeId !== undefined) {
    const nextUser = patch.assigneeUserId ?? null;
    const nextEmployee = nextUser ? null : (patch.assigneeEmployeeId ?? null);
    if (nextUser) await assertMemberInCompany(companyId, nextUser);
    if (nextEmployee) await assertEmployeeInCompany(companyId, nextEmployee);
    if (nextUser !== ticket.assigneeUserId || nextEmployee !== ticket.assigneeEmployeeId) {
      fields.assigneeUserId = nextUser;
      fields.assigneeEmployeeId = nextEmployee;
      push("assigned", { userId: nextUser, employeeId: nextEmployee });
      assignedUserId = nextUser;
      assignedEmployee = Boolean(nextEmployee);
    }
  }

  if (Object.keys(fields).length === 0) return ticket;
  fields.lastActivityAt = now;
  if (fields.status === "solved" || fields.status === "closed" || fields.status === "spam") {
    await supersedeReadyDrafts(ticket.id);
  }
  await patchTicket(ticket, fields);
  for (const event of events) await recordTicketEvent(event);
  await auditTicket(actor, ticket, "update", { fields: Object.keys(fields) });
  const updated = await requireTicket(companyId, ticket.id);
  if (assignedUserId) await notifyAssigned(updated, assignedUserId, actor);
  if (fields.status === "solved") void archiveInMailbox(updated);
  if (assignedEmployee) {
    // Handing a ticket to an AI Employee is a reason for it to look, and for any
    // Routine it keeps on Support to wake.
    emitResourceChange(companyId, "support_ticket", ticket.id);
    if (updated.actionable) {
      const { queueTicketWork } = await import("./work.js");
      await queueTicketWork(updated);
    }
  }
  // Pulled out of Spam: it never had its first read.
  if (ticket.status === "spam" && updated.actionable) {
    const { queueTicketWork } = await import("./work.js");
    await queueTicketWork(updated);
  }
  return updated;
}

/** New targets for a new priority: unmet ones move, met ones stay as they were. */
export function clockFieldsForPriority(
  ticket: SupportTicket,
  priority: SupportPriority,
  settings: SupportSettings,
  pending: Partial<SupportTicket>,
): Partial<SupportTicket> {
  // No targets to move: imported, with history that never had a clock.
  if (!ticket.firstResponseDueAt && !ticket.resolutionDueAt && !ticket.responseDueAt) return {};
  const from = ticket.lastCustomerMessageAt ?? ticket.createdAt;
  const { firstResponseDue, resolutionDue } = targetsFrom({
    settings,
    priority,
    from: ticket.createdAt,
  });
  const nextResponse = targetsFrom({ settings, priority, from }).firstResponseDue;
  const fields: Partial<SupportTicket> = {};
  if (!ticket.firstRespondedAt) fields.firstResponseDueAt = firstResponseDue;
  fields.resolutionDueAt = ticket.solvedAt ? ticket.resolutionDueAt : resolutionDue;
  fields.responseDueAt = ticket.responseDueAt ? nextResponse : null;
  const actionable = pending.actionable ?? ticket.actionable;
  fields.slaDueAt = nextSlaDue({
    actionable,
    slaEnabled: settings.slaEnabled,
    responseDueAt: fields.responseDueAt ?? null,
    resolutionDueAt: fields.resolutionDueAt ?? null,
  });
  return fields;
}

export type BulkTicketResult = {
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
};

/** One change to many tickets; a ticket that refuses does not stop the rest. */
export async function bulkUpdateTickets(args: {
  companyId: string;
  ticketIds: string[];
  patch: TicketPatch;
  actor: SupportActor;
}): Promise<BulkTicketResult> {
  const succeeded: string[] = [];
  const skipped: BulkTicketResult["skipped"] = [];
  for (const ticketId of args.ticketIds) {
    try {
      await updateTicket({
        companyId: args.companyId,
        ticketId,
        patch: args.patch,
        actor: args.actor,
      });
      succeeded.push(ticketId);
    } catch (error) {
      skipped.push({ id: ticketId, reason: error instanceof Error ? error.message : "Failed" });
    }
  }
  return { succeeded, skipped };
}

/**
 * Fold one ticket into another: its messages move, its conversation keeps
 * routing here (through `mergedIntoId`, since its thread stays unique to it), and
 * the requester of the one folded in stays on the replies.
 */
export async function mergeTickets(args: {
  companyId: string;
  sourceId: string;
  targetId: string;
  actor: SupportActor;
}): Promise<SupportTicket> {
  const { companyId, actor } = args;
  if (args.sourceId === args.targetId) {
    throw new SupportValidationError("A ticket cannot be merged into itself.");
  }
  const source = await requireTicket(companyId, args.sourceId);
  const target = await requireTicket(companyId, args.targetId);
  if (source.mergedIntoId) throw new SupportConflictError("That ticket was already merged.");
  if (target.mergedIntoId)
    throw new SupportConflictError("Merge into the ticket it was merged into.");
  // A chat conversation is read by whoever holds its token. Folded into anyone
  // else's ticket, each would have to be answered in front of the other.
  if (source.chatVisitorId !== target.chatVisitorId) {
    throw new SupportConflictError(
      "A chat conversation can only be merged with another from the same visitor.",
      "chat_merge",
    );
  }
  const cc = new Set(parseJsonArray<string>(target.ccJson));
  for (const address of parseJsonArray<string>(source.ccJson)) cc.add(address);
  if (source.requesterEmail && source.requesterEmail !== target.requesterEmail) {
    cc.add(source.requesterEmail);
  }
  cc.delete(target.requesterEmail);
  const lastCustomerMessageAt = latest(target.lastCustomerMessageAt, source.lastCustomerMessageAt);
  const lastAgentMessageAt = latest(target.lastAgentMessageAt, source.lastAgentMessageAt);
  await AppDataSource.transaction(async (manager) => {
    await manager
      .getRepository(SupportMessage)
      .update({ ticketId: source.id }, { ticketId: target.id });
    // Neither draft knew about the other conversation.
    await manager
      .getRepository(SupportDraft)
      .update({ ticketId: In([source.id, target.id]), status: "ready" }, { status: "superseded" });
    const messageCount = await manager
      .getRepository(SupportMessage)
      .createQueryBuilder("m")
      .where("m.ticketId = :ticketId", { ticketId: target.id })
      .andWhere("m.kind IN (:...kinds)", { kinds: ["customer", "reply"] })
      .getCount();
    await manager.getRepository(SupportTicket).update(
      { id: target.id },
      {
        ccJson: JSON.stringify([...cc]),
        messageCount,
        draftReady: false,
        lastActivityAt: new Date(),
        lastCustomerMessageAt,
        lastAgentMessageAt,
      },
    );
    await manager.getRepository(SupportTicket).update(
      { id: source.id },
      {
        mergedIntoId: target.id,
        status: "closed",
        actionable: false,
        closedAt: new Date(),
        draftReady: false,
        slaDueAt: null,
        ratingDueAt: null,
      },
    );
  });
  await recordTicketEvent({
    ticket: target,
    kind: "merged_in",
    actor,
    data: { number: source.number, subject: source.subject },
  });
  await recordTicketEvent({
    ticket: source,
    kind: "merged_into",
    actor,
    data: { number: target.number, ticketId: target.id },
  });
  await auditTicket(actor, target, "merge", { from: source.id });
  announceTicket(source);
  announceTicket(target);
  // The merge may have brought a customer who is still owed an answer onto a ticket
  // nobody is looking at.
  const merged = await requireTicket(companyId, target.id);
  const owed =
    lastCustomerMessageAt !== null &&
    (lastAgentMessageAt === null || lastCustomerMessageAt > lastAgentMessageAt);
  if (!owed || merged.status === "spam") return merged;
  if (!merged.actionable) {
    const settings = await getSupportSettings(companyId);
    await patchTicket(
      merged,
      statusFields({ ticket: merged, status: "open", now: new Date(), settings }),
    );
    await recordTicketEvent({
      ticket: merged,
      kind: "reopened",
      actor,
      data: { from: target.status },
    });
  }
  const { queueTicketWork } = await import("./work.js");
  await queueTicketWork(merged);
  return requireTicket(companyId, target.id);
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a && b) return a > b ? a : b;
  return a ?? b;
}

/** Follow a merge to the ticket that stands now. */
export async function liveTicket(ticket: SupportTicket): Promise<SupportTicket> {
  let current = ticket;
  for (let hop = 0; hop < 8 && current.mergedIntoId; hop++) {
    const next = await AppDataSource.getRepository(SupportTicket).findOneBy({
      id: current.mergedIntoId,
    });
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Tickets created at or after a moment, without their text, for reporting. */
export async function ticketsSince(companyId: string, since: Date, take: number) {
  return AppDataSource.getRepository(SupportTicket).find({
    where: { companyId, createdAt: MoreThanOrEqual(since) },
    order: { createdAt: "DESC" },
    take,
  });
}
