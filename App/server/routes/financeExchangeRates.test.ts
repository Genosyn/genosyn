import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Bill } from "../db/entities/Bill.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { Vendor } from "../db/entities/Vendor.js";
import { errorHandler } from "../middleware/error.js";
import { ECB_RATES_URL } from "../services/exchangeRateFeed.js";
import { seedChartOfAccounts } from "../services/ledger.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * Exchange rates fill themselves from the ECB, and a foreign-currency document
 * locks the rate it was booked at: an invoice or bill when it is issued, a
 * payment the rate of the day it was paid. A rate that arrives later for the
 * issue date then can't leave part of a receivable or payable behind.
 */

type Body = Record<string, unknown> & { error?: string };

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let customer: Customer;
let vendor: Vendor;

const originalLog = console.log;
const originalFetch = globalThis.fetch;
let ecbAnswer: () => Response = () => new Response("unreachable", { status: 503 });

const ECB_FEED =
  `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube>` +
  `<Cube time="2026-10-22"><Cube currency="USD" rate="1.1205"/><Cube currency="GBP" rate="0.8377"/></Cube>\n` +
  `<Cube time="2026-10-21"><Cube currency="USD" rate="1.1234"/><Cube currency="GBP" rate="0.83825"/></Cube>\n` +
  `</Cube></gesmes:Envelope>`;

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
  // The ECB is never reached from a test: its URL answers with `ecbAnswer`.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === ECB_RATES_URL) return ecbAnswer();
    return originalFetch(input, init);
  }) as typeof fetch;
});

beforeEach(async () => {
  await resetTestDb();
  ecbAnswer = () => new Response("unreachable", { status: 503 });
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, { name: "Sunwise", slug: randomUUID(), ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Wayne Enterprises",
    slug: "wayne",
    email: "ap@wayne.example",
    currency: "EUR",
  });
  vendor = await insert(Vendor, {
    companyId: company.id,
    name: "Hosting GmbH",
    slug: "hosting-gmbh",
    currency: "EUR",
  });
  await seedChartOfAccounts(company.id);
});

afterEach(() => {
  console.log = originalLog;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Body }> {
  console.log = () => undefined;
  try {
    const response = await originalFetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Body };
  } finally {
    console.log = originalLog;
  }
}

async function ok(method: string, path: string, body?: unknown): Promise<Body> {
  const response = await call(method, path, body);
  assert.equal(response.status, 200, response.body.error);
  return response.body;
}

/** A rate on file, as a person or the feed would have left it. */
async function rate(day: string, value: number, automatic = true): Promise<void> {
  await insert(ExchangeRate, {
    companyId: company.id,
    fromCurrency: "EUR",
    toCurrency: "USD",
    date: new Date(`${day}T00:00:00.000Z`),
    rate: value,
    source: automatic ? "ECB" : "manual",
    automatic,
  });
}

async function accountId(code: string): Promise<string> {
  return (
    await AppDataSource.getRepository(Account).findOneByOrFail({ companyId: company.id, code })
  ).id;
}

/** Debits less credits on one account across the whole ledger, in home cents. */
async function balance(code: string): Promise<number> {
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId: company.id, accountId: await accountId(code) },
  });
  return lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0);
}

async function issuedInvoice(): Promise<{ slug: string; id: string }> {
  const draft = await ok("POST", "/invoices", {
    customerId: customer.id,
    currency: "EUR",
    issueDate: "2026-10-05T10:00:00.000Z",
    lines: [{ description: "EU retainer", quantity: 1, unitPriceCents: 100_000 }],
  });
  const issued = await ok("POST", `/invoices/${String(draft.slug)}/issue`);
  return { slug: String(issued.slug), id: String(issued.id) };
}

test("an invoice keeps the rate it was issued at, and a payment locks the rate of its day", async () => {
  await rate("2026-10-01", 1.1, false);
  const invoice = await issuedInvoice();
  const issued = await AppDataSource.getRepository(Invoice).findOneByOrFail({ id: invoice.id });
  assert.equal(issued.exchangeRate, 1.1);

  // The ECB's rates for the issue day and the payment day arrive afterwards.
  await rate("2026-10-05", 1.2);
  await rate("2026-10-20", 1.15);
  await ok("POST", `/invoices/${invoice.slug}/payments`, {
    amountCents: 100_000,
    paidAt: "2026-10-20T00:00:00.000Z",
    method: "bank_transfer",
  });

  const [payment] = await AppDataSource.getRepository(InvoicePayment).findBy({
    invoiceId: invoice.id,
  });
  assert.equal(payment.exchangeRate, 1.15);
  assert.equal(await balance("1200"), 0, "the receivable clears at the rate it was booked at");
  assert.equal(await balance("1100"), 115_000, "the cash comes in at the payment day's rate");
  assert.equal(await balance("4910"), -5_000, "the difference is an FX gain");

  const detail = await ok("GET", `/invoices/${invoice.slug}`);
  assert.equal(detail.homeCurrency, "USD");
  assert.equal(detail.exchangeRate, 1.1);
});

