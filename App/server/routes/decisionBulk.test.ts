import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { createDecision } from "../services/decisions.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { decisionsRouter } from "./decisions.js";

/**
 * The Decision stack's bulk bar, at the route: a selection is dismissed or
 * snoozed in one request, and every Decision in it is still held to its own
 * row's rules — who may answer it, which company it belongs to, whether it
 * is still waiting. A selection never answers anything.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", decisionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let otherEmployee: AIEmployee;
let owner: User;
let member: User;
let teammate: User;

beforeEach(async () => {
  await resetTestDb();
  owner = await createUser("owner@example.com", "Owner");
  member = await createUser("member@example.com", "Member");
  teammate = await createUser("teammate@example.com", "Teammate");
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  await insert(Membership, { companyId: company.id, userId: teammate.id, role: "member" as Role });
  await insert(Membership, { companyId: otherCompany.id, userId: owner.id, role: "owner" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Operator",
    slug: "operator",
    role: "Operations",
  });
  otherEmployee = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Elsewhere",
    slug: "elsewhere",
    role: "Operations",
  });
  actingUserId = member.id;
});

async function createUser(email: string, name: string): Promise<User> {
  return insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
}

async function stack(title: string, changes: { assigneeUserId?: string } = {}) {
  const { decision } = await createDecision({
    companyId: company.id,
    employeeId: employee.id,
    title,
    options: [{ label: "Go ahead", tone: "primary" }, { label: "Hold" }],
    ...changes,
  });
  return decision;
}

async function stored(id: string): Promise<Decision> {
  return AppDataSource.getRepository(Decision).findOneByOrFail({ id });
}

type BulkResult = {
  action: string;
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
};

async function bulk(
  body: unknown,
  companyId = company.id,
): Promise<{ status: number; body: BulkResult & { error?: string } }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/decisions/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("dismissing a selection", () => {
  test("every Decision is dismissed on its own: status, journal, audit and no pickup", async () => {
    const first = await stack("Renew the Acme contract?");
    const second = await stack("Bid on the UTA RFP?");
    const third = await stack("Keep the old pricing page?");

    const response = await bulk({ action: "dismiss", ids: [first.id, second.id] });

    assert.equal(response.status, 200);
    assert.equal(response.body.action, "dismiss");
    assert.deepEqual(response.body.succeeded, [first.id, second.id]);
    assert.deepEqual(response.body.skipped, []);
    for (const id of [first.id, second.id]) {
      const row = await stored(id);
      assert.equal(row.status, "cancelled");
      assert.equal(row.decidedByUserId, member.id);
      assert.equal(row.chosenOptionId, null, "dismissing chooses nothing");
      assert.equal(row.pickupStatus, "none", "dismissing starts no work");
    }
    assert.equal((await stored(third.id)).status, "pending", "an unselected row is untouched");

    const journal = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId: employee.id },
    });
    assert.deepEqual(journal.map((entry) => entry.title).sort(), [
      'A teammate dismissed the decision "Bid on the UTA RFP?" without choosing',
      'A teammate dismissed the decision "Renew the Acme contract?" without choosing',
    ]);
    const audits = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id, action: "decision.cancel" },
    });
    assert.deepEqual(audits.map((event) => event.targetId).sort(), [first.id, second.id].sort());
  });

  test("a row that fails its own rules is skipped with the reason and the rest still go", async () => {
    const open = await stack("Renew the Acme contract?");
    const forTeammate = await stack("Approve Teammate's travel?", {
      assigneeUserId: teammate.id,
    });
    const answered = await stack("Bid on the UTA RFP?");
    await AppDataSource.getRepository(Decision).update(
      { id: answered.id },
      { status: "decided", chosenOptionId: "go-ahead", decidedByUserId: owner.id },
    );
    const { decision: elsewhere } = await createDecision({
      companyId: otherCompany.id,
      employeeId: otherEmployee.id,
      title: "Another company's question",
      options: [{ label: "Yes" }],
    });
    const unknown = crypto.randomUUID();

    const response = await bulk({
      action: "dismiss",
      ids: [forTeammate.id, answered.id, elsewhere.id, unknown, open.id],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, [open.id]);
    assert.deepEqual(response.body.skipped, [
      { id: forTeammate.id, reason: "Assigned to another teammate" },
      { id: answered.id, reason: "Already answered" },
      { id: elsewhere.id, reason: "Decision not found" },
      { id: unknown, reason: "Decision not found" },
    ]);
    assert.equal((await stored(open.id)).status, "cancelled");
    assert.equal((await stored(forTeammate.id)).status, "pending");
    assert.equal((await stored(answered.id)).status, "decided");
    assert.equal((await stored(elsewhere.id)).status, "pending");
  });

  test("an owner may dismiss a Decision assigned to somebody else, as on its row", async () => {
    const forTeammate = await stack("Approve Teammate's travel?", {
      assigneeUserId: teammate.id,
    });
    actingUserId = owner.id;
    const response = await bulk({ action: "dismiss", ids: [forTeammate.id] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, [forTeammate.id]);
    assert.equal((await stored(forTeammate.id)).status, "cancelled");
  });

  test("a repeated id is dismissed once", async () => {
    const decision = await stack("Renew the Acme contract?");
    const response = await bulk({ action: "dismiss", ids: [decision.id, decision.id] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, [decision.id]);
    assert.deepEqual(response.body.skipped, []);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).count({
        where: { companyId: company.id, action: "decision.cancel" },
      }),
      1,
    );
  });
});

describe("snoozing a selection", () => {
  test("every Decision is snoozed until the same time and leaves the waiting list", async () => {
    const first = await stack("Renew the Acme contract?");
    const second = await stack("Bid on the UTA RFP?");
    const before = Date.now();

    const response = await bulk({
      action: "snooze",
      duration: "one_week",
      ids: [first.id, second.id],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, [first.id, second.id]);
    for (const id of [first.id, second.id]) {
      const row = await stored(id);
      assert.equal(row.status, "pending", "snoozing answers nothing");
      const until = row.snoozedUntil?.getTime() ?? 0;
      assert.ok(until >= before + 7 * 86_400_000 - 1_000, "snoozed for a week");
    }
    const list = await fetch(`${baseUrl}/api/companies/${company.id}/decisions?status=pending`, {
      headers: { connection: "close" },
    });
    assert.deepEqual(await list.json(), []);
  });

  test("a settled Decision is skipped rather than snoozed", async () => {
    const decision = await stack("Renew the Acme contract?");
    await bulk({ action: "dismiss", ids: [decision.id] });
    const response = await bulk({ action: "snooze", duration: "one_day", ids: [decision.id] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, []);
    assert.deepEqual(response.body.skipped, [{ id: decision.id, reason: "Already dismissed" }]);
    assert.equal((await stored(decision.id)).snoozedUntil, null);
  });
});

describe("bulk request validation", () => {
  test("only dismiss and snooze exist: a selection can never answer", async () => {
    const decision = await stack("Renew the Acme contract?");
    const response = await bulk({ action: "decide", optionId: "go-ahead", ids: [decision.id] });
    assert.equal(response.status, 400);
    assert.equal((await stored(decision.id)).status, "pending");
  });

  test("snooze needs one of the preset durations, and dismiss takes none", async () => {
    const decision = await stack("Renew the Acme contract?");
    assert.equal((await bulk({ action: "snooze", ids: [decision.id] })).status, 400);
    assert.equal(
      (await bulk({ action: "snooze", duration: "tomorrow", ids: [decision.id] })).status,
      400,
    );
    assert.equal(
      (await bulk({ action: "dismiss", duration: "one_day", ids: [decision.id] })).status,
      400,
    );
    assert.equal((await stored(decision.id)).status, "pending");
  });

  test("ids must be one to two hundred uuids", async () => {
    assert.equal((await bulk({ action: "dismiss", ids: [] })).status, 400);
    assert.equal((await bulk({ action: "dismiss", ids: ["not-a-uuid"] })).status, 400);
    const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
    assert.equal((await bulk({ action: "dismiss", ids: tooMany })).status, 400);
  });

  test("callers outside the company are turned away", async () => {
    const decision = await stack("Renew the Acme contract?");
    actingUserId = null;
    assert.equal((await bulk({ action: "dismiss", ids: [decision.id] })).status, 401);
    actingUserId = member.id;
    assert.equal(
      (await bulk({ action: "dismiss", ids: [decision.id] }, otherCompany.id)).status,
      403,
    );
    assert.equal((await stored(decision.id)).status, "pending");
  });
});
