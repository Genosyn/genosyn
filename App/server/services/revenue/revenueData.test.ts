import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
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
  UNATTRIBUTED_CHANNEL,
  buildEverBeforeSet,
  buildMonthlyRevenueSnapshots,
  collectCollectedRevenue,
  collectFunnelDeals,
  collectSpendByChannel,
  collectStages,
  collectWonDealsByChannel,
  getReportingCurrency,
} from "./revenueData.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_revenue_data";
const OTHER_CO = "co_someone_else";

const JAN = new Date("2026-01-01T00:00:00Z");
const APR_END = new Date("2026-04-30T00:00:00Z");

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

function at(iso: string): Date {
  return new Date(iso);
}

async function makeCustomer(overrides: Partial<Customer> = {}): Promise<Customer> {
  const n = nextSeq();
  return insert(Customer, {
    companyId: CO,
    name: `Customer ${n}`,
    slug: `customer-${n}`,
    createdAt: JAN,
    ...overrides,
  });
}

/** A schedule plus one line worth `unitPriceCents`, which is the common shape. */
async function makeSchedule(
  customer: Customer,
  overrides: Partial<RecurringInvoice> = {},
  line: { quantity?: number; unitPriceCents: number } | null = { unitPriceCents: 50_000 },
): Promise<RecurringInvoice> {
  const n = nextSeq();
  const schedule = await insert(RecurringInvoice, {
    companyId: customer.companyId,
    customerId: customer.id,
    slug: `ri-${n}`,
    name: `Schedule ${n}`,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    intervalCount: 1,
    status: "active",
    createdAt: JAN,
    ...overrides,
  });
  if (line !== null) {
    await insert(RecurringInvoiceLineItem, {
      recurringInvoiceId: schedule.id,
      description: "Retainer",
      quantity: line.quantity ?? 1,
      unitPriceCents: line.unitPriceCents,
      sortOrder: 0,
    });
  }
  return schedule;
}

async function snapshotsFor(from = JAN, to = APR_END) {
  return buildMonthlyRevenueSnapshots(CO, from, to);
}

/** `Map` → plain object, so assertions read as the table people argue about. */
function plain(snapshots: Map<string, Map<string, number>>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [month, snapshot] of snapshots) {
    out[month] = [...snapshot.values()].sort((a, b) => a - b);
  }
  return out;
}

// ─────────────────── buildMonthlyRevenueSnapshots ────────────────────

