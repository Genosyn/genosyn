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
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import {
  createRevenueOperation,
  type OperationRowWrite,
  type RevenueOperationActor,
} from "./operations.js";

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
  if (opts.sourceKind)
    qb.andWhere("event.sourceKind = :sourceKind", { sourceKind: opts.sourceKind });
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

export type DealHistoryCompleteness = "complete" | "partial" | "snapshot_only";

export type HistoricalDealImportEvent = {
  sourceId: string;
  kind: Exclude<DealHistoryEventKind, "created" | "snapshot">;
  occurredAt: Date;
  fromStageId?: string | null;
  toStageId?: string | null;
  fromAmountCents?: number | null;
  toAmountCents?: number | null;
  fromCurrency?: string | null;
  toCurrency?: string | null;
  /** Backward-compatible alias for `toCurrency`. */
  currency?: string;
  fromOwnerId?: string | null;
  fromOwnerEmployeeId?: string | null;
  toOwnerId?: string | null;
  toOwnerEmployeeId?: string | null;
  fromExpectedCloseDate?: Date | null;
  toExpectedCloseDate?: Date | null;
  lostReason?: string;
  sourceActor?: string;
  metadata?: unknown;
};

export type HistoricalDealImport = {
  sourceId: string;
  dealId: string;
  historyCompleteness?: DealHistoryCompleteness;
  originalCreatedAt?: Date;
  initialStageId?: string | null;
  snapshotAt?: Date;
  events: HistoricalDealImportEvent[];
};

export type DealHistoryImportDecisionStatus = "accepted" | "rejected" | "duplicate" | "conflicting";

export type DealHistoryImportDecision = {
  sourceId: string;
  kind: DealHistoryEventKind;
  occurredAt: Date;
  status: DealHistoryImportDecisionStatus;
  reordered: boolean;
  reason?: string;
};

export type DealHistoryImportResult = {
  sourceId: string;
  dealId: string;
  historyCompleteness: DealHistoryCompleteness;
  status: "ready" | "imported" | "partial" | "failed" | "skipped";
  imported: number;
  skipped: number;
  errors: string[];
  decisions: DealHistoryImportDecision[];
};

export type HistoricalDealImportOptions = {
  sourceSystem?: string;
  dryRun?: boolean;
};

export type HistoricalDealImportSummary = {
  batchKey: string;
  sourceSystem: string;
  dryRun: boolean;
  operationId?: string;
  replayed?: boolean;
  imported: number;
  accepted: number;
  rejected: number;
  reordered: number;
  conflicting: number;
  duplicates: number;
  skipped: number;
  failed: number;
  rows: DealHistoryImportResult[];
};

type ImportCandidate = {
  sourceId: string;
  sourceKey: string;
  kind: DealHistoryEventKind;
  occurredAt: Date;
  originalIndex: number;
  reordered: boolean;
  event?: HistoricalDealImportEvent;
  decision: DealHistoryImportDecision;
};

type PreparedImport = {
  input: HistoricalDealImport;
  completeness: DealHistoryCompleteness;
  initialStageId: string | null;
  deal: Deal | null;
  result: DealHistoryImportResult;
  candidates: ImportCandidate[];
  existingHistory: DealHistoryEvent[];
};

function importSourceKey(
  sourceSystem: string,
  sourceRecordId: string,
  sourceEventId: string,
): string {
  return `history:${encodeURIComponent(sourceSystem)}:${encodeURIComponent(sourceRecordId)}:${encodeURIComponent(sourceEventId)}`;
}

function eventComparable(
  event: Pick<
    DealHistoryEvent,
    | "dealId"
    | "kind"
    | "occurredAt"
    | "fromStageId"
    | "toStageId"
    | "fromAmountCents"
    | "toAmountCents"
    | "currency"
    | "fromOwnerId"
    | "fromOwnerEmployeeId"
    | "toOwnerId"
    | "toOwnerEmployeeId"
    | "lostReason"
  >,
): string {
  return JSON.stringify({
    dealId: event.dealId,
    kind: event.kind,
    occurredAt: event.occurredAt.toISOString(),
    fromStageId: event.fromStageId ?? null,
    toStageId: event.toStageId ?? null,
    fromAmountCents: event.fromAmountCents ?? null,
    toAmountCents: event.toAmountCents ?? null,
    currency: event.currency ?? "",
    fromOwnerId: event.fromOwnerId ?? null,
    fromOwnerEmployeeId: event.fromOwnerEmployeeId ?? null,
    toOwnerId: event.toOwnerId ?? null,
    toOwnerEmployeeId: event.toOwnerEmployeeId ?? null,
    lostReason: event.lostReason ?? "",
  });
}

