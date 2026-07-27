import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealHistoryEvent } from "../../db/entities/DealHistoryEvent.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import { RevenueOperationRow } from "../../db/entities/RevenueOperationRow.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import {
  historicalFunnelMetrics,
  importHistoricalDealEvents,
  type DealHistoryImportDecision,
  type HistoricalDealImport,
  type HistoricalDealImportSummary,
} from "./dealHistory.js";
import { rollbackRevenueOperation } from "./operations.js";
import { getFunnelReport } from "./reports.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

type StageFixtures = {
  fresh: DealStage;
  qualified: DealStage;
  demo: DealStage;
  won: DealStage;
  lost: DealStage;
};

async function stages(companyId: string): Promise<StageFixtures> {
  const rows = await Promise.all([
    insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
      archivedAt: null,
    }),
    insert(DealStage, {
      companyId,
      name: "Qualified",
      slug: "qualified",
      sortOrder: 1,
      probability: 40,
      kind: "open",
      archivedAt: null,
    }),
    insert(DealStage, {
      companyId,
      name: "Demo",
      slug: "demo",
      sortOrder: 2,
      probability: 70,
      kind: "open",
      archivedAt: null,
    }),
    insert(DealStage, {
      companyId,
      name: "Closed Won",
      slug: "closed-won",
      sortOrder: 3,
      probability: 100,
      kind: "won",
      archivedAt: null,
    }),
    insert(DealStage, {
      companyId,
      name: "Closed Lost",
      slug: "closed-lost",
      sortOrder: 4,
      probability: 0,
      kind: "lost",
      archivedAt: null,
    }),
  ]);
  return {
    fresh: rows[0],
    qualified: rows[1],
    demo: rows[2],
    won: rows[3],
    lost: rows[4],
  };
}

async function deal(
  companyId: string,
  stage: DealStage,
  values: Partial<Deal> = {},
): Promise<Deal> {
  return insert(Deal, {
    companyId,
    title: "Imported history fixture",
    stageId: stage.id,
    amountCents: 100_000,
    currency: "USD",
    status: stage.kind,
    closedAt: stage.kind === "open" ? null : new Date("2026-06-01T00:00:00.000Z"),
    lostReason: stage.kind === "lost" ? "Existing reason" : "",
    ownerId: null,
    ownerEmployeeId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...values,
  });
}

function decision(
  summary: HistoricalDealImportSummary,
  sourceId: string,
): DealHistoryImportDecision {
  const found = summary.rows
    .flatMap((row) => row.decisions)
    .find((row) => row.sourceId === sourceId);
  assert.ok(found, `expected a decision for ${sourceId}`);
  return found;
}

function completeWin(
  target: Deal,
  fixture: StageFixtures,
  sourceId = "legacy-deal-1",
): HistoricalDealImport {
  return {
    sourceId,
    dealId: target.id,
    historyCompleteness: "complete",
    originalCreatedAt: new Date("2024-01-01T00:00:00.000Z"),
    initialStageId: fixture.fresh.id,
    events: [
      {
        sourceId: "qualified",
        kind: "stage_changed",
        occurredAt: new Date("2024-01-11T00:00:00.000Z"),
        fromStageId: fixture.fresh.id,
        toStageId: fixture.qualified.id,
      },
      {
        sourceId: "demo",
        kind: "stage_changed",
        occurredAt: new Date("2024-01-21T00:00:00.000Z"),
        fromStageId: fixture.qualified.id,
        toStageId: fixture.demo.id,
      },
      {
        sourceId: "won",
        kind: "won",
        occurredAt: new Date("2024-02-01T00:00:00.000Z"),
        fromStageId: fixture.demo.id,
        toStageId: fixture.won.id,
      },
    ],
  };
}

