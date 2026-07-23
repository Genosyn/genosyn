import { Brackets, In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import {
  ACTIVITY_BODY_CAP,
  Activity,
  type ActivityKind,
} from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { touchLastActivity } from "./contacts.js";

/**
 * The activity timeline.
 *
 * Append-only, and mostly written by machines rather than people — mail sync
 * produces the bulk of it, the deal service adds stage changes, sequences add
 * their touches. That is the point: a CRM whose history depends on humans
 * remembering to log calls is a CRM with no history, so the useful default is
 * that opening a Contact shows every conversation you have ever had with them
 * without anyone having typed anything.
 *
 * Writes here also move the denormalized `lastActivityAt` on the contact and
 * deal, which is what the list views sort by.
 */

export type ActivityActor = {
  userId?: string | null;
  employeeId?: string | null;
};

export type ActivityInput = {
  kind: ActivityKind;
  subject?: string;
  bodyText?: string;
  occurredAt?: Date;
  contactId?: string | null;
  dealId?: string | null;
  customerId?: string | null;
  mailThreadId?: string | null;
  mailMessageId?: string | null;
  meta?: Record<string, unknown> | null;
};

export type ActivityListOptions = {
  contactId?: string;
  dealId?: string;
  customerId?: string;
  kinds?: ActivityKind[];
  /** Also include activities on deals belonging to this contact. */
  includeRelatedDeals?: boolean;
  limit?: number;
  offset?: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Body text is capped in the service, never by the column — see the entity. */
function capBody(body: string | undefined): string {
  if (!body) return "";
  if (body.length <= ACTIVITY_BODY_CAP) return body;
  return `${body.slice(0, ACTIVITY_BODY_CAP)}\n…[truncated]`;
}

function serializeMeta(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  try {
    return JSON.stringify(meta);
  } catch {
    // Metadata comes from callers as varied as a customer's own database via a
    // signal payload. A circular or unserializable value must not stop the
    // activity being recorded — the timeline entry matters more than its detail.
    return null;
  }
}

/**
 * Write one activity and move the denormalized recency markers.
 *
 * `occurredAt` defaults to now but is deliberately separate from `createdAt`:
 * a backfilled email happened long before we learned about it, and the timeline
 * sorts by when it happened.
 */
export async function recordActivity(
  companyId: string,
  input: ActivityInput,
  actor: ActivityActor = {},
): Promise<Activity> {
  const occurredAt = input.occurredAt ?? new Date();
  const repo = AppDataSource.getRepository(Activity);
  const row = await repo.save(
    repo.create({
      companyId,
      kind: input.kind,
      subject: (input.subject ?? "").slice(0, 500),
      bodyText: capBody(input.bodyText),
      occurredAt,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      customerId: input.customerId ?? null,
      mailThreadId: input.mailThreadId ?? null,
      mailMessageId: input.mailMessageId ?? null,
      actorUserId: actor.userId ?? null,
      actorEmployeeId: actor.employeeId ?? null,
      metaJson: serializeMeta(input.meta),
    }),
  );

  if (input.contactId) await touchLastActivity(companyId, [input.contactId], occurredAt);
  if (input.dealId) await touchDealActivity(companyId, [input.dealId], occurredAt);
  return row;
}

/**
 * Record a mail-derived activity exactly once.
 *
 * Idempotent on `mailMessageId`, because the backfill re-walks threads it has
 * already seen when Gmail expires a history cursor. Returns the existing row
 * rather than a duplicate, so a re-import does not double every conversation.
 */
export async function recordMailActivity(
  companyId: string,
  input: ActivityInput & { mailMessageId: string },
  actor: ActivityActor = {},
): Promise<Activity | null> {
  const existing = await AppDataSource.getRepository(Activity).findOneBy({
    companyId,
    mailMessageId: input.mailMessageId,
  });
  if (existing) return existing;
  return recordActivity(companyId, input, actor);
}

/**
 * Bulk-record mail activities, skipping any message already on the timeline.
 *
 * One query to find what exists, then one save — an initial mailbox import can
 * carry thousands of messages and must not issue two round-trips each.
 */
export async function recordMailActivities(
  companyId: string,
  inputs: Array<ActivityInput & { mailMessageId: string }>,
): Promise<number> {
  if (inputs.length === 0) return 0;
  const repo = AppDataSource.getRepository(Activity);
  const ids = [...new Set(inputs.map((i) => i.mailMessageId))];
  const existing = await repo.find({
    where: { companyId, mailMessageId: In(ids) },
    select: { mailMessageId: true },
  });
  const seen = new Set(existing.map((e) => e.mailMessageId));

  const fresh = inputs.filter((i) => !seen.has(i.mailMessageId));
  if (fresh.length === 0) return 0;

  const rows = fresh.map((input) =>
    repo.create({
      companyId,
      kind: input.kind,
      subject: (input.subject ?? "").slice(0, 500),
      bodyText: capBody(input.bodyText),
      occurredAt: input.occurredAt ?? new Date(),
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      customerId: input.customerId ?? null,
      mailThreadId: input.mailThreadId ?? null,
      mailMessageId: input.mailMessageId,
      metaJson: serializeMeta(input.meta),
    }),
  );
  await repo.save(rows);

  // Move recency markers once for the whole batch, using each contact's newest
  // touched moment rather than one save per row.
  const newestByContact = new Map<string, Date>();
  for (const input of fresh) {
    if (!input.contactId) continue;
    const at = input.occurredAt ?? new Date();
    const current = newestByContact.get(input.contactId);
    if (!current || at > current) newestByContact.set(input.contactId, at);
  }
  for (const [contactId, at] of newestByContact) {
    await touchLastActivity(companyId, [contactId], at);
  }
  return rows.length;
}

/**
 * The timeline.
 *
 * With `includeRelatedDeals`, a contact's timeline also carries activities
 * logged against their deals — which is what somebody opening a contact
 * actually expects to see, since "we moved their deal to Proposal" is part of
 * that relationship's history even though it was recorded against the deal.
 */
export async function listActivities(
  companyId: string,
  opts: ActivityListOptions = {},
): Promise<{ rows: Activity[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const qb = AppDataSource.getRepository(Activity)
    .createQueryBuilder("a")
    .where("a.companyId = :companyId", { companyId });

  if (opts.contactId && opts.includeRelatedDeals) {
    const dealIds = await AppDataSource.getRepository(Deal).find({
      where: { companyId, primaryContactId: opts.contactId },
      select: { id: true },
    });
    const ids = dealIds.map((d) => d.id);
    qb.andWhere(
      new Brackets((w) => {
        w.where("a.contactId = :contactId", { contactId: opts.contactId });
        if (ids.length > 0) w.orWhere("a.dealId IN (:...ids)", { ids });
      }),
    );
  } else if (opts.contactId) {
    qb.andWhere("a.contactId = :contactId", { contactId: opts.contactId });
  }

  if (opts.dealId) qb.andWhere("a.dealId = :dealId", { dealId: opts.dealId });
  if (opts.customerId) {
    qb.andWhere("a.customerId = :customerId", { customerId: opts.customerId });
  }
  if (opts.kinds && opts.kinds.length > 0) {
    qb.andWhere("a.kind IN (:...kinds)", { kinds: opts.kinds });
  }

  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("a.occurredAt", "DESC")
    .addOrderBy("a.createdAt", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();

  return { rows, total };
}

/** Move a deal's denormalized recency marker forward only. */
export async function touchDealActivity(
  companyId: string,
  dealIds: string[],
  when: Date,
): Promise<void> {
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (ids.length === 0) return;
  await AppDataSource.getRepository(Deal)
    .createQueryBuilder()
    .update(Deal)
    .set({ lastActivityAt: when })
    .where("companyId = :companyId", { companyId })
    .andWhere("id IN (:...ids)", { ids })
    .andWhere(
      new Brackets((w) => {
        w.where("lastActivityAt IS NULL").orWhere("lastActivityAt < :when", { when });
      }),
    )
    .execute();
}

/**
 * Count activities per kind for a contact or deal — drives the little summary
 * chips on the detail header ("14 emails · 2 meetings").
 */
export async function countActivitiesByKind(
  companyId: string,
  scope: { contactId?: string; dealId?: string },
): Promise<Record<string, number>> {
  const qb = AppDataSource.getRepository(Activity)
    .createQueryBuilder("a")
    .select("a.kind", "kind")
    .addSelect("COUNT(*)", "count")
    .where("a.companyId = :companyId", { companyId })
    .groupBy("a.kind");

  if (scope.contactId) qb.andWhere("a.contactId = :contactId", { contactId: scope.contactId });
  if (scope.dealId) qb.andWhere("a.dealId = :dealId", { dealId: scope.dealId });

  const rows = await qb.getRawMany<{ kind: string; count: string | number }>();
  const out: Record<string, number> = {};
  for (const row of rows) out[row.kind] = Number(row.count);
  return out;
}

/** Contacts touched most recently — the "what's happening" feed on the index. */
export async function recentlyActiveContacts(
  companyId: string,
  limit = 10,
): Promise<Contact[]> {
  return AppDataSource.getRepository(Contact)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("c.archivedAt IS NULL")
    .andWhere("c.lastActivityAt IS NOT NULL")
    .orderBy("c.lastActivityAt", "DESC")
    .take(Math.min(Math.max(limit, 1), MAX_LIMIT))
    .getMany();
}
