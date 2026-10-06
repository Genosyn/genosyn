import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Membership } from "../db/entities/Membership.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { RECURRING_INVOICE_NAME_REQUIRED_ERROR } from "../services/recurringInvoices.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * A recurring invoice is named after its customer unless someone names it:
 * the create route fills in an omitted or blank name the way the New
 * recurring invoice form pre-fills it, and edits never rename a schedule
 * behind the person's back.
 */

type Schedule = { id: string; slug: string; name: string; customerId: string; error?: string };

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let customer: Customer;
let other: Customer;

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
    name: "SMC Partners LLC, d/b/a Hyphen",
    slug: "smc-partners",
    email: "ap@hyphen.example",
    domain: "hyphen.example",
    currency: "USD",
  });
  other = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
    currency: "EUR",
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The form's own payload, minus whatever the test leaves out. */
function schedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: customer.id,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    intervalCount: 1,
    daysUntilDue: 14,
    autoSend: false,
    lines: [{ description: "Monthly retainer", quantity: 1, unitPriceCents: 250_000 }],
    ...overrides,
  };
}

async function create(overrides: Record<string, unknown> = {}): Promise<Schedule> {
  const response = await request("/recurring-invoices", "POST", schedule(overrides));
  const body = (await response.json()) as Schedule;
  assert.equal(response.status, 200, body.error);
  return body;
}

async function storedName(id: string): Promise<string> {
  return (await AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({ id })).name;
}

function countSchedules(): Promise<number> {
  return AppDataSource.getRepository(RecurringInvoice).count();
}

test("a schedule created without a name is named after its customer", async () => {
  const created = await create();
  assert.equal(created.name, "SMC Partners LLC, d/b/a Hyphen");
  assert.equal(created.customerId, customer.id);
  assert.equal(await storedName(created.id), "SMC Partners LLC, d/b/a Hyphen");

  const fetched = (await (await request(`/recurring-invoices/${created.slug}`)).json()) as Schedule;
  assert.equal(fetched.name, "SMC Partners LLC, d/b/a Hyphen");
  const listed = (await (
    await request(`/recurring-invoices?customerId=${customer.id}`)
  ).json()) as Schedule[];
  assert.deepEqual(
    listed.map((row) => row.name),
    ["SMC Partners LLC, d/b/a Hyphen"],
  );
  assert.equal(
    await AppDataSource.getRepository(RecurringInvoiceLineItem).countBy({
      recurringInvoiceId: created.id,
    }),
    1,
  );
  assert.equal(await AppDataSource.getRepository(Invoice).count(), 0, "creating never bills");
});

test("a blank or whitespace-only name also falls back to the customer's name", async () => {
  for (const name of ["", " ", "   ", "\n\t "]) {
    const created = await create({ name, customerId: other.id });
    assert.equal(created.name, "Acme Corp", JSON.stringify(name));
    assert.equal(await storedName(created.id), "Acme Corp");
  }
  assert.equal(await countSchedules(), 4);
});

test("a name that is given is kept, trimmed, and two schedules may share a name", async () => {
  const first = await create({ name: "  Monthly retainer — Hyphen  " });
  assert.equal(first.name, "Monthly retainer — Hyphen");
  assert.equal(await storedName(first.id), "Monthly retainer — Hyphen");

  const second = await create({ name: "Monthly retainer — Hyphen" });
  assert.notEqual(second.slug, first.slug);
  assert.equal(second.name, first.name);

  const named = await create({ name: "Acme Corp" });
  assert.equal(named.name, "Acme Corp", "a given name wins even when it is another customer's");
  assert.equal(named.customerId, customer.id);
});

test("the name limit still applies to a given name, measured after trimming", async () => {
  const exact = "N".repeat(200);
  assert.equal((await create({ name: exact })).name, exact);
  assert.equal((await create({ name: `  ${exact}  ` })).name, exact);

  const tooLong = await request("/recurring-invoices", "POST", schedule({ name: "N".repeat(201) }));
  assert.equal(tooLong.status, 400);
  assert.equal(((await tooLong.json()) as { error: string }).error, "ValidationError");
  assert.equal(await countSchedules(), 2);
});

