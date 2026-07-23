import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { weightedValueCents } from "./dealStage.js";
import {
  computePipelineCoverage,
  computeSalesCycleDays,
  computeStageConversion,
  computeStageFunnel,
  computeWinRate,
  type FunnelDeal,
  type Period,
  type StageLike,
} from "./funnel.js";

// ───────────────────────────── fixtures ─────────────────────────────

let nextId = 0;

/** A plain open deal; override only what the case is about. */
const deal = (over: Partial<FunnelDeal> = {}): FunnelDeal => {
  nextId += 1;
  return {
    id: `d${nextId}`,
    stageId: "s1",
    amountCents: 100_000,
    status: "open",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    closedAt: null,
    probabilityOverride: null,
    ...over,
  };
};

const stage = (
  id: string,
  sortOrder: number,
  over: Partial<StageLike> = {},
): StageLike => ({
  id,
  name: id.toUpperCase(),
  sortOrder,
  probability: 50,
  kind: "open",
  ...over,
});

const at = (iso: string): Date => new Date(iso);

/** Q1 2026: inclusive Jan 1, exclusive Apr 1. */
const Q1: Period = {
  from: at("2026-01-01T00:00:00Z"),
  to: at("2026-04-01T00:00:00Z"),
};

const won = (closedAt: string, over: Partial<FunnelDeal> = {}) =>
  deal({ status: "won", closedAt: at(closedAt), ...over });

const lost = (closedAt: string, over: Partial<FunnelDeal> = {}) =>
  deal({ status: "lost", closedAt: at(closedAt), ...over });

// ───────────────────────────── computeWinRate ─────────────────────────────

describe("computeWinRate", () => {
  test("counts the wins and losses that closed inside the period", () => {
    const r = computeWinRate(
      [
        won("2026-01-15T00:00:00Z"),
        won("2026-02-20T00:00:00Z"),
        won("2026-03-01T00:00:00Z"),
        lost("2026-02-02T00:00:00Z"),
      ],
      Q1,
    );
    assert.equal(r.won, 3);
    assert.equal(r.lost, 1);
    assert.equal(r.winRatePct, 75);
  });

  test("keys on closedAt, not createdAt", () => {
    const r = computeWinRate(
      [
        // Created long before the quarter, closed inside it: counts.
        won("2026-02-01T00:00:00Z", { createdAt: at("2024-06-01T00:00:00Z") }),
        // Created inside the quarter, closed after it: does not.
        won("2026-05-01T00:00:00Z", { createdAt: at("2026-01-05T00:00:00Z") }),
      ],
      Q1,
    );
    assert.equal(r.won, 1);
  });

  test("`from` is inclusive and `to` is exclusive, so quarters tile exactly", () => {
    const onFrom = won("2026-01-01T00:00:00Z");
    const onTo = won("2026-04-01T00:00:00Z");
    const first = computeWinRate([onFrom, onTo], Q1);
    assert.equal(first.won, 1);

    const q2: Period = {
      from: at("2026-04-01T00:00:00Z"),
      to: at("2026-07-01T00:00:00Z"),
    };
    const second = computeWinRate([onFrom, onTo], q2);
    assert.equal(second.won, 1);
    // Neither deal was counted twice, and neither fell through the crack.
    assert.equal(first.won + second.won, 2);
  });

  test("closures before the period are excluded", () => {
    const r = computeWinRate([won("2025-12-31T23:59:59Z")], Q1);
    assert.deepEqual(r, { won: 0, lost: 0, winRatePct: null });
  });

  test("still-open deals are excluded, not counted as losses", () => {
    const r = computeWinRate([deal(), deal(), won("2026-02-01T00:00:00Z")], Q1);
    assert.equal(r.won, 1);
    assert.equal(r.lost, 0);
    assert.equal(r.winRatePct, 100);
  });

  test("a won deal with a null closedAt is excluded", () => {
    const r = computeWinRate([deal({ status: "won", closedAt: null })], Q1);
    assert.deepEqual(r, { won: 0, lost: 0, winRatePct: null });
  });

  test("status is the authority: an open deal carrying a closedAt is ignored", () => {
    // A reopened deal keeps its old close date; it is not a win yet.
    const r = computeWinRate(
      [deal({ status: "open", closedAt: at("2026-02-01T00:00:00Z") })],
      Q1,
    );
    assert.equal(r.won, 0);
    assert.equal(r.lost, 0);
  });

  test("an unparseable closedAt is dropped rather than throwing", () => {
    const r = computeWinRate(
      [won("not-a-date"), won("2026-02-01T00:00:00Z")],
      Q1,
    );
    assert.equal(r.won, 1);
  });

  test("all wins is 100%, all losses is 0% — and 0% is not null", () => {
    assert.equal(computeWinRate([won("2026-02-01T00:00:00Z")], Q1).winRatePct, 100);
    const allLost = computeWinRate([lost("2026-02-01T00:00:00Z")], Q1);
    assert.equal(allLost.winRatePct, 0);
    assert.notEqual(allLost.winRatePct, null);
  });

  test("nothing closed in the period yields null, never a divide-by-zero", () => {
    const r = computeWinRate([won("2027-01-01T00:00:00Z")], Q1);
    assert.equal(r.winRatePct, null);
  });

  test("an empty book is zeros and null", () => {
    assert.deepEqual(computeWinRate([], Q1), { won: 0, lost: 0, winRatePct: null });
  });

  test("rounds to one decimal", () => {
    const r = computeWinRate(
      [
        won("2026-01-02T00:00:00Z"),
        lost("2026-01-03T00:00:00Z"),
        lost("2026-01-04T00:00:00Z"),
      ],
      Q1,
    );
    assert.equal(r.winRatePct, 33.3);
  });

  test("an Invalid Date bound widens the report instead of breaking it", () => {
    const open: Period = { from: at("nonsense"), to: at("2026-04-01T00:00:00Z") };
    const r = computeWinRate([won("1999-05-05T00:00:00Z")], open);
    assert.equal(r.won, 1);
  });
});

