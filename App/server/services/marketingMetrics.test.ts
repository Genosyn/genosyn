import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { MarketingCampaignPolicy, MarketingReadout } from "./marketingMetrics.js";
import {
  campaignMetrics,
  deriveMetrics,
  liveReadouts,
  normalizeMetricKey,
  readoutsInWindow,
  resolveSuccessMetric,
  targetStatus,
  totalReadouts,
} from "./marketingMetrics.js";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function day(offsetDays: number): string {
  return new Date(NOW.getTime() - offsetDays * 86_400_000).toISOString();
}

function readout(partial: Partial<MarketingReadout> = {}): MarketingReadout {
  return {
    periodStart: new Date(day(2)),
    periodEnd: new Date(day(1)),
    spendMinor: 10_000,
    impressions: 100_000,
    clicks: 2_000,
    conversions: "40",
    conversionValue: "1200",
    supersededAt: null,
    ...partial,
  } as MarketingReadout;
}

function policy(partial: Partial<MarketingCampaignPolicy> = {}): MarketingCampaignPolicy {
  return {
    status: "active",
    currency: "USD",
    successMetric: "cpa",
    targetValue: "2",
    targetDirection: "at_most",
    dailyBudgetMinor: 10_000,
    ...partial,
  };
}

describe("Marketing success metrics", () => {
  test("resolves the spellings a company actually types", () => {
    assert.equal(normalizeMetricKey("  Qualified Leads! "), "qualified_leads");
    assert.equal(resolveSuccessMetric("Qualified Leads")?.key, "conversions");
    assert.equal(resolveSuccessMetric("cost-per-acquisition")?.key, "cpa");
    assert.equal(resolveSuccessMetric("ROAS")?.key, "roas");
    assert.equal(resolveSuccessMetric("brand lift among founders"), null);
  });

  test("each metric knows which way is good", () => {
    assert.equal(resolveSuccessMetric("cpa")?.betterDirection, "at_most");
    assert.equal(resolveSuccessMetric("roas")?.betterDirection, "at_least");
    assert.equal(resolveSuccessMetric("spend")?.betterDirection, "at_most");
  });
});

describe("Marketing totals", () => {
  test("counts a restated readout once and drops the superseded row", () => {
    const rows = [
      readout({ spendMinor: 9_000, supersededAt: new Date(day(1)) }),
      readout({ spendMinor: 10_000 }),
    ];
    assert.equal(liveReadouts(rows).length, 1);
    assert.equal(totalReadouts(liveReadouts(rows)).spendMinor, 10_000);
  });

  test("converts conversion value from whole currency into minor units", () => {
    const totals = totalReadouts([readout({ spendMinor: 10_000, conversionValue: "1200.50" })]);
    assert.equal(totals.conversionValueMinor, 120_050);
    assert.equal(deriveMetrics(totals).roas, 12.005);
  });

  test("counts a day covered by two overlapping readouts once", () => {
    const totals = totalReadouts([
      readout({ periodStart: new Date(day(4)), periodEnd: new Date(day(2)) }),
      readout({ periodStart: new Date(day(3)), periodEnd: new Date(day(1)) }),
    ]);
    assert.equal(totals.coveredDays, 3);
  });

  test("only measures readouts inside the window", () => {
    const rows = [
      readout({ periodStart: new Date(day(2)), periodEnd: new Date(day(1)) }),
      readout({ periodStart: new Date(day(100)), periodEnd: new Date(day(99)) }),
    ];
    assert.equal(readoutsInWindow(rows, 30, NOW).length, 1);
  });
});

describe("Marketing derived metrics", () => {
  test("computes the rates an optimization decision is made from", () => {
    const derived = deriveMetrics(
      totalReadouts([
        readout({
          periodStart: new Date(day(2)),
          periodEnd: new Date(day(1)),
          spendMinor: 20_000,
          impressions: 100_000,
          clicks: 2_000,
          conversions: "50",
          conversionValue: "1000",
        }),
      ]),
    );
    assert.equal(derived.ctr, 0.02);
    assert.equal(derived.conversionRate, 0.025);
    assert.equal(derived.cpcMinor, 10);
    assert.equal(derived.cpmMinor, 200);
    assert.equal(derived.cpaMinor, 400);
    assert.equal(derived.roas, 5);
    assert.equal(derived.avgDailySpendMinor, 20_000);
  });

  test("returns null rather than dividing by zero", () => {
    const derived = deriveMetrics(
      totalReadouts([
        readout({ spendMinor: 0, impressions: 0, clicks: 0, conversions: "0", conversionValue: "0" }),
      ]),
    );
    assert.deepEqual(
      [derived.ctr, derived.cpcMinor, derived.cpaMinor, derived.cpmMinor, derived.roas],
      [null, null, null, null, null],
    );
  });
});