test("a name that is not a string is refused rather than defaulted", async () => {
  for (const name of [null, 42, true, ["Acme"], { text: "Acme" }]) {
    const response = await request("/recurring-invoices", "POST", schedule({ name }));
    assert.equal(response.status, 400, JSON.stringify(name));
  }
  assert.equal(await countSchedules(), 0);
});

test("an imported customer's long, multi-line name becomes a one-line name within the limit", async () => {
  const imported = await insert(Customer, {
    companyId: company.id,
    name: `Northwind\nTraders   ${"International Holdings ".repeat(12)}Group`,
    slug: "northwind",
    currency: "USD",
  });
  const created = await create({ customerId: imported.id });
  assert.equal(created.name.length <= 200, true);
  assert.equal(created.name.includes("\n"), false);
  assert.equal(created.name.includes("  "), false);
  assert.match(created.name, /^Northwind Traders International Holdings /);
  assert.equal(created.name, created.name.trim());
});

test("a customer without a name lends its domain, then its email, and with neither the create is refused", async () => {
  const withDomain = await insert(Customer, {
    companyId: company.id,
    name: " ",
    slug: "domain-only",
    domain: "domain-only.example",
    email: "ap@domain-only.example",
  });
  assert.equal((await create({ customerId: withDomain.id })).name, "domain-only.example");

  const withEmail = await insert(Customer, {
    companyId: company.id,
    name: "",
    slug: "email-only",
    email: "ap@email-only.example",
  });
  assert.equal((await create({ customerId: withEmail.id })).name, "ap@email-only.example");

  const anonymous = await insert(Customer, { companyId: company.id, name: "", slug: "anonymous" });
  const refused = await request("/recurring-invoices", "POST", schedule({ customerId: anonymous.id }));
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { error: string }).error, RECURRING_INVOICE_NAME_REQUIRED_ERROR);
  assert.equal(await countSchedules(), 2);

  const named = await create({ customerId: anonymous.id, name: "Anonymous retainer" });
  assert.equal(named.name, "Anonymous retainer");
});

test("another company's customer is refused before its name is ever used", async () => {
  const foreignCompany = await insert(Company, {
    name: "Other Co",
    slug: randomUUID(),
    ownerId: "someone-else",
  });
  const foreign = await insert(Customer, {
    companyId: foreignCompany.id,
    name: "Foreign Customer Ltd",
    slug: "foreign-customer",
    email: "ap@foreign.example",
  });
  for (const overrides of [{}, { name: "" }, { name: "Named anyway" }]) {
    const response = await request(
      "/recurring-invoices",
      "POST",
      schedule({ ...overrides, customerId: foreign.id }),
    );
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "Invalid customer");
  }
  const missing = await request("/recurring-invoices", "POST", schedule({ customerId: randomUUID() }));
  assert.equal(missing.status, 400);
  const malformed = await request("/recurring-invoices", "POST", schedule({ customerId: "acme" }));
  assert.equal(malformed.status, 400);
  const absent = await request("/recurring-invoices", "POST", schedule({ customerId: undefined }));
  assert.equal(absent.status, 400);
  assert.equal(await countSchedules(), 0);
});