describe("historical Deal import preview validation", () => {
  test("is non-mutating and reports accepted decisions without creating an operation", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.won);

    const result = await importHistoricalDealEvents(
      companyId,
      "preview-only",
      [completeWin(target, fixture)],
      { userId: randomUUID() },
      { sourceSystem: "legacy crm/production", dryRun: true },
    );

    assert.equal(result.dryRun, true);
    assert.equal(result.accepted, 4);
    assert.equal(result.imported, 0);
    assert.equal(result.rows[0].status, "ready");
    assert.equal(await AppDataSource.getRepository(DealHistoryEvent).count(), 0);
    assert.equal(await AppDataSource.getRepository(RevenueOperation).count(), 0);
    assert.equal(
      (
        await AppDataSource.getRepository(Deal).findOneByOrFail({ id: target.id })
      ).createdAt.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );
  });

  test("requires a creation boundary and every stage exit for complete history", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.qualified, { status: "open" });

    const missingCreation = await importHistoricalDealEvents(
      companyId,
      "missing-created",
      [
        {
          sourceId: "legacy-missing-created",
          dealId: target.id,
          historyCompleteness: "complete",
          initialStageId: fixture.fresh.id,
          events: [
            {
              sourceId: "qualified",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-10T00:00:00.000Z"),
              fromStageId: fixture.fresh.id,
              toStageId: fixture.qualified.id,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.equal(missingCreation.failed, 1);
    assert.match(missingCreation.rows[0].errors.join(" "), /original Deal creation date/);
    assert.equal(decision(missingCreation, "qualified").status, "rejected");

    const missingExit = await importHistoricalDealEvents(
      companyId,
      "missing-exit",
      [
        {
          sourceId: "legacy-missing-exit",
          dealId: target.id,
          historyCompleteness: "complete",
          originalCreatedAt: new Date("2024-01-01T00:00:00.000Z"),
          initialStageId: fixture.fresh.id,
          events: [
            {
              sourceId: "qualified",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-10T00:00:00.000Z"),
              toStageId: fixture.qualified.id,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.equal(decision(missingExit, "created").status, "accepted");
    assert.equal(decision(missingExit, "qualified").status, "rejected");
    assert.match(decision(missingExit, "qualified").reason ?? "", /every exit boundary/);
  });

  test("rejects events before creation and an alleged creation later than the current record", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.qualified);

    const predatesCreation = await importHistoricalDealEvents(
      companyId,
      "predates-creation",
      [
        {
          sourceId: "legacy-predates",
          dealId: target.id,
          historyCompleteness: "complete",
          originalCreatedAt: new Date("2024-02-01T00:00:00.000Z"),
          events: [
            {
              sourceId: "amount",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-31T23:59:59.999Z"),
              fromAmountCents: 10_000,
              toAmountCents: 20_000,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.equal(predatesCreation.accepted, 0);
    assert.match(predatesCreation.rows[0].errors.join(" "), /predates/);

    const futureCreation = await importHistoricalDealEvents(
      companyId,
      "future-creation",
      [
        {
          sourceId: "legacy-future-created",
          dealId: target.id,
          historyCompleteness: "partial",
          originalCreatedAt: new Date("2027-01-01T00:00:00.000Z"),
          events: [],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.equal(futureCreation.failed, 1);
    assert.match(futureCreation.rows[0].errors.join(" "), /cannot be later/);
  });

  test("enforces snapshot-only semantics while accepting a real snapshot marker", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });

    const missingTimestamp = await importHistoricalDealEvents(
      companyId,
      "snapshot-missing-time",
      [
        {
          sourceId: "snapshot-missing-time",
          dealId: target.id,
          historyCompleteness: "snapshot_only",
          events: [],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.equal(missingTimestamp.failed, 1);
    assert.match(missingTimestamp.rows[0].errors.join(" "), /requires snapshotAt/);

    const fabricated = await importHistoricalDealEvents(
      companyId,
      "snapshot-fabricated",
      [
        {
          sourceId: "snapshot-fabricated",
          dealId: target.id,
          historyCompleteness: "snapshot_only",
          snapshotAt: new Date("2026-01-01T00:00:00.000Z"),
          events: [
            {
              sourceId: "invented-stage",
              kind: "stage_changed",
              occurredAt: new Date("2025-12-01T00:00:00.000Z"),
              toStageId: fixture.fresh.id,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.equal(fabricated.accepted, 0);
    assert.match(fabricated.rows[0].errors.join(" "), /cannot include fabricated/);

    const valid = await importHistoricalDealEvents(
      companyId,
      "snapshot-valid",
      [
        {
          sourceId: "snapshot-valid",
          dealId: target.id,
          historyCompleteness: "snapshot_only",
          snapshotAt: new Date("2026-01-01T00:00:00.000Z"),
          events: [],
        },
      ],
      {},
      { sourceSystem: "legacy-crm", dryRun: true },
    );
    assert.equal(valid.accepted, 1);
    assert.equal(decision(valid, "snapshot").kind, "snapshot");
  });

  test("rejects unknown stages, missing destinations, and a broken stage chain", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.demo, { status: "open" });
    const unknownStageId = randomUUID();

    const invalidInitial = await importHistoricalDealEvents(
      companyId,
      "unknown-initial",
      [
        {
          sourceId: "unknown-initial",
          dealId: target.id,
          historyCompleteness: "partial",
          initialStageId: unknownStageId,
          events: [
            {
              sourceId: "qualified",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-10T00:00:00.000Z"),
              fromStageId: fixture.fresh.id,
              toStageId: fixture.qualified.id,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.match(invalidInitial.rows[0].errors.join(" "), /Unknown initial Deal Stage/);

    const invalidEvents = await importHistoricalDealEvents(
      companyId,
      "invalid-stage-events",
      [
        {
          sourceId: "invalid-stage-events",
          dealId: target.id,
          historyCompleteness: "partial",
          initialStageId: fixture.fresh.id,
          events: [
            {
              sourceId: "unknown-from",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
              fromStageId: unknownStageId,
              toStageId: fixture.qualified.id,
            },
            {
              sourceId: "missing-to",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-02T00:00:00.000Z"),
              fromStageId: fixture.fresh.id,
            },
            {
              sourceId: "broken-chain",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-03T00:00:00.000Z"),
              fromStageId: fixture.qualified.id,
              toStageId: fixture.demo.id,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );
    assert.match(decision(invalidEvents, "unknown-from").reason ?? "", /Unknown from/);
    assert.match(decision(invalidEvents, "missing-to").reason ?? "", /destination/);
    assert.match(decision(invalidEvents, "broken-chain").reason ?? "", /Stage chain expected/);
  });

  test("keeps terminal events consistent with destination stage kind and lost reason", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.lost, {
      lostReason: "Current Deal reason must not become imported history",
    });

    const result = await importHistoricalDealEvents(
      companyId,
      "terminal-validation",
      [
        {
          sourceId: "terminal-validation",
          dealId: target.id,
          historyCompleteness: "partial",
          initialStageId: fixture.demo.id,
          events: [
            {
              sourceId: "won-into-open",
              kind: "won",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
              fromStageId: fixture.demo.id,
              toStageId: fixture.qualified.id,
            },
            {
              sourceId: "lost-into-won",
              kind: "lost",
              occurredAt: new Date("2024-01-02T00:00:00.000Z"),
              fromStageId: fixture.demo.id,
              toStageId: fixture.won.id,
              lostReason: "No budget",
            },
            {
              sourceId: "lost-without-reason",
              kind: "lost",
              occurredAt: new Date("2024-01-03T00:00:00.000Z"),
              fromStageId: fixture.demo.id,
              toStageId: fixture.lost.id,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );

    assert.match(decision(result, "won-into-open").reason ?? "", /must enter a won/);
    assert.match(decision(result, "lost-into-won").reason ?? "", /must enter a lost/);
    assert.match(decision(result, "lost-without-reason").reason ?? "", /requires a lost reason/);
  });

  test("requires meaningful amount, owner, and expected-close boundaries", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });

    const result = await importHistoricalDealEvents(
      companyId,
      "typed-boundaries",
      [
        {
          sourceId: "typed-boundaries",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "empty-amount",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
            },
            {
              sourceId: "negative-amount",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-02T00:00:00.000Z"),
              fromAmountCents: -1,
              toAmountCents: 10,
            },
            {
              sourceId: "invalid-currency",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-03T00:00:00.000Z"),
              fromCurrency: "US",
              toCurrency: "USD",
            },
            {
              sourceId: "empty-owner",
              kind: "owner_changed",
              occurredAt: new Date("2024-01-04T00:00:00.000Z"),
            },
            {
              sourceId: "dual-owner",
              kind: "owner_changed",
              occurredAt: new Date("2024-01-05T00:00:00.000Z"),
              toOwnerId: randomUUID(),
              toOwnerEmployeeId: randomUUID(),
            },
            {
              sourceId: "empty-close",
              kind: "expected_close_changed",
              occurredAt: new Date("2024-01-06T00:00:00.000Z"),
            },
            {
              sourceId: "clear-close",
              kind: "expected_close_changed",
              occurredAt: new Date("2024-01-07T00:00:00.000Z"),
              fromExpectedCloseDate: new Date("2024-03-01T00:00:00.000Z"),
              toExpectedCloseDate: null,
            },
          ],
        },
      ],
      {},
      { dryRun: true },
    );

    assert.match(decision(result, "empty-amount").reason ?? "", /amount or currency boundary/);
    assert.match(decision(result, "negative-amount").reason ?? "", /invalid amount/);
    assert.match(decision(result, "invalid-currency").reason ?? "", /invalid currency/);
    assert.match(decision(result, "empty-owner").reason ?? "", /before or after owner/);
    assert.match(decision(result, "dual-owner").reason ?? "", /both owner types/);
    assert.match(decision(result, "empty-close").reason ?? "", /before or after date/);
    assert.equal(decision(result, "clear-close").status, "accepted");
  });

  test("refuses every effective historical event at or after the first native event", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.qualified, { status: "open" });
    await insert(DealHistoryEvent, {
      companyId,
      dealId: target.id,
      kind: "stage_changed",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      fromStageId: fixture.fresh.id,
      toStageId: fixture.qualified.id,
      sourceKind: "live",
      sourceKey: "live:first-native",
    });

    const result = await importHistoricalDealEvents(
      companyId,
      "native-boundary",
      [
        {
          sourceId: "native-boundary-created",
          dealId: target.id,
          historyCompleteness: "partial",
          originalCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
          events: [],
        },
        {
          sourceId: "native-boundary-events",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "before-native",
              kind: "amount_changed",
              occurredAt: new Date("2024-12-31T23:59:59.999Z"),
              fromAmountCents: 90_000,
              toAmountCents: 100_000,
            },
            {
              sourceId: "after-native",
              kind: "amount_changed",
              occurredAt: new Date("2025-01-02T00:00:00.000Z"),
              fromAmountCents: 100_000,
              toAmountCents: 110_000,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm", dryRun: true },
    );

    assert.equal(decision(result, "before-native").status, "accepted");
    assert.equal(decision(result, "created").status, "conflicting");
    assert.equal(decision(result, "after-native").status, "conflicting");
    assert.match(decision(result, "created").reason ?? "", /overlaps native history/);
  });

  test("sorts by effective time, marks moved inputs, and derives creation stage from that order", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.demo, { status: "open" });

    const result = await importHistoricalDealEvents(
      companyId,
      "reordered-history",
      [
        {
          sourceId: "reordered-history",
          dealId: target.id,
          historyCompleteness: "complete",
          originalCreatedAt: new Date("2024-01-01T00:00:00.000Z"),
          events: [
            {
              sourceId: "demo",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-21T00:00:00.000Z"),
              fromStageId: fixture.qualified.id,
              toStageId: fixture.demo.id,
            },
            {
              sourceId: "qualified",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-11T00:00:00.000Z"),
              fromStageId: fixture.fresh.id,
              toStageId: fixture.qualified.id,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );

    assert.equal(result.reordered, 2);
    assert.equal(result.imported, 3);
    const history = await AppDataSource.getRepository(DealHistoryEvent).find({
      where: { companyId, dealId: target.id },
      order: { occurredAt: "ASC" },
    });
    assert.equal(history[0].kind, "created");
    assert.equal(history[0].toStageId, fixture.fresh.id);
    assert.deepEqual(
      history.map((event) => event.kind),
      ["created", "stage_changed", "stage_changed"],
    );
  });

  test("classifies duplicate source identities inside one request without double-writing", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const repeatedRow: HistoricalDealImport = {
      sourceId: "same-source-record",
      dealId: target.id,
      historyCompleteness: "partial",
      events: [
        {
          sourceId: "same-event",
          kind: "amount_changed",
          occurredAt: new Date("2024-01-01T00:00:00.000Z"),
          fromAmountCents: 90_000,
          toAmountCents: 100_000,
          currency: "USD",
        },
      ],
    };

    const result = await importHistoricalDealEvents(
      companyId,
      "duplicates-in-request",
      [repeatedRow, repeatedRow],
      {},
      { sourceSystem: "legacy-crm" },
    );

    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.skipped, 1);
    assert.equal(await AppDataSource.getRepository(DealHistoryEvent).count(), 1);
  });
});

describe("historical Deal import identity and provenance", () => {
  test("deduplicates the same source event across batch keys, even after mutable Deal fields change", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const originalOwner = randomUUID();
    const target = await deal(companyId, fixture.qualified, {
      status: "open",
      ownerId: originalOwner,
    });
    const row: HistoricalDealImport = {
      sourceId: "legacy-stable-id",
      dealId: target.id,
      historyCompleteness: "complete",
      originalCreatedAt: new Date("2024-01-01T00:00:00.000Z"),
      initialStageId: fixture.fresh.id,
      events: [
        {
          sourceId: "qualified",
          kind: "stage_changed",
          occurredAt: new Date("2024-01-10T00:00:00.000Z"),
          fromStageId: fixture.fresh.id,
          toStageId: fixture.qualified.id,
        },
      ],
    };
    await importHistoricalDealEvents(
      companyId,
      "stable-id-first",
      [row],
      {},
      { sourceSystem: "legacy/crm" },
    );
    await AppDataSource.getRepository(Deal).update(
      { id: target.id },
      { currency: "EUR", ownerId: randomUUID() },
    );

    const duplicate = await importHistoricalDealEvents(
      companyId,
      "stable-id-second",
      [row],
      {},
      { sourceSystem: "legacy/crm" },
    );

    assert.equal(duplicate.imported, 0);
    assert.equal(duplicate.duplicates, 2);
    assert.equal(duplicate.conflicting, 0);
    assert.equal(await AppDataSource.getRepository(DealHistoryEvent).count(), 2);
  });

  test("marks a reused source event ID with different semantic data as conflicting", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const base: HistoricalDealImport = {
      sourceId: "legacy-conflict",
      dealId: target.id,
      historyCompleteness: "partial",
      events: [
        {
          sourceId: "amount",
          kind: "amount_changed",
          occurredAt: new Date("2024-01-01T00:00:00.000Z"),
          fromAmountCents: 50_000,
          toAmountCents: 100_000,
          toCurrency: "USD",
        },
      ],
    };
    await importHistoricalDealEvents(
      companyId,
      "conflict-first",
      [base],
      {},
      { sourceSystem: "legacy-crm" },
    );

    const conflict = await importHistoricalDealEvents(
      companyId,
      "conflict-second",
      [
        {
          ...base,
          events: [{ ...base.events[0], toAmountCents: 125_000 }],
        },
      ],
      {},
      { sourceSystem: "legacy-crm", dryRun: true },
    );

    assert.equal(conflict.conflicting, 1);
    assert.equal(conflict.duplicates, 0);
    assert.match(decision(conflict, "amount").reason ?? "", /different data/);
  });

  test("replays an identical committed batch and rejects batch-key reuse with another request", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const row: HistoricalDealImport = {
      sourceId: "legacy-idempotency",
      dealId: target.id,
      historyCompleteness: "partial",
      events: [
        {
          sourceId: "amount",
          kind: "amount_changed",
          occurredAt: new Date("2024-01-01T00:00:00.000Z"),
          fromAmountCents: 50_000,
          toAmountCents: 100_000,
        },
      ],
    };
    const first = await importHistoricalDealEvents(
      companyId,
      "fixed-batch-key",
      [row],
      {},
      { sourceSystem: "legacy-crm" },
    );
    const replay = await importHistoricalDealEvents(
      companyId,
      "fixed-batch-key",
      [row],
      {},
      { sourceSystem: "legacy-crm" },
    );

    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, first.operationId);
    assert.equal(replay.imported, 0);
    assert.equal(replay.duplicates, 1);

    await assert.rejects(
      () =>
        importHistoricalDealEvents(
          companyId,
          "fixed-batch-key",
          [{ ...row, sourceId: "different-record" }],
          {},
          { sourceSystem: "legacy-crm" },
        ),
      /batch key was already used for different data/,
    );
  });

  test("persists typed boundaries, caller metadata, actor, and full source provenance", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const memberId = randomUUID();
    const employeeId = randomUUID();
    const nextOwnerId = randomUUID();

    const result = await importHistoricalDealEvents(
      companyId,
      "provenance-batch",
      [
        {
          sourceId: "record / with spaces",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "amount/1",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
              fromAmountCents: 90_000,
              toAmountCents: 100_000,
              fromCurrency: "EUR",
              toCurrency: "USD",
              sourceActor: "Jamie in legacy CRM",
              metadata: { sourceLine: 17, verified: true },
            },
            {
              sourceId: "owner-1",
              kind: "owner_changed",
              occurredAt: new Date("2024-01-02T00:00:00.000Z"),
              fromOwnerId: null,
              toOwnerId: nextOwnerId,
            },
            {
              sourceId: "close-1",
              kind: "expected_close_changed",
              occurredAt: new Date("2024-01-03T00:00:00.000Z"),
              fromExpectedCloseDate: new Date("2024-03-01T00:00:00.000Z"),
              toExpectedCloseDate: new Date("2024-04-01T00:00:00.000Z"),
            },
          ],
        },
      ],
      { userId: memberId, employeeId },
      { sourceSystem: "legacy crm/production" },
    );

    assert.equal(result.imported, 3);
    const rows = await AppDataSource.getRepository(DealHistoryEvent).find({
      where: { companyId, dealId: target.id },
      order: { occurredAt: "ASC" },
    });
    assert.equal(
      rows[0].sourceKey,
      "history:legacy%20crm%2Fproduction:record%20%2F%20with%20spaces:amount%2F1",
    );
    assert.equal(rows[0].currency, "USD");
    assert.equal(rows[0].createdByUserId, memberId);
    assert.equal(rows[0].createdByEmployeeId, employeeId);
    assert.equal(rows[1].toOwnerId, nextOwnerId);
    const amountMetadata = JSON.parse(rows[0].metadataJson) as Record<string, unknown> & {
      historyImport: Record<string, unknown>;
    };
    assert.equal(amountMetadata.sourceLine, 17);
    assert.equal(amountMetadata.verified, true);
    assert.equal(amountMetadata.fromCurrency, "EUR");
    assert.equal(amountMetadata.toCurrency, "USD");
    assert.equal(amountMetadata.historyImport.batchKey, "provenance-batch");
    assert.equal(amountMetadata.historyImport.sourceSystem, "legacy crm/production");
    assert.equal(amountMetadata.historyImport.sourceRecordId, "record / with spaces");
    assert.equal(amountMetadata.historyImport.sourceEventId, "amount/1");
    assert.equal(amountMetadata.historyImport.sourceActor, "Jamie in legacy CRM");
    assert.equal(amountMetadata.historyImport.historyCompleteness, "partial");
    assert.equal(typeof amountMetadata.historyImport.fingerprint, "string");
    assert.equal(typeof amountMetadata.historyImport.importedAt, "string");
    const closeMetadata = JSON.parse(rows[2].metadataJson) as Record<string, unknown>;
    assert.equal(closeMetadata.fromExpectedCloseDate, "2024-03-01T00:00:00.000Z");
    assert.equal(closeMetadata.toExpectedCloseDate, "2024-04-01T00:00:00.000Z");
  });

  test("scopes the same external source identity independently per company", async () => {
    const firstCompanyId = testCompanyId();
    const secondCompanyId = testCompanyId();
    const firstStages = await stages(firstCompanyId);
    const secondStages = await stages(secondCompanyId);
    const firstDeal = await deal(firstCompanyId, firstStages.fresh, { status: "open" });
    const secondDeal = await deal(secondCompanyId, secondStages.fresh, { status: "open" });

    for (const [companyId, target] of [
      [firstCompanyId, firstDeal],
      [secondCompanyId, secondDeal],
    ] as const) {
      const result = await importHistoricalDealEvents(
        companyId,
        "same-batch",
        [
          {
            sourceId: "same-record",
            dealId: target.id,
            historyCompleteness: "partial",
            events: [
              {
                sourceId: "same-event",
                kind: "amount_changed",
                occurredAt: new Date("2024-01-01T00:00:00.000Z"),
                fromAmountCents: 1,
                toAmountCents: 2,
              },
            ],
          },
        ],
        {},
        { sourceSystem: "same-system" },
      );
      assert.equal(result.imported, 1);
    }

    assert.equal(await AppDataSource.getRepository(DealHistoryEvent).count(), 2);
    assert.equal(await AppDataSource.getRepository(RevenueOperation).count(), 2);
  });
});

describe("historical Deal import state reconciliation and guarded undo", () => {
  test("restores an actual lost date and reason only when the current terminal state agrees", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.lost, {
      status: "lost",
      closedAt: new Date("2026-06-01T00:00:00.000Z"),
      lostReason: "Migrated placeholder",
    });

    const result = await importHistoricalDealEvents(
      companyId,
      "lost-reconciliation",
      [
        {
          sourceId: "legacy-lost",
          dealId: target.id,
          historyCompleteness: "partial",
          initialStageId: fixture.demo.id,
          events: [
            {
              sourceId: "lost",
              kind: "lost",
              occurredAt: new Date("2024-02-15T00:00:00.000Z"),
              fromStageId: fixture.demo.id,
              toStageId: fixture.lost.id,
              lostReason: "Security requirements",
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );

    const reconciled = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: target.id });
    assert.equal(reconciled.closedAt?.toISOString(), "2024-02-15T00:00:00.000Z");
    assert.equal(reconciled.lostReason, "Security requirements");

    await rollbackRevenueOperation(companyId, result.operationId!);
    const restored = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: target.id });
    assert.equal(restored.closedAt?.toISOString(), "2026-06-01T00:00:00.000Z");
    assert.equal(restored.lostReason, "Migrated placeholder");
  });

  test("does not rewrite close fields when current status or stage disagrees with history", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.demo, {
      status: "open",
      closedAt: null,
      lostReason: "",
    });

    const result = await importHistoricalDealEvents(
      companyId,
      "terminal-mismatch",
      [
        {
          sourceId: "terminal-mismatch",
          dealId: target.id,
          historyCompleteness: "partial",
          initialStageId: fixture.demo.id,
          events: [
            {
              sourceId: "won",
              kind: "won",
              occurredAt: new Date("2024-02-15T00:00:00.000Z"),
              fromStageId: fixture.demo.id,
              toStageId: fixture.won.id,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );

    assert.equal(result.imported, 1);
    const unchanged = await AppDataSource.getRepository(Deal).findOneByOrFail({ id: target.id });
    assert.equal(unchanged.status, "open");
    assert.equal(unchanged.stageId, fixture.demo.id);
    assert.equal(unchanged.closedAt, null);
    const operationRows = await AppDataSource.getRepository(RevenueOperationRow).find({
      where: { operationId: result.operationId },
    });
    assert.equal(operationRows.filter((row) => row.entityType === "deal").length, 0);
  });

  test("commits valid events from a partial batch and rolls back only those writes", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const native = await insert(DealHistoryEvent, {
      companyId,
      dealId: target.id,
      kind: "amount_changed",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      fromAmountCents: 100_000,
      toAmountCents: 110_000,
      currency: "USD",
      sourceKind: "live",
      sourceKey: "live:amount",
    });

    const result = await importHistoricalDealEvents(
      companyId,
      "partially-valid-batch",
      [
        {
          sourceId: "partially-valid",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "accepted",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
              fromAmountCents: 90_000,
              toAmountCents: 100_000,
            },
            {
              sourceId: "conflict",
              kind: "amount_changed",
              occurredAt: new Date("2025-02-01T00:00:00.000Z"),
              fromAmountCents: 110_000,
              toAmountCents: 120_000,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );

    assert.equal(result.imported, 1);
    assert.equal(result.conflicting, 1);
    assert.equal(
      (
        await AppDataSource.getRepository(RevenueOperation).findOneByOrFail({
          id: result.operationId,
        })
      ).status,
      "partial",
    );
    await rollbackRevenueOperation(companyId, result.operationId!);
    const remaining = await AppDataSource.getRepository(DealHistoryEvent).find({
      where: { companyId, dealId: target.id },
    });
    assert.deepEqual(
      remaining.map((event) => event.id),
      [native.id],
    );
  });

  test("undo preserves events from other imports and is idempotent", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const first = await importHistoricalDealEvents(
      companyId,
      "preserve-first",
      [
        {
          sourceId: "first-record",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "first-event",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
              fromAmountCents: 50_000,
              toAmountCents: 75_000,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );
    const second = await importHistoricalDealEvents(
      companyId,
      "preserve-second",
      [
        {
          sourceId: "second-record",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "second-event",
              kind: "amount_changed",
              occurredAt: new Date("2024-02-01T00:00:00.000Z"),
              fromAmountCents: 75_000,
              toAmountCents: 100_000,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );

    const undone = await rollbackRevenueOperation(companyId, second.operationId!);
    assert.equal(undone.rolledBack, 1);
    const replayedUndo = await rollbackRevenueOperation(companyId, second.operationId!);
    assert.equal(replayedUndo.rolledBack, 1);
    const remaining = await AppDataSource.getRepository(DealHistoryEvent).find({
      where: { companyId, dealId: target.id },
    });
    assert.equal(remaining.length, 1);
    assert.match(remaining[0].sourceKey, /first-record/);
    assert.ok(first.operationId);
  });

  test("undo refuses atomically when an imported event changed after the batch", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.fresh, { status: "open" });
    const result = await importHistoricalDealEvents(
      companyId,
      "event-conflict-undo",
      [
        {
          sourceId: "event-conflict-undo",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceId: "amount",
              kind: "amount_changed",
              occurredAt: new Date("2024-01-01T00:00:00.000Z"),
              fromAmountCents: 50_000,
              toAmountCents: 100_000,
              toCurrency: "USD",
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );
    const imported = await AppDataSource.getRepository(DealHistoryEvent).findOneByOrFail({
      companyId,
      sourceKind: "import",
    });
    await AppDataSource.getRepository(DealHistoryEvent).update(
      { id: imported.id },
      { currency: "EUR" },
    );

    await assert.rejects(
      () => rollbackRevenueOperation(companyId, result.operationId!),
      /Rollback blocked.*changed after the operation/,
    );
    assert.equal(await AppDataSource.getRepository(DealHistoryEvent).count(), 1);
    assert.equal(
      (
        await AppDataSource.getRepository(RevenueOperation).findOneByOrFail({
          id: result.operationId,
        })
      ).status,
      "completed",
    );
  });

  test("undo refuses atomically when a reconciled Deal field changed later", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.won, {
      status: "won",
      closedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const result = await importHistoricalDealEvents(
      companyId,
      "deal-conflict-undo",
      [completeWin(target, fixture, "deal-conflict-undo")],
      {},
      { sourceSystem: "legacy-crm" },
    );
    await AppDataSource.getRepository(Deal).update(
      { id: target.id },
      { closedAt: new Date("2025-01-01T00:00:00.000Z") },
    );

    await assert.rejects(
      () => rollbackRevenueOperation(companyId, result.operationId!),
      /Rollback blocked.*changed after the operation/,
    );
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({
        where: { companyId, dealId: target.id },
      }),
      4,
    );
    assert.equal(
      (
        await AppDataSource.getRepository(Deal).findOneByOrFail({ id: target.id })
      ).createdAt.toISOString(),
      "2024-01-01T00:00:00.000Z",
    );
  });
});

describe("historical Deal reporting semantics", () => {
  test("computes exact cohort conversion, time in stage, outcomes, and sales cycle from imported dates", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.won, {
      status: "won",
      closedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await importHistoricalDealEvents(
      companyId,
      "report-complete",
      [completeWin(target, fixture, "report-complete")],
      {},
      { sourceSystem: "legacy-crm" },
    );

    const metrics = await historicalFunnelMetrics(
      companyId,
      new Date("2024-01-01T00:00:00.000Z"),
      new Date("2024-03-01T00:00:00.000Z"),
      Object.values(fixture),
    );

    assert.deepEqual(
      metrics.stagePerformance.map((row) => ({
        stage: row.stage.name,
        entered: row.enteredDuringPeriod,
        progressed: row.progressedDuringPeriod,
        medianDays: row.medianTimeInStageDays,
      })),
      [
        { stage: "New", entered: 1, progressed: 1, medianDays: 10 },
        { stage: "Qualified", entered: 1, progressed: 1, medianDays: 10 },
        { stage: "Demo", entered: 1, progressed: 1, medianDays: 11 },
        { stage: "Closed Won", entered: 1, progressed: 0, medianDays: null },
        { stage: "Closed Lost", entered: 0, progressed: 0, medianDays: null },
      ],
    );
    assert.deepEqual(
      metrics.conversion.map((row) => ({
        from: row.fromStage.name,
        to: row.toStage.name,
        entered: row.cohortEntered,
        progressed: row.cohortProgressed,
        pct: row.conversionPct,
      })),
      [
        { from: "New", to: "Qualified", entered: 1, progressed: 1, pct: 100 },
        { from: "Qualified", to: "Demo", entered: 1, progressed: 1, pct: 100 },
        { from: "Demo", to: "Closed Won", entered: 1, progressed: 1, pct: 100 },
      ],
    );
    assert.deepEqual(metrics.outcomes, { won: 1, lost: 0, winRatePct: 100 });
    assert.equal(metrics.salesCycleDays, 31);
    assert.deepEqual(metrics.historyCoverage, {
      eligibleDeals: 1,
      completeDeals: 1,
      partialDeals: 0,
      snapshotOnlyDeals: 0,
      withoutHistory: 0,
      importedDeals: 1,
    });
  });

  test("uses partial history only for known boundaries and excludes snapshots from transitions", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const partialDeal = await deal(companyId, fixture.demo, { status: "open" });
    const snapshotDeal = await deal(companyId, fixture.qualified, {
      title: "Snapshot current total",
      status: "open",
      amountCents: 250_000,
    });
    await deal(companyId, fixture.fresh, {
      title: "No history",
      status: "open",
      amountCents: 50_000,
    });
    await importHistoricalDealEvents(
      companyId,
      "report-partial",
      [
        {
          sourceId: "report-partial",
          dealId: partialDeal.id,
          historyCompleteness: "partial",
          initialStageId: fixture.fresh.id,
          events: [
            {
              sourceId: "qualified",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-10T00:00:00.000Z"),
              fromStageId: fixture.fresh.id,
              toStageId: fixture.qualified.id,
            },
            {
              sourceId: "demo",
              kind: "stage_changed",
              occurredAt: new Date("2024-01-15T00:00:00.000Z"),
              fromStageId: fixture.qualified.id,
              toStageId: fixture.demo.id,
            },
          ],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );
    await importHistoricalDealEvents(
      companyId,
      "report-snapshot",
      [
        {
          sourceId: "report-snapshot",
          dealId: snapshotDeal.id,
          historyCompleteness: "snapshot_only",
          snapshotAt: new Date("2024-01-12T00:00:00.000Z"),
          events: [],
        },
      ],
      {},
      { sourceSystem: "legacy-crm" },
    );

    const from = new Date("2024-01-01T00:00:00.000Z");
    const to = new Date("2027-01-01T00:00:00.000Z");
    const metrics = await historicalFunnelMetrics(companyId, from, to, Object.values(fixture));
    assert.equal(metrics.historyCoverage.completeDeals, 0);
    assert.equal(metrics.historyCoverage.partialDeals, 1);
    assert.equal(metrics.historyCoverage.snapshotOnlyDeals, 1);
    assert.equal(metrics.historyCoverage.withoutHistory, 1);
    assert.ok(metrics.conversion.every((row) => row.cohortEntered === 0));
    assert.equal(
      metrics.stagePerformance.find((row) => row.stage.id === fixture.qualified.id)
        ?.enteredDuringPeriod,
      1,
    );
    assert.equal(
      metrics.stagePerformance.find((row) => row.stage.id === fixture.qualified.id)
        ?.medianTimeInStageDays,
      5,
    );

    const report = await getFunnelReport(companyId, { from, to });
    const snapshotStage = report.stages.find((row) => row.stage.id === fixture.qualified.id);
    assert.equal(snapshotStage?.count, 1);
    assert.equal(snapshotStage?.valueCents, 250_000);
  });

  test("treats native history with a real creation event as complete for backward compatibility", async () => {
    const companyId = testCompanyId();
    const fixture = await stages(companyId);
    const target = await deal(companyId, fixture.qualified, {
      status: "open",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    await insert(DealHistoryEvent, {
      companyId,
      dealId: target.id,
      kind: "created",
      occurredAt: new Date("2024-01-01T00:00:00.000Z"),
      toStageId: fixture.fresh.id,
      sourceKind: "live",
      sourceKey: "live:created",
    });
    await insert(DealHistoryEvent, {
      companyId,
      dealId: target.id,
      kind: "stage_changed",
      occurredAt: new Date("2024-01-10T00:00:00.000Z"),
      fromStageId: fixture.fresh.id,
      toStageId: fixture.qualified.id,
      sourceKind: "live",
      sourceKey: "live:qualified",
    });

    const metrics = await historicalFunnelMetrics(
      companyId,
      new Date("2024-01-01T00:00:00.000Z"),
      new Date("2024-02-01T00:00:00.000Z"),
      Object.values(fixture),
    );
    assert.equal(metrics.historyCoverage.completeDeals, 1);
    assert.equal(metrics.historyCoverage.importedDeals, 0);
    assert.equal(metrics.conversion[0].cohortEntered, 1);
    assert.equal(metrics.conversion[0].cohortProgressed, 1);
  });
});