describe("Marketing target attainment", () => {
  test("judges a cost target in whole currency, not in cents", () => {
    const totals = totalReadouts([readout({ spendMinor: 40_000, conversions: "100" })]);
    // 400 minor units per conversion is USD 4.00 against a USD 5.00 ceiling.
    const met = targetStatus(
      policy({ successMetric: "cpa", targetValue: "5", targetDirection: "at_most" }),
      totals,
      deriveMetrics(totals),
    );
    assert.equal(met.actualValue, 4);
    assert.equal(met.state, "on_target");

    const missed = targetStatus(
      policy({ successMetric: "cpa", targetValue: "3", targetDirection: "at_most" }),
      totals,
      deriveMetrics(totals),
    );
    assert.equal(missed.state, "off_target");
  });

  test("judges a rate target as a percentage", () => {
    const totals = totalReadouts([readout({ impressions: 100_000, clicks: 2_000 })]);
    const status = targetStatus(
      policy({ successMetric: "ctr", targetValue: "1.5", targetDirection: "at_least" }),
      totals,
      deriveMetrics(totals),
    );
    assert.equal(status.unit, "percent");
    assert.equal(status.actualValue, 2);
    assert.equal(status.state, "on_target");
  });

  test("says so instead of guessing when it cannot judge", () => {
    const totals = totalReadouts([readout()]);
    const derived = deriveMetrics(totals);
    assert.equal(
      targetStatus(policy({ successMetric: "brand lift", targetValue: "10" }), totals, derived)
        .state,
      "not_comparable",
    );
    assert.equal(
      targetStatus(policy({ targetValue: "" }), totals, derived).state,
      "no_target",
    );
    const empty = totalReadouts([]);
    assert.equal(
      targetStatus(policy({ successMetric: "cpa", targetValue: "5" }), empty, deriveMetrics(empty))
        .state,
      "no_data",
    );
  });
});

describe("Marketing attention", () => {
  test("flags an active Campaign with nothing recorded", () => {
    const metrics = campaignMetrics(policy(), [], { now: NOW, liveCreativeCount: 1 });
    assert.deepEqual(
      metrics.attention.map((item) => item.code),
      ["no_performance_data"],
    );
  });

  test("flags a readout nobody has refreshed", () => {
    const metrics = campaignMetrics(
      policy({ targetValue: "" }),
      [readout({ periodStart: new Date(day(9)), periodEnd: new Date(day(8)) })],
      { now: NOW, liveCreativeCount: 1 },
    );
    assert.ok(metrics.attention.some((item) => item.code === "stale_performance"));
  });

  test("flags spend running away from the plan", () => {
    const metrics = campaignMetrics(
      policy({ targetValue: "", dailyBudgetMinor: 10_000 }),
      [readout({ spendMinor: 30_000, periodStart: new Date(day(2)), periodEnd: new Date(day(1)) })],
      { now: NOW, liveCreativeCount: 1 },
    );
    const overspending = metrics.attention.find((item) => item.code === "overspending");
    assert.ok(overspending);
    assert.match(overspending.message, /USD 300\.00 a day against a USD 100\.00 plan/);
    assert.equal(metrics.pacingRatio, 3);
  });

  test("flags a missed target with both numbers in it", () => {
    const metrics = campaignMetrics(
      policy({ successMetric: "cpa", targetValue: "1", targetDirection: "at_most" }),
      [readout({ spendMinor: 10_000, conversions: "40" })],
      { now: NOW, liveCreativeCount: 1 },
    );
    const offTarget = metrics.attention.find((item) => item.code === "off_target");
    assert.ok(offTarget);
    assert.match(offTarget.message, /USD 2\.50 against a target of at most USD 1\.00/);
  });

  test("says nothing about a Campaign that is not running", () => {
    const metrics = campaignMetrics(policy({ status: "draft", targetValue: "" }), [], {
      now: NOW,
      liveCreativeCount: 0,
    });
    assert.deepEqual(metrics.attention, []);
  });

  test("notices an active Campaign with no Creative behind it", () => {
    const metrics = campaignMetrics(
      policy({ targetValue: "" }),
      [readout({ spendMinor: 10_000 })],
      { now: NOW, liveCreativeCount: 0 },
    );
    assert.ok(metrics.attention.some((item) => item.code === "no_live_creative"));
  });
});
