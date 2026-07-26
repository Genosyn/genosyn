import crypto from "node:crypto";
import { In, LessThan } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Deal } from "../../db/entities/Deal.js";
import {
  DealHistoryEvent,
  type DealHistoryEventKind,
  type DealHistorySourceKind,
} from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import type { RevenueOperationActor } from "./operations.js";

const DAY_MS = 86_400_000;

export type DealHistoryEventWrite = {
  dealId: string;
  kind: DealHistoryEventKind;
  occurredAt: Date;
  fromStageId?: string | null;
  toStageId?: string | null;
  fromAmountCents?: number | null;
  toAmountCents?: number | null;
  currency?: string;
  fromOwnerId?: string | null;
  fromOwnerEmployeeId?: string | null;
  toOwnerId?: string | null;
  toOwnerEmployeeId?: string | null;
  lostReason?: string;
  sourceKind: DealHistorySourceKind;
  sourceKey: string;
  sourceActivityId?: string | null;
  metadata?: unknown;
  actor?: RevenueOperationActor;
};

export async function recordDealHistoryEvent(
  companyId: string,
  input: DealHistoryEventWrite,
): Promise<DealHistoryEvent> {
  const repo = AppDataSource.getRepository(DealHistoryEvent);
  const existing = await repo.findOneBy({ companyId, sourceKey: input.sourceKey });
  if (existing) return existing;
  return repo.save(
    repo.create({
      companyId,
      dealId: input.dealId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      fromStageId: input.fromStageId ?? null,
      toStageId: input.toStageId ?? null,
      fromAmountCents: input.fromAmountCents ?? null,
      toAmountCents: input.toAmountCents ?? null,
      currency: input.currency ?? "",
      fromOwnerId: input.fromOwnerId ?? null,
      fromOwnerEmployeeId: input.fromOwnerEmployeeId ?? null,
      toOwnerId: input.toOwnerId ?? null,
      toOwnerEmployeeId: input.toOwnerEmployeeId ?? null,
      lostReason: input.lostReason ?? "",
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      sourceActivityId: input.sourceActivityId ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdByUserId: input.actor?.userId ?? null,
      createdByEmployeeId: input.actor?.employeeId ?? null,
    }),
  );
}

export function liveDealHistoryKey(dealId: string, kind: DealHistoryEventKind): string {
  return `live:${dealId}:${kind}:${crypto.randomUUID()}`;
}

