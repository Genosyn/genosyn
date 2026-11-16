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
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { Workstream } from "../db/entities/Workstream.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

/**
 * A Routine's run condition over the REST API: owners and admins set it on the
 * Routine like any other setting, and anyone in the company can ask where it
 * stands — answered by the same function the scheduler asks.
 */

let server: Server;
let baseUrl: string;
let administrator: User;
let member: User;
let acting: User;
let company: Company;
let employee: AIEmployee;
let routine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      userId: acting.id,
      sessionVersion: 0,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", routinesRouter);
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
  administrator = await insert(User, {
    name: "Admin",
    email: "admin@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    name: "Member",
    email: "member@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  acting = administrator;
  company = await insert(Company, { name: "Cond Co", slug: "cond", ownerId: administrator.id });
  await insert(Membership, { companyId: company.id, userId: administrator.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Follow through",
    slug: "follow-through",
    cronExpr: "*/30 * * * *",
    body: "Resume due work.",
  });
});

async function call(method: string, path: string, payload?: unknown) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

const saved = () => AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });

test("a new Routine runs every time, and the list says so", async () => {
  assert.equal((await saved()).runCondition, "always");
  const list = await call("GET", "/routines");
  assert.equal(list.status, 200);
  const [row] = list.body as unknown as Array<Record<string, unknown>>;
  assert.equal(row.runCondition, "always");
  assert.equal(row.nothingDueCount, 0);
  assert.equal(row.nothingDueAt, null);
});

test("an admin sets the condition; changing it starts a fresh count of declined starts", async () => {
  await AppDataSource.getRepository(Routine).update(routine.id, {
    nothingDueAt: new Date(),
    nothingDueCount: 9,
  });
  const set = await call("PATCH", `/routines/${routine.id}`, { runCondition: "workstream_due" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.runCondition, "workstream_due");
  let row = await saved();
  assert.equal(row.runCondition, "workstream_due");
  assert.equal(row.nothingDueCount, 0);
  assert.equal(row.nothingDueAt, null);
  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    action: "routine.update",
    targetId: routine.id,
  });
  assert.match(audit.metadataJson ?? "", /workstream_due/);

  // Saving the same condition again, with other settings, keeps the count.
  await AppDataSource.getRepository(Routine).update(routine.id, { nothingDueCount: 4 });
  const again = await call("PATCH", `/routines/${routine.id}`, {
    runCondition: "workstream_due",
    name: "Follow through on open work",
  });
  assert.equal(again.status, 200);
  row = await saved();
  assert.equal(row.nothingDueCount, 4);
  assert.equal(row.name, "Follow through on open work");

  const back = await call("PATCH", `/routines/${routine.id}`, { runCondition: "always" });
  assert.equal(back.status, 200);
  row = await saved();
  assert.equal(row.runCondition, "always");
  assert.equal(row.nothingDueCount, 0);
});

test("an unknown condition is refused and writes nothing", async () => {
  for (const runCondition of ["sometimes", "", null, 1, "ALWAYS"]) {
    const refused = await call("PATCH", `/routines/${routine.id}`, {
      runCondition,
      name: "Renamed",
    });
    assert.equal(refused.status, 400, JSON.stringify(runCondition));
  }
  const row = await saved();
  assert.equal(row.runCondition, "always");
  assert.equal(row.name, "Follow through");
});

test("a Member cannot change it", async () => {
  acting = member;
  const refused = await call("PATCH", `/routines/${routine.id}`, {
    runCondition: "workstream_due",
  });
  assert.equal(refused.status, 403);
  assert.equal((await saved()).runCondition, "always");
});

test("a Routine can be created with a condition", async () => {
  const created = await call("POST", `/employees/${employee.id}/routines`, {
    name: "Check due work",
    cronExpr: "*/15 * * * *",
    brief: "Resume what is due.",
    runCondition: "workstream_due",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const row = await AppDataSource.getRepository(Routine).findOneByOrFail({
    id: created.body.id as string,
  });
  assert.equal(row.runCondition, "workstream_due");
  const plain = await call("POST", `/employees/${employee.id}/routines`, {
    name: "Daily digest",
    cronExpr: "0 9 * * *",
    brief: "Write the digest.",
  });
  assert.equal(plain.status, 200);
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: plain.body.id as string }))
      .runCondition,
    "always",
  );
});

test("anyone in the company can read where the condition stands", async () => {
  await AppDataSource.getRepository(Routine).update(routine.id, { runCondition: "workstream_due" });
  const due = await insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Check the fix",
    revisitAt: new Date(Date.now() - 60_000),
  });
  await insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Waiting on the customer",
  });
  acting = member;
  const status = await call("GET", `/routines/${routine.id}/run-condition`);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.condition, "workstream_due");
  assert.equal(status.body.due, true);
  assert.deepEqual(
    (status.body.dueWorkstreams as Array<{ id: string }>).map((w) => w.id),
    [due.id],
  );
  assert.equal(status.body.unplanned, 1);
  assert.equal(status.body.nextRevisit, null);
  assert.equal(status.body.lookedAt, null);

  await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "completed",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  const after = await call("GET", `/routines/${routine.id}/run-condition`);
  assert.equal(after.body.due, false, "the Run took the revisit up");
  assert.ok(after.body.lookedAt);
});

test("a malformed, unknown or foreign Routine is refused", async () => {
  assert.equal((await call("GET", "/routines/not-a-uuid/run-condition")).status, 400);
  assert.equal((await call("GET", `/routines/${randomUUID()}/run-condition`)).status, 404);
  const elsewhere = await insert(Company, { name: "Other", slug: "other", ownerId: member.id });
  const stranger = await insert(AIEmployee, {
    companyId: elsewhere.id,
    name: "Stranger",
    slug: "stranger",
    role: "Ops",
  });
  const foreign = await insert(Routine, {
    employeeId: stranger.id,
    name: "Theirs",
    slug: "theirs",
    cronExpr: "0 9 * * *",
    runCondition: "workstream_due",
  });
  assert.equal((await call("GET", `/routines/${foreign.id}/run-condition`)).status, 404);
});
