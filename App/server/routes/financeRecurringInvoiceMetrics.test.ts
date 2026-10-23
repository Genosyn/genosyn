import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { Membership } from "../db/entities/Membership.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { seedChartOfAccounts } from "../services/ledger.js";
import { recurringRevenueMetrics } from "../services/recurringInvoiceMetrics.js";
import { computeNextRun } from "../services/recurringInvoices.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * Finance → Recurring invoices leads with the schedules' recurring revenue:
 * ARR from the active ones, before tax and after discounts, in the home
 * currency; what the next 30 days will invoice; and what is paused or about
 * to stop billing.
 */

type Created = { id: string; slug: string; error?: string };

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let acme: Customer;
let globex: Customer;
let vat: TaxRate;

const originalLog = console.log;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: actingUserId, sessionVersion: 0 };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", financeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, { name: "Sunwise", slug: randomUUID(), ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  acme = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
    currency: "USD",
  });
  globex = await insert(Customer, {
    companyId: company.id,
    name: "Globex",
    slug: "globex",
    email: "ap@globex.example",
    currency: "USD",
  });
  vat = await insert(TaxRate, { companyId: company.id, name: "VAT", ratePercent: 10 });
  await seedChartOfAccounts(company.id);
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  console.log = () => undefined;
  try {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  } finally {
    console.log = originalLog;
  }
}

/** A monthly schedule billing `unitPriceCents` a run, untaxed, unless overridden. */
async function create(overrides: Record<string, unknown> = {}): Promise<Created> {
  const created = await call<Created>("POST", "/recurring-invoices", {
    customerId: acme.id,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 100_000 }],
    ...overrides,
  });
  assert.equal(created.status, 200, created.body.error);
  return created.body;
}

async function update(id: string, patch: Partial<RecurringInvoice>): Promise<void> {
  await AppDataSource.getRepository(RecurringInvoice).update({ id }, patch);
}

/** Line the schedule's next run up with `now`, as the heartbeat would have. */
async function scheduleFrom(id: string, now: Date): Promise<void> {
  const repo = AppDataSource.getRepository(RecurringInvoice);
  const ri = await repo.findOneByOrFail({ id });
  await update(id, { nextRunAt: computeNextRun(ri, now) });
}

test("ARR annualizes the active schedules' amount per invoice, before tax and after discounts", async () => {
  // 1,000 a month less 10%, with VAT on top that is no part of revenue.
  await create({
    discountPercent: 10,
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 100_000, taxRateId: vat.id }],
  });
  // 2,400 a year from a second customer.
  await create({
    customerId: globex.id,
    cronExpr: "0 9 1 1 *",
    frequency: "yearly",
    lines: [{ description: "Licence", quantity: 1, unitPriceCents: 240_000 }],
  });
  // 3,000 every second quarter: twice a year.
  await create({
    cronExpr: "0 9 1 1,4,7,10 *",
    frequency: "quarterly",
    intervalCount: 2,
    lines: [{ description: "Audit", quantity: 1, unitPriceCents: 300_000 }],
  });

  const response = await call<Awaited<ReturnType<typeof recurringRevenueMetrics>>>(
    "GET",
    "/recurring-invoices/metrics",
  );
  assert.equal(response.status, 200);
  const metrics = response.body;
  assert.equal(metrics.currency, "USD");
  assert.equal(metrics.arrCents, 1_080_000 + 240_000 + 600_000);
  assert.equal(metrics.mrrCents, 160_000);
  assert.equal(metrics.activeSchedules, 3);
  assert.equal(metrics.activeCustomers, 2);
  assert.deepEqual(metrics.cadences, [
    { frequency: "monthly", schedules: 1, arrCents: 1_080_000 },
    { frequency: "quarterly", schedules: 1, arrCents: 600_000 },
    { frequency: "yearly", schedules: 1, arrCents: 240_000 },
  ]);
  assert.deepEqual(metrics.largestCustomer, {
    id: acme.id,
    name: "Acme Corp",
    slug: "acme-corp",
    arrCents: 1_680_000,
  });
  assert.deepEqual(metrics.converted, []);
  assert.deepEqual(metrics.unconverted, []);
});

test("a paused schedule is revenue on hold, and ended or archived ones count nowhere", async () => {
  await create();
  await create({ status: "paused", lines: [{ description: "On hold", quantity: 1, unitPriceCents: 50_000 }] });
  const filed = await create({ status: "paused" });
  await update(filed.id, { archivedAt: new Date() });
  const ended = await create();
  await update(ended.id, { status: "ended", nextRunAt: null });

  const metrics = await recurringRevenueMetrics(company.id);
  assert.equal(metrics.arrCents, 1_200_000);
  assert.equal(metrics.activeSchedules, 1);
  assert.deepEqual(metrics.paused, { schedules: 1, arrCents: 600_000 });
});

