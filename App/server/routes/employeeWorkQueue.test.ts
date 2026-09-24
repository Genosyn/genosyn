import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Standdown } from "../db/entities/Standdown.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import type { EmployeeWorkQueue } from "../services/employeeWorkQueue.js";
import { claimRetryDispatch } from "../services/runRecovery.js";
import { refreshStanddowns } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { employeeWorkQueueRouter } from "./employeeWorkQueue.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null;
let company: Company;
let employee: AIEmployee;
let routine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(async (req, _res, next) => {
    req.session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", employeeWorkQueueRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  await refreshStanddowns();
  const member = await insert(User, {
    email: "queue-member@example.test", name: "Member", passwordHash: "x", sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id, name: "Rey", slug: "rey", role: "Support", soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id, name: "Daily digest", slug: "daily-digest", cronExpr: "0 9 * * *", body: "",
  });
  actingUserId = member.id;
});

async function seedRun(overrides: Partial<Run> = {}): Promise<Run> {
  return insert(Run, {
    employeeId: employee.id,
    routineId: routine.id,
    status: "queued",
    triggerKind: "manual",
    startedAt: new Date("2026-09-24T08:00:00Z"),
    createdAt: new Date("2026-09-24T08:00:00Z"),
    ...overrides,
  });
}

async function call(eid = employee.id, suffix = "", cid = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${cid}/employees/${eid}/work-queue${suffix}`);
  return { status: response.status, body: await response.json() as EmployeeWorkQueue };
}

test("an ordinary Member sees active and FIFO pending work without internal payloads", async () => {
  const active = await seedRun({ status: "running", queueActiveEmployeeId: employee.id });
  const second = await seedRun({
    createdAt: new Date("2026-09-24T08:02:00Z"),
    queueOptionsJson: JSON.stringify({ proactiveApprovalId: "private-authority" }),
    logContent: "private-transcript",
    checkpointJson: "private-checkpoint",
  });
  const first = await seedRun({ createdAt: new Date("2026-09-24T08:01:00Z") });
  await seedRun({ status: "completed" });
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.employeeId, employee.id);
  assert.equal(body.current?.runId, active.id);
  assert.equal(body.current?.position, null);
  assert.equal(body.pendingCount, 2);
  assert.deepEqual(body.pending.map((row) => [row.runId, row.position]), [[first.id, 1], [second.id, 2]]);
  assert.deepEqual(body.pending[0].routine, { id: routine.id, name: routine.name, slug: routine.slug });
  assert.doesNotMatch(JSON.stringify(body), /private-|queueOptionsJson|queueActiveEmployeeId|checkpointJson|logContent/);
});

test("a finishing Run still occupies the current slot until its cleanup completes", async () => {
  const active = await seedRun({ status: "completed", queueActiveEmployeeId: employee.id });
  assert.equal((await call()).body.current?.runId, active.id);
});

test("empty, unauthenticated, foreign company and foreign employee queues stay distinct", async () => {
  assert.deepEqual((await call()).body, { employeeId: employee.id, current: null, pending: [], pendingCount: 0 });
  assert.equal((await call(randomUUID())).status, 404);
  const foreign = await insert(AIEmployee, { companyId: randomUUID(), name: "Other", slug: "other", role: "", soulBody: "" });
  assert.equal((await call(foreign.id)).status, 404);
  assert.equal((await call(employee.id, "", randomUUID())).status, 403);
  actingUserId = null;
  assert.equal((await call()).status, 401);
});

test("validates employee identifiers and rejects unknown query fields", async () => {
  assert.equal((await call("invalid")).status, 400);
  assert.equal((await call(employee.id, "?since=yesterday")).status, 400);
});

test("excludes another employee's Runs and stale ownership after reassignment", async () => {
  await seedRun({ employeeId: randomUUID() });
  const otherRoutine = await insert(Routine, {
    employeeId: randomUUID(), name: "Other", slug: "other", cronExpr: "0 9 * * *", body: "",
  });
  await seedRun({ routineId: otherRoutine.id });
  assert.equal((await call()).body.pendingCount, 0);
});

test("shows delayed retries once, without exposing internal dispatch claim dates", async () => {
  const due = new Date(Date.now() + 60_000);
  const retry = await seedRun({ status: "error", triggerKind: "schedule", retryAt: due });
  let queue = (await call()).body;
  assert.equal(queue.pending[0].triggerKind, "retry");
  assert.equal(queue.pending[0].availableAt, due.toISOString());
  assert.equal(queue.pending[0].runId, null);
  await claimRetryDispatch(retry.id, due);
  queue = (await call()).body;
  assert.equal(queue.pending[0].availableAt, null);
  const child = await seedRun({ parentRunId: retry.id, triggerKind: "retry" });
  queue = (await call()).body;
  assert.equal(queue.pendingCount, 1);
  assert.equal(queue.pending[0].runId, child.id);
});

test("Standdown reasons accompany pending work and do not expose credentials", async () => {
  await seedRun();
  await insert(Standdown, {
    companyId: company.id, scope: "employee", scopeId: employee.id,
    reason: "Review access; password: hidden-secret", placedAt: new Date(),
  });
  await refreshStanddowns();
  const { body } = await call();
  assert.match(body.pending[0].blockedReason ?? "", /Stood down: Review access/);
  assert.doesNotMatch(JSON.stringify(body), /hidden-secret/);
});

test("bounds the preview while preserving the full pending count", async () => {
  for (let i = 0; i < 103; i++) {
    await seedRun({ createdAt: new Date(Date.UTC(2026, 8, 24, 8, i)) });
  }
  const { body } = await call();
  assert.equal(body.pending.length, 100);
  assert.equal(body.pendingCount, 103);
  assert.equal(body.pending[99].position, 100);
});