// ────────────────────────── computeSalesCycleDays ──────────────────────────

/** Won deal that took exactly `days` from creation to close. */
const cycle = (days: number, createdIso = "2026-01-01T00:00:00Z"): FunnelDeal => {
  const created = at(createdIso);
  return deal({
    status: "won",
    createdAt: created,
    closedAt: new Date(created.getTime() + days * 86_400_000),
  });
};

describe("computeSalesCycleDays", () => {
  test("an odd count takes the middle value", () => {
    assert.equal(computeSalesCycleDays([cycle(30), cycle(10), cycle(20)]), 20);
  });

  test("an even count averages the two middle values", () => {
    assert.equal(
      computeSalesCycleDays([cycle(10), cycle(20), cycle(30), cycle(40)]),
      25,
    );
  });

  test("the median ignores the two-year enterprise deal that would wreck the mean", () => {
    const deals = [cycle(10), cycle(12), cycle(14), cycle(16), cycle(730)];
    // Mean would be 156.4 days — a number nobody could plan against.
    assert.equal(computeSalesCycleDays(deals), 14);
  });

  test("lost and open deals are excluded", () => {
    const deals = [
      cycle(10),
      deal({ status: "lost", createdAt: at("2026-01-01T00:00:00Z"), closedAt: at("2027-01-01T00:00:00Z") }),
      deal({ status: "open" }),
    ];
    assert.equal(computeSalesCycleDays(deals), 10);
  });

  test("a won deal with a null closedAt is excluded", () => {
    const deals = [cycle(10), deal({ status: "won", closedAt: null })];
    assert.equal(computeSalesCycleDays(deals), 10);
  });

  test("an unparseable date on either end drops that deal only", () => {
    const deals = [
      cycle(10),
      deal({ status: "won", closedAt: at("garbage") }),
      deal({ status: "won", createdAt: at("garbage"), closedAt: at("2026-02-01T00:00:00Z") }),
    ];
    assert.equal(computeSalesCycleDays(deals), 10);
  });

  test("the optional period filters on closedAt", () => {
    const inQ1 = cycle(10, "2026-01-05T00:00:00Z");
    const inQ3 = cycle(100, "2026-07-01T00:00:00Z");
    assert.equal(computeSalesCycleDays([inQ1, inQ3]), 55); // no period: both
    assert.equal(computeSalesCycleDays([inQ1, inQ3], Q1), 10);
  });

  test("an omitted period includes everything, including ancient deals", () => {
    assert.equal(computeSalesCycleDays([cycle(5, "1998-01-01T00:00:00Z")]), 5);
  });

  test("a close before the create clamps to zero days rather than dropping the deal", () => {
    // Clock skew or a backdated import: negative is nonsense, but shrinking
    // the sample silently is worse.
    const skewed = deal({
      status: "won",
      createdAt: at("2026-02-10T00:00:00Z"),
      closedAt: at("2026-02-01T00:00:00Z"),
    });
    assert.equal(computeSalesCycleDays([skewed]), 0);
    assert.equal(computeSalesCycleDays([skewed, cycle(10), cycle(20)]), 10);
  });

  test("a single won deal is its own median", () => {
    assert.equal(computeSalesCycleDays([cycle(42)]), 42);
  });

  test("a same-day close is zero, not null", () => {
    const r = computeSalesCycleDays([cycle(0)]);
    assert.equal(r, 0);
    assert.notEqual(r, null);
  });

  test("an empty set is null, never NaN", () => {
    assert.equal(computeSalesCycleDays([]), null);
    assert.equal(computeSalesCycleDays([deal()]), null);
    assert.equal(computeSalesCycleDays([cycle(10)], { from: at("2030-01-01T00:00:00Z"), to: at("2031-01-01T00:00:00Z") }), null);
  });

  test("rounds to one decimal", () => {
    // 10 and 11 days -> 10.5 exactly; 1 and 2 -> 1.5; sub-day parts round.
    assert.equal(computeSalesCycleDays([cycle(10), cycle(11)]), 10.5);
    assert.equal(computeSalesCycleDays([cycle(1 / 3)]), 0.3);
  });

  test("the result is a median, not a mean, even on a two-element set", () => {
    // With [1, 99] both agree; the point is [1, 1, 99] where they do not.
    assert.equal(computeSalesCycleDays([cycle(1), cycle(1), cycle(99)]), 1);
  });
});

