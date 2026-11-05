import { In, IsNull, LessThanOrEqual, Not } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { SupportChatVisitor } from "../../db/entities/SupportChatVisitor.js";
import { SupportSettings } from "../../db/entities/SupportSettings.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { ticketReference } from "../../../shared/support.js";
import { pruneAuthRateLimits } from "../authThrottle.js";
import { createNotifications } from "../notifications.js";
import { patchTicket, recordTicketEvent } from "./access.js";
import { enqueueSupportJob } from "./queue.js";
import { getSupportSettings } from "./settings.js";
import { statusFields } from "./tickets.js";

/**
 * The clocks. Every minute, under one lease: wake what was snoozed, say when a
 * target was missed, ask for the ratings that have come due, close what has
 * stayed solved, and read the week's themes. Each step is bounded and works from
 * an index, so a quiet company costs a few empty reads.
 */

const BATCH = 200;
/** How long a company's themes stay current before they are read again. */
const INSIGHTS_EVERY_MS = 7 * 24 * 60 * 60_000;
/** New tickets since the last reading that make a new one worth a model call. */
const INSIGHTS_MIN_TICKETS = 5;
/** A Chat widget visitor who never wrote after this long was nobody. */
const SILENT_VISITOR_MS = 24 * 60 * 60_000;
/** Longer than any throttle's window, so a bucket this old has nothing left to say. */
const THROTTLE_RETENTION_MS = 7 * 24 * 60 * 60_000;

export async function runSupportSweep(now = new Date()): Promise<void> {
  await wakeSnoozed(now);
  await markBreaches(now);
  await queueDueRatings(now);
  await solveSilent(now);
  await closeSolved(now);
  await queueInsights(now);
  await clearChatLeftovers(now);
}

/**
 * What an open endpoint leaves behind: visitors who got a token and never wrote
 * anything, and throttle buckets whose windows ended long ago.
 */
async function clearChatLeftovers(now: Date): Promise<void> {
  const silent = await AppDataSource.getRepository(SupportChatVisitor).find({
    where: { lastSeq: 0, createdAt: LessThanOrEqual(new Date(now.getTime() - SILENT_VISITOR_MS)) },
    select: { id: true },
    take: BATCH,
  });
  if (silent.length > 0) {
    await AppDataSource.getRepository(SupportChatVisitor).delete({
      id: In(silent.map((visitor) => visitor.id)),
    });
  }
  await pruneAuthRateLimits(new Date(now.getTime() - THROTTLE_RETENTION_MS));
}

async function wakeSnoozed(now: Date): Promise<void> {
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: { status: "snoozed", snoozedUntil: LessThanOrEqual(now) },
    take: BATCH,
  });
  for (const ticket of tickets) {
    const settings = await getSupportSettings(ticket.companyId);
    await patchTicket(ticket, {
      ...statusFields({ ticket, status: "open", now, settings }),
      lastActivityAt: now,
    });
    await recordTicketEvent({
      ticket,
      kind: "status_changed",
      actor: { kind: "system" },
      data: { from: "snoozed", to: "open", reason: "The snooze ended." },
    });
  }
}

/** Reported once per ticket: to its Member, or the owners when it has none. */
async function markBreaches(now: Date): Promise<void> {
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: {
      slaDueAt: LessThanOrEqual(now),
      slaBreachedAt: IsNull(),
      actionable: true,
    },
    take: BATCH,
  });
  for (const ticket of tickets) {
    await patchTicket(ticket, { slaBreachedAt: now });
    await recordTicketEvent({ ticket, kind: "sla_breached", actor: { kind: "system" } });
    if (ticket.assigneeUserId) {
      await createNotifications([
        {
          companyId: ticket.companyId,
          userId: ticket.assigneeUserId,
          kind: "support_sla_breached",
          title: `${ticketReference(ticket.number)} missed its target`,
          body: ticket.subject,
          link: `/support/tickets/${ticket.id}`,
          actorKind: "system",
          entityKind: "support_ticket",
          entityId: ticket.id,
        },
      ]);
    }
  }
}

async function queueDueRatings(now: Date): Promise<void> {
  const tickets = await AppDataSource.getRepository(SupportTicket).find({
    where: { ratingDueAt: LessThanOrEqual(now), status: "solved" },
    select: { id: true, companyId: true },
    take: BATCH,
  });
  for (const ticket of tickets) {
    await enqueueSupportJob({
      companyId: ticket.companyId,
      kind: "rating",
      targetId: ticket.id,
      ticketId: ticket.id,
    });
    await AppDataSource.getRepository(SupportTicket).update(
      { id: ticket.id },
      { ratingDueAt: null },
    );
  }
}

/** A customer who has gone quiet after an answer counts as answered. */
async function solveSilent(now: Date): Promise<void> {
  const companies = await AppDataSource.getRepository(SupportSettings).find({
    where: { autoSolveDays: Not(0) },
  });
  for (const settings of companies) {
    const before = new Date(now.getTime() - settings.autoSolveDays * 24 * 60 * 60_000);
    const tickets = await AppDataSource.getRepository(SupportTicket).find({
      where: {
        companyId: settings.companyId,
        status: "waiting",
        lastActivityAt: LessThanOrEqual(before),
      },
      take: BATCH,
    });
    for (const ticket of tickets) {
      await patchTicket(ticket, statusFields({ ticket, status: "solved", now, settings }));
      await recordTicketEvent({
        ticket,
        kind: "status_changed",
        actor: { kind: "system" },
        data: {
          from: "waiting",
          to: "solved",
          reason: `No reply from the customer in ${settings.autoSolveDays} days.`,
        },
      });
    }
  }
}

async function closeSolved(now: Date): Promise<void> {
  const companies = await AppDataSource.getRepository(SupportSettings).find({
    where: { autoCloseDays: Not(0) },
    select: { id: true, companyId: true, autoCloseDays: true },
  });
  for (const company of companies) {
    const before = new Date(now.getTime() - company.autoCloseDays * 24 * 60 * 60_000);
    const tickets = await AppDataSource.getRepository(SupportTicket).find({
      where: {
        companyId: company.companyId,
        status: "solved",
        solvedAt: LessThanOrEqual(before),
      },
      take: BATCH,
      select: { id: true, companyId: true },
    });
    if (tickets.length === 0) continue;
    await AppDataSource.getRepository(SupportTicket).update(
      { id: In(tickets.map((ticket) => ticket.id)) },
      { status: "closed", closedAt: now, actionable: false, ratingDueAt: null },
    );
  }
}

async function queueInsights(now: Date): Promise<void> {
  const companies = await AppDataSource.getRepository(SupportSettings).find({
    where: { aiEmployeeId: Not(IsNull()) },
    select: { id: true, companyId: true, insightsAt: true },
  });
  for (const company of companies) {
    if (company.insightsAt && now.getTime() - company.insightsAt.getTime() < INSIGHTS_EVERY_MS) {
      continue;
    }
    const recent = await AppDataSource.getRepository(SupportTicket)
      .createQueryBuilder("t")
      .where("t.companyId = :companyId", { companyId: company.companyId })
      .andWhere("t.createdAt >= :since", {
        since: company.insightsAt ?? new Date(now.getTime() - INSIGHTS_EVERY_MS),
      })
      .getCount();
    if (recent < INSIGHTS_MIN_TICKETS) continue;
    await enqueueSupportJob({
      companyId: company.companyId,
      kind: "insights",
      targetId: company.companyId,
    });
  }
}
