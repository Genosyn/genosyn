import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { seedChartOfAccounts } from "../services/ledger.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Archiving invoices from Finance → Invoices: the list leaves archived ones
 * out unless asked, the bulk endpoint files away only invoices with nothing
 * left to collect, an archived invoice that is owed money again comes back by
 * itself, and read-only finance access can look but not archive.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let customer: Customer;

const originalLog = console.log;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
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

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function member(role: Role, financeAccess?: "read" | "full"): Promise<string> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.com`,
    name: role,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role,
    ...(financeAccess ? { financeAccess } : {}),
  });
  return user.id;
}

beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, {
    name: "Archive test",
    slug: `archive-test-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  actingUserId = await member("owner");
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "ap@acme.example",
    currency: "USD",
  });
  await seedChartOfAccounts(company.id);
});

type Body = Record<string, unknown> & { error?: string };

/** Quiet: an unconfigured transport prints every email to the console. */
async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Body }> {
  console.log = () => undefined;
  try {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Body };
  } finally {
    console.log = originalLog;
  }
}

/** A fixture row; the tests that need real money flows go through the routes. */
async function invoice(values: Partial<Invoice> = {}): Promise<Invoice> {
  return insert(Invoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: `draft-${randomUUID().slice(0, 8)}`,
    currency: "USD",
    issueDate: new Date("2026-10-01T09:00:00.000Z"),
    dueDate: new Date("2026-10-31T09:00:00.000Z"),
    ...values,
  });
}

/** A draft for $1,000, made the way the New invoice form makes one. */
async function draft(): Promise<Body> {
  const created = await call("POST", "/invoices", {
    customerId: customer.id,
    issueDate: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-10-31T00:00:00.000Z",
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 100_000 }],
  });
  assert.equal(created.status, 200, created.body.error);
  return created.body;
}

async function issued(): Promise<Body> {
  const made = await draft();
  const done = await call("POST", `/invoices/${made.slug}/issue`);
  assert.equal(done.status, 200, done.body.error);
  return done.body;
}

async function archive(ids: string[]): Promise<Body> {
  const response = await call("POST", "/invoices/bulk", { action: "archive", ids });
  assert.equal(response.status, 200, response.body.error);
  return response.body;
}

const stored = (id: string) => AppDataSource.getRepository(Invoice).findOneByOrFail({ id });

async function listedIds(query = ""): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/invoices${query}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as Array<{ id: string }>).map((row) => row.id).sort();
}

test("the invoices list leaves archived invoices out unless archived=true", async () => {
  const active = await invoice();
  const archived = await invoice({
    status: "paid",
    slug: "acme-corp-inv-0001",
    number: "ACME-CORP-INV-0001",
    numberSeq: 1,
    archivedAt: new Date("2026-10-02T10:00:00.000Z"),
  });

  assert.deepEqual(await listedIds(), [active.id]);
  assert.deepEqual(await listedIds(`?customerId=${customer.id}`), [active.id]);
  assert.deepEqual(await listedIds("?archived=true"), [active.id, archived.id].sort());

  // An archived invoice still opens by its URL, and says so.
  const opened = await call("GET", `/invoices/${archived.slug}`);
  assert.equal(opened.status, 200, opened.body.error);
  assert.equal(opened.body.archivedAt, "2026-10-02T10:00:00.000Z");
});

test("bulk archive files away invoices with nothing left to collect and skips the rest", async () => {
  const unissued = await draft();
  const owed = await issued();
  const paidInvoice = await issued();
  const paid = await call("POST", `/invoices/${paidInvoice.slug}/payments`, {
    amountCents: 100_000,
  });
  assert.equal(paid.body.status, "paid", paid.body.error);
  const writtenOff = await issued();
  const cleared = await call("POST", `/invoices/${writtenOff.slug}/write-off`, {
    amountCents: 100_000,
    kind: "bad_debt",
  });
  assert.equal(cleared.status, 200, cleared.body.error);
  const voidedInvoice = await issued();
  const voided = await call("POST", `/invoices/${voidedInvoice.slug}/void`);
  assert.equal(voided.status, 200, voided.body.error);
  const already = await invoice({ archivedAt: new Date("2026-10-02T10:00:00.000Z") });
  const foreign = await insert(Invoice, {
    companyId: randomUUID(),
    customerId: randomUUID(),
    slug: "draft-foreign",
    issueDate: new Date("2026-10-01T09:00:00.000Z"),
    dueDate: new Date("2026-10-31T09:00:00.000Z"),
  });
  const before = await stored(String(paidInvoice.id));

  const result = await archive([
    String(unissued.id),
    String(owed.id),
    String(paidInvoice.id),
    String(writtenOff.id),
    String(voidedInvoice.id),
    already.id,
    foreign.id,
  ]);
  assert.deepEqual(result, {
    action: "archive",
    succeeded: [unissued.id, paidInvoice.id, writtenOff.id, voidedInvoice.id],
    skipped: [
      { id: owed.id, reason: "Has a balance due" },
      { id: already.id, reason: "Already archived" },
      { id: foreign.id, reason: "Invoice not found" },
    ],
  });
  assert.deepEqual(await listedIds(), [owed.id]);
  assert.equal((await stored(String(owed.id))).archivedAt, null, "money owed stays in the list");
  assert.equal((await stored(foreign.id)).archivedAt, null, "another company's row is untouched");

  // Archiving is a timestamp and nothing else.
  const after = await stored(String(paidInvoice.id));
  assert.ok(after.archivedAt instanceof Date);
  assert.deepEqual(
    { ...after, archivedAt: null, updatedAt: null },
    { ...before, archivedAt: null, updatedAt: null },
  );

  // One History row per archived invoice.
  const audits = await AppDataSource.getRepository(AuditEvent).findBy({
    companyId: company.id,
    action: "finance.invoice.archive",
  });
  assert.deepEqual(
    audits.map((a) => a.targetId).sort(),
    [unissued.id, paidInvoice.id, writtenOff.id, voidedInvoice.id].sort(),
  );
  for (const a of audits) {
    assert.equal(a.targetType, "invoice");
    assert.equal(a.actorUserId, actingUserId);
  }
  assert.equal(
    audits.find((a) => a.targetId === paidInvoice.id)?.targetLabel,
    paidInvoice.number,
  );

  const restored = await call("POST", "/invoices/bulk", {
    action: "restore",
    ids: [paidInvoice.id],
  });
  assert.equal(restored.status, 200, restored.body.error);
  assert.deepEqual(restored.body.succeeded, [paidInvoice.id]);
  assert.deepEqual(await listedIds(), [owed.id, paidInvoice.id].sort());
  const restoreAudit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id,
    action: "finance.invoice.restore",
  });
  assert.equal(restoreAudit.targetId, paidInvoice.id);
});