// ─────────────────────────── computeStageFunnel ───────────────────────────

const LEAD = stage("lead", 1, { probability: 10 });
const DEMO = stage("demo", 2, { probability: 40 });
const NEGOTIATION = stage("neg", 3, { probability: 80 });

describe("computeStageFunnel", () => {
  test("orders rows by sortOrder regardless of input order", () => {
    const { rows } = computeStageFunnel([], [NEGOTIATION, LEAD, DEMO]);
    assert.deepEqual(rows.map((r) => r.stage.id), ["lead", "demo", "neg"]);
  });

  test("a stage holding nothing still gets a row — an empty column is information", () => {
    const { rows } = computeStageFunnel(
      [deal({ stageId: "lead", amountCents: 5_000 })],
      [LEAD, DEMO, NEGOTIATION],
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.stage.id, r.count, r.valueCents]),
      [["lead", 1, 5_000], ["demo", 0, 0], ["neg", 0, 0]],
    );
  });

  test("counts and values open deals only", () => {
    const { rows } = computeStageFunnel(
      [
        deal({ stageId: "demo", amountCents: 1_000 }),
        deal({ stageId: "demo", amountCents: 2_000 }),
        deal({ stageId: "demo", amountCents: 900_000, status: "won", closedAt: at("2026-02-01T00:00:00Z") }),
        deal({ stageId: "demo", amountCents: 900_000, status: "lost", closedAt: at("2026-02-01T00:00:00Z") }),
      ],
      [DEMO],
    );
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].valueCents, 3_000);
  });

  test("orphan deals are dropped from the rows but surfaced as a count", () => {
    const result = computeStageFunnel(
      [
        deal({ stageId: "lead", amountCents: 1_000 }),
        deal({ stageId: "deleted-stage", amountCents: 999_999 }),
        deal({ stageId: "deleted-stage", amountCents: 999_999 }),
      ],
      [LEAD, DEMO],
    );
    assert.equal(result.orphanedCount, 2);
    assert.equal(result.rows.reduce((sum, r) => sum + r.valueCents, 0), 1_000);
  });

  test("orphan counting is open-only, matching the rows", () => {
    const result = computeStageFunnel(
      [
        deal({ stageId: "ghost", status: "won", closedAt: at("2026-02-01T00:00:00Z") }),
        deal({ stageId: "ghost", status: "open" }),
      ],
      [LEAD],
    );
    assert.equal(result.orphanedCount, 1);
  });

  test("no stages means no rows and every open deal is orphaned", () => {
    const result = computeStageFunnel([deal(), deal()], []);
    assert.deepEqual(result.rows, []);
    assert.equal(result.orphanedCount, 2);
  });

  test("no deals yields a full set of zero rows, not an empty funnel", () => {
    const { rows, orphanedCount } = computeStageFunnel([], [LEAD, DEMO]);
    assert.equal(orphanedCount, 0);
    for (const row of rows) {
      assert.equal(row.count, 0);
      assert.equal(row.valueCents, 0);
      assert.equal(row.weightedValueCents, 0);
    }
  });

  test("ties in sortOrder keep the input order", () => {
    const a = stage("a", 5);
    const b = stage("b", 5);
    const c = stage("c", 5);
    const { rows } = computeStageFunnel([], [c, a, b]);
    assert.deepEqual(rows.map((r) => r.stage.id), ["c", "a", "b"]);
  });

  test("a duplicate stage id feeds the first row and leaves the later one empty", () => {
    const first = stage("dup", 1);
    const second = stage("dup", 2);
    const { rows } = computeStageFunnel(
      [deal({ stageId: "dup", amountCents: 700 })],
      [first, second],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].valueCents, 700);
    assert.equal(rows[1].count, 0);
    assert.equal(rows[1].valueCents, 0);
  });

  test("does not mutate the caller's stages array", () => {
    const stages = [NEGOTIATION, LEAD, DEMO];
    computeStageFunnel([], stages);
    assert.deepEqual(stages.map((s) => s.id), ["neg", "lead", "demo"]);
  });

  test("the row carries the stage object it was built from", () => {
    const { rows } = computeStageFunnel([], [LEAD]);
    assert.equal(rows[0].stage, LEAD);
  });

  test("weighted value is the sum of the per-deal weighting from dealStage", () => {
    const d1 = deal({ stageId: "demo", amountCents: 100_000 });
    const d2 = deal({ stageId: "demo", amountCents: 250_000, probabilityOverride: 90 });
    const { rows } = computeStageFunnel([d1, d2], [DEMO]);
    assert.equal(
      rows[0].weightedValueCents,
      weightedValueCents(d1, DEMO) + weightedValueCents(d2, DEMO),
    );
  });

  test("a zero-probability stage weights to nothing while still counting the deal", () => {
    const dead = stage("dead", 1, { probability: 0 });
    const { rows } = computeStageFunnel(
      [deal({ stageId: "dead", amountCents: 500_000 })],
      [dead],
    );
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].valueCents, 500_000);
    assert.equal(rows[0].weightedValueCents, 0);
  });

  test("a non-finite amount counts as zero without poisoning the column", () => {
    const { rows } = computeStageFunnel(
      [
        deal({ stageId: "lead", amountCents: Number.NaN }),
        deal({ stageId: "lead", amountCents: 4_000 }),
      ],
      [LEAD],
    );
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].valueCents, 4_000);
    assert.ok(Number.isFinite(rows[0].weightedValueCents));
  });

  test("negative amounts pass through — a credited deal is real pipeline movement", () => {
    const { rows } = computeStageFunnel(
      [deal({ stageId: "lead", amountCents: -1_000 }), deal({ stageId: "lead", amountCents: 3_000 })],
      [LEAD],
    );
    assert.equal(rows[0].valueCents, 2_000);
  });
});

