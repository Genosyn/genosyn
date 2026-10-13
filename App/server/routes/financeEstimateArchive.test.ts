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
import { Estimate } from "../db/entities/Estimate.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Archiving estimates from Finance → Estimates: the list leaves archived ones
 * out unless asked, the bulk endpoint files many away (or restores them) in
 * one request, and read-only finance access can look but not archive.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let customer: Customer;

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
  const ownerId = randomUUID();
  company = await insert(Company, {
    name: "Archive test",
    slug: `archive-test-${randomUUID()}`,
    ownerId,
  });
  actingUserId = await member("owner");
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    currency: "USD",
  });
});

async function quote(values: Partial<Estimate> = {}): Promise<Estimate> {
  return insert(Estimate, {
    companyId: company.id,
    customerId: customer.id,
    slug: `edraft-${randomUUID().slice(0, 8)}`,
    currency: "USD",
    issueDate: new Date("2026-10-01T09:00:00.000Z"),
    validUntil: new Date("2026-10-31T09:00:00.000Z"),
    ...values,
  });
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { error?: string } }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

async function listedSlugs(query = ""): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/estimates${query}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as Array<{ slug: string }>).map((row) => row.slug).sort();
}

test("the estimates list leaves archived estimates out unless archived=true", async () => {
  const active = await quote();
  const archived = await quote({ archivedAt: new Date("2026-10-02T10:00:00.000Z") });

  assert.deepEqual(await listedSlugs(), [active.slug]);
  assert.deepEqual(await listedSlugs(`?customerId=${customer.id}`), [active.slug]);
  assert.deepEqual(await listedSlugs("?archived=true"), [active.slug, archived.slug].sort());

  // An archived estimate still opens by its URL.
  const opened = await call("GET", `/estimates/${archived.slug}`);
  assert.equal(opened.status, 200, opened.body.error);
  assert.equal(opened.body.archivedAt, "2026-10-02T10:00:00.000Z");
});

test("bulk archive files the selection away, reports what it skipped, and audits once", async () => {
  const draft = await quote();
  const sent = await quote({
    slug: "acme-corp-est-0001",
    number: "ACME-CORP-EST-0001",
    numberSeq: 1,
    status: "sent",
  });
  const already = await quote({ archivedAt: new Date("2026-10-02T10:00:00.000Z") });
  const foreign = await insert(Estimate, {
    companyId: randomUUID(),
    customerId: randomUUID(),
    slug: "edraft-foreign",
    issueDate: new Date("2026-10-01T09:00:00.000Z"),
    validUntil: new Date("2026-10-31T09:00:00.000Z"),
  });

  const archived = await call("POST", "/estimates/bulk", {
    action: "archive",
    ids: [draft.id, sent.id, already.id, foreign.id],
  });
  assert.equal(archived.status, 200, archived.body.error);
  assert.deepEqual(archived.body, {
    action: "archive",
    succeeded: [draft.id, sent.id],
    skipped: [
      { id: already.id, reason: "Already archived" },
      { id: foreign.id, reason: "Estimate not found" },
    ],
  });
  assert.deepEqual(await listedSlugs(), []);
  const sentNow = await AppDataSource.getRepository(Estimate).findOneByOrFail({ id: sent.id });
  assert.equal(sentNow.status, "sent", "archiving never changes where a quote stands");
  assert.equal(
    (await AppDataSource.getRepository(Estimate).findOneByOrFail({ id: foreign.id })).archivedAt,
    null,
  );

  const audits = await AppDataSource.getRepository(AuditEvent).findBy({ companyId: company.id });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "finance.estimate.archive");
  assert.equal(audits[0].targetType, "estimate");
  assert.equal(audits[0].targetLabel, "2 estimates");
  assert.equal(audits[0].actorUserId, actingUserId);

  const restored = await call("POST", "/estimates/bulk", { action: "restore", ids: [sent.id] });
  assert.equal(restored.status, 200, restored.body.error);
  assert.deepEqual(restored.body.succeeded, [sent.id]);
  assert.deepEqual(await listedSlugs(), [sent.slug]);
  const restoreAudit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id,
    action: "finance.estimate.restore",
  });
  assert.equal(restoreAudit.targetId, sent.id);
  assert.equal(restoreAudit.targetLabel, "ACME-CORP-EST-0001");
});

test("a request that changes nothing writes no audit row", async () => {
  const active = await quote();
  const response = await call("POST", "/estimates/bulk", { action: "restore", ids: [active.id] });
  assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(response.body.succeeded, []);
  assert.deepEqual(response.body.skipped, [{ id: active.id, reason: "Not archived" }]);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ companyId: company.id }), 0);
});

test("bulk archive validates its body", async () => {
  for (const body of [
    { action: "archive", ids: [] },
    { action: "archive", ids: ["edraft-abc"] },
    { action: "delete", ids: [randomUUID()] },
    { action: "archive", ids: Array.from({ length: 501 }, () => randomUUID()) },
  ]) {
    const response = await call("POST", "/estimates/bulk", body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("read-only finance access can list archived estimates but not archive or restore", async () => {
  const active = await quote();
  const archived = await quote({ archivedAt: new Date("2026-10-02T10:00:00.000Z") });
  actingUserId = await member("member", "read");

  assert.deepEqual(await listedSlugs("?archived=true"), [active.slug, archived.slug].sort());
  for (const action of ["archive", "restore"] as const) {
    const response = await call("POST", "/estimates/bulk", {
      action,
      ids: [active.id, archived.id],
    });
    assert.equal(response.status, 403);
  }
  const rows = await AppDataSource.getRepository(Estimate).findBy({ companyId: company.id });
  assert.deepEqual(
    rows.map((row) => [row.id, row.archivedAt === null]).sort(),
    [
      [active.id, true],
      [archived.id, false],
    ].sort(),
  );
});