describe("buildMonthlyRevenueSnapshots", () => {
  test("a company with no rows gets an empty snapshot for every month", async () => {
    const snapshots = await snapshotsFor();
    assert.deepEqual([...snapshots.keys()], ["2026-01", "2026-02", "2026-03", "2026-04"]);
    for (const snapshot of snapshots.values()) assert.equal(snapshot.size, 0);
  });

  test("the range is inclusive of both end months", async () => {
    const snapshots = await buildMonthlyRevenueSnapshots(
      CO,
      at("2026-03-31T23:59:59Z"),
      at("2026-05-01T00:00:00Z"),
    );
    assert.deepEqual([...snapshots.keys()], ["2026-03", "2026-04", "2026-05"]);
  });

  test("a from after to yields no months rather than an error", async () => {
    const snapshots = await buildMonthlyRevenueSnapshots(CO, APR_END, JAN);
    assert.equal(snapshots.size, 0);
  });

  test("falls back to ACV / 12 for a customer with no recurring invoice", async () => {
    const customer = await makeCustomer({ annualContractValueCents: 120_000 });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-01")?.get(customer.id), 10_000);
    assert.equal(snapshots.get("2026-04")?.get(customer.id), 10_000);
  });

  test("the ACV fallback starts in the month the customer was created", async () => {
    const customer = await makeCustomer({
      annualContractValueCents: 120_000,
      createdAt: at("2026-03-20T00:00:00Z"),
    });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.has(customer.id), false);
    assert.equal(snapshots.get("2026-03")?.get(customer.id), 10_000);
    assert.equal(snapshots.get("2026-04")?.get(customer.id), 10_000);
  });

  test("an archived customer counts in the month they were archived, then stops", async () => {
    const customer = await makeCustomer({
      annualContractValueCents: 120_000,
      archivedAt: at("2026-02-10T00:00:00Z"),
    });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 10_000);
    assert.equal(snapshots.get("2026-03")?.has(customer.id), false);
  });

  test("a customer with no ACV and no schedule never appears", async () => {
    await makeCustomer({ annualContractValueCents: 0 });
    await makeCustomer({ annualContractValueCents: -50_000 });
    const snapshots = await snapshotsFor();
    for (const snapshot of snapshots.values()) assert.equal(snapshot.size, 0);
  });

  test("a monthly schedule prices the customer and the ACV is ignored", async () => {
    const customer = await makeCustomer({ annualContractValueCents: 1_200_000 });
    await makeSchedule(customer, {}, { unitPriceCents: 50_000 });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 50_000);
  });

  test("a yearly schedule normalizes to a twelfth", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, { frequency: "yearly" }, { unitPriceCents: 120_000 });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 10_000);
  });

  test("intervalCount multiplies the frequency — monthly x3 is a quarter", async () => {
    const customer = await makeCustomer();
    await makeSchedule(
      customer,
      { frequency: "monthly", intervalCount: 3 },
      { unitPriceCents: 120_000 },
    );
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 40_000);
  });

  test("a weekly schedule uses the 365/12 average month, not four weeks", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, { frequency: "weekly" }, { unitPriceCents: 10_000 });
    const snapshots = await snapshotsFor();
    // 10_000 / (7 / (365/12)) = 43452.38 → rounds half away from zero.
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 43_452);
  });

  test("an intervalCount of zero clamps to 1 instead of throwing", async () => {
    const customer = await makeCustomer();
    await makeSchedule(
      customer,
      { frequency: "monthly", intervalCount: 0 },
      { unitPriceCents: 50_000 },
    );
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 50_000);
  });

  test("line quantity multiplies the unit price and rounds half away from zero", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, {}, { quantity: 2.5, unitPriceCents: 1_999 });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 4_998);
  });

  test("two schedules on one customer are summed", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, {}, { unitPriceCents: 50_000 });
    await makeSchedule(customer, { frequency: "yearly" }, { unitPriceCents: 120_000 });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 60_000);
  });

  test("an ended schedule stops at its last run — this is how churn appears", async () => {
    const customer = await makeCustomer({ annualContractValueCents: 1_200_000 });
    await makeSchedule(customer, {
      status: "ended",
      lastRunAt: at("2026-02-01T09:00:00Z"),
    });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 50_000);
    // Deliberately NOT reverting to ACV/12: a schedule-priced customer must be
    // able to churn.
    assert.equal(snapshots.get("2026-03")?.has(customer.id), false);
  });

  test("an active schedule still honours an endsOn that has already elapsed", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, { status: "active", endsOn: at("2026-02-20T00:00:00Z") });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 50_000);
    assert.equal(snapshots.get("2026-03")?.has(customer.id), false);
  });

  test("a paused schedule stops at its last run", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, {
      status: "paused",
      lastRunAt: at("2026-01-15T09:00:00Z"),
    });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-01")?.get(customer.id), 50_000);
    assert.equal(snapshots.get("2026-02")?.has(customer.id), false);
  });

  test("anchorAt wins over createdAt, so a schedule set up early bills late", async () => {
    const customer = await makeCustomer();
    await makeSchedule(customer, { createdAt: JAN, anchorAt: at("2026-03-01T09:00:00Z") });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.has(customer.id), false);
    assert.equal(snapshots.get("2026-03")?.get(customer.id), 50_000);
  });

  test("an unreadable frequency drops the schedule and lets ACV take over", async () => {
    const customer = await makeCustomer({ annualContractValueCents: 120_000 });
    await makeSchedule(customer, {
      frequency: "fortnightly" as RecurringInvoice["frequency"],
    });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-02")?.get(customer.id), 10_000);
  });

  test("a readable schedule worth nothing still suppresses the ACV fallback", async () => {
    const customer = await makeCustomer({ annualContractValueCents: 120_000 });
    await makeSchedule(customer, {}, { unitPriceCents: 0 });
    const snapshots = await snapshotsFor();
    for (const snapshot of snapshots.values()) assert.equal(snapshot.has(customer.id), false);
  });

  test("a schedule pointing at a customer that no longer exists is dropped", async () => {
    const ghost = { id: "cust_deleted", companyId: CO } as Customer;
    await makeSchedule(ghost);
    const snapshots = await snapshotsFor();
    for (const snapshot of snapshots.values()) assert.equal(snapshot.size, 0);
  });

  test("another company's customers and schedules never leak in", async () => {
    const mine = await makeCustomer({ annualContractValueCents: 120_000 });
    const theirs = await makeCustomer({
      companyId: OTHER_CO,
      annualContractValueCents: 999_999_00,
    });
    await makeSchedule(theirs, { companyId: OTHER_CO });
    const snapshots = await snapshotsFor();
    assert.deepEqual(plain(snapshots), {
      "2026-01": [10_000],
      "2026-02": [10_000],
      "2026-03": [10_000],
      "2026-04": [10_000],
    });
    assert.equal(snapshots.get("2026-02")?.get(mine.id), 10_000);
  });

  test("a customer who signs and cancels inside one month is counted for it", async () => {
    const customer = await makeCustomer({
      annualContractValueCents: 120_000,
      createdAt: at("2026-03-03T00:00:00Z"),
      archivedAt: at("2026-03-20T00:00:00Z"),
    });
    const snapshots = await snapshotsFor();
    assert.equal(snapshots.get("2026-03")?.get(customer.id), 10_000);
    assert.equal(snapshots.get("2026-02")?.has(customer.id), false);
    assert.equal(snapshots.get("2026-04")?.has(customer.id), false);
  });
});