test("only full Finance access can create a schedule, named or not", async () => {
  const member = await insert(User, {
    email: `member-${randomUUID()}@example.com`,
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const membership = await insert(Membership, {
    companyId: company.id,
    userId: member.id,
    role: "member",
    financeAccess: "none",
  });
  actingUserId = member.id;

  for (const access of ["none", "read"] as const) {
    await AppDataSource.getRepository(Membership).update(membership.id, { financeAccess: access });
    for (const overrides of [{}, { name: "" }, { name: "Named" }]) {
      const response = await request("/recurring-invoices", "POST", schedule(overrides));
      assert.equal(response.status, 403, `${access} ${JSON.stringify(overrides)}`);
    }
  }
  assert.equal(await countSchedules(), 0);

  await AppDataSource.getRepository(Membership).update(membership.id, { financeAccess: "full" });
  assert.equal((await create()).name, "SMC Partners LLC, d/b/a Hyphen");

  const admin = await insert(User, {
    email: `admin-${randomUUID()}@example.com`,
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  actingUserId = admin.id;
  assert.equal((await create({ customerId: other.id })).name, "Acme Corp");

  const outsider = await insert(User, {
    email: `outsider-${randomUUID()}@example.com`,
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = outsider.id;
  const refused = await request("/recurring-invoices", "POST", schedule());
  assert.equal(refused.status, 403, "a non-member cannot create in the company at all");
  assert.equal(await countSchedules(), 2);
});

test("changing a schedule's customer never renames it", async () => {
  const defaulted = await create();
  const moved = await request(`/recurring-invoices/${defaulted.slug}`, "PATCH", {
    customerId: other.id,
  });
  assert.equal(moved.status, 200);
  const body = (await moved.json()) as Schedule;
  assert.equal(body.customerId, other.id);
  assert.equal(body.name, "SMC Partners LLC, d/b/a Hyphen");
  assert.equal(await storedName(defaulted.id), "SMC Partners LLC, d/b/a Hyphen");

  const named = await create({ name: "Quarterly support" });
  const notes = await request(`/recurring-invoices/${named.slug}`, "PATCH", {
    customerId: other.id,
    notes: "Moved to Acme",
    cronExpr: "0 9 1 1,4,7,10 *",
    frequency: "quarterly",
  });
  assert.equal(notes.status, 200);
  assert.equal(((await notes.json()) as Schedule).name, "Quarterly support");
});

test("an edit renames a schedule only when it sends a name, and a sent name cannot be blank", async () => {
  const created = await create();
  const renamed = await request(`/recurring-invoices/${created.slug}`, "PATCH", {
    name: "  Hyphen retainer  ",
  });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as Schedule).name, "Hyphen retainer");

  for (const name of ["", "   ", "\n"]) {
    const response = await request(`/recurring-invoices/${created.slug}`, "PATCH", { name });
    assert.equal(response.status, 400, JSON.stringify(name));
  }
  const tooLong = await request(`/recurring-invoices/${created.slug}`, "PATCH", {
    name: "N".repeat(201),
  });
  assert.equal(tooLong.status, 400);
  assert.equal(await storedName(created.id), "Hyphen retainer");

  const untouched = await request(`/recurring-invoices/${created.slug}`, "PATCH", {
    daysUntilDue: 30,
  });
  assert.equal(untouched.status, 200);
  assert.equal(((await untouched.json()) as Schedule).name, "Hyphen retainer");
});

test("schedules saved before names defaulted keep their names through every edit", async () => {
  const legacy = await insert(RecurringInvoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: "ri-legacy",
    name: "Monthly retainer — SMC Partners LLC, d/b/a Hyphen",
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    intervalCount: 1,
    status: "active",
    daysUntilDue: 14,
    autoSend: false,
    currency: "USD",
    notes: "",
    footer: "",
    runsCreated: 0,
    lastInvoiceSlug: "",
    maxRuns: null,
    endsOn: null,
    createdById: null,
  });
  const fetched = (await (await request("/recurring-invoices/ri-legacy")).json()) as Schedule;
  assert.equal(fetched.name, legacy.name);

  for (const patch of [{ customerId: other.id }, { notes: "Updated" }, { status: "paused" }]) {
    const response = await request("/recurring-invoices/ri-legacy", "PATCH", patch);
    assert.equal(response.status, 200, JSON.stringify(patch));
    assert.equal(((await response.json()) as Schedule).name, legacy.name);
  }
  assert.equal(await storedName(legacy.id), legacy.name);
});

test("a duplicated schedule copies the name it has, not its customer's", async () => {
  const created = await create({ name: "Hyphen retainer" });
  const copied = await request(`/recurring-invoices/${created.slug}/duplicate`, "POST");
  assert.equal(copied.status, 200);
  assert.equal(((await copied.json()) as Schedule).name, "Hyphen retainer (copy)");
});
