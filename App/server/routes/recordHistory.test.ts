import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { digestMetadata } from "../services/recordHistory.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { recordHistoryRouter } from "./recordHistory.js";

/**
 * A record's History is readable by whoever can open the record, attributes
 * every row to the Member or AI Employee who made it, and shows nothing the
 * record's own read bar would hide — another record's rows, another company's,
 * a finance record to a Member without Finance access, a restricted Project
 * to someone outside it, or a type that has no History at all.
 */

let server: Server;
let baseUrl: string;
let viewer: User;
let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      userId: viewer.id,
      sessionVersion: 0,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", recordHistoryRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  viewer = await insert(User, {
    name: "Morgan",
    email: "morgan@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "History Co", slug: "history", ownerId: viewer.id });
  await insert(Membership, {
    companyId: company.id,
    userId: viewer.id,
    role: "member",
    financeAccess: "read",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Finance",
  });
});

async function history(targetType: string, targetId: string) {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/history/${targetType}/${targetId}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function auditRow(fields: Partial<AuditEvent>) {
  return insert(AuditEvent, {
    companyId: company.id,
    actorKind: "user",
    actorUserId: null,
    actorEmployeeId: null,
    runId: null,
    conversationId: null,
    action: "invoice.update",
    targetType: "invoice",
    targetId: null,
    targetLabel: "INV-1",
    metadataJson: "",
    ...fields,
  });
}

test("lists one record's rows newest first, naming the Member or AI Employee", async () => {
  const invoiceId = randomUUID();
  await auditRow({
    action: "finance.invoice.create",
    actorKind: "ai",
    actorEmployeeId: employee.id,
    targetId: invoiceId,
    createdAt: new Date("2026-10-01T10:00:00Z"),
  });
  await auditRow({
    action: "finance.invoice.payment",
    actorUserId: viewer.id,
    targetId: invoiceId,
    metadataJson: JSON.stringify({ amountCents: 5000, paymentId: randomUUID() }),
    createdAt: new Date("2026-10-02T10:00:00Z"),
  });
  // Another invoice's row, and the same invoice id in another company.
  await auditRow({ targetId: randomUUID() });
  const other = await insert(Company, { name: "Other", slug: "other", ownerId: viewer.id });
  await auditRow({ companyId: other.id, targetId: invoiceId });

  const { status, body } = await history("invoice", invoiceId);
  assert.equal(status, 200);
  const items = body.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.map((i) => i.action),
    ["finance.invoice.payment", "finance.invoice.create"],
  );
  assert.equal(items[0].actorKind, "user");
  assert.equal((items[0].actor as { name: string }).name, "Morgan");
  // Ids name other records and mean nothing on screen, so they never leave.
  assert.deepEqual(items[0].details, { amountCents: 5000 });
  assert.equal(items[1].actorKind, "ai");
  assert.equal((items[1].actorEmployee as { name: string }).name, "Jamie");
  assert.equal(body.nextCursor, null);
});

test("holds a finance record to the viewer's Finance access", async () => {
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: viewer.id },
    { financeAccess: "none" },
  );
  const invoiceId = randomUUID();
  await auditRow({ targetId: invoiceId });
  assert.equal((await history("invoice", invoiceId)).status, 404);
  // A Member-readable record is unaffected by Finance access.
  assert.equal((await history("routine", randomUUID())).status, 200);
});

test("refuses a type with no History", async () => {
  const id = randomUUID();
  await auditRow({ action: "vault_item.update", targetType: "vault_item", targetId: id });
  assert.equal((await history("vault_item", id)).status, 404);
  assert.equal((await history("secret", id)).status, 404);
});

test("keeps a restricted Project's History to its own members", async () => {
  const project = await insert(Project, {
    companyId: company.id,
    name: "Board pack",
    slug: "board-pack",
    key: "BRD",
    accessMode: "restricted",
  });
  assert.equal((await history("project", project.id)).status, 404);
  const open = await insert(Project, {
    companyId: company.id,
    name: "Launch",
    slug: "launch",
    key: "LCH",
    accessMode: "open",
  });
  assert.equal((await history("project", open.id)).status, 200);
});

test("digests metadata to field names and safe scalars", () => {
  assert.deepEqual(
    digestMetadata({
      changes: { name: "New", cronExpr: "0 9 * * *" },
      status: "sent",
      toAddress: "billing@example.test",
      apiToken: "sk-live-123",
      employeeId: randomUUID(),
      nested: { deep: true },
    }),
    {
      changedFields: ["name", "cronExpr"],
      details: { status: "sent", toAddress: "billing@example.test" },
    },
  );
  assert.deepEqual(digestMetadata({ before: { a: 1, b: 2 }, after: { a: 1, b: 3 } }), {
    changedFields: ["b"],
    details: {},
  });
});
