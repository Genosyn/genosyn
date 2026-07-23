import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AdSpendEvent } from "../../db/entities/AdSpendEvent.js";
import { CompanyFinanceSettings } from "../../db/entities/CompanyFinanceSettings.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { InvoicePayment } from "../../db/entities/InvoicePayment.js";
import { RecurringInvoice } from "../../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../../db/entities/RecurringInvoiceLineItem.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  getCacReport,
  getFunnelReport,
  getMrrSeries,
  getRevenueOverview,
} from "./reports.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_revenue_reports";

const FROM = new Date("2026-01-01T00:00:00Z");
/** Exclusive — the series must end at 2026-04, not 2026-05. */
const TO = new Date("2026-05-01T00:00:00Z");
const PERIOD = { from: FROM, to: TO };

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

function at(iso: string): Date {
  return new Date(iso);
}

/** Nothing a report returns may be NaN — the whole point of the null handling. */
function assertNoNaN(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    assert.equal(Number.isFinite(value), true, `${path} is not finite: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoNaN(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) assertNoNaN(inner, `${path}.${key}`);
  }
}

async function makeCustomer(overrides: Partial<Customer> = {}): Promise<Customer> {
  const n = nextSeq();
  return insert(Customer, {
    companyId: CO,
    name: `Customer ${n}`,
    slug: `customer-${n}`,
    createdAt: FROM,
    ...overrides,
  });
}

async function makeSchedule(
  customer: Customer,
  overrides: Partial<RecurringInvoice> = {},
  unitPriceCents = 50_000,
): Promise<RecurringInvoice> {
  const n = nextSeq();
  const schedule = await insert(RecurringInvoice, {
    companyId: CO,
    customerId: customer.id,
    slug: `ri-${n}`,
    name: `Schedule ${n}`,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    intervalCount: 1,
    status: "active",
    createdAt: FROM,
    ...overrides,
  });
  await insert(RecurringInvoiceLineItem, {
    recurringInvoiceId: schedule.id,
    description: "Retainer",
    quantity: 1,
    unitPriceCents,
    sortOrder: 0,
  });
  return schedule;
}

async function makeStage(overrides: Partial<DealStage> = {}): Promise<DealStage> {
  const n = nextSeq();
  return insert(DealStage, {
    companyId: CO,
    name: `Stage ${n}`,
    slug: `stage-${n}`,
    sortOrder: n,
    probability: 50,
    kind: "open",
    ...overrides,
  });
}

async function makeDeal(overrides: Partial<Deal> = {}): Promise<Deal> {
  const n = nextSeq();
  return insert(Deal, {
    companyId: CO,
    title: `Deal ${n}`,
    stageId: "stage_missing",
    amountCents: 100_000,
    status: "open",
    createdAt: FROM,
    ...overrides,
  });
}

async function makeSpend(amountMinor: number, platform: string): Promise<AdSpendEvent> {
  return insert(AdSpendEvent, {
    companyId: CO,
    connectionId: "conn_1",
    platform,
    toolName: "ads_update_budget",
    mutationKind: "budget_increase",
    amountMinor,
    createdAt: at("2026-02-01T00:00:00Z"),
  });
}

/**
 * The scenario most assertions below share:
 *   A — ACV 120_000 (10_000/mo) from January, never leaves.
 *   B — ACV 120_000 from March, new business.
 *   C — a 50_000/mo schedule that ended on 5 February, so March is a churn.
 */
async function seedMrrScenario() {
  const a = await makeCustomer({ annualContractValueCents: 120_000 });
  const b = await makeCustomer({
    annualContractValueCents: 120_000,
    createdAt: at("2026-03-05T00:00:00Z"),
  });
  const c = await makeCustomer();
  await makeSchedule(c, { status: "ended", lastRunAt: at("2026-02-05T09:00:00Z") });
  return { a, b, c };
}

// ───────────────────────── brand-new company ─────────────────────────

describe("empty company", () => {
  test("getRevenueOverview returns an all-zero report, no NaN and no crash", async () => {
    const report = await getRevenueOverview(CO, PERIOD);
    assertNoNaN(report);

    assert.equal(report.mrr.currentCents, 0);
    assert.equal(report.arrCents, 0);
    assert.deepEqual(report.mrr.series.map((p) => p.month), [
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    for (const point of report.mrr.series) {
      assert.equal(point.endingCents, 0);
      assert.equal(point.netCents, 0);
      assert.equal(point.counts.new, 0);
    }
    assert.equal(report.mrr.movement.startingCents, 0);
    assert.equal(report.mrr.movement.endingCents, 0);

    assert.deepEqual(report.retention, {
      cohortSize: 0,
      startingCents: 0,
      endingCents: 0,
      retainedCents: 0,
      churnedCount: 0,
      nrrPct: null,
      grrPct: null,
    });

    assert.deepEqual(report.funnel.stages, []);
    assert.deepEqual(report.funnel.conversion, []);
    assert.equal(report.funnel.orphanedCount, 0);
    assert.deepEqual(report.funnel.winRate, { won: 0, lost: 0, winRatePct: null });
    assert.equal(report.funnel.salesCycleDays, null);

    assert.deepEqual(report.coverage, {
      openCents: 0,
      weightedCents: 0,
      coverage: null,
      weightedCoverage: null,
    });

    assert.deepEqual(report.cac.channels, []);
    assert.equal(report.cac.blendedCacCents, null);
    assert.equal(report.cac.spendCents, 0);
    assert.equal(report.cac.wonCount, 0);
    assert.equal(report.cac.arpaCents, null);
    assert.equal(report.cac.monthlyChurnPct, null);
    assert.equal(report.cac.ltvCents, null);
    assert.equal(report.cac.ltvToCac, null);
    assert.equal(report.cac.paybackMonths, null);

    assert.equal(report.collectedCents, 0);
    assert.equal(report.currency, "USD");
  });

  test("getMrrSeries on an empty company is zeros for every month", async () => {
    const report = await getMrrSeries(CO, 3, at("2026-04-15T00:00:00Z"));
    assertNoNaN(report);
    assert.deepEqual(report.months, ["2026-02", "2026-03", "2026-04"]);
    assert.equal(report.currentCents, 0);
    assert.equal(report.arrCents, 0);
    assert.equal(report.series.length, 3);
  });

  test("getFunnelReport on an empty company has no stages and no win rate", async () => {
    const report = await getFunnelReport(CO, PERIOD);
    assertNoNaN(report);
    assert.deepEqual(report.stages, []);
    assert.equal(report.winRate.winRatePct, null);
    assert.equal(report.salesCycleDays, null);
    assert.equal(report.coverage.coverage, null);
  });

  test("getCacReport on an empty company has no channels and a null blended CAC", async () => {
    const report = await getCacReport(CO, PERIOD, { grossMarginPct: 80 });
    assertNoNaN(report);
    assert.deepEqual(report.channels, []);
    assert.equal(report.blendedCacCents, null);
    assert.equal(report.ltvCents, null);
    assert.equal(report.paybackMonths, null);
    assert.equal(report.spendIsProxy, true);
  });
});

// ──────────────────────── getRevenueOverview: MRR ────────────────────────

describe("getRevenueOverview — recurring revenue", () => {
  test("splits the month-over-month change into new, churn and retained", async () => {
    await seedMrrScenario();
    const report = await getRevenueOverview(CO, PERIOD);
    const [jan, feb, mar, apr] = report.mrr.series;

    // Cold start: the first month of any window is all new business.
    assert.equal(jan.newCents, 60_000);
    assert.equal(jan.counts.new, 2);
    assert.equal(jan.endingCents, 60_000);

    assert.equal(feb.netCents, 0);
    assert.equal(feb.counts.retained, 2);

    assert.equal(mar.newCents, 10_000);
    assert.equal(mar.churnCents, 50_000);
    assert.equal(mar.counts.churned, 1);
    assert.equal(mar.netCents, -40_000);
    assert.equal(mar.endingCents, 20_000);

    assert.equal(apr.endingCents, 20_000);
    assert.equal(report.mrr.currentCents, 20_000);
  });

  test("the reported movement is the final month's, without the month key", async () => {
    await seedMrrScenario();
    const report = await getRevenueOverview(CO, PERIOD);
    const { month: _month, ...expected } = report.mrr.series[report.mrr.series.length - 1];
    assert.deepEqual(report.mrr.movement, expected);
    assert.equal("month" in report.mrr.movement, false);
  });

  test("ARR is twelve times the final month", async () => {
    await seedMrrScenario();
    const report = await getRevenueOverview(CO, PERIOD);
    assert.equal(report.arrCents, 240_000);
  });

  test("a returning customer is reactivation, not new business", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, { status: "ended", lastRunAt: at("2026-01-20T09:00:00Z") });
    await makeSchedule(customer, { anchorAt: at("2026-03-01T09:00:00Z") });

    const report = await getRevenueOverview(CO, PERIOD);
    const [, feb, mar] = report.mrr.series;
    assert.equal(feb.churnCents, 50_000);
    assert.equal(mar.reactivationCents, 50_000);
    assert.equal(mar.newCents, 0);
    assert.equal(mar.counts.reactivated, 1);
  });

  test("an exclusive upper bound on a month boundary adds no trailing month", async () => {
    const report = await getRevenueOverview(CO, {
      from: FROM,
      to: at("2026-02-01T00:00:00Z"),
    });
    assert.deepEqual(report.mrr.series.map((p) => p.month), ["2026-01"]);
  });

  test("retention compares the first month of the window against the last", async () => {
    await seedMrrScenario();
    const report = await getRevenueOverview(CO, PERIOD);
    // January's cohort was A (10_000) + C (50_000); by April only A is left.
    assert.equal(report.retention.cohortSize, 2);
    assert.equal(report.retention.startingCents, 60_000);
    assert.equal(report.retention.endingCents, 10_000);
    assert.equal(report.retention.churnedCount, 1);
    assert.equal(report.retention.nrrPct, 16.7);
    assert.equal(report.retention.grrPct, 16.7);
  });
});

// ────────────────────── getRevenueOverview: the rest ──────────────────────

describe("getRevenueOverview — cash, funnel and currency", () => {
  test("collected revenue is cash in the period, independent of MRR", async () => {
    const customer = await makeCustomer({ annualContractValueCents: 120_000 });
    const invoice = await insert(Invoice, {
      companyId: CO,
      customerId: customer.id,
      slug: "inv-1",
      status: "paid",
      issueDate: FROM,
      dueDate: FROM,
      totalCents: 120_000,
    });
    await insert(InvoicePayment, {
      invoiceId: invoice.id,
      amountCents: 120_000,
      paidAt: at("2026-02-11T00:00:00Z"),
    });

    const report = await getRevenueOverview(CO, PERIOD);
    // A whole year paid up front against a 10_000/mo run rate: they disagree,
    // and that is the point of showing both.
    assert.equal(report.collectedCents, 120_000);
    assert.equal(report.mrr.currentCents, 10_000);
  });

  test("the reporting currency comes from finance settings", async () => {
    await insert(CompanyFinanceSettings, { companyId: CO, homeCurrency: "GBP" });
    const report = await getRevenueOverview(CO, PERIOD);
    assert.equal(report.currency, "GBP");
  });

  test("coverage is null without a target and a multiple with one", async () => {
    const stage = await makeStage({ probability: 50 });
    await makeDeal({ stageId: stage.id, amountCents: 400_000 });

    const noTarget = await getRevenueOverview(CO, PERIOD);
    assert.equal(noTarget.coverage.openCents, 400_000);
    assert.equal(noTarget.coverage.weightedCents, 200_000);
    assert.equal(noTarget.coverage.coverage, null);

    const withTarget = await getRevenueOverview(CO, { ...PERIOD, targetCents: 200_000 });
    assert.equal(withTarget.coverage.coverage, 2);
    assert.equal(withTarget.coverage.weightedCoverage, 1);
  });

  test("a non-finite target is treated as no target rather than throwing", async () => {
    const report = await getRevenueOverview(CO, { ...PERIOD, targetCents: Number.NaN });
    assert.equal(report.coverage.coverage, null);
  });

  test("an invalid period is a caller bug and throws", async () => {
    await assert.rejects(
      () => getRevenueOverview(CO, { from: new Date("nope"), to: TO }),
      /valid Dates/,
    );
    await assert.rejects(() => getFunnelReport(CO, { from: FROM, to: new Date("nope") }));
  });
});

// ───────────────────────────── getFunnelReport ─────────────────────────────

async function seedFunnelScenario() {
  const newStage = await makeStage({ name: "New", slug: "new", sortOrder: 1, probability: 10 });
  const demo = await makeStage({ name: "Demo", slug: "demo", sortOrder: 2, probability: 40 });
  const won = await makeStage({
    name: "Won",
    slug: "won",
    sortOrder: 3,
    probability: 100,
    kind: "won",
  });
  const lost = await makeStage({
    name: "Lost",
    slug: "lost",
    sortOrder: 4,
    probability: 0,
    kind: "lost",
  });

  await makeDeal({ stageId: newStage.id, amountCents: 100_000 });
  await makeDeal({ stageId: demo.id, amountCents: 200_000 });
  await makeDeal({ stageId: demo.id, amountCents: 100_000 });
  await makeDeal({
    stageId: won.id,
    status: "won",
    amountCents: 500_000,
    createdAt: FROM,
    closedAt: at("2026-02-10T00:00:00Z"),
  });
  await makeDeal({
    stageId: lost.id,
    status: "lost",
    amountCents: 300_000,
    closedAt: at("2026-02-20T00:00:00Z"),
  });
  // Points at a stage nobody can resolve — must surface, not vanish.
  await makeDeal({ stageId: "stage_archived", amountCents: 999_000 });

  return { newStage, demo, won, lost };
}

describe("getFunnelReport", () => {
  test("counts and values every stage, empty ones included", async () => {
    await seedFunnelScenario();
    const report = await getFunnelReport(CO, PERIOD);
    assert.deepEqual(
      report.stages.map((row) => [row.stage.name, row.count, row.valueCents, row.weightedValueCents]),
      [
        ["New", 1, 100_000, 10_000],
        ["Demo", 2, 300_000, 120_000],
        ["Won", 0, 0, 0],
        ["Lost", 0, 0, 0],
      ],
    );
  });

  test("deals in an unresolvable stage are reported as orphaned, not dropped silently", async () => {
    await seedFunnelScenario();
    const report = await getFunnelReport(CO, PERIOD);
    assert.equal(report.orphanedCount, 1);
  });

  test("conversion is null out of an empty stage rather than 0%", async () => {
    await seedFunnelScenario();
    const report = await getFunnelReport(CO, PERIOD);
    assert.deepEqual(
      report.conversion.map((row) => [row.fromStage.name, row.toStage.name, row.conversionPct]),
      [
        ["New", "Demo", 200],
        ["Demo", "Won", 0],
        ["Won", "Lost", null],
      ],
    );
  });

  test("win rate and sales cycle come from the deals that closed in the period", async () => {
    await seedFunnelScenario();
    const report = await getFunnelReport(CO, PERIOD);
    assert.deepEqual(report.winRate, { won: 1, lost: 1, winRatePct: 50 });
    assert.equal(report.salesCycleDays, 40);
  });

  test("coverage excludes orphaned deals from both the raw and weighted totals", async () => {
    await seedFunnelScenario();
    const report = await getFunnelReport(CO, PERIOD, { targetCents: 1_000_000 });
    assert.equal(report.coverage.openCents, 400_000);
    assert.equal(report.coverage.weightedCents, 130_000);
    assert.equal(report.coverage.coverage, 0.4);
    assert.equal(report.coverage.weightedCoverage, 0.13);
  });

  test("a period that excludes the closes leaves the pipeline intact", async () => {
    await seedFunnelScenario();
    const report = await getFunnelReport(CO, {
      from: at("2026-06-01T00:00:00Z"),
      to: at("2026-07-01T00:00:00Z"),
    });
    assert.deepEqual(report.winRate, { won: 0, lost: 0, winRatePct: null });
    // Open deals are point-in-time, so the funnel columns do not empty out.
    assert.equal(report.stages[1].count, 2);
  });
});

// ────────────────────────────── getCacReport ──────────────────────────────

/**
 * Two customers on 10_000/mo from January; one leaves in March, which is the
 * only way to get a non-zero churn rate and therefore a real LTV.
 */
async function seedCacScenario() {
  await makeCustomer({ annualContractValueCents: 120_000 });
  await makeCustomer({
    annualContractValueCents: 120_000,
    archivedAt: at("2026-02-10T00:00:00Z"),
  });
  await makeSpend(100_000, "google-ads");
  await makeDeal({
    status: "won",
    source: "google-ads",
    closedAt: at("2026-02-15T00:00:00Z"),
  });
  await makeDeal({
    status: "won",
    source: "google-ads",
    closedAt: at("2026-03-15T00:00:00Z"),
  });
}

describe("getCacReport", () => {
  test("per-channel CAC is spend over wins", async () => {
    await seedCacScenario();
    const report = await getCacReport(CO, PERIOD);
    assert.deepEqual(report.channels, [
      {
        channel: "google-ads",
        spendCents: 100_000,
        wonCount: 2,
        cacCents: 50_000,
        note: "ok",
      },
    ]);
    assert.equal(report.blendedCacCents, 50_000);
    assert.equal(report.spendCents, 100_000);
    assert.equal(report.wonCount, 2);
  });

  test("a channel with spend and no wins reports no-wins rather than Infinity", async () => {
    await makeSpend(40_000, "meta-ads");
    const report = await getCacReport(CO, PERIOD);
    assert.deepEqual(report.channels, [
      {
        channel: "meta-ads",
        spendCents: 40_000,
        wonCount: 0,
        cacCents: null,
        note: "no-wins",
      },
    ]);
    assert.equal(report.blendedCacCents, null);
  });

  test("ARPA and churn are derived from the same snapshots the MRR chart uses", async () => {
    await seedCacScenario();
    const report = await getCacReport(CO, PERIOD);
    assert.equal(report.arpaCents, 10_000);
    // Feb 0%, Mar 50%, Apr 0% — January is skipped, it started at zero.
    assert.equal(report.monthlyChurnPct, 16.7);
  });

  test("without a gross margin the unit economics stay null instead of invented", async () => {
    await seedCacScenario();
    const report = await getCacReport(CO, PERIOD);
    assert.equal(report.ltvCents, null);
    assert.equal(report.ltvToCac, null);
    assert.equal(report.paybackMonths, null);
    // The inputs are still there so the UI can say what it is missing.
    assert.equal(report.arpaCents, 10_000);
  });

  test("with a gross margin it produces LTV, LTV:CAC and payback", async () => {
    await seedCacScenario();
    const report = await getCacReport(CO, PERIOD, { grossMarginPct: 80 });
    assert.equal(report.ltvCents, 47_904);
    assert.equal(report.ltvToCac, 1);
    assert.equal(report.paybackMonths, 6.3);
  });

  test("an out-of-range margin nulls LTV rather than computing on it", async () => {
    await seedCacScenario();
    const report = await getCacReport(CO, PERIOD, { grossMarginPct: 800 });
    assert.equal(report.ltvCents, null);
    assert.equal(report.ltvToCac, null);
    // Payback does not depend on the lifetime, so it still answers.
    assert.equal(report.paybackMonths, 0.6);
  });

  test("the payload always declares that spend is a proxy", async () => {
    await seedCacScenario();
    const report = await getCacReport(CO, PERIOD);
    assert.equal(report.spendIsProxy, true);
    const overview = await getRevenueOverview(CO, PERIOD);
    assert.equal(overview.cac.spendIsProxy, true);
  });
});

// ────────────────────────────── getMrrSeries ──────────────────────────────

describe("getMrrSeries", () => {
  const now = at("2026-04-15T00:00:00Z");

  test("ends with the month containing now, incomplete though it is", async () => {
    await seedMrrScenario();
    const report = await getMrrSeries(CO, 3, now);
    assert.deepEqual(report.months, ["2026-02", "2026-03", "2026-04"]);
    assert.equal(report.currentCents, 20_000);
    assert.equal(report.arrCents, 240_000);
  });

  test("the window is a real window — earlier months are excluded", async () => {
    await seedMrrScenario();
    const report = await getMrrSeries(CO, 2, now);
    assert.deepEqual(report.months, ["2026-03", "2026-04"]);
    // March is now the cold-start month, so its 20_000 reads as all new.
    assert.equal(report.series[0].newCents, 20_000);
  });

  test("crosses a year boundary correctly", async () => {
    const report = await getMrrSeries(CO, 3, at("2026-02-10T00:00:00Z"));
    assert.deepEqual(report.months, ["2025-12", "2026-01", "2026-02"]);
  });

  test("clamps an absurd request instead of rejecting it", async () => {
    const long = await getMrrSeries(CO, 5_000, now);
    assert.equal(long.months.length, 60);
    const short = await getMrrSeries(CO, 0, now);
    assert.equal(short.months.length, 1);
    assert.deepEqual(short.months, ["2026-04"]);
  });

  test("carries the reporting currency", async () => {
    await insert(CompanyFinanceSettings, { companyId: CO, homeCurrency: "EUR" });
    const report = await getMrrSeries(CO, 2, now);
    assert.equal(report.currency, "EUR");
  });
});