// ───────────────────────── buildEverBeforeSet ─────────────────────────

describe("buildEverBeforeSet", () => {
  const snapshots = new Map<string, Map<string, number>>([
    ["2026-01", new Map([["a", 100]])],
    ["2026-02", new Map([["b", 200]])],
    ["2026-03", new Map([["c", 300]])],
  ]);

  test("collects customers from strictly earlier months", () => {
    assert.deepEqual([...buildEverBeforeSet(snapshots, "2026-03")].sort(), ["a", "b"]);
  });

  test("the earliest month has nobody before it", () => {
    assert.equal(buildEverBeforeSet(snapshots, "2026-01").size, 0);
  });

  test("a month after every snapshot sees all of them", () => {
    assert.deepEqual([...buildEverBeforeSet(snapshots, "2026-12")].sort(), ["a", "b", "c"]);
  });

  test("zero and negative entries do not count as having had revenue", () => {
    const dirty = new Map<string, Map<string, number>>([
      [
        "2026-01",
        new Map([
          ["a", 0],
          ["b", -5],
          ["c", 1],
        ]),
      ],
    ]);
    assert.deepEqual([...buildEverBeforeSet(dirty, "2026-02")], ["c"]);
  });
});

// ────────────────────────── collectFunnelDeals ──────────────────────────

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
    stageId: "stage_x",
    amountCents: 100_000,
    status: "open",
    createdAt: JAN,
    ...overrides,
  });
}

describe("collectFunnelDeals", () => {
  test("shapes rows exactly as funnel.ts expects", async () => {
    const stage = await makeStage();
    const deal = await makeDeal({ stageId: stage.id, probabilityOverride: 70 });
    const [row] = await collectFunnelDeals(CO);
    assert.deepEqual(row, {
      id: deal.id,
      stageId: stage.id,
      amountCents: 100_000,
      status: "open",
      createdAt: deal.createdAt,
      closedAt: null,
      probabilityOverride: 70,
    });
  });

  test("archived deals are excluded", async () => {
    await makeDeal({ archivedAt: at("2026-02-01T00:00:00Z") });
    assert.deepEqual(await collectFunnelDeals(CO), []);
  });

  test("open deals ignore the period; closed deals respect it", async () => {
    const open = await makeDeal({ createdAt: at("2020-01-01T00:00:00Z") });
    const inside = await makeDeal({ status: "won", closedAt: at("2026-02-15T00:00:00Z") });
    await makeDeal({ status: "lost", closedAt: at("2025-11-01T00:00:00Z") });

    const rows = await collectFunnelDeals(CO, { from: JAN, to: at("2026-05-01T00:00:00Z") });
    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      [open.id, inside.id].sort(),
    );
  });

  test("the period upper bound is exclusive", async () => {
    const boundary = at("2026-05-01T00:00:00Z");
    await makeDeal({ status: "won", closedAt: boundary });
    const rows = await collectFunnelDeals(CO, { from: JAN, to: boundary });
    assert.deepEqual(rows, []);
  });

  test("no window at all returns every live deal", async () => {
    await makeDeal({ status: "won", closedAt: at("2019-01-01T00:00:00Z") });
    await makeDeal();
    assert.equal((await collectFunnelDeals(CO)).length, 2);
  });

  test("scoped to the company", async () => {
    await makeDeal({ companyId: OTHER_CO });
    assert.deepEqual(await collectFunnelDeals(CO), []);
  });
});

// ──────────────────────────── collectStages ────────────────────────────

