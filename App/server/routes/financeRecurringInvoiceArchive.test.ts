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
import { Membership, type Role } from "../db/entities/Membership.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * Archiving recurring invoice schedules from Finance → Recurring: only a
 * paused or ended schedule can be filed away, the list leaves archived ones
 * out unless asked, and resuming an archived schedule brings it back — so a
 * schedule that bills is never out of sight.
 */

type Body = Record<string, unknown> & { error?: string };

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
  company = await insert(Company, { name: "Retainers", slug: randomUUID(), ownerId: randomUUID() });
  actingUserId = await member("owner");
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
    currency: "USD",
  });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

/** A monthly retainer, made the way the New recurring invoice form makes one. */
async function schedule(name: string, status: "active" | "paused" | "ended"): Promise<Body> {
  const created = await call("POST", "/recurring-invoices", {
    customerId: customer.id,
    name,
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    status: status === "ended" ? "paused" : status,
    lines: [{ description: "Monthly retainer", quantity: 1, unitPriceCents: 250_000 }],
  });
  assert.equal(created.status, 200, created.body.error);
  if (status !== "ended") return created.body;
  const ended = await call("PATCH", `/recurring-invoices/${created.body.slug}`, { status: "ended" });
  assert.equal(ended.status, 200, ended.body.error);
  return ended.body;
}

const stored = (id: unknown) =>
  AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({ id: String(id) });

async function listedNames(query = ""): Promise<string[]> {
  const response = await call("GET", `/recurring-invoices${query}`);
  assert.equal(response.status, 200);
  return (response.body as unknown as Array<{ name: string }>).map((row) => row.name).sort();
}

test("bulk archive files away paused and ended schedules and skips an active one", async () => {
  const running = await schedule("Running", "active");
  const paused = await schedule("Paused", "paused");
  const ended = await schedule("Ended", "ended");
  const foreign = randomUUID();
  const before = await stored(paused.id);

  const archived = await call("POST", "/recurring-invoices/bulk", {
    action: "archive",
    ids: [running.id, paused.id, ended.id, foreign],
  });
  assert.equal(archived.status, 200, archived.body.error);
  assert.deepEqual(archived.body, {
    action: "archive",
    succeeded: [paused.id, ended.id],
    skipped: [
      { id: running.id, reason: "Still active" },
      { id: foreign, reason: "Recurring invoice not found" },
    ],
  });
  assert.deepEqual(await listedNames(), ["Running"]);
  assert.deepEqual(await listedNames(`?customerId=${customer.id}`), ["Running"]);
  assert.deepEqual(await listedNames("?archived=true"), ["Ended", "Paused", "Running"]);

  // Archiving is a timestamp and nothing else; the schedule still opens.
  const after = await stored(paused.id);
  assert.ok(after.archivedAt instanceof Date);
  assert.deepEqual(
    { ...after, archivedAt: null, updatedAt: null },
    { ...before, archivedAt: null, updatedAt: null },
  );
  const opened = await call("GET", `/recurring-invoices/${paused.slug}`);
  assert.equal(opened.status, 200, opened.body.error);
  assert.equal(opened.body.archivedAt, after.archivedAt?.toISOString());

  const audits = await AppDataSource.getRepository(AuditEvent).findBy({
    companyId: company.id,
    action: "finance.recurring_invoice.archive",
  });
  assert.deepEqual(audits.map((a) => a.targetId).sort(), [paused.id, ended.id].sort());
  assert.deepEqual(audits.map((a) => a.targetLabel).sort(), ["Ended", "Paused"]);

  const restored = await call("POST", "/recurring-invoices/bulk", {
    action: "restore",
    ids: [ended.id, running.id],
  });
  assert.equal(restored.status, 200, restored.body.error);
  assert.deepEqual(restored.body.succeeded, [ended.id]);
  assert.deepEqual(restored.body.skipped, [{ id: running.id, reason: "Not archived" }]);
  assert.deepEqual(await listedNames(), ["Ended", "Running"]);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({
      companyId: company.id,
      action: "finance.recurring_invoice.restore",
    }),
    1,
  );
});

test("resuming an archived schedule brings it back to the list", async () => {
  const paused = await schedule("Paused", "paused");
  await call("POST", "/recurring-invoices/bulk", { action: "archive", ids: [paused.id] });
  assert.deepEqual(await listedNames(), []);

  // Edits and pausing again leave it filed away.
  const edited = await call("PATCH", `/recurring-invoices/${paused.slug}`, { daysUntilDue: 30 });
  assert.equal(edited.status, 200, edited.body.error);
  assert.ok(edited.body.archivedAt);

  const resumed = await call("PATCH", `/recurring-invoices/${paused.slug}`, { status: "active" });
  assert.equal(resumed.status, 200, resumed.body.error);
  assert.equal(resumed.body.status, "active");
  assert.equal(resumed.body.archivedAt, null);
  assert.ok(resumed.body.nextRunAt, "it bills again, so it is listed again");
  assert.deepEqual(await listedNames(), ["Paused"]);
});

test("a schedule that ends the moment it is resumed stays archived", async () => {
  const paused = await schedule("Capped", "paused");
  // Its one allowed run is used up, so resuming ends it at once.
  await AppDataSource.getRepository(RecurringInvoice).update(
    { id: String(paused.id) },
    { maxRuns: 1, runsCreated: 1 },
  );
  await call("POST", "/recurring-invoices/bulk", { action: "archive", ids: [paused.id] });

  const resumed = await call("PATCH", `/recurring-invoices/${paused.slug}`, { status: "active" });
  assert.equal(resumed.status, 200, resumed.body.error);
  assert.equal(resumed.body.status, "ended");
  assert.ok(resumed.body.archivedAt, "it bills nobody, so it may stay where it was filed");
});

test("bulk archive validates its body, and read-only finance access cannot use it", async () => {
  for (const body of [
    { action: "archive", ids: [] },
    { action: "archive", ids: ["ri-abc123"] },
    { action: "pause", ids: [randomUUID()] },
    { action: "archive", ids: Array.from({ length: 501 }, () => randomUUID()) },
  ]) {
    const response = await call("POST", "/recurring-invoices/bulk", body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }

  const paused = await schedule("Paused", "paused");
  actingUserId = await member("member", "read");
  assert.deepEqual(await listedNames("?archived=true"), ["Paused"]);
  const refused = await call("POST", "/recurring-invoices/bulk", {
    action: "archive",
    ids: [paused.id],
  });
  assert.equal(refused.status, 403);
  assert.equal((await stored(paused.id)).archivedAt, null);
});