test("another currency converts at the latest rate, and one with no rate is named instead of added", async () => {
  await create();
  await create({ currency: "EUR" });
  await create({ currency: "GBP", status: "paused" });
  await create({ currency: "GBP" });
  const now = new Date();
  await insert(ExchangeRate, {
    companyId: company.id,
    fromCurrency: "EUR",
    toCurrency: "USD",
    date: new Date(now.getTime() - 30 * 86_400_000),
    rate: 1,
    source: "manual",
  });
  const latest = new Date(now.getTime() - 86_400_000);
  await insert(ExchangeRate, {
    companyId: company.id,
    fromCurrency: "EUR",
    toCurrency: "USD",
    date: latest,
    rate: 1.1,
    source: "manual",
  });

  const metrics = await recurringRevenueMetrics(company.id, now);
  assert.equal(metrics.arrCents, 1_200_000 + 1_320_000);
  assert.equal(metrics.activeSchedules, 2);
  assert.deepEqual(metrics.paused, { schedules: 0, arrCents: 0 });
  assert.deepEqual(metrics.converted, [
    { currency: "EUR", rate: 1.1, rateDate: latest.toISOString() },
  ]);
  assert.deepEqual(metrics.unconverted, [{ currency: "GBP", schedules: 2, arrCents: 1_200_000 }]);
});

test("the next 30 days count every run due, tax included, up to a schedule's run limit", async () => {
  // Sunday 1 November, noon: Mondays fall on the 2nd, 9th, 16th, 23rd and 30th.
  const now = new Date(2026, 10, 1, 12, 0);
  const weekly = await create({
    cronExpr: "0 9 * * 1",
    frequency: "weekly",
    lines: [{ description: "Support", quantity: 1, unitPriceCents: 10_000, taxRateId: vat.id }],
  });
  const monthly = await create({ cronExpr: "0 9 15 * *" });
  const limited = await create({ cronExpr: "0 9 * * 1", frequency: "weekly", maxRuns: 4 });
  await update(limited.id, { runsCreated: 2 });
  for (const { id } of [weekly, monthly, limited]) await scheduleFrom(id, now);

  const metrics = await recurringRevenueMetrics(company.id, now);
  // Five weekly runs at 110.00, one monthly at 1,000.00, two left on the limit.
  assert.deepEqual(metrics.upcoming, {
    days: 30,
    invoices: 5 + 1 + 2,
    totalCents: 5 * 11_000 + 100_000 + 2 * 100_000,
  });
});

test("a schedule whose end date or last allowed run falls within 90 days is ending", async () => {
  const now = new Date(2026, 10, 1, 12, 0);
  const capped = await create({ cronExpr: "0 9 15 * *", maxRuns: 3 });
  await update(capped.id, { runsCreated: 1 });
  const dated = await create({
    customerId: globex.id,
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 50_000 }],
  });
  // Set apart from the create, which would end a schedule whose date has passed.
  await update(dated.id, { endsOn: new Date(2027, 0, 10) });
  const openEnded = await create();
  const farOff = await create({ maxRuns: 12 });
  for (const { id } of [capped, dated, openEnded, farOff]) await scheduleFrom(id, now);

  const metrics = await recurringRevenueMetrics(company.id, now);
  assert.equal(metrics.ending.days, 90);
  assert.equal(metrics.ending.schedules, 2);
  assert.equal(metrics.ending.arrCents, 1_200_000 + 600_000);
  // The capped schedule's last run, on 15 December, comes first.
  assert.equal(metrics.ending.firstEndsAt, new Date(2026, 11, 15, 9, 0).toISOString());
});

test("a company with no schedules gets zeros, not an error or a schedule lookup", async () => {
  const response = await call<Awaited<ReturnType<typeof recurringRevenueMetrics>>>(
    "GET",
    "/recurring-invoices/metrics",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    currency: "USD",
    arrCents: 0,
    mrrCents: 0,
    activeSchedules: 0,
    activeCustomers: 0,
    cadences: [],
    largestCustomer: null,
    upcoming: { days: 30, invoices: 0, totalCents: 0 },
    paused: { schedules: 0, arrCents: 0 },
    ending: { days: 90, schedules: 0, arrCents: 0, firstEndsAt: null },
    converted: [],
    unconverted: [],
  });

  const unknown = await call<{ error?: string }>("GET", "/recurring-invoices/metrics?days=7");
  assert.equal(unknown.status, 400);
});