describe("collectStages", () => {
  test("maps stages in board order and does not seed a default ladder", async () => {
    await makeStage({ name: "Demo", slug: "demo", sortOrder: 2, probability: 40 });
    await makeStage({ name: "New", slug: "new", sortOrder: 1, probability: 10 });
    await makeStage({ name: "Won", slug: "won", sortOrder: 3, kind: "won", probability: 100 });

    const stages = await collectStages(CO);
    assert.deepEqual(
      stages.map((s) => [s.name, s.sortOrder, s.probability, s.kind]),
      [
        ["New", 1, 10, "open"],
        ["Demo", 2, 40, "open"],
        ["Won", 3, 100, "won"],
      ],
    );
  });

  test("archived stages are excluded", async () => {
    await makeStage({ archivedAt: at("2026-02-01T00:00:00Z") });
    assert.deepEqual(await collectStages(CO), []);
  });

  test("a company that never opened the board gets an empty list, not seven rows", async () => {
    assert.deepEqual(await collectStages(CO), []);
    assert.equal(await AppDataSource.getRepository(DealStage).count(), 0);
  });
});

// ───────────────────────── collectSpendByChannel ─────────────────────────

async function makeSpend(overrides: Partial<AdSpendEvent> = {}): Promise<AdSpendEvent> {
  return insert(AdSpendEvent, {
    companyId: CO,
    connectionId: "conn_1",
    platform: "google-ads",
    toolName: "ads_update_budget",
    mutationKind: "budget_increase",
    amountMinor: 100_00,
    createdAt: at("2026-02-01T00:00:00Z"),
    ...overrides,
  });
}

describe("collectSpendByChannel", () => {
  const from = JAN;
  const to = at("2026-05-01T00:00:00Z");

  test("sums authorized increases per platform", async () => {
    await makeSpend({ platform: "google-ads", amountMinor: 100_00 });
    await makeSpend({ platform: "google-ads", amountMinor: 50_00 });
    await makeSpend({ platform: "meta-ads", amountMinor: 25_00 });
    const spend = await collectSpendByChannel(CO, from, to);
    assert.deepEqual([...spend.byChannel].sort(), [
      ["google-ads", 150_00],
      ["meta-ads", 25_00],
    ]);
  });

  test("decreases are ignored rather than netted off", async () => {
    // A campaign raised to $1000 then zeroed still cost money while it ran.
    await makeSpend({ amountMinor: 1_000_00 });
    await makeSpend({ amountMinor: -1_000_00, mutationKind: "budget_decrease" });
    const spend = await collectSpendByChannel(CO, from, to);
    assert.deepEqual([...spend.byChannel], [["google-ads", 1_000_00]]);
  });

  test("events outside the half-open period are excluded", async () => {
    await makeSpend({ createdAt: at("2025-12-31T23:59:59Z") });
    await makeSpend({ createdAt: to });
    assert.equal((await collectSpendByChannel(CO, from, to)).byChannel.size, 0);
  });

  test("a platform-less event lands in the unattributed bucket", async () => {
    await makeSpend({ platform: "", amountMinor: 700 });
    const spend = await collectSpendByChannel(CO, from, to);
    assert.deepEqual([...spend.byChannel], [[UNATTRIBUTED_CHANNEL, 700]]);
  });

  test("scoped to the company", async () => {
    await makeSpend({ companyId: OTHER_CO });
    assert.equal((await collectSpendByChannel(CO, from, to)).byChannel.size, 0);
  });

  test("reports every currency the events were denominated in", async () => {
    // AdSpendEvent.amountMinor is in the ad account's own currency, and this
    // sums across accounts. Two currencies means the total is not a number, so
    // the caller has to be able to find out.
    await makeSpend({ platform: "google-ads", amountMinor: 100_00, currency: "USD" });
    await makeSpend({ platform: "meta-ads", amountMinor: 90_00, currency: "EUR" });
    const spend = await collectSpendByChannel(CO, from, to);
    assert.deepEqual(spend.currencies, ["EUR", "USD"]);
  });

  test("a single currency reports exactly one, normalized to upper case", async () => {
    await makeSpend({ amountMinor: 100_00, currency: "usd" });
    await makeSpend({ amountMinor: 50_00, currency: "USD" });
    assert.deepEqual((await collectSpendByChannel(CO, from, to)).currencies, ["USD"]);
  });
});

// ─────────────────────── collectWonDealsByChannel ───────────────────────