test("an archived invoice that is owed money again comes back to the list", async () => {
  // A paid invoice whose payment is deleted.
  const paidInvoice = await issued();
  await call("POST", `/invoices/${paidInvoice.slug}/payments`, { amountCents: 100_000 });
  // A written-off invoice whose write-off is reversed.
  const writtenOff = await issued();
  await call("POST", `/invoices/${writtenOff.slug}/write-off`, {
    amountCents: 100_000,
    kind: "bad_debt",
  });
  // A draft that is issued.
  const unissued = await draft();
  // A void invoice stays filed: it owes nothing at all.
  const voidedInvoice = await issued();
  await call("POST", `/invoices/${voidedInvoice.slug}/void`);
  const ids = [paidInvoice.id, writtenOff.id, unissued.id, voidedInvoice.id].map(String);
  assert.deepEqual((await archive(ids)).succeeded, ids);
  assert.deepEqual(await listedIds(), []);

  const detail = await call("GET", `/invoices/${paidInvoice.slug}`);
  const payments = detail.body.payments as Array<{ id: string }>;
  const removed = await call("DELETE", `/invoices/${paidInvoice.slug}/payments/${payments[0].id}`);
  assert.equal(removed.status, 200, removed.body.error);
  assert.equal(removed.body.status, "sent");
  assert.equal(removed.body.archivedAt, null);

  const writeOffs = (await call("GET", `/invoices/${writtenOff.slug}`)).body.writeOffs as Array<{
    id: string;
  }>;
  const reversed = await call("DELETE", `/invoices/${writtenOff.slug}/write-offs/${writeOffs[0].id}`);
  assert.equal(reversed.status, 200, reversed.body.error);
  assert.equal(reversed.body.archivedAt, null);

  const issuedNow = await call("POST", `/invoices/${unissued.slug}/issue`);
  assert.equal(issuedNow.status, 200, issuedNow.body.error);
  assert.equal(issuedNow.body.status, "sent");
  assert.equal(issuedNow.body.archivedAt, null);

  assert.deepEqual(
    await listedIds(),
    [paidInvoice.id, writtenOff.id, unissued.id].map(String).sort(),
  );
  assert.ok((await stored(String(voidedInvoice.id))).archivedAt instanceof Date);
});

test("a request that changes nothing writes no audit row", async () => {
  const active = await invoice();
  const response = await call("POST", "/invoices/bulk", { action: "restore", ids: [active.id] });
  assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(response.body.succeeded, []);
  assert.deepEqual(response.body.skipped, [{ id: active.id, reason: "Not archived" }]);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ companyId: company.id }), 0);
});

test("bulk archive validates its body", async () => {
  for (const body of [
    { action: "archive", ids: [] },
    { action: "archive", ids: ["draft-abc"] },
    { action: "void", ids: [randomUUID()] },
    { action: "archive", ids: Array.from({ length: 501 }, () => randomUUID()) },
  ]) {
    const response = await call("POST", "/invoices/bulk", body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("read-only finance access can list archived invoices but not archive or restore", async () => {
  const active = await invoice();
  const archived = await invoice({ archivedAt: new Date("2026-10-02T10:00:00.000Z") });
  actingUserId = await member("member", "read");

  assert.deepEqual(await listedIds("?archived=true"), [active.id, archived.id].sort());
  for (const action of ["archive", "restore"] as const) {
    const response = await call("POST", "/invoices/bulk", { action, ids: [active.id, archived.id] });
    assert.equal(response.status, 403);
  }
  assert.equal((await stored(active.id)).archivedAt, null);
  assert.ok((await stored(archived.id)).archivedAt instanceof Date);
});