function candidateComparable(
  candidate: ImportCandidate,
  deal: Deal,
  initialStageId: string | null,
): string {
  const event = candidate.event;
  return eventComparable({
    dealId: deal.id,
    kind: candidate.kind,
    occurredAt: candidate.occurredAt,
    fromStageId: event?.fromStageId ?? null,
    toStageId:
      candidate.kind === "created"
        ? initialStageId
        : candidate.kind === "snapshot"
          ? null
          : (event?.toStageId ?? null),
    fromAmountCents: event?.fromAmountCents ?? null,
    toAmountCents: event?.toAmountCents ?? null,
    // Creation provenance must not depend on the Deal's mutable current
    // currency or owner. Otherwise the same source event can become a false
    // conflict after an ordinary live edit.
    currency: event?.toCurrency ?? event?.currency ?? "",
    fromOwnerId: event?.fromOwnerId ?? null,
    fromOwnerEmployeeId: event?.fromOwnerEmployeeId ?? null,
    toOwnerId: event?.toOwnerId ?? null,
    toOwnerEmployeeId: event?.toOwnerEmployeeId ?? null,
    lostReason: event?.lostReason ?? "",
  });
}

function candidateFingerprint(
  candidate: ImportCandidate,
  deal: Deal,
  initialStageId: string | null,
): string {
  const event = candidate.event;
  return JSON.stringify({
    event: JSON.parse(candidateComparable(candidate, deal, initialStageId)) as unknown,
    fromCurrency: event?.fromCurrency ?? null,
    toCurrency: event?.toCurrency ?? event?.currency ?? null,
    fromExpectedCloseDate: event?.fromExpectedCloseDate?.toISOString() ?? null,
    toExpectedCloseDate: event?.toExpectedCloseDate?.toISOString() ?? null,
    sourceActor: event?.sourceActor ?? null,
    metadata: metadataObject(event?.metadata),
  });
}

function storedEventFingerprint(event: DealHistoryEvent): string {
  try {
    const metadata = JSON.parse(event.metadataJson || "{}") as {
      historyImport?: { fingerprint?: unknown };
    };
    if (typeof metadata.historyImport?.fingerprint === "string") {
      return metadata.historyImport.fingerprint;
    }
  } catch {
    // Fall through to the typed columns for imports written before fingerprints.
  }
  return eventComparable(event);
}