test("an invoice issued before rates were locked clears at the rate its issue entry used", async () => {
  await rate("2026-10-01", 1.1, false);
  const invoice = await issuedInvoice();
  // As every invoice issued before this release was left.
  await AppDataSource.getRepository(Invoice).update({ id: invoice.id }, { exchangeRate: null });
  await rate("2026-10-05", 1.2);
  await rate("2026-10-20", 1.15);

  await ok("POST", `/invoices/${invoice.slug}/write-off`, {
    amountCents: 40_000,
    kind: "bad_debt",
    writeOffDate: "2026-10-20T00:00:00.000Z",
  });
  await ok("POST", `/invoices/${invoice.slug}/payments`, {
    amountCents: 60_000,
    paidAt: "2026-10-20T00:00:00.000Z",
  });
  assert.equal(await balance("1200"), 0);
});

test("a bill keeps the rate it was issued at, and its payment locks the rate of its day", async () => {
  await rate("2026-10-01", 1.1, false);
  const draft = await ok("POST", "/bills", {
    vendorId: vendor.id,
    currency: "EUR",
    issueDate: "2026-10-05T10:00:00.000Z",
    lines: [
      {
        expenseAccountId: await accountId("6000"),
        description: "Servers",
        quantity: 1,
        unitPriceCents: 50_000,
      },
    ],
  });
  const issued = await ok("POST", `/bills/${String(draft.slug)}/issue`);
  const bill = await AppDataSource.getRepository(Bill).findOneByOrFail({ id: String(issued.id) });
  assert.equal(bill.exchangeRate, 1.1);

  await rate("2026-10-05", 1.2);
  await rate("2026-10-20", 1.15);
  await ok("POST", `/bills/${bill.slug}/payments`, {
    amountCents: 50_000,
    paidAt: "2026-10-20T00:00:00.000Z",
  });
  const [payment] = await AppDataSource.getRepository(BillPayment).findBy({ billId: bill.id });
  assert.equal(payment.exchangeRate, 1.15);
  assert.equal(await balance("2200"), 0, "the payable clears at the rate it was booked at");
  assert.equal(
    await balance("6900"),
    2_500,
    "paying more home currency than was owed is an FX loss",
  );
});

test("with automatic rates off, conversions use only the rates a person set", async () => {
  await rate("2026-10-01", 1.2);
  const settings = await ok("PATCH", "/finance-settings", { automaticExchangeRates: false });
  assert.equal(settings.automaticExchangeRates, false);
  const draft = await ok("POST", "/invoices", {
    customerId: customer.id,
    currency: "EUR",
    issueDate: "2026-10-05T10:00:00.000Z",
    lines: [{ description: "EU retainer", quantity: 1, unitPriceCents: 100_000 }],
  });
  const refused = await call("POST", `/invoices/${String(draft.slug)}/issue`);
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /No exchange rate available/);

  await ok("POST", "/exchange-rates", {
    fromCurrency: "EUR",
    toCurrency: "USD",
    date: "2026-10-02T00:00:00.000Z",
    rate: 1.08,
  });
  const issued = await ok("POST", `/invoices/${String(draft.slug)}/issue`);
  assert.equal(issued.exchangeRate, 1.08);
});

test("Update now fetches the ECB's rates, and the overview shows them", async () => {
  ecbAnswer = () =>
    new Response(ECB_FEED, { status: 200, headers: { "Content-Type": "text/xml" } });
  const refreshed = await ok("POST", "/exchange-rates/refresh", {});
  // EUR from the customer, and GBP from the catalog the settings seed; the
  // other catalog currencies aren't in this feed.
  assert.deepEqual(refreshed, { added: 4, latestDate: "2026-10-22" });

  const overview = await ok("GET", "/exchange-rates/overview");
  assert.deepEqual(overview.automatic, {
    enabled: true,
    available: true,
    latestDate: "2026-10-22",
  });
  const eur = (overview.rates as Array<Record<string, unknown>>).find(
    (row) => row.currency === "EUR",
  );
  assert.deepEqual(eur, {
    currency: "EUR",
    rate: 1.1205,
    date: "2026-10-22T00:00:00.000Z",
    source: "ECB",
    automatic: true,
  });

  const mine = await call("GET", "/exchange-rates?automatic=false");
  assert.deepEqual(mine.body, []);
  const fetched = await call("GET", "/exchange-rates?automatic=true");
  assert.equal((fetched.body as unknown as unknown[]).length, 4);
});

test("Update now says why when the ECB can't be reached, or automatic rates are off", async () => {
  const unreachable = await call("POST", "/exchange-rates/refresh", {});
  assert.equal(unreachable.status, 502);
  assert.match(String(unreachable.body.error), /European Central Bank/);

  await ok("PATCH", "/finance-settings", { automaticExchangeRates: false });
  const off = await call("POST", "/exchange-rates/refresh", {});
  assert.equal(off.status, 409);
});

test("turning automatic rates back on fetches them straight away", async () => {
  ecbAnswer = () => new Response(ECB_FEED, { status: 200 });
  await ok("PATCH", "/finance-settings", { automaticExchangeRates: false });
  await ok("PATCH", "/finance-settings", { automaticExchangeRates: true });
  const repo = AppDataSource.getRepository(ExchangeRate);
  for (let i = 0; i < 50 && (await repo.countBy({ companyId: company.id })) === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await repo.countBy({ companyId: company.id, automatic: true }), 4);
});