// ───────────────────────── computePipelineCoverage ─────────────────────────

describe("computePipelineCoverage", () => {
  test("coverage is a multiple of the target, not a percentage", () => {
    const deals = [
      deal({ stageId: "lead", amountCents: 200_000 }),
      deal({ stageId: "demo", amountCents: 400_000 }),
    ];
    const r = computePipelineCoverage(deals, [LEAD, DEMO], 200_000);
    assert.equal(r.openCents, 600_000);
    assert.equal(r.coverage, 3); // "3x", not 300
  });

  test("weighted coverage uses the dealStage weighting", () => {
    const d1 = deal({ stageId: "lead", amountCents: 200_000 });
    const d2 = deal({ stageId: "neg", amountCents: 400_000 });
    const r = computePipelineCoverage([d1, d2], [LEAD, NEGOTIATION], 100_000);
    const expected = weightedValueCents(d1, LEAD) + weightedValueCents(d2, NEGOTIATION);
    assert.equal(r.weightedCents, expected);
    assert.equal(r.weightedCoverage, Math.round((expected / 100_000) * 100) / 100);
  });

  test("a zero target yields null coverage, not Infinity", () => {
    const r = computePipelineCoverage([deal({ stageId: "lead" })], [LEAD], 0);
    assert.equal(r.coverage, null);
    assert.equal(r.weightedCoverage, null);
    assert.equal(r.openCents, 100_000); // the totals are still reported
  });

  test("a negative target yields null coverage", () => {
    const r = computePipelineCoverage([deal({ stageId: "lead" })], [LEAD], -5_000);
    assert.equal(r.coverage, null);
    assert.equal(r.weightedCoverage, null);
  });

  test("throws on a non-finite target — that is a caller bug, not data", () => {
    assert.throws(() => computePipelineCoverage([], [LEAD], Number.NaN));
    assert.throws(() => computePipelineCoverage([], [LEAD], Infinity));
    assert.throws(() => computePipelineCoverage([], [LEAD], -Infinity));
  });

  test("deals in an unknown stage are skipped from both totals", () => {
    const r = computePipelineCoverage(
      [
        deal({ stageId: "lead", amountCents: 100_000 }),
        deal({ stageId: "ghost", amountCents: 999_999 }),
      ],
      [LEAD],
      100_000,
    );
    assert.equal(r.openCents, 100_000);
    assert.equal(r.coverage, 1);
  });

  test("non-open deals are ignored, so a whole book still reports pipeline", () => {
    const r = computePipelineCoverage(
      [
        deal({ stageId: "lead", amountCents: 100_000 }),
        deal({ stageId: "lead", amountCents: 900_000, status: "won", closedAt: at("2026-02-01T00:00:00Z") }),
        deal({ stageId: "lead", amountCents: 900_000, status: "lost", closedAt: at("2026-02-01T00:00:00Z") }),
      ],
      [LEAD],
      100_000,
    );
    assert.equal(r.openCents, 100_000);
  });

  test("an empty pipeline is zero cents and zero coverage, not null", () => {
    const r = computePipelineCoverage([], [LEAD], 100_000);
    assert.deepEqual(r, {
      openCents: 0,
      weightedCents: 0,
      coverage: 0,
      weightedCoverage: 0,
    });
  });

  test("coverage rounds to two decimals — the second digit of a multiple reads", () => {
    const r = computePipelineCoverage(
      [deal({ stageId: "lead", amountCents: 100_000 })],
      [LEAD],
      30_000,
    );
    assert.equal(r.coverage, 3.33);
  });

  test("a duplicate stage id resolves to the first entry", () => {
    const first = stage("dup", 1, { probability: 0 });
    const second = stage("dup", 2, { probability: 100 });
    const r = computePipelineCoverage(
      [deal({ stageId: "dup", amountCents: 100_000 })],
      [first, second],
      100_000,
    );
    assert.equal(r.weightedCents, weightedValueCents(deal({ stageId: "dup", amountCents: 100_000 }), first));
  });

  test("a non-finite amount counts as zero rather than NaN-ing the coverage", () => {
    const r = computePipelineCoverage(
      [
        deal({ stageId: "lead", amountCents: Number.POSITIVE_INFINITY }),
        deal({ stageId: "lead", amountCents: 50_000 }),
      ],
      [LEAD],
      50_000,
    );
    assert.equal(r.openCents, 50_000);
    assert.equal(r.coverage, 1);
    assert.ok(Number.isFinite(r.weightedCents));
  });
});