export async function listDealHistory(
  companyId: string,
  opts: {
    dealId?: string;
    sourceKind?: DealHistorySourceKind;
    kind?: DealHistoryEventKind;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: DealHistoryEvent[]; total: number }> {
  const qb = AppDataSource.getRepository(DealHistoryEvent)
    .createQueryBuilder("event")
    .where("event.companyId = :companyId", { companyId });
  if (opts.dealId) qb.andWhere("event.dealId = :dealId", { dealId: opts.dealId });
  if (opts.sourceKind) qb.andWhere("event.sourceKind = :sourceKind", { sourceKind: opts.sourceKind });
  if (opts.kind) qb.andWhere("event.kind = :kind", { kind: opts.kind });
  if (opts.from) qb.andWhere("event.occurredAt >= :from", { from: opts.from });
  if (opts.to) qb.andWhere("event.occurredAt < :to", { to: opts.to });
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("event.occurredAt", "ASC")
    .addOrderBy("event.createdAt", "ASC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return { rows, total };
}

export type HistoricalDealImport = {
  sourceId: string;
  dealId: string;
  originalCreatedAt?: Date;
  events: Array<{
    sourceId: string;
    kind: Exclude<DealHistoryEventKind, "created">;
    occurredAt: Date;
    fromStageId?: string | null;
    toStageId?: string | null;
    fromAmountCents?: number | null;
    toAmountCents?: number | null;
    currency?: string;
    fromOwnerId?: string | null;
    fromOwnerEmployeeId?: string | null;
    toOwnerId?: string | null;
    toOwnerEmployeeId?: string | null;
    lostReason?: string;
    metadata?: unknown;
  }>;
};

export type DealHistoryImportResult = {
  sourceId: string;
  dealId: string;
  status: "imported" | "partial" | "failed" | "skipped";
  imported: number;
  skipped: number;
  errors: string[];
};

export async function importHistoricalDealEvents(
  companyId: string,
  batchKey: string,
  rows: HistoricalDealImport[],
  actor: RevenueOperationActor = {},
): Promise<{
  batchKey: string;
  imported: number;
  skipped: number;
  failed: number;
  rows: DealHistoryImportResult[];
}> {
  const dealIds = [...new Set(rows.map((row) => row.dealId))];
  const deals = await AppDataSource.getRepository(Deal).find({
    where: { companyId, id: In(dealIds) },
  });
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const stages = await AppDataSource.getRepository(DealStage).find({ where: { companyId } });
  const stageIds = new Set(stages.map((stage) => stage.id));
  const results: DealHistoryImportResult[] = [];

  for (const input of rows) {
    const deal = dealById.get(input.dealId);
    const result: DealHistoryImportResult = {
      sourceId: input.sourceId,
      dealId: input.dealId,
      status: "imported",
      imported: 0,
      skipped: 0,
      errors: [],
    };
    if (!deal) {
      result.status = "failed";
      result.errors.push("Deal not found");
      results.push(result);
      continue;
    }
    const ordered = [...input.events].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    if (input.originalCreatedAt && ordered.some((event) => event.occurredAt < input.originalCreatedAt!)) {
      result.errors.push("An event predates the original Deal creation date");
    }
    for (const event of ordered) {
      if (event.fromStageId && !stageIds.has(event.fromStageId)) {
        result.errors.push(`Unknown from Deal Stage: ${event.fromStageId}`);
      }
      if (event.toStageId && !stageIds.has(event.toStageId)) {
        result.errors.push(`Unknown to Deal Stage: ${event.toStageId}`);
      }
      if (
        (event.kind === "stage_changed" || event.kind === "won" || event.kind === "lost") &&
        !event.toStageId
      ) {
        result.errors.push(`${event.kind} requires a destination Deal Stage`);
      }
    }
    if (result.errors.length > 0) {
      result.status = "failed";
      results.push(result);
      continue;
    }

    await AppDataSource.transaction(async (manager) => {
      const eventRepo = manager.getRepository(DealHistoryEvent);
      if (input.originalCreatedAt) {
        const sourceKey = `${batchKey}:${input.sourceId}:created`;
        if (await eventRepo.findOneBy({ companyId, sourceKey })) {
          result.skipped += 1;
        } else {
          await eventRepo.save(
            eventRepo.create({
              companyId,
              dealId: deal.id,
              kind: "created",
              occurredAt: input.originalCreatedAt,
              fromStageId: null,
              toStageId: ordered[0]?.fromStageId ?? ordered[0]?.toStageId ?? deal.stageId,
              fromAmountCents: null,
              toAmountCents: null,
              currency: deal.currency,
              fromOwnerId: null,
              fromOwnerEmployeeId: null,
              toOwnerId: deal.ownerId,
              toOwnerEmployeeId: deal.ownerEmployeeId,
              lostReason: "",
              sourceKind: "import",
              sourceKey,
              sourceActivityId: null,
              metadataJson: JSON.stringify({ sourceId: input.sourceId }),
              createdByUserId: actor.userId ?? null,
              createdByEmployeeId: actor.employeeId ?? null,
            }),
          );
          result.imported += 1;
        }
        if (input.originalCreatedAt < deal.createdAt) {
          await manager.update(
            Deal,
            { companyId, id: deal.id },
            { createdAt: input.originalCreatedAt },
          );
          deal.createdAt = input.originalCreatedAt;
        }
      }
      for (const event of ordered) {
        const sourceKey = `${batchKey}:${input.sourceId}:${event.sourceId}`;
        if (await eventRepo.findOneBy({ companyId, sourceKey })) {
          result.skipped += 1;
          continue;
        }
        await eventRepo.save(
          eventRepo.create({
            companyId,
            dealId: deal.id,
            kind: event.kind,
            occurredAt: event.occurredAt,
            fromStageId: event.fromStageId ?? null,
            toStageId: event.toStageId ?? null,
            fromAmountCents: event.fromAmountCents ?? null,
            toAmountCents: event.toAmountCents ?? null,
            currency: event.currency ?? deal.currency,
            fromOwnerId: event.fromOwnerId ?? null,
            fromOwnerEmployeeId: event.fromOwnerEmployeeId ?? null,
            toOwnerId: event.toOwnerId ?? null,
            toOwnerEmployeeId: event.toOwnerEmployeeId ?? null,
            lostReason: event.lostReason ?? "",
            sourceKind: "import",
            sourceKey,
            sourceActivityId: null,
            metadataJson: JSON.stringify(event.metadata ?? {}),
            createdByUserId: actor.userId ?? null,
            createdByEmployeeId: actor.employeeId ?? null,
          }),
        );
        result.imported += 1;
        if ((event.kind === "won" && deal.status === "won") || (event.kind === "lost" && deal.status === "lost")) {
          await manager.update(
            Deal,
            { companyId, id: deal.id },
            {
              closedAt: event.occurredAt,
              lostReason: event.kind === "lost" ? event.lostReason ?? deal.lostReason : deal.lostReason,
            },
          );
        }
      }
    });
    result.status =
      result.imported > 0 ? (result.skipped > 0 ? "partial" : "imported") : "skipped";
    results.push(result);
  }

  return {
    batchKey,
    imported: results.reduce((sum, row) => sum + row.imported, 0),
    skipped: results.reduce((sum, row) => sum + row.skipped, 0),
    failed: results.filter((row) => row.status === "failed").length,
    rows: results,
  };
}

export async function backfillDealHistoryFromActivities(
  companyId: string,
  actor: RevenueOperationActor = {},
): Promise<{ imported: number; skipped: number }> {
  const activities = await AppDataSource.getRepository(Activity)
    .createQueryBuilder("activity")
    .where("activity.companyId = :companyId", { companyId })
    .andWhere("activity.dealId IS NOT NULL")
    .andWhere("activity.kind IN ('deal_created', 'stage_change', 'deal_won', 'deal_lost')")
    .orderBy("activity.occurredAt", "ASC")
    .getMany();
  let imported = 0;
  let skipped = 0;
  for (const raw of activities) {
    const id = String(raw.id);
    const existing = await AppDataSource.getRepository(DealHistoryEvent).findOneBy({
      sourceActivityId: id,
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    let metadata: Record<string, unknown> = {};
    try {
      metadata = raw.metaJson ? (JSON.parse(String(raw.metaJson)) as Record<string, unknown>) : {};
    } catch {
      metadata = {};
    }
    const activityKind = String(raw.kind);
    const kind: DealHistoryEventKind =
      activityKind === "deal_created"
        ? "created"
        : activityKind === "deal_won"
          ? "won"
          : activityKind === "deal_lost"
            ? "lost"
            : "stage_changed";
    await recordDealHistoryEvent(companyId, {
      dealId: String(raw.dealId),
      kind,
      occurredAt: raw.occurredAt as Date,
      fromStageId: typeof metadata.fromStageId === "string" ? metadata.fromStageId : null,
      toStageId:
        typeof metadata.toStageId === "string"
          ? metadata.toStageId
          : typeof metadata.stageId === "string"
            ? metadata.stageId
            : null,
      toAmountCents:
        typeof metadata.amountCents === "number" ? metadata.amountCents : null,
      currency: typeof metadata.currency === "string" ? metadata.currency : "",
      lostReason: typeof metadata.lostReason === "string" ? metadata.lostReason : "",
      sourceKind: "activity_backfill",
      sourceKey: `activity:${id}`,
      sourceActivityId: id,
      metadata,
      actor,
    });
    imported += 1;
  }
  return { imported, skipped };
}

type HistoricalStage = Pick<DealStage, "id" | "name" | "kind" | "sortOrder" | "probability">;

export type HistoricalStagePerformance = {
  stage: HistoricalStage;
  enteredDuringPeriod: number;
  progressedDuringPeriod: number;
  medianTimeInStageDays: number | null;
};

export type HistoricalStageConversion = {
  fromStage: HistoricalStage;
  toStage: HistoricalStage;
  cohortEntered: number;
  cohortProgressed: number;
  conversionPct: number | null;
};

function medianDays(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const value =
    values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return Math.round(value * 10) / 10;
}

export async function historicalFunnelMetrics(
  companyId: string,
  from: Date,
  to: Date,
  stages: HistoricalStage[],
): Promise<{
  stagePerformance: HistoricalStagePerformance[];
  conversion: HistoricalStageConversion[];
  outcomes: { won: number; lost: number; winRatePct: number | null };
  salesCycleDays: number | null;
  historyCoverage: {
    eligibleDeals: number;
    completeDeals: number;
    partialDeals: number;
    withoutHistory: number;
    importedDeals: number;
  };
}> {
  const deals = await AppDataSource.getRepository(Deal).find({
    where: { companyId, createdAt: LessThan(to) },
  });
  const activeDeals = deals.filter((deal) => !deal.archivedAt);
  const events = await AppDataSource.getRepository(DealHistoryEvent)
    .createQueryBuilder("event")
    .where("event.companyId = :companyId", { companyId })
    .andWhere("event.occurredAt < :to", { to })
    .orderBy("event.occurredAt", "ASC")
    .addOrderBy("event.createdAt", "ASC")
    .getMany();
  const activeIds = new Set(activeDeals.map((deal) => deal.id));
  const byDeal = new Map<string, DealHistoryEvent[]>();
  for (const event of events) {
    if (!activeIds.has(event.dealId)) continue;
    const list = byDeal.get(event.dealId) ?? [];
    list.push(event);
    byDeal.set(event.dealId, list);
  }
  const orderedStages = [...stages].sort((left, right) => left.sortOrder - right.sortOrder);
  const entered = new Map<string, Set<string>>();
  const progressed = new Map<string, Set<string>>();
  const durations = new Map<string, number[]>();
  const cohortDeals = new Set<string>();
  let won = 0;
  let lost = 0;
  const cycles: number[] = [];
  let completeDeals = 0;
  let partialDeals = 0;
  let importedDeals = 0;

  for (const deal of activeDeals) {
    const history = byDeal.get(deal.id) ?? [];
    if (history.length === 0) continue;
    if (history.some((event) => event.sourceKind === "import")) importedDeals += 1;
    const created = history.find((event) => event.kind === "created");
    if (created) {
      completeDeals += 1;
      if (created.occurredAt >= from && created.occurredAt < to) cohortDeals.add(deal.id);
    } else {
      partialDeals += 1;
    }
    let currentStageId: string | null = null;
    let stageEnteredAt: Date | null = null;
    for (const event of history) {
      const inPeriod = event.occurredAt >= from && event.occurredAt < to;
      if (event.kind === "created") {
        currentStageId = event.toStageId;
        stageEnteredAt = event.occurredAt;
        if (inPeriod && currentStageId) {
          const set = entered.get(currentStageId) ?? new Set<string>();
          set.add(deal.id);
          entered.set(currentStageId, set);
        }
      } else if (
        event.kind === "stage_changed" ||
        event.kind === "won" ||
        event.kind === "lost"
      ) {
        const fromStageId: string | null = event.fromStageId ?? currentStageId;
        if (fromStageId && stageEnteredAt && event.occurredAt >= stageEnteredAt && inPeriod) {
          const list = durations.get(fromStageId) ?? [];
          list.push((event.occurredAt.getTime() - stageEnteredAt.getTime()) / DAY_MS);
          durations.set(fromStageId, list);
        }
        if (inPeriod && event.toStageId) {
          const set = entered.get(event.toStageId) ?? new Set<string>();
          set.add(deal.id);
          entered.set(event.toStageId, set);
        }
        if (inPeriod && fromStageId && event.toStageId && fromStageId !== event.toStageId) {
          const set = progressed.get(fromStageId) ?? new Set<string>();
          set.add(deal.id);
          progressed.set(fromStageId, set);
        }
        currentStageId = event.toStageId ?? currentStageId;
        stageEnteredAt = event.occurredAt;
      }
      if (inPeriod && event.kind === "won") won += 1;
      if (inPeriod && event.kind === "lost") lost += 1;
    }
    if (created) {
      const wonEvent = history.find(
        (event) => event.kind === "won" && event.occurredAt >= from && event.occurredAt < to,
      );
      if (wonEvent && wonEvent.occurredAt >= created.occurredAt) {
        cycles.push((wonEvent.occurredAt.getTime() - created.occurredAt.getTime()) / DAY_MS);
      }
    }
  }

  const cohortEntered = new Map<string, Set<string>>();
  for (const dealId of cohortDeals) {
    for (const event of byDeal.get(dealId) ?? []) {
      const stageId =
        event.kind === "created" ||
        event.kind === "stage_changed" ||
        event.kind === "won" ||
        event.kind === "lost"
          ? event.toStageId
          : null;
      if (!stageId) continue;
      const set = cohortEntered.get(stageId) ?? new Set<string>();
      set.add(dealId);
      cohortEntered.set(stageId, set);
    }
  }
  const conversionStages = orderedStages.filter((stage) => stage.kind !== "lost");
  const conversion = conversionStages.slice(0, -1).map((stage, index) => {
    const toStage = conversionStages[index + 1];
    const fromSet = cohortEntered.get(stage.id) ?? new Set<string>();
    const toSet = cohortEntered.get(toStage.id) ?? new Set<string>();
    const progressedCount = [...fromSet].filter((dealId) => toSet.has(dealId)).length;
    return {
      fromStage: stage,
      toStage,
      cohortEntered: fromSet.size,
      cohortProgressed: progressedCount,
      conversionPct:
        fromSet.size > 0 ? Math.round((progressedCount / fromSet.size) * 1_000) / 10 : null,
    };
  });
  return {
    stagePerformance: orderedStages.map((stage) => ({
      stage,
      enteredDuringPeriod: entered.get(stage.id)?.size ?? 0,
      progressedDuringPeriod: progressed.get(stage.id)?.size ?? 0,
      medianTimeInStageDays: medianDays(durations.get(stage.id) ?? []),
    })),
    conversion,
    outcomes: {
      won,
      lost,
      winRatePct: won + lost > 0 ? Math.round((won / (won + lost)) * 1_000) / 10 : null,
    },
    salesCycleDays: medianDays(cycles),
    historyCoverage: {
      eligibleDeals: activeDeals.length,
      completeDeals,
      partialDeals,
      withoutHistory: activeDeals.length - completeDeals - partialDeals,
      importedDeals,
    },
  };
}