describe("collectWonDealsByChannel", () => {
  const from = JAN;
  const to = at("2026-05-01T00:00:00Z");

  test("counts won deals grouped by source", async () => {
    const closedAt = at("2026-02-10T00:00:00Z");
    await makeDeal({ status: "won", closedAt, source: "google-ads" });
    await makeDeal({ status: "won", closedAt, source: "google-ads" });
    await makeDeal({ status: "won", closedAt, source: "referral" });
    const won = await collectWonDealsByChannel(CO, from, to);
    assert.deepEqual([...won].sort(), [
      ["google-ads", 2],
      ["referral", 1],
    ]);
  });

  test("open and lost deals are not wins", async () => {
    const closedAt = at("2026-02-10T00:00:00Z");
    await makeDeal({ status: "lost", closedAt, source: "google-ads" });
    await makeDeal({ status: "open", source: "google-ads" });
    assert.equal((await collectWonDealsByChannel(CO, from, to)).size, 0);
  });

  test("wins closed outside the period do not count", async () => {
    await makeDeal({ status: "won", closedAt: at("2025-06-01T00:00:00Z"), source: "seo" });
    assert.equal((await collectWonDealsByChannel(CO, from, to)).size, 0);
  });

  test("a win with no source is counted as unattributed, not dropped", async () => {
    await makeDeal({ status: "won", closedAt: at("2026-03-01T00:00:00Z"), source: "" });
    const won = await collectWonDealsByChannel(CO, from, to);
    assert.deepEqual([...won], [[UNATTRIBUTED_CHANNEL, 1]]);
  });

  test("archived wins and other companies are excluded", async () => {
    const closedAt = at("2026-02-10T00:00:00Z");
    await makeDeal({ status: "won", closedAt, source: "seo", archivedAt: closedAt });
    await makeDeal({ companyId: OTHER_CO, status: "won", closedAt, source: "seo" });
    assert.equal((await collectWonDealsByChannel(CO, from, to)).size, 0);
  });
});

// ─────────────────────── collectCollectedRevenue ───────────────────────

async function makeInvoice(companyId = CO): Promise<Invoice> {
  const n = nextSeq();
  return insert(Invoice, {
    companyId,
    customerId: `cust_${n}`,
    slug: `inv-${n}`,
    status: "sent",
    issueDate: JAN,
    dueDate: JAN,
    totalCents: 100_000,
  });
}

describe("collectCollectedRevenue", () => {
  const from = JAN;
  const to = at("2026-05-01T00:00:00Z");

  test("sums payments in the period", async () => {
    const invoice = await makeInvoice();
    await insert(InvoicePayment, {
      invoiceId: invoice.id,
      amountCents: 30_000,
      paidAt: at("2026-02-01T00:00:00Z"),
    });
    await insert(InvoicePayment, {
      invoiceId: invoice.id,
      amountCents: 70_000,
      paidAt: at("2026-03-01T00:00:00Z"),
    });
    assert.equal(await collectCollectedRevenue(CO, from, to), 100_000);
  });

  test("payments outside the half-open period are excluded", async () => {
    const invoice = await makeInvoice();
    await insert(InvoicePayment, {
      invoiceId: invoice.id,
      amountCents: 30_000,
      paidAt: at("2025-12-31T23:59:59Z"),
    });
    await insert(InvoicePayment, { invoiceId: invoice.id, amountCents: 70_000, paidAt: to });
    assert.equal(await collectCollectedRevenue(CO, from, to), 0);
  });

  test("scoped through the invoice to the company", async () => {
    const theirs = await makeInvoice(OTHER_CO);
    await insert(InvoicePayment, {
      invoiceId: theirs.id,
      amountCents: 500_000,
      paidAt: at("2026-02-01T00:00:00Z"),
    });
    assert.equal(await collectCollectedRevenue(CO, from, to), 0);
  });

  test("a company with no payments collects zero, not NaN", async () => {
    const total = await collectCollectedRevenue(CO, from, to);
    assert.equal(total, 0);
    assert.equal(Number.isFinite(total), true);
  });
});

// ───────────────────────── getReportingCurrency ─────────────────────────

describe("getReportingCurrency", () => {
  test("falls back to USD without creating a settings row", async () => {
    assert.equal(await getReportingCurrency(CO), "USD");
    assert.equal(await AppDataSource.getRepository(CompanyFinanceSettings).count(), 0);
  });

  test("returns the configured home currency", async () => {
    await insert(CompanyFinanceSettings, { companyId: CO, homeCurrency: "EUR" });
    assert.equal(await getReportingCurrency(CO), "EUR");
  });
});