function recordSnapshot(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function completenessFromInput(input: HistoricalDealImport): DealHistoryCompleteness {
  return input.historyCompleteness ?? "partial";
}

function setDecision(
  candidate: ImportCandidate,
  status: DealHistoryImportDecisionStatus,
  reason?: string,
): void {
  candidate.decision.status = status;
  candidate.decision.reason = reason;
}

function summaryFromResults(
  batchKey: string,
  sourceSystem: string,
  dryRun: boolean,
  rows: DealHistoryImportResult[],
): HistoricalDealImportSummary {
  const decisions = rows.flatMap((row) => row.decisions);
  return {
    batchKey,
    sourceSystem,
    dryRun,
    imported: rows.reduce((sum, row) => sum + row.imported, 0),
    accepted: decisions.filter((decision) => decision.status === "accepted").length,
    rejected: decisions.filter((decision) => decision.status === "rejected").length,
    reordered: decisions.filter((decision) => decision.reordered).length,
    conflicting: decisions.filter((decision) => decision.status === "conflicting").length,
    duplicates: decisions.filter((decision) => decision.status === "duplicate").length,
    skipped: rows.reduce((sum, row) => sum + row.skipped, 0),
    failed: rows.filter((row) => row.status === "failed").length,
    rows,
  };
}

/**
 * Preview or import immutable, effective-dated Deal history.
 *
 * Source identity is deliberately independent of `batchKey`: moving the same
 * source events through a second reconciliation batch must still be a replay,
 * not a second history. A committed batch is also recorded as one guarded
 * Revenue operation, so undo removes only its new ledger events and restores
 * only the Deal timestamps that batch changed.
 */
export async function importHistoricalDealEvents(
  companyId: string,
  batchKey: string,
  rows: HistoricalDealImport[],
  actor: RevenueOperationActor = {},
  options: HistoricalDealImportOptions = {},
): Promise<HistoricalDealImportSummary> {
  const sourceSystem = options.sourceSystem?.trim() || `batch:${batchKey}`;
  const dryRun = options.dryRun ?? false;
  const operationRequest = { batchKey, sourceSystem, rows };
  const idempotencyKey = `deal-history:${batchKey}`;

  if (!dryRun) {
    const existingOperation = await AppDataSource.getRepository(RevenueOperation).findOneBy({
      companyId,
      idempotencyKey,
    });
    if (existingOperation) {
      if (existingOperation.requestJson !== JSON.stringify(operationRequest)) {
        throw new Error("That historical import batch key was already used for different data");
      }
      const prior = JSON.parse(existingOperation.summaryJson) as HistoricalDealImportSummary;
      const replayRows = prior.rows.map((row) => {
        const replayedDecisions = row.decisions.map((decision) =>
          decision.status === "accepted"
            ? {
                ...decision,
                status: "duplicate" as const,
                reason: "Source event was already imported",
              }
            : decision,
        );
        const duplicates = replayedDecisions.filter(
          (decision) => decision.status === "duplicate",
        ).length;
        return {
          ...row,
          status: duplicates > 0 ? ("skipped" as const) : row.status,
          imported: 0,
          skipped: duplicates,
          decisions: replayedDecisions,
        };
      });
      return {
        ...summaryFromResults(batchKey, sourceSystem, false, replayRows),
        operationId: existingOperation.id,
        replayed: true,
      };
    }
  }

  const dealIds = [...new Set(rows.map((row) => row.dealId))];
  const [deals, stages, existingEvents] = await Promise.all([
    AppDataSource.getRepository(Deal).find({
      where: { companyId, id: In(dealIds) },
    }),
    AppDataSource.getRepository(DealStage).find({ where: { companyId } }),
    dealIds.length
      ? AppDataSource.getRepository(DealHistoryEvent).find({
          where: { companyId, dealId: In(dealIds) },
          order: { occurredAt: "ASC", createdAt: "ASC" },
        })
      : Promise.resolve([]),
  ]);
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const existingByKey = new Map(existingEvents.map((event) => [event.sourceKey, event]));
  const historyByDeal = new Map<string, DealHistoryEvent[]>();
  for (const event of existingEvents) {
    const list = historyByDeal.get(event.dealId) ?? [];
    list.push(event);
    historyByDeal.set(event.dealId, list);
  }
  const prepared: PreparedImport[] = [];
  const requestSourceKeys = new Set<string>();

  for (const input of rows) {
    const completeness = completenessFromInput(input);
    const deal = dealById.get(input.dealId) ?? null;
    const result: DealHistoryImportResult = {
      sourceId: input.sourceId,
      dealId: input.dealId,
      historyCompleteness: completeness,
      status: "ready",
      imported: 0,
      skipped: 0,
      errors: [],
      decisions: [],
    };
    const existingHistory = historyByDeal.get(input.dealId) ?? [];
    const candidates: ImportCandidate[] = [];
    const orderedEvents = input.events
      .map((event, index) => ({ event, index }))
      .sort(
        (left, right) =>
          left.event.occurredAt.getTime() - right.event.occurredAt.getTime() ||
          left.index - right.index,
      );
    const reorderedIndexes = new Set(
      orderedEvents
        .map(({ index }, sortedIndex) => (index === sortedIndex ? null : index))
        .filter((index): index is number => index !== null),
    );
    const firstStageEvent = orderedEvents.find(({ event }) =>
      ["stage_changed", "won", "lost"].includes(event.kind),
    )?.event;
    const initialStageId =
      input.initialStageId ??
      firstStageEvent?.fromStageId ??
      firstStageEvent?.toStageId ??
      deal?.stageId ??
      null;

    const addCandidate = (
      sourceId: string,
      kind: DealHistoryEventKind,
      occurredAt: Date,
      originalIndex: number,
      event?: HistoricalDealImportEvent,
    ) => {
      const candidate: ImportCandidate = {
        sourceId,
        sourceKey: importSourceKey(sourceSystem, input.sourceId, sourceId),
        kind,
        occurredAt,
        originalIndex,
        reordered: originalIndex >= 0 && reorderedIndexes.has(originalIndex),
        event,
        decision: {
          sourceId,
          kind,
          occurredAt,
          status: "accepted",
          reordered: originalIndex >= 0 && reorderedIndexes.has(originalIndex),
        },
      };
      candidates.push(candidate);
      result.decisions.push(candidate.decision);
    };

    if (input.originalCreatedAt) {
      addCandidate("created", "created", input.originalCreatedAt, -1);
    }
    if (completeness === "snapshot_only" && input.snapshotAt) {
      addCandidate("snapshot", "snapshot", input.snapshotAt, -1);
    }
    for (const { event, index } of orderedEvents) {
      addCandidate(event.sourceId, event.kind, event.occurredAt, index, event);
    }

    if (!deal) {
      result.errors.push("Deal not found");
      for (const candidate of candidates) setDecision(candidate, "rejected", "Deal not found");
    }
    if (completeness === "complete" && !input.originalCreatedAt) {
      result.errors.push("Complete history requires the original Deal creation date");
    }
    if (completeness === "snapshot_only") {
      if (!input.snapshotAt) result.errors.push("Snapshot-only history requires snapshotAt");
      if (input.originalCreatedAt || input.events.length > 0) {
        result.errors.push("Snapshot-only history cannot include fabricated historical events");
      }
    } else if (!input.originalCreatedAt && input.events.length === 0) {
      result.errors.push("Partial or complete history requires at least one effective-dated event");
    }
    if (
      input.originalCreatedAt &&
      input.events.some((event) => event.occurredAt < input.originalCreatedAt!)
    ) {
      result.errors.push("An event predates the original Deal creation date");
    }
    if (deal && input.originalCreatedAt && input.originalCreatedAt > deal.createdAt) {
      result.errors.push(
        "Original Deal creation date cannot be later than its current creation date",
      );
    }
    if (input.initialStageId && !stageById.has(input.initialStageId)) {
      result.errors.push(`Unknown initial Deal Stage: ${input.initialStageId}`);
    }

    let currentStageId = initialStageId;
    const earliestNativeAt = existingHistory
      .filter((event) => event.sourceKind !== "import")
      .reduce<Date | null>(
        (earliest, event) =>
          !earliest || event.occurredAt < earliest ? event.occurredAt : earliest,
        null,
      );
    for (const candidate of candidates) {
      if (!deal) continue;
      if (requestSourceKeys.has(candidate.sourceKey)) {
        setDecision(candidate, "duplicate", "Duplicate source event in this request");
        result.skipped += 1;
        continue;
      }
      requestSourceKeys.add(candidate.sourceKey);
      const existing = existingByKey.get(candidate.sourceKey);
      if (existing) {
        const fingerprint = candidateFingerprint(candidate, deal, initialStageId);
        if (
          storedEventFingerprint(existing) === fingerprint ||
          storedEventFingerprint(existing) === candidateComparable(candidate, deal, initialStageId)
        ) {
          setDecision(candidate, "duplicate", "Source event was already imported");
        } else {
          setDecision(
            candidate,
            "conflicting",
            "Source event ID already exists with different data",
          );
        }
        result.skipped += 1;
        continue;
      }
      if (!Number.isFinite(candidate.occurredAt.getTime())) {
        setDecision(candidate, "rejected", "Invalid effective timestamp");
        continue;
      }
      if (
        earliestNativeAt &&
        candidate.kind !== "snapshot" &&
        candidate.occurredAt >= earliestNativeAt
      ) {
        setDecision(
          candidate,
          "conflicting",
          `Effective timestamp overlaps native history beginning ${earliestNativeAt.toISOString()}`,
        );
        continue;
      }
      const event = candidate.event;
      if (!event) continue;
      if (event.fromStageId && !stageById.has(event.fromStageId)) {
        setDecision(candidate, "rejected", `Unknown from Deal Stage: ${event.fromStageId}`);
        continue;
      }
      if (event.toStageId && !stageById.has(event.toStageId)) {
        setDecision(candidate, "rejected", `Unknown to Deal Stage: ${event.toStageId}`);
        continue;
      }
      if (["stage_changed", "won", "lost"].includes(event.kind) && !event.toStageId) {
        setDecision(candidate, "rejected", `${event.kind} requires a destination Deal Stage`);
        continue;
      }
      if (
        ["stage_changed", "won", "lost"].includes(event.kind) &&
        completeness === "complete" &&
        !event.fromStageId
      ) {
        setDecision(candidate, "rejected", "Complete stage history requires every exit boundary");
        continue;
      }
      if (
        ["stage_changed", "won", "lost"].includes(event.kind) &&
        event.fromStageId &&
        currentStageId &&
        event.fromStageId !== currentStageId
      ) {
        setDecision(
          candidate,
          "conflicting",
          `Stage chain expected ${currentStageId} but event exits ${event.fromStageId}`,
        );
        continue;
      }
      if (event.kind === "won" || event.kind === "lost") {
        const expectedKind = event.kind;
        const destination = event.toStageId ? stageById.get(event.toStageId) : null;
        if (destination?.kind !== expectedKind) {
          setDecision(
            candidate,
            "conflicting",
            `${event.kind} must enter a ${expectedKind} Deal Stage`,
          );
          continue;
        }
        if (event.kind === "lost" && !(event.lostReason?.trim() || deal.lostReason.trim())) {
          setDecision(candidate, "rejected", "A lost event requires a lost reason");
          continue;
        }
      }
      if (
        event.kind === "amount_changed" &&
        event.fromAmountCents == null &&
        event.toAmountCents == null &&
        !event.fromCurrency &&
        !event.toCurrency &&
        !event.currency
      ) {
        setDecision(
          candidate,
          "rejected",
          "Amount history requires an amount or currency boundary",
        );
        continue;
      }
      if (
        [event.fromAmountCents, event.toAmountCents].some(
          (value) =>
            value != null && (!Number.isInteger(value) || value < 0 || value > 2_000_000_000),
        )
      ) {
        setDecision(candidate, "rejected", "Amount history contains an invalid amount");
        continue;
      }
      if (
        [event.fromCurrency, event.toCurrency, event.currency].some(
          (value) => value != null && value !== "" && !/^[A-Za-z]{3}$/.test(value),
        )
      ) {
        setDecision(candidate, "rejected", "Amount history contains an invalid currency");
        continue;
      }
      if (
        event.kind === "owner_changed" &&
        event.fromOwnerId === undefined &&
        event.fromOwnerEmployeeId === undefined &&
        event.toOwnerId === undefined &&
        event.toOwnerEmployeeId === undefined
      ) {
        setDecision(candidate, "rejected", "Owner history requires a before or after owner");
        continue;
      }
      if (
        event.kind === "expected_close_changed" &&
        event.fromExpectedCloseDate === undefined &&
        event.toExpectedCloseDate === undefined
      ) {
        setDecision(
          candidate,
          "rejected",
          "Expected-close history requires a before or after date",
        );
        continue;
      }
      if (
        (event.fromOwnerId && event.fromOwnerEmployeeId) ||
        (event.toOwnerId && event.toOwnerEmployeeId)
      ) {
        setDecision(candidate, "rejected", "An owner boundary cannot name both owner types");
        continue;
      }
      if (["stage_changed", "won", "lost"].includes(event.kind)) {
        currentStageId = event.toStageId ?? currentStageId;
      }
    }
    if (result.errors.length > 0) {
      for (const candidate of candidates) {
        if (candidate.decision.status === "accepted") {
          setDecision(candidate, "rejected", result.errors[0]);
        }
      }
    }
    const accepted = result.decisions.filter((decision) => decision.status === "accepted").length;
    const rejected = result.decisions.filter(
      (decision) => decision.status === "rejected" || decision.status === "conflicting",
    ).length;
    result.status =
      accepted > 0
        ? rejected > 0 || result.skipped > 0
          ? "partial"
          : "ready"
        : result.skipped > 0 && rejected === 0
          ? "skipped"
          : "failed";
    result.errors.push(
      ...result.decisions
        .filter(
          (decision) =>
            (decision.status === "rejected" || decision.status === "conflicting") &&
            decision.reason,
        )
        .map((decision) => `${decision.sourceId}: ${decision.reason}`),
    );
    prepared.push({
      input,
      completeness,
      initialStageId,
      deal,
      result,
      candidates,
      existingHistory,
    });
  }

  const preview = summaryFromResults(
    batchKey,
    sourceSystem,
    dryRun,
    prepared.map((row) => row.result),
  );
  if (dryRun || preview.accepted === 0) return preview;

  return AppDataSource.transaction("SERIALIZABLE", async (manager) => {
    const operationRows: OperationRowWrite[] = [];
    for (const item of prepared) {
      const { deal, input, completeness, result } = item;
      if (!deal) continue;
      const acceptedCandidates = item.candidates.filter(
        (candidate) => candidate.decision.status === "accepted",
      );
      const importedEvents: DealHistoryEvent[] = [];
      for (const candidate of acceptedCandidates) {
        const event = candidate.event;
        const initialStageId = item.initialStageId;
        const metadata = {
          ...metadataObject(event?.metadata),
          historyImport: {
            batchKey,
            sourceSystem,
            sourceRecordId: input.sourceId,
            sourceEventId: candidate.sourceId,
            sourceActor: event?.sourceActor ?? null,
            historyCompleteness: completeness,
            reordered: candidate.reordered,
            importedAt: new Date().toISOString(),
            fingerprint: candidateFingerprint(candidate, deal, initialStageId),
          },
          ...(event?.kind === "expected_close_changed"
            ? {
                fromExpectedCloseDate: event.fromExpectedCloseDate?.toISOString() ?? null,
                toExpectedCloseDate: event.toExpectedCloseDate?.toISOString() ?? null,
              }
            : {}),
          ...(event?.kind === "amount_changed"
            ? {
                fromCurrency: event.fromCurrency ?? null,
                toCurrency: event.toCurrency ?? event.currency ?? null,
              }
            : {}),
        };
        const saved = await manager.save(
          DealHistoryEvent,
          manager.create(DealHistoryEvent, {
            companyId,
            dealId: deal.id,
            kind: candidate.kind,
            occurredAt: candidate.occurredAt,
            fromStageId: event?.fromStageId ?? null,
            toStageId: candidate.kind === "created" ? initialStageId : (event?.toStageId ?? null),
            fromAmountCents: event?.fromAmountCents ?? null,
            toAmountCents: event?.toAmountCents ?? null,
            currency: event?.toCurrency ?? event?.currency ?? deal.currency,
            fromOwnerId: event?.fromOwnerId ?? null,
            fromOwnerEmployeeId: event?.fromOwnerEmployeeId ?? null,
            toOwnerId: event?.toOwnerId ?? (candidate.kind === "created" ? deal.ownerId : null),
            toOwnerEmployeeId:
              event?.toOwnerEmployeeId ??
              (candidate.kind === "created" ? deal.ownerEmployeeId : null),
            lostReason: event?.kind === "lost" ? event.lostReason?.trim() || deal.lostReason : "",
            sourceKind: "import",
            sourceKey: candidate.sourceKey,
            sourceActivityId: null,
            metadataJson: JSON.stringify(metadata),
            createdByUserId: actor.userId ?? null,
            createdByEmployeeId: actor.employeeId ?? null,
          }),
        );
        importedEvents.push(saved);
        result.imported += 1;
        operationRows.push({
          resourceType: "deal",
          resourceId: saved.id,
          entityType: "deal_history_event",
          action: "import_history_event",
          before: null,
          after: recordSnapshot(saved),
          detail: `${input.sourceId}:${candidate.sourceId}`,
        });
      }

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (input.originalCreatedAt && input.originalCreatedAt < deal.createdAt) {
        before.createdAt = deal.createdAt;
        after.createdAt = input.originalCreatedAt;
      }
      const latestStageEvent = importedEvents
        .filter((event) => ["stage_changed", "won", "lost"].includes(event.kind))
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0];
      const laterNativeEvent = latestStageEvent
        ? item.existingHistory.some(
            (event) =>
              event.sourceKind !== "import" && event.occurredAt >= latestStageEvent.occurredAt,
          )
        : false;
      if (
        latestStageEvent &&
        (latestStageEvent.kind === "won" || latestStageEvent.kind === "lost") &&
        !laterNativeEvent &&
        deal.status === latestStageEvent.kind &&
        deal.stageId === latestStageEvent.toStageId
      ) {
        if (deal.closedAt?.getTime() !== latestStageEvent.occurredAt.getTime()) {
          before.closedAt = deal.closedAt;
          after.closedAt = latestStageEvent.occurredAt;
        }
        if (
          latestStageEvent.kind === "lost" &&
          latestStageEvent.lostReason &&
          deal.lostReason !== latestStageEvent.lostReason
        ) {
          before.lostReason = deal.lostReason;
          after.lostReason = latestStageEvent.lostReason;
        }
        if (latestStageEvent.kind === "won" && deal.lostReason) {
          before.lostReason = deal.lostReason;
          after.lostReason = "";
        }
      }
      if (Object.keys(after).length > 0) {
        await manager.update(Deal, { companyId, id: deal.id }, after);
        operationRows.push({
          resourceType: "deal",
          resourceId: deal.id,
          entityType: "deal",
          action: "restore_historical_timestamps",
          before,
          after,
        });
      }
      result.status =
        result.imported > 0
          ? result.decisions.some(
              (decision) =>
                decision.status === "rejected" ||
                decision.status === "conflicting" ||
                decision.status === "duplicate",
            )
            ? "partial"
            : "imported"
          : result.skipped > 0
            ? "skipped"
            : "failed";
    }

    const result = summaryFromResults(
      batchKey,
      sourceSystem,
      false,
      prepared.map((row) => row.result),
    );
    const operation = await createRevenueOperation(manager, {
      companyId,
      kind: "history_import",
      resourceType: "deal",
      status:
        result.rejected > 0 || result.conflicting > 0
          ? result.imported > 0
            ? "partial"
            : "failed"
          : "completed",
      idempotencyKey,
      request: operationRequest,
      summary: result,
      actor,
      rows: operationRows,
    });
    result.operationId = operation.id;
    operation.summaryJson = JSON.stringify(result);
    await manager.save(RevenueOperation, operation);
    return result;
  });
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
      toAmountCents: typeof metadata.amountCents === "number" ? metadata.amountCents : null,
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

function importedHistoryCompleteness(
  history: DealHistoryEvent[],
): DealHistoryCompleteness | "missing" {
  const declared = history.flatMap((event) => {
    try {
      const metadata = JSON.parse(event.metadataJson || "{}") as {
        historyImport?: { historyCompleteness?: unknown };
      };
      const value = metadata.historyImport?.historyCompleteness;
      return value === "complete" || value === "partial" || value === "snapshot_only"
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  if (declared.includes("complete")) return "complete";
  if (declared.includes("partial")) return "partial";
  if (declared.includes("snapshot_only") || history.some((event) => event.kind === "snapshot")) {
    return "snapshot_only";
  }
  // Native histories and imports written before completeness was explicit are
  // complete only when their real creation boundary exists.
  if (history.some((event) => event.kind === "created")) return "complete";
  return history.length > 0 ? "partial" : "missing";
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
    snapshotOnlyDeals: number;
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
  let snapshotOnlyDeals = 0;
  let importedDeals = 0;

  for (const deal of activeDeals) {
    const history = byDeal.get(deal.id) ?? [];
    const completeness = importedHistoryCompleteness(history);
    if (completeness === "missing") continue;
    if (history.some((event) => event.sourceKind === "import")) importedDeals += 1;
    if (completeness === "snapshot_only") {
      snapshotOnlyDeals += 1;
      continue;
    }
    const created = history.find((event) => event.kind === "created");
    if (completeness === "complete") {
      completeDeals += 1;
      if (created && created.occurredAt >= from && created.occurredAt < to) {
        cohortDeals.add(deal.id);
      }
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
      } else if (event.kind === "stage_changed" || event.kind === "won" || event.kind === "lost") {
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
      snapshotOnlyDeals,
      withoutHistory: activeDeals.length - completeDeals - partialDeals - snapshotOnlyDeals,
      importedDeals,
    },
  };
}
