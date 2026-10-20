import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Membership } from "../db/entities/Membership.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * A recurring invoice's page lists every invoice it has created: each one a
 * scheduled run or Run now makes names the schedule, the invoice list filters
 * on it, and an invoice shows which schedule it came from.
 */

type Stub = { id: string; name: string; slug: string };
type InvoiceRow = {
  id: string;
  slug: string;
  recurringInvoiceId: string | null;
  recurringInvoice: Stub | null;
  error?: string;
};
type Schedule = { id: string; slug: string; name: string; error?: string };

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let customer: Customer;

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
  company = await insert(Company, { name: "Hyphen Billing", slug: randomUUID(), ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
    currency: "USD",
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { error?: string };
  assert.equal(response.status, 200, `${method} ${path}: ${json.error ?? ""}`);
  return json;
}

const lines = [{ description: "Monthly retainer", quantity: 1, unitPriceCents: 250_000 }];

function createSchedule(name: string): Promise<Schedule> {
  return call<Schedule>("/recurring-invoices", "POST", {
    customerId: customer.id,
    name,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    lines,
  });
}

async function runNow(schedule: Schedule): Promise<InvoiceRow> {
  return (await call<{ invoice: InvoiceRow }>(`/recurring-invoices/${schedule.slug}/run-now`, "POST"))
    .invoice;
}

const createdBy = (schedule: Schedule, archived = true) =>
  call<InvoiceRow[]>(
    `/invoices?recurringInvoiceId=${schedule.id}${archived ? "&archived=true" : ""}`,
  );

test("the invoice list filters to one schedule's invoices, newest first, archived ones on request", async () => {
  const retainer = await createSchedule("Retainer");
  const licence = await createSchedule("Licence");
  const first = await runNow(retainer);
  const second = await runNow(retainer);
  const theirs = await runNow(licence);
  const byHand = await call<InvoiceRow>("/invoices", "POST", { customerId: customer.id, lines });

  const stub = { id: retainer.id, name: "Retainer", slug: retainer.slug };
  assert.equal(first.recurringInvoiceId, retainer.id, "Run now hands back the invoice linked");
  assert.deepEqual(
    (await createdBy(retainer)).map((row) => [row.id, row.recurringInvoice]),
    [
      [second.id, stub],
      [first.id, stub],
    ],
  );
  assert.deepEqual(
    (await createdBy(licence)).map((row) => row.id),
    [theirs.id],
  );

  // Archiving a draft files it away from the default list, not from history.
  await call("/invoices/bulk", "POST", { action: "archive", ids: [first.id] });
  assert.deepEqual(
    (await createdBy(retainer, false)).map((row) => row.id),
    [second.id],
  );
  assert.deepEqual(
    (await createdBy(retainer)).map((row) => row.id),
    [second.id, first.id],
  );

  const everything = await call<InvoiceRow[]>("/invoices?archived=true");
  assert.equal(everything.length, 4);
  assert.equal(everything.find((row) => row.id === byHand.id)?.recurringInvoice, null);

  const detail = await call<InvoiceRow>(`/invoices/${second.slug}`);
  assert.deepEqual(detail.recurringInvoice, stub, "an invoice's own page names its schedule");
  const handMade = await call<InvoiceRow>(`/invoices/${byHand.slug}`);
  assert.equal(handMade.recurringInvoice, null);
});

test("another company's schedule filters this company's list to nothing", async () => {
  const elsewhere = await insert(Company, { name: "Other", slug: randomUUID(), ownerId: "x" });
  const theirCustomer = await insert(Customer, {
    companyId: elsewhere.id,
    name: "Beta",
    slug: "beta",
  });
  const theirSchedule = await insert(RecurringInvoice, {
    companyId: elsewhere.id,
    customerId: theirCustomer.id,
    slug: "ri-theirs",
    name: "Their retainer",
    cronExpr: "0 9 1 * *",
  });
  await insert(Invoice, {
    companyId: elsewhere.id,
    customerId: theirCustomer.id,
    recurringInvoiceId: theirSchedule.id,
    slug: "draft-theirs",
    issueDate: new Date(),
    dueDate: new Date(),
  });
  assert.deepEqual(
    await call(`/invoices?recurringInvoiceId=${theirSchedule.id}&archived=true`),
    [],
  );
});

test("deleting a schedule keeps the invoices it created, no longer linked", async () => {
  const retainer = await createSchedule("Retainer");
  const first = await runNow(retainer);
  const second = await runNow(retainer);

  await call(`/recurring-invoices/${retainer.slug}`, "DELETE");

  assert.deepEqual(await createdBy(retainer), []);
  const kept = await call<InvoiceRow[]>("/invoices?archived=true");
  assert.deepEqual(kept.map((row) => row.id).sort(), [first.id, second.id].sort());
  assert.ok(kept.every((row) => row.recurringInvoice === null));
});
