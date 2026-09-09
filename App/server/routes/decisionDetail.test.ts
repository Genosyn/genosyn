import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import type { DecisionDTO } from "../services/decisions.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { decisionsRouter } from "./decisions.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", decisionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
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

let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let member: User;
let assignee: User;
let outsider: User;

beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, { email: "member@example.test", name: "Member", passwordHash: "x" });
  assignee = await insert(User, {
    email: "assignee@example.test",
    name: "Assignee",
    passwordHash: "x",
  });
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "x",
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: company.id, userId: assignee.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Alex",
    slug: "alex",
    role: "Operations",
  });
  actingUserId = member.id;
});

const options = [
  { id: "send", label: "Send it", detail: "Send the reviewed draft", tone: "primary" },
  { id: "wait", label: "Wait", detail: "More context needed", tone: "neutral" },
];

async function stack(overrides: Partial<Decision> = {}): Promise<Decision> {
  return insert(Decision, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Send the customer update?",
    body: "The draft and its trade-offs.",
    optionsJson: JSON.stringify(options),
    status: "pending",
    assigneeUserId: assignee.id,
    ...overrides,
  });
}

async function get<T>(path: string, companyId = company.id): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

describe("linked Decision detail route", () => {
  test("finds an older pending Decision beyond the newest 200 list entries", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    const older = await stack({ createdAt });
    const repo = AppDataSource.getRepository(Decision);
    await repo.save(
      repo.create(
        Array.from({ length: 201 }, (_, index) => ({
          companyId: company.id,
          employeeId: employee.id,
          title: `Newer Decision ${index + 1}`,
          body: "Already handled",
          optionsJson: JSON.stringify(options),
          status: "decided" as const,
          createdAt: new Date(createdAt.getTime() + (index + 1) * 1000),
        })),
      ),
    );
    const list = await get<DecisionDTO[]>("/decisions");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 200);
    assert.equal(
      list.body.some((decision) => decision.id === older.id),
      false,
    );

    const detail = await get<DecisionDTO>(`/decisions/${older.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, older.id);
    assert.equal(detail.body.companyId, company.id);
    assert.equal(detail.body.body, older.body);
    assert.equal(detail.body.status, "pending");
    assert.deepEqual(detail.body.options, options);
    assert.equal(detail.body.employee?.id, employee.id);
    assert.equal(detail.body.employee?.slug, "alex");
    assert.equal(detail.body.assignee?.id, assignee.id);
    assert.equal(detail.body.source.kind, "unknown");
  });

  test("any Member can read another assignee's Decision in every state without answering it", async () => {
    const row = await stack();
    const repo = AppDataSource.getRepository(Decision);
    for (const status of ["pending", "decided", "cancelled", "expired"] as const) {
      await repo.update(row.id, {
        status,
        chosenOptionLabel: status === "decided" ? "Wait" : null,
        note: "Discussed the timing",
        pickupStatus: "none",
        pickupSummary: "More context follows",
      });
      const beforeRow = await repo.findOneByOrFail({ id: row.id });
      const detail = await get<DecisionDTO>(`/decisions/${row.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.status, status);
      assert.equal(detail.body.assignee?.id, assignee.id);
      assert.equal(detail.body.note, "Discussed the timing");
      assert.equal(detail.body.pickupSummary, "More context follows");
      assert.deepEqual(await repo.findOneByOrFail({ id: row.id }), beforeRow);
    }
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  });

  test("requires a current authenticated company membership", async () => {
    const row = await stack();
    actingUserId = null;
    assert.equal((await get(`/decisions/${row.id}`)).status, 401);
    actingUserId = outsider.id;
    assert.equal((await get(`/decisions/${row.id}`)).status, 403);
    actingUserId = member.id;
    await AppDataSource.getRepository(Membership).delete({
      companyId: company.id,
      userId: member.id,
    });
    assert.equal((await get(`/decisions/${row.id}`)).status, 403);
  });

  test("returns the same 404 for another company's id and an absent id", async () => {
    const row = await stack();
    const foreign = await get(`/decisions/${row.id}`, otherCompany.id);
    const missing = await get("/decisions/00000000-0000-4000-8000-000000000000");
    assert.deepEqual(foreign, { status: 404, body: { error: "Not found" } });
    assert.deepEqual(missing, foreign);
    assert.equal((await get<DecisionDTO>(`/decisions/${row.id}`)).body.id, row.id);
  });

  test("rejects malformed UUID params and reports deleted Decisions as missing", async () => {
    for (const id of ["not-a-uuid", "11111111-1111-4111-8111-111111111111-extra"]) {
      const result = await get<{ error: string; issues: unknown[] }>(`/decisions/${id}`);
      assert.equal(result.status, 400);
      assert.equal(result.body.error, "ValidationError");
      assert.ok(result.body.issues.length > 0);
    }
    const row = await stack();
    await AppDataSource.getRepository(Decision).delete(row.id);
    assert.deepEqual(await get(`/decisions/${row.id}`), {
      status: 404,
      body: { error: "Not found" },
    });
  });

  test("keeps history readable after the asking employee has been deleted", async () => {
    const row = await stack({ status: "decided", chosenOptionLabel: "Wait" });
    await AppDataSource.getRepository(AIEmployee).delete(employee.id);
    const detail = await get<DecisionDTO>(`/decisions/${row.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.employee, null);
    assert.equal(detail.body.title, row.title);
    assert.equal(detail.body.chosenOptionLabel, "Wait");
  });

  test("reconciles expiry and stale pickup state consistently with the stack", async () => {
    const row = await stack({
      expiresAt: new Date(Date.now() - 60_000),
      pickupStatus: "running",
      pickupStartedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    });
    const detail = await get<DecisionDTO>(`/decisions/${row.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "expired");
    assert.equal(detail.body.pickupStatus, "failed");
    assert.match(detail.body.pickupSummary ?? "", /server stopped/i);
  });
});