// ───────────────────────── computeStageConversion ─────────────────────────

describe("computeStageConversion", () => {
  test("converts between consecutive rows, in order", () => {
    const rows = [
      { stage: LEAD, count: 100 },
      { stage: DEMO, count: 40 },
      { stage: NEGOTIATION, count: 10 },
    ];
    const conv = computeStageConversion(rows);
    assert.equal(conv.length, 2);
    assert.equal(conv[0].fromStage, LEAD);
    assert.equal(conv[0].toStage, DEMO);
    assert.equal(conv[0].conversionPct, 40);
    assert.equal(conv[1].conversionPct, 25);
  });

  test("an empty from-stage yields null, not 0% — 0/0 is undefined", () => {
    const conv = computeStageConversion([
      { stage: LEAD, count: 0 },
      { stage: DEMO, count: 5 },
    ]);
    assert.equal(conv[0].conversionPct, null);
  });

  test("an empty to-stage is a real 0%, not null", () => {
    const conv = computeStageConversion([
      { stage: LEAD, count: 5 },
      { stage: DEMO, count: 0 },
    ]);
    assert.equal(conv[0].conversionPct, 0);
  });

  test("a snapshot ratio above 100% is left uncapped", () => {
    // A late stage can hold more than the one feeding it; clamping hides it.
    const conv = computeStageConversion([
      { stage: LEAD, count: 2 },
      { stage: DEMO, count: 5 },
    ]);
    assert.equal(conv[0].conversionPct, 250);
  });

  test("fewer than two rows yields nothing rather than a self-conversion", () => {
    assert.deepEqual(computeStageConversion([]), []);
    assert.deepEqual(computeStageConversion([{ stage: LEAD, count: 3 }]), []);
  });

  test("rounds to one decimal", () => {
    const conv = computeStageConversion([
      { stage: LEAD, count: 3 },
      { stage: DEMO, count: 1 },
    ]);
    assert.equal(conv[0].conversionPct, 33.3);
  });

  test("consumes computeStageFunnel's rows untouched", () => {
    const { rows } = computeStageFunnel(
      [
        deal({ stageId: "lead" }),
        deal({ stageId: "lead" }),
        deal({ stageId: "demo" }),
      ],
      [DEMO, LEAD],
    );
    const conv = computeStageConversion(rows);
    assert.equal(conv.length, 1);
    assert.equal(conv[0].fromStage.id, "lead");
    assert.equal(conv[0].toStage.id, "demo");
    assert.equal(conv[0].conversionPct, 50);
  });
});

