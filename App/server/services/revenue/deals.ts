import { Brackets, In, type SelectQueryBuilder } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealContact } from "../../db/entities/DealContact.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { DEFAULT_CURRENCY } from "../../lib/money.js";
import { recordActivity } from "./activities.js";
import { applyStageChange, weightedValueCents } from "./dealStage.js";
import { defaultStageFor, getDealStage, listDealStages } from "./stages.js";
import {
  assertClassification,
  classificationValue,
  listRevenueClassifications,
} from "./classifications.js";
import { matchingResourceIds } from "./customFields.js";
import { liveDealHistoryKey, recordDealHistoryEvent } from "./dealHistory.js";
import { assertRevenueLinks, assertRevenueOwner } from "./integrity.js";
import { findMergedRecordRedirect } from "./operations.js";

/**
 * Deals — the opportunity layer.
 *
 * The invariant this module exists to protect: **a deal's `status` always
 * mirrors the `kind` of the stage it sits in.** The arithmetic lives in the
 * pure `dealStage.ts`; this file is the only place allowed to write `stageId`,
 * so there is exactly one code path that can get it wrong. Every stage move
 * also writes an Activity, which is what the funnel report reads to compute
 * stage-to-stage conversion — a move that skipped it would be invisible to
 * every report.
 */

export type DealActor = {
  userId?: string | null;
  employeeId?: string | null;
};

export type DealInput = {
  title: string;
  description?: string;
  customerId?: string | null;
  primaryContactId?: string | null;
  stageId?: string | null;
  amountCents?: number;
  currency?: string;
  probabilityOverride?: number | null;
  expectedCloseDate?: Date | null;
  source?: string;
  ownerId?: string | null;
  ownerEmployeeId?: string | null;
  nextStep?: string;
  nextFollowUpAt?: Date | null;
  followUpReminderAt?: Date | null;
  lostReason?: string;
};

