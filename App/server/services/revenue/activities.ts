import { Brackets, In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import {
  ACTIVITY_BODY_CAP,
  Activity,
  type ActivityPriority,
  type ActivityKind,
  type ActivityTaskStatus,
} from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { touchLastActivity } from "./contacts.js";
import { assertRevenueLinks } from "./integrity.js";

/**
 * The activity timeline.
 *
 * Mostly written by machines rather than people — mail sync produces the bulk
 * of it, the deal service adds stage changes, sequences add their touches. Those
 * machine rows are immutable evidence. Manually logged notes, calls, meetings,
 * and tasks may be corrected through the narrow administration functions below.
 * That is the point: a CRM whose history depends on humans remembering to log
 * calls is a CRM with no history, so the useful default is that opening a
 * Contact shows every conversation without anyone having typed anything.
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
  partnershipId?: string | null;
  mailThreadId?: string | null;
  mailMessageId?: string | null;
  meta?: Record<string, unknown> | null;
  taskStatus?: ActivityTaskStatus | null;
  dueAt?: Date | null;
  completedAt?: Date | null;
  assignedUserId?: string | null;
  assignedEmployeeId?: string | null;
  priority?: ActivityPriority | null;
  reminderAt?: Date | null;
  recurrenceRule?: string | null;
};

export type ActivityListOptions = {
  q?: string;
  contactId?: string;
  dealId?: string;
  customerId?: string;
  partnershipId?: string;
  kinds?: ActivityKind[];
  from?: Date;
  to?: Date;
  actorUserId?: string;
  actorEmployeeId?: string;
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
      partnershipId: input.partnershipId ?? null,
      mailThreadId: input.mailThreadId ?? null,
      mailMessageId: input.mailMessageId ?? null,
      actorUserId: actor.userId ?? null,
      actorEmployeeId: actor.employeeId ?? null,
      metaJson: serializeMeta(input.meta),
      taskStatus: input.kind === "task" ? (input.taskStatus ?? "open") : null,
      dueAt: input.kind === "task" ? (input.dueAt ?? null) : null,
      completedAt: input.kind === "task" ? (input.completedAt ?? null) : null,
      assignedUserId: input.kind === "task" ? (input.assignedUserId ?? null) : null,
      assignedEmployeeId: input.kind === "task" ? (input.assignedEmployeeId ?? null) : null,
      priority: input.kind === "task" ? (input.priority ?? "normal") : null,
      reminderAt: input.kind === "task" ? (input.reminderAt ?? null) : null,
      recurrenceRule: input.kind === "task" ? (input.recurrenceRule ?? null) : null,
    }),
  );

  if (input.contactId) await touchLastActivity(companyId, [input.contactId], occurredAt);
  if (input.dealId) await touchDealActivity(companyId, [input.dealId], occurredAt);
  if (input.partnershipId) {
    await AppDataSource.getRepository(Partnership)
      .createQueryBuilder()
      .update(Partnership)
      .set({ lastActivityAt: occurredAt })
      .where("companyId = :companyId AND id = :id", {
        companyId,
        id: input.partnershipId,
      })
      .execute();
  }
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
      partnershipId: input.partnershipId ?? null,
      mailThreadId: input.mailThreadId ?? null,
      mailMessageId: input.mailMessageId,
      metaJson: serializeMeta(input.meta),
      taskStatus: null,
      dueAt: null,
      completedAt: null,
      assignedUserId: null,
      assignedEmployeeId: null,
      priority: null,
      reminderAt: null,
      recurrenceRule: null,
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
  if (opts.partnershipId) {
    qb.andWhere("a.partnershipId = :partnershipId", { partnershipId: opts.partnershipId });
  }
  if (opts.kinds && opts.kinds.length > 0) {
    qb.andWhere("a.kind IN (:...kinds)", { kinds: opts.kinds });
  }
  if (opts.q?.trim()) {
    qb.andWhere(
      new Brackets((where) => {
        where
          .where("LOWER(a.subject) LIKE :activityQuery", {
            activityQuery: `%${opts.q!.trim().toLowerCase()}%`,
          })
          .orWhere("LOWER(a.bodyText) LIKE :activityQuery", {
            activityQuery: `%${opts.q!.trim().toLowerCase()}%`,
          });
      }),
    );
  }
  if (opts.from) qb.andWhere("a.occurredAt >= :from", { from: opts.from });
  if (opts.to) qb.andWhere("a.occurredAt <= :to", { to: opts.to });
  if (opts.actorUserId) {
    qb.andWhere("a.actorUserId = :actorUserId", { actorUserId: opts.actorUserId });
  }
  if (opts.actorEmployeeId) {
    qb.andWhere("a.actorEmployeeId = :actorEmployeeId", {
      actorEmployeeId: opts.actorEmployeeId,
    });
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

export const MANUAL_ACTIVITY_KINDS = ["note", "call", "meeting", "task"] as const;

function isManualActivity(activity: Activity): boolean {
  return (MANUAL_ACTIVITY_KINDS as readonly string[]).includes(activity.kind);
}

export async function getActivity(companyId: string, id: string): Promise<Activity | null> {
  return AppDataSource.getRepository(Activity).findOneBy({ companyId, id });
}

export type ActivityPatch = {
  subject?: string;
  bodyText?: string;
  occurredAt?: Date;
  contactId?: string | null;
  dealId?: string | null;
  customerId?: string | null;
  partnershipId?: string | null;
};

/**
 * Correct a manually logged fact. Machine-derived rows stay immutable because
 * mail, stage and Signal history are evidence used by reporting and compliance.
 */
export async function updateManualActivity(
  companyId: string,
  id: string,
  patch: ActivityPatch,
): Promise<Activity | null> {
  const repo = AppDataSource.getRepository(Activity);
  const activity = await repo.findOneBy({ companyId, id });
  if (!activity) return null;
  if (!isManualActivity(activity)) {
    throw new Error("Only manually logged notes, calls, meetings, and tasks can be edited");
  }
  await assertRevenueLinks(companyId, patch);
  const previousLinks = activityLinks(activity);
  if (patch.subject !== undefined) activity.subject = patch.subject.slice(0, 500);
  if (patch.bodyText !== undefined) activity.bodyText = capBody(patch.bodyText);
  if (patch.occurredAt !== undefined) activity.occurredAt = patch.occurredAt;
  if (patch.contactId !== undefined) activity.contactId = patch.contactId;
  if (patch.dealId !== undefined) activity.dealId = patch.dealId;
  if (patch.customerId !== undefined) activity.customerId = patch.customerId;
  if (patch.partnershipId !== undefined) activity.partnershipId = patch.partnershipId;
  const saved = await repo.save(activity);
  await refreshActivityRecency(companyId, [...previousLinks, ...activityLinks(saved)]);
  return saved;
}

export async function deleteManualActivity(
  companyId: string,
  id: string,
): Promise<Activity | null> {
  const repo = AppDataSource.getRepository(Activity);
  const activity = await repo.findOneBy({ companyId, id });
  if (!activity) return null;
  if (!isManualActivity(activity)) {
    throw new Error("Only manually logged notes, calls, meetings, and tasks can be deleted");
  }
  const links = activityLinks(activity);
  await repo.delete({ companyId, id });
  await refreshActivityRecency(companyId, links);
  return activity;
}

type RecencyLink =
  | { type: "contact"; id: string }
  | { type: "deal"; id: string }
  | { type: "partnership"; id: string };

function activityLinks(
  activity: Pick<Activity, "contactId" | "dealId" | "partnershipId">,
): RecencyLink[] {
  return [
    ...(activity.contactId ? [{ type: "contact" as const, id: activity.contactId }] : []),
    ...(activity.dealId ? [{ type: "deal" as const, id: activity.dealId }] : []),
    ...(activity.partnershipId
      ? [{ type: "partnership" as const, id: activity.partnershipId }]
      : []),
  ];
}

async function refreshActivityRecency(companyId: string, links: RecencyLink[]): Promise<void> {
  const unique = new Map(links.map((link) => [`${link.type}:${link.id}`, link]));
  for (const link of unique.values()) {
    const column =
      link.type === "contact" ? "contactId" : link.type === "deal" ? "dealId" : "partnershipId";
    const raw = await AppDataSource.getRepository(Activity)
      .createQueryBuilder("activity")
      .select("MAX(activity.occurredAt)", "latest")
      .where("activity.companyId = :companyId", { companyId })
      .andWhere(`activity.${column} = :resourceId`, { resourceId: link.id })
      .getRawOne<{ latest: string | Date | null }>();
    const latest = raw?.latest ? new Date(raw.latest) : null;
    if (link.type === "contact") {
      await AppDataSource.getRepository(Contact).update(
        { companyId, id: link.id },
        { lastActivityAt: latest },
      );
    } else if (link.type === "deal") {
      await AppDataSource.getRepository(Deal).update(
        { companyId, id: link.id },
        { lastActivityAt: latest },
      );
    } else {
      await AppDataSource.getRepository(Partnership).update(
        { companyId, id: link.id },
        { lastActivityAt: latest },
      );
    }
  }
}

const ACTIVITY_EXPORT_CAP = 10_000;

function csvCell(value: unknown): string {
  const text =
    value instanceof Date
      ? value.toISOString()
      : value === null || value === undefined
        ? ""
        : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportActivitiesCsv(
  companyId: string,
  opts: Omit<ActivityListOptions, "limit" | "offset"> = {},
): Promise<{ csv: string; exported: number; truncated: boolean }> {
  const rows: Activity[] = [];
  let offset = 0;
  let total = 0;
  while (rows.length < ACTIVITY_EXPORT_CAP) {
    const page = await listActivities(companyId, {
      ...opts,
      limit: MAX_LIMIT,
      offset,
    });
    total = page.total;
    rows.push(...page.rows);
    if (page.rows.length < MAX_LIMIT || rows.length >= total) break;
    offset += page.rows.length;
  }
  const exportedRows = rows.slice(0, ACTIVITY_EXPORT_CAP);
  const header = [
    "id",
    "occurredAt",
    "kind",
    "subject",
    "bodyText",
    "contactId",
    "dealId",
    "customerId",
    "partnershipId",
    "actorUserId",
    "actorEmployeeId",
    "createdAt",
  ];
  const lines = [
    header.map(csvCell).join(","),
    ...exportedRows.map((row) =>
      [
        row.id,
        row.occurredAt,
        row.kind,
        row.subject,
        row.bodyText,
        row.contactId,
        row.dealId,
        row.customerId,
        row.partnershipId,
        row.actorUserId,
        row.actorEmployeeId,
        row.createdAt,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  return {
    csv: lines.join("\r\n"),
    exported: exportedRows.length,
    truncated: total > exportedRows.length,
  };
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
export async function recentlyActiveContacts(companyId: string, limit = 10): Promise<Contact[]> {
  return AppDataSource.getRepository(Contact)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("c.archivedAt IS NULL")
    .andWhere("c.lastActivityAt IS NOT NULL")
    .orderBy("c.lastActivityAt", "DESC")
    .take(Math.min(Math.max(limit, 1), MAX_LIMIT))
    .getMany();
}