// ─────────────────────────── property invariants ───────────────────────────

describe("computeStageFunnel invariants", () => {
  test("INVARIANT: the rows partition every open deal with a known stage", () => {
    // Deterministic LCG so a failure is reproducible; Math.random would make
    // a red build unrepeatable.
    let seed = 0x1a2b3c4;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pickInt = (n: number) => Math.floor(rand() * n);

    for (let round = 0; round < 400; round += 1) {
      const stages: StageLike[] = [];
      const stageCount = 1 + pickInt(5);
      for (let i = 0; i < stageCount; i += 1) {
        stages.push(stage(`s${i}`, pickInt(10), { probability: pickInt(101) }));
      }
      const stageById = new Map(stages.map((s) => [s.id, s]));

      const deals: FunnelDeal[] = [];
      const dealCount = pickInt(20);
      for (let i = 0; i < dealCount; i += 1) {
        const roll = rand();
        let status: FunnelDeal["status"] = "open";
        if (roll >= 0.7 && roll < 0.85) status = "won";
        if (roll >= 0.85) status = "lost";

        const known = rand() < 0.85;
        const stageId = known ? `s${pickInt(stageCount)}` : `ghost${pickInt(3)}`;

        let override: number | null = null;
        if (rand() < 0.3) override = pickInt(101);

        deals.push(
          deal({
            stageId,
            status,
            amountCents: pickInt(1_000_000) - 100_000, // some negatives
            probabilityOverride: override,
            closedAt: status === "open" ? null : at("2026-02-01T00:00:00Z"),
          }),
        );
      }

      const { rows, orphanedCount } = computeStageFunnel(deals, stages);

      let expectedValue = 0;
      let expectedCount = 0;
      let expectedOrphans = 0;
      let expectedWeighted = 0;
      for (const d of deals) {
        if (d.status !== "open") continue;
        const s = stageById.get(d.stageId);
        if (s === undefined) {
          expectedOrphans += 1;
          continue;
        }
        expectedValue += d.amountCents;
        expectedCount += 1;
        expectedWeighted += weightedValueCents(d, s);
      }

      const sum = (pick: (r: (typeof rows)[number]) => number) =>
        rows.reduce((acc, r) => acc + pick(r), 0);

      assert.equal(rows.length, stages.length, `round ${round}: lost a stage row`);
      assert.equal(
        sum((r) => r.valueCents),
        expectedValue,
        `round ${round}: column values do not sum to the open pipeline`,
      );
      assert.equal(
        sum((r) => r.count),
        expectedCount,
        `round ${round}: column counts do not sum to the open deal count`,
      );
      assert.equal(orphanedCount, expectedOrphans, `round ${round}: orphan count`);
      assert.ok(
        Math.abs(sum((r) => r.weightedValueCents) - expectedWeighted) < 1e-6,
        `round ${round}: weighted columns do not sum to the weighted pipeline`,
      );

      // Rows stay sorted, so computeStageConversion's pairing is meaningful.
      for (let i = 1; i < rows.length; i += 1) {
        assert.ok(
          rows[i - 1].stage.sortOrder <= rows[i].stage.sortOrder,
          `round ${round}: rows out of order`,
        );
      }

      // Coverage over the same deals agrees with the funnel columns.
      const coverage = computePipelineCoverage(deals, stages, 1_000_000);
      assert.equal(
        coverage.openCents,
        expectedValue,
        `round ${round}: coverage disagrees with the funnel`,
      );

      // Conversion always yields exactly one fewer row than the funnel.
      const conv = computeStageConversion(rows);
      assert.equal(conv.length, Math.max(0, rows.length - 1));
    }
  });
});
