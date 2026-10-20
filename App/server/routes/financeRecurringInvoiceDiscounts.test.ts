import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Membership } from "../db/entities/Membership.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { seedChartOfAccounts } from "../services/ledger.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * A recurring invoice carries a whole-invoice discount the way an invoice
 * does: a percentage or a fixed amount, taken off before tax, stamped on
 * every invoice the schedule creates with the same totals the invoice would
 * work out for itself.
 */

type Doc = {
  id: string;
  slug: string;
  status: string;
  discountPercent: number;
  discountAmountCents: number;
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  balanceCents: number;
  error?: string;
};

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let customer: Customer;
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
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
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

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Doc }> {
  console.log = () => undefined;
  try {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Doc };
  } finally {
    console.log = originalLog;
  }
}

function schedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: customer.id,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    lines: [
      { description: "Monthly retainer", quantity: 1, unitPriceCents: 100_000, taxRateId: vat.id },
    ],
    ...overrides,
  };
}

async function create(overrides: Record<string, unknown> = {}): Promise<Doc> {
  const created = await call("POST", "/recurring-invoices", schedule(overrides));
  assert.equal(created.status, 200, created.body.error);
  return created.body;
}

function stored(id: string): Promise<RecurringInvoice> {
  return AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({ id });
}

test("every invoice a schedule creates takes its discount before tax", async () => {
  const ri = await create({ discountPercent: 10 });
  assert.equal(ri.discountPercent, 10);
  assert.equal(ri.discountAmountCents, 0);
  // What one run bills: 100_000 less 10%, then 10% VAT on what is charged.
  assert.equal(ri.discountCents, 10_000);
  assert.equal(ri.totalCents, 99_000);

  const run = await call("POST", `/recurring-invoices/${ri.slug}/run-now`);
  assert.equal(run.status, 200, run.body.error);
  const invoice = (run.body as unknown as { invoice: Doc }).invoice;
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.discountPercent, 10);
  assert.equal(invoice.discountAmountCents, 0);
  assert.equal(invoice.discountCents, 10_000);
  assert.equal(invoice.subtotalCents, 90_000);
  assert.equal(invoice.taxCents, 9_000);
  assert.equal(invoice.totalCents, 99_000);
  assert.equal(invoice.balanceCents, 99_000);

  // Issuing recomputes the invoice from its own lines and discount: the
  // numbers the schedule wrote are the ones the invoice works out itself.
  const issued = await call("POST", `/invoices/${invoice.slug}/issue`);
  assert.equal(issued.status, 200, issued.body.error);
  assert.equal(issued.body.status, "sent");
  assert.equal(issued.body.discountCents, 10_000);
  assert.equal(issued.body.subtotalCents, 90_000);
  assert.equal(issued.body.taxCents, 9_000);
  assert.equal(issued.body.totalCents, 99_000);
});

test("a fixed discount replaces a percentage, other edits keep it, and zero for both removes it", async () => {
  const ri = await create({ discountPercent: 10 });

  const fixed = await call("PATCH", `/recurring-invoices/${ri.slug}`, {
    discountAmountCents: 25_000,
  });
  assert.equal(fixed.status, 200, fixed.body.error);
  assert.equal(fixed.body.discountPercent, 0);
  assert.equal(fixed.body.discountAmountCents, 25_000);
  assert.equal(fixed.body.discountCents, 25_000);
  assert.equal(fixed.body.totalCents, 82_500);

  const renamed = await call("PATCH", `/recurring-invoices/${ri.slug}`, { notes: "Thanks!" });
  assert.equal(renamed.status, 200, renamed.body.error);
  assert.equal(renamed.body.discountAmountCents, 25_000);

  const removed = await call("PATCH", `/recurring-invoices/${ri.slug}`, {
    discountPercent: 0,
    discountAmountCents: 0,
  });
  assert.equal(removed.status, 200, removed.body.error);
  assert.equal(removed.body.discountCents, 0);
  assert.equal(removed.body.totalCents, 110_000);
  const saved = await stored(ri.id);
  assert.equal(saved.discountPercent, 0);
  assert.equal(saved.discountAmountCents, 0);
});

test("a discount is a percentage from 0 to 100 or an amount, never both", async () => {
  const both = await call("POST", "/recurring-invoices", schedule({ discountPercent: 5, discountAmountCents: 100 }));
  assert.equal(both.status, 400);
  assert.match(both.body.error ?? "", /percentage or an amount/);
  const tooMuch = await call("POST", "/recurring-invoices", schedule({ discountPercent: 120 }));
  assert.equal(tooMuch.status, 400);
  assert.equal(await AppDataSource.getRepository(RecurringInvoice).count(), 0);

  const ri = await create({ discountPercent: 10 });
  const bothEdit = await call("PATCH", `/recurring-invoices/${ri.slug}`, {
    discountPercent: 5,
    discountAmountCents: 100,
    notes: "Not saved",
  });
  assert.equal(bothEdit.status, 400);
  const saved = await stored(ri.id);
  assert.equal(saved.discountPercent, 10);
  assert.equal(saved.notes, "");
});

test("a duplicated schedule keeps its discount", async () => {
  const ri = await create({ discountAmountCents: 5_000 });
  const copy = await call("POST", `/recurring-invoices/${ri.slug}/duplicate`);
  assert.equal(copy.status, 200, copy.body.error);
  assert.equal(copy.body.discountAmountCents, 5_000);
  assert.equal(copy.body.discountCents, 5_000);
});