export type DealListOptions = {
  q?: string;
  status?: "open" | "won" | "lost";
  stageId?: string;
  customerId?: string;
  contactId?: string;
  ownerId?: string;
  ownerEmployeeId?: string;
  customFieldKey?: string;
  customFieldValue?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type HydratedDeal = Deal & {
  stageName: string | null;
  stageKind: string | null;
  customerName: string | null;
  contactName: string | null;
  weightedValueCents: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Keeps a deal inside a 32-bit `int` column on Postgres. */
export const MAX_DEAL_AMOUNT_CENTS = 2_000_000_000;

function applySearch(qb: SelectQueryBuilder<Deal>, q: string): void {
  const term = `%${q.trim().toLowerCase()}%`;
  qb.andWhere(
    new Brackets((w) => {
      w.where("LOWER(d.title) LIKE :term", { term }).orWhere("LOWER(d.description) LIKE :term", {
        term,
      });
    }),
  );
}

export async function listDeals(
  companyId: string,
  opts: DealListOptions = {},
): Promise<{ rows: HydratedDeal[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const qb = AppDataSource.getRepository(Deal)
    .createQueryBuilder("d")
    .where("d.companyId = :companyId", { companyId });

  if (!opts.includeArchived) qb.andWhere("d.archivedAt IS NULL");
  if (opts.q) applySearch(qb, opts.q);
  if (opts.status) qb.andWhere("d.status = :status", { status: opts.status });
  if (opts.stageId) qb.andWhere("d.stageId = :stageId", { stageId: opts.stageId });
  if (opts.customerId) qb.andWhere("d.customerId = :cid", { cid: opts.customerId });
  if (opts.contactId) qb.andWhere("d.primaryContactId = :ctid", { ctid: opts.contactId });
  if (opts.ownerId) qb.andWhere("d.ownerId = :oid", { oid: opts.ownerId });
  if (opts.ownerEmployeeId) {
    qb.andWhere("d.ownerEmployeeId = :oeid", { oeid: opts.ownerEmployeeId });
  }
  if (opts.customFieldKey && opts.customFieldValue !== undefined) {
    const ids = await matchingResourceIds(
      companyId,
      "deal",
      opts.customFieldKey,
      opts.customFieldValue,
    );
    if (ids.length === 0) return { rows: [], total: 0 };
    qb.andWhere("d.id IN (:...customIds)", { customIds: ids });
  }

  const total = await qb.clone().getCount();
  const rows = await qb.orderBy("d.updatedAt", "DESC").skip(offset).take(limit).getMany();

  return { rows: await hydrateDeals(companyId, rows), total };
}

/**
 * Attach stage / customer / contact names and the weighted value in three
 * queries regardless of page size — a board with 200 cards must not issue 600
 * lookups.
 */
export async function hydrateDeals(companyId: string, deals: Deal[]): Promise<HydratedDeal[]> {
  if (deals.length === 0) return [];

  const stageIds = [...new Set(deals.map((d) => d.stageId).filter(Boolean))];
  const customerIds = [
    ...new Set(deals.map((d) => d.customerId).filter((id): id is string => !!id)),
  ];
  const contactIds = [
    ...new Set(deals.map((d) => d.primaryContactId).filter((id): id is string => !!id)),
  ];

  const [stages, customers, contacts] = await Promise.all([
    stageIds.length
      ? AppDataSource.getRepository(DealStage).find({ where: { companyId, id: In(stageIds) } })
      : Promise.resolve([]),
    customerIds.length
      ? AppDataSource.getRepository(Customer).find({
          where: { companyId, id: In(customerIds) },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    contactIds.length
      ? AppDataSource.getRepository(Contact).find({
          where: { companyId, id: In(contactIds) },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const stageById = new Map(stages.map((s) => [s.id, s]));
  const customerById = new Map(customers.map((c) => [c.id, c.name]));
  const contactById = new Map(contacts.map((c) => [c.id, c.name]));

  return deals.map((d) => {
    const stage = stageById.get(d.stageId);
    return Object.assign(d, {
      stageName: stage?.name ?? null,
      stageKind: stage?.kind ?? null,
      customerName: d.customerId ? (customerById.get(d.customerId) ?? null) : null,
      contactName: d.primaryContactId ? (contactById.get(d.primaryContactId) ?? null) : null,
      weightedValueCents: stage ? weightedValueCents(d, stage) : 0,
    });
  });
}

export async function getDeal(companyId: string, id: string): Promise<Deal | null> {
  return AppDataSource.getRepository(Deal).findOneBy({ id, companyId });
}

export async function getHydratedDeal(companyId: string, id: string): Promise<HydratedDeal | null> {
  const deal = await getDeal(companyId, id);
  if (!deal) return null;
  return (await hydrateDeals(companyId, [deal]))[0] ?? null;
}

export class InvalidStageError extends Error {
  constructor(stageId: string) {
    super(`Stage ${stageId} does not belong to this company`);
    this.name = "InvalidStageError";
  }
}

/**
 * Open a deal. Lands in the first open stage unless one is named, and writes a
 * `deal_created` activity so the timeline starts at the beginning.
 */
export async function createDeal(
  companyId: string,
  input: DealInput,
  actor: DealActor = {},
): Promise<Deal> {
  let stage = input.stageId ? await getDealStage(companyId, input.stageId) : null;
  if (input.stageId && !stage) throw new InvalidStageError(input.stageId);
  if (!stage) stage = await defaultStageFor(companyId);
  if (!stage) throw new Error("createDeal: the company has no deal stages");
  await assertRevenueOwner(companyId, input);
  await assertRevenueLinks(companyId, {
    customerId: input.customerId,
    contactId: input.primaryContactId,
  });
  const source = input.source ? classificationValue(input.source) : "";
  await assertClassification(companyId, "deal_source", source);

  const now = new Date();
  const repo = AppDataSource.getRepository(Deal);
  const draft = repo.create({
    companyId,
    title: input.title.trim(),
    description: input.description ?? "",
    customerId: input.customerId ?? null,
    primaryContactId: input.primaryContactId ?? null,
    stageId: stage.id,
    amountCents: clampAmount(input.amountCents),
    currency: input.currency || DEFAULT_CURRENCY,
    probabilityOverride: clampProbability(input.probabilityOverride),
    expectedCloseDate: input.expectedCloseDate ?? null,
    source,
    ownerId: input.ownerId ?? null,
    ownerEmployeeId: input.ownerEmployeeId ?? null,
    nextStep: input.nextStep ?? "",
    nextFollowUpAt: input.nextFollowUpAt ?? null,
    followUpReminderAt: input.followUpReminderAt ?? null,
    lastActivityAt: now,
    createdById: actor.userId ?? null,
    createdByEmployeeId: actor.employeeId ?? null,
  });

  // A deal created straight into a won/lost stage must still close correctly.
  const change = applyStageChange({ ...draft, status: "open", closedAt: null }, stage, now);
  draft.status = change.status;
  draft.closedAt = change.closedAt;

  const deal = await repo.save(draft);

  const activity = await recordActivity(
    companyId,
    {
      kind: "deal_created",
      subject: deal.title,
      dealId: deal.id,
      contactId: deal.primaryContactId,
      customerId: deal.customerId,
      occurredAt: now,
      meta: { stage: stage.name, amountCents: deal.amountCents, currency: deal.currency },
    },
    actor,
  );
  await recordDealHistoryEvent(companyId, {
    dealId: deal.id,
    kind: "created",
    occurredAt: now,
    toStageId: stage.id,
    toAmountCents: deal.amountCents,
    currency: deal.currency,
    toOwnerId: deal.ownerId,
    toOwnerEmployeeId: deal.ownerEmployeeId,
    sourceKind: "live",
    sourceKey: `activity:${activity.id}`,
    sourceActivityId: activity.id,
    actor,
  });
  if (stage.kind === "won" || stage.kind === "lost") {
    await recordDealHistoryEvent(companyId, {
      dealId: deal.id,
      kind: stage.kind,
      occurredAt: now,
      fromStageId: null,
      toStageId: stage.id,
      lostReason: deal.lostReason,
      sourceKind: "live",
      sourceKey: liveDealHistoryKey(deal.id, stage.kind),
      actor,
    });
  }

  return deal;
}

export async function updateDeal(
  companyId: string,
  id: string,
  patch: Partial<DealInput>,
  actor: DealActor = {},
): Promise<Deal | null> {
  const repo = AppDataSource.getRepository(Deal);
  const deal = await repo.findOneBy({ id, companyId });
  if (!deal) return null;
  const beforeAmountCents = deal.amountCents;
  const beforeCurrency = deal.currency;
  const beforeOwnerId = deal.ownerId;
  const beforeOwnerEmployeeId = deal.ownerEmployeeId;
  const beforeExpectedCloseDate = deal.expectedCloseDate;
  await assertRevenueOwner(companyId, patch);
  await assertRevenueLinks(companyId, {
    customerId: patch.customerId,
    contactId: patch.primaryContactId,
  });

  // A stage change is not an ordinary field write — it carries the status
  // invariant and an activity — so it is routed through moveDealToStage.
  const { stageId, ...rest } = patch;

  if (rest.title !== undefined) deal.title = rest.title.trim();
  if (rest.description !== undefined) deal.description = rest.description;
  if (rest.customerId !== undefined) deal.customerId = rest.customerId;
  if (rest.primaryContactId !== undefined) deal.primaryContactId = rest.primaryContactId;
  if (rest.amountCents !== undefined) deal.amountCents = clampAmount(rest.amountCents);
  if (rest.currency !== undefined) deal.currency = rest.currency || DEFAULT_CURRENCY;
  if (rest.probabilityOverride !== undefined) {
    deal.probabilityOverride = clampProbability(rest.probabilityOverride);
  }
  if (rest.expectedCloseDate !== undefined) deal.expectedCloseDate = rest.expectedCloseDate;
  if (rest.source !== undefined) {
    const source = classificationValue(rest.source);
    await assertClassification(companyId, "deal_source", source);
    deal.source = source;
  }
  if (rest.ownerId !== undefined) {
    deal.ownerId = rest.ownerId;
    if (rest.ownerId) deal.ownerEmployeeId = null;
  }
  if (rest.ownerEmployeeId !== undefined) {
    deal.ownerEmployeeId = rest.ownerEmployeeId;
    if (rest.ownerEmployeeId) deal.ownerId = null;
  }
  if (rest.nextStep !== undefined) deal.nextStep = rest.nextStep;
  if (rest.nextFollowUpAt !== undefined) deal.nextFollowUpAt = rest.nextFollowUpAt;
  if (rest.followUpReminderAt !== undefined) {
    deal.followUpReminderAt = rest.followUpReminderAt;
  }
  if (rest.lostReason !== undefined) deal.lostReason = rest.lostReason;

  const saved = await repo.save(deal);
  const changedAt = new Date();
  if (saved.amountCents !== beforeAmountCents || saved.currency !== beforeCurrency) {
    await recordDealHistoryEvent(companyId, {
      dealId: saved.id,
      kind: "amount_changed",
      occurredAt: changedAt,
      fromAmountCents: beforeAmountCents,
      toAmountCents: saved.amountCents,
      currency: saved.currency,
      sourceKind: "live",
      sourceKey: liveDealHistoryKey(saved.id, "amount_changed"),
      actor,
    });
  }
  if (saved.ownerId !== beforeOwnerId || saved.ownerEmployeeId !== beforeOwnerEmployeeId) {
    await recordDealHistoryEvent(companyId, {
      dealId: saved.id,
      kind: "owner_changed",
      occurredAt: changedAt,
      fromOwnerId: beforeOwnerId,
      fromOwnerEmployeeId: beforeOwnerEmployeeId,
      toOwnerId: saved.ownerId,
      toOwnerEmployeeId: saved.ownerEmployeeId,
      sourceKind: "live",
      sourceKey: liveDealHistoryKey(saved.id, "owner_changed"),
      actor,
    });
  }
  if (saved.expectedCloseDate?.getTime() !== beforeExpectedCloseDate?.getTime()) {
    await recordDealHistoryEvent(companyId, {
      dealId: saved.id,
      kind: "expected_close_changed",
      occurredAt: changedAt,
      sourceKind: "live",
      sourceKey: liveDealHistoryKey(saved.id, "expected_close_changed"),
      metadata: {
        fromExpectedCloseDate: beforeExpectedCloseDate?.toISOString() ?? null,
        toExpectedCloseDate: saved.expectedCloseDate?.toISOString() ?? null,
      },
      actor,
    });
  }
  if (stageId && stageId !== saved.stageId) {
    return (await moveDealToStage(companyId, id, stageId, actor)) ?? saved;
  }
  return saved;
}

/**
 * Move a deal between stages, applying the status invariant and logging it.
 *
 * The activity is what makes stage-to-stage conversion computable, so it is
 * written here rather than left to callers — a move recorded without one is a
 * move no report can see.
 */
export async function moveDealToStage(
  companyId: string,
  dealId: string,
  stageId: string,
  actor: DealActor = {},
  opts: { lostReason?: string; now?: Date } = {},
): Promise<Deal | null> {
  const repo = AppDataSource.getRepository(Deal);
  const deal = await repo.findOneBy({ id: dealId, companyId });
  if (!deal) return null;

  const stage = await getDealStage(companyId, stageId);
  if (!stage) throw new InvalidStageError(stageId);

  const fromStage = await getDealStage(companyId, deal.stageId);
  const now = opts.now ?? new Date();

  if (opts.lostReason !== undefined) deal.lostReason = opts.lostReason;
  const change = applyStageChange(deal, stage, now);
  deal.stageId = change.stageId;
  deal.status = change.status;
  deal.closedAt = change.closedAt;
  deal.lostReason = opts.lostReason ?? change.lostReason;
  deal.lastActivityAt = now;
  if (stage.kind !== "open") {
    deal.nextFollowUpAt = null;
    deal.followUpReminderAt = null;
  }

  const saved = await repo.save(deal);

  const kind =
    stage.kind === "won" ? "deal_won" : stage.kind === "lost" ? "deal_lost" : "stage_change";
  const activity = await recordActivity(
    companyId,
    {
      kind,
      subject:
        fromStage && fromStage.id !== stage.id ? `${fromStage.name} → ${stage.name}` : stage.name,
      dealId: saved.id,
      contactId: saved.primaryContactId,
      customerId: saved.customerId,
      occurredAt: now,
      meta: {
        fromStageId: fromStage?.id ?? null,
        fromStage: fromStage?.name ?? null,
        toStageId: stage.id,
        toStage: stage.name,
        amountCents: saved.amountCents,
        currency: saved.currency,
        lostReason: saved.lostReason || undefined,
      },
    },
    actor,
  );
  await recordDealHistoryEvent(companyId, {
    dealId: saved.id,
    kind: stage.kind === "won" ? "won" : stage.kind === "lost" ? "lost" : "stage_changed",
    occurredAt: now,
    fromStageId: fromStage?.id ?? null,
    toStageId: stage.id,
    toAmountCents: saved.amountCents,
    currency: saved.currency,
    lostReason: saved.lostReason,
    sourceKind: "live",
    sourceKey: `activity:${activity.id}`,
    sourceActivityId: activity.id,
    actor,
  });

  return saved;
}

export async function archiveDeal(
  companyId: string,
  id: string,
  now = new Date(),
): Promise<Deal | null> {
  const repo = AppDataSource.getRepository(Deal);
  const deal = await repo.findOneBy({ id, companyId });
  if (!deal) return null;
  deal.archivedAt = now;
  return repo.save(deal);
}

/**
 * Un-archive. Exists because `?includeArchived=true` will happily list rows,
 * and a list that shows you something with no way to act on it is a dead end —
 * contacts already had the pair, deals did not.
 */
export async function restoreDeal(companyId: string, id: string): Promise<Deal | null> {
  const repo = AppDataSource.getRepository(Deal);
  const deal = await repo.findOneBy({ id, companyId });
  if (!deal) return null;
  const redirect = await findMergedRecordRedirect(companyId, "deal", id);
  if (redirect) {
    throw new Error(
      `Restore blocked: this Deal was merged into ${redirect.targetId}; undo the merge instead`,
    );
  }
  deal.archivedAt = null;
  return repo.save(deal);
}

/**
 * How far back the won and lost columns look. Long enough that a deal you
 * closed this morning is still visible where you dropped it; short enough that
 * two years of history does not make the board unusable.
 */
export const BOARD_CLOSED_WINDOW_DAYS = 30;

/**
 * The board: deals grouped by stage, in board order.
 *
 * Open stages carry every open deal. The won and lost stages carry deals closed
 * within {@link BOARD_CLOSED_WINDOW_DAYS} — **not** nothing, which is what a
 * naive `status: "open"` filter gives you. That version rendered two permanently
 * empty columns, and worse, a card dragged into one of them disappeared on the
 * next refetch: the move had succeeded, but the board could not show the result,
 * so it looked like data loss.
 */
export async function dealBoard(
  companyId: string,
  now = new Date(),
): Promise<
  Array<{
    stage: DealStage;
    deals: HydratedDeal[];
    totalCents: number;
    weightedCents: number;
    /** True for the won/lost columns, so the UI can label the time window. */
    windowed: boolean;
  }>
> {
  const stages = await listDealStages(companyId);
  const cutoff = new Date(now.getTime() - BOARD_CLOSED_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const deals = await AppDataSource.getRepository(Deal)
    .createQueryBuilder("d")
    .where("d.companyId = :companyId", { companyId })
    .andWhere("d.archivedAt IS NULL")
    .andWhere(
      new Brackets((w) => {
        w.where("d.status = :open", { open: "open" }).orWhere("d.closedAt >= :cutoff", { cutoff });
      }),
    )
    .orderBy("d.updatedAt", "DESC")
    .getMany();

  const hydrated = await hydrateDeals(companyId, deals);

  return stages.map((stage) => {
    const inStage = hydrated.filter((d) => d.stageId === stage.id);
    return {
      stage,
      deals: inStage,
      totalCents: inStage.reduce((sum, d) => sum + d.amountCents, 0),
      weightedCents: inStage.reduce((sum, d) => sum + d.weightedValueCents, 0),
      windowed: stage.kind !== "open",
    };
  });
}

// ── Buying committee ───────────────────────────────────────────────────────

export async function listDealContacts(
  companyId: string,
  dealId: string,
): Promise<Array<DealContact & { contact: Contact | null }>> {
  const links = await AppDataSource.getRepository(DealContact).find({
    where: { companyId, dealId },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  if (links.length === 0) return [];
  const contacts = await AppDataSource.getRepository(Contact).find({
    where: { companyId, id: In(links.map((l) => l.contactId)) },
  });
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return links.map((l) => Object.assign(l, { contact: byId.get(l.contactId) ?? null }));
}

/** Idempotent — adding somebody already on the committee just updates the role. */
export async function addDealContact(
  companyId: string,
  dealId: string,
  contactId: string,
  role = "",
): Promise<DealContact> {
  const normalizedRole = role ? classificationValue(role) : "";
  const classifications = normalizedRole
    ? await listRevenueClassifications(companyId, "committee_role")
    : [];
  const storedRole =
    classifications.find((classification) => classification.value === normalizedRole)?.label ?? "";
  if (normalizedRole && !storedRole) {
    throw new Error("Unknown committee role classification");
  }
  const repo = AppDataSource.getRepository(DealContact);
  const existing = await repo.findOneBy({ companyId, dealId, contactId });
  if (existing) {
    if (storedRole && existing.role !== storedRole) {
      existing.role = storedRole;
      return repo.save(existing);
    }
    return existing;
  }
  const count = await repo.countBy({ companyId, dealId });
  return repo.save(
    repo.create({ companyId, dealId, contactId, role: storedRole, sortOrder: count }),
  );
}

export async function removeDealContact(
  companyId: string,
  dealId: string,
  contactId: string,
): Promise<boolean> {
  const result = await AppDataSource.getRepository(DealContact).delete({
    companyId,
    dealId,
    contactId,
  });
  return (result.affected ?? 0) > 0;
}

function clampAmount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), MAX_DEAL_AMOUNT_CENTS);
}

function clampProbability(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), 0), 100);
}
