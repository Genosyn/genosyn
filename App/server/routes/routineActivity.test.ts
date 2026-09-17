import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import type { RoutineActivityRun } from "../services/routineActivity.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null;
let company: Company;
let member: User;
let outsider: User;
let employee: AIEmployee;
let routine: Routine;

// Midnight in the Member's timezone, rather than the server's calendar day.
const from = "2026-09-17T00:00:00+01:00";
const to = "2026-09-18T00:00:00+01:00";
const at = (hours: number) => new Date(Date.parse(from) + hours * 60 * 60 * 1000);
type RunBody = Omit<RoutineActivityRun, "startedAt" | "finishedAt" | "retryAt"> & {
  startedAt: string;
  finishedAt: string | null;
  retryAt: string | null;
};
type ActivityBody = {
  running: RunBody[];
  today: { routineId: string; runCount: number; latestRun: RunBody }[];
};

before(async () => {
  await initTestDb();
  const app = express();
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, {
    email: "member@example.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "private soul",
  });
  routine = await seedRoutine();
  actingUserId = member.id;
});

async function seedRoutine(employeeId = employee.id, name = "Daily report") {
  return insert(Routine, {
    employeeId,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    cronExpr: "0 9 * * *",
    body: "private brief",
  });
}

async function seedRun(overrides: Partial<Run> = {}): Promise<Run> {
  return insert(Run, {
    routineId: routine.id,
    status: "completed",
    startedAt: at(8),
    finishedAt: at(9),
    logContent: "private transcript",
    outcomeNote: "private assessment",
    failureReason: "private failure",
    exitCode: 0,
    ...overrides,
  });
}

async function call(query: Record<string, string> = { from, to }, companyId = company.id) {
  const response = await fetch(
    `${baseUrl}/api/companies/${companyId}/routines/activity?${new URLSearchParams(query)}`,
  );
  return { status: response.status, body: (await response.json()) as ActivityBody };
}

test("ordinary Members can read the overview; strangers and anonymous callers cannot", async () => {
  assert.equal((await call()).status, 200);
  actingUserId = outsider.id;
  assert.equal((await call()).status, 403);
  actingUserId = null;
  assert.equal((await call()).status, 401);
});

test("a company with no Runs returns empty sections", async () => {
  assert.deepEqual((await call()).body, { running: [], today: [] });
  await AppDataSource.getRepository(Routine).delete(routine.id);
  await AppDataSource.getRepository(AIEmployee).delete(employee.id);
  assert.deepEqual((await call()).body, { running: [], today: [] });
});

test("both sections follow Routine ownership and exclude another company's work", async () => {
  const otherCompany = await insert(Company, {
    name: "Other",
    slug: "other",
    ownerId: outsider.id,
  });
  const otherEmployee = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Other",
    slug: "other",
    role: "Support",
    soulBody: "",
  });
  const otherRoutine = await seedRoutine(otherEmployee.id);
  await seedRun({ routineId: otherRoutine.id });
  await seedRun({ routineId: otherRoutine.id, status: "running", finishedAt: null });
  const ours = await seedRun();
  const running = await seedRun({ status: "running", finishedAt: null });
  const { body } = await call();
  assert.deepEqual(
    body.running.map((run) => run.id),
    [running.id],
  );
  assert.deepEqual(
    body.today.map((row) => row.latestRun.id),
    [ours.id],
  );
  assert.equal((await call({ from, to }, otherCompany.id)).status, 403);
});

test("all active Runs appear, including overnight work and concurrent Runs of one Routine", async () => {
  const overnight = await seedRun({ status: "running", startedAt: at(-30), finishedAt: null });
  const current = await seedRun({ status: "running", startedAt: at(2), finishedAt: null });
  const { body } = await call();
  assert.deepEqual(
    body.running.map((run) => run.id),
    [current.id, overnight.id],
  );
  assert.deepEqual(body.today, []);
  await AppDataSource.getRepository(Run).update([overnight.id, current.id], {
    status: "completed",
    finishedAt: at(3),
  });
  const finished = (await call()).body;
  assert.deepEqual(finished.running, []);
  assert.equal(finished.today[0].runCount, 2);
});

test("local midnight is inclusive, the next midnight is exclusive, and overnight completion counts", async () => {
  const cases: Array<{ name: string; startedAt: Date; finishedAt: Date | null; include: boolean }> =
    [
      { name: "Starts at midnight", startedAt: at(0), finishedAt: null, include: true },
      { name: "Ends at midnight", startedAt: at(-2), finishedAt: at(0), include: true },
      { name: "Overnight", startedAt: at(-2), finishedAt: at(1), include: true },
      { name: "Ends tomorrow", startedAt: at(23), finishedAt: at(25), include: true },
      { name: "Only yesterday", startedAt: at(-2), finishedAt: at(-1), include: false },
      { name: "Starts tomorrow", startedAt: at(24), finishedAt: at(25), include: false },
      { name: "Neither edge today", startedAt: at(-1), finishedAt: at(24), include: false },
    ];
  const expected = new Set<string>();
  for (const item of cases) {
    const row = await seedRoutine(employee.id, item.name);
    await seedRun({ routineId: row.id, startedAt: item.startedAt, finishedAt: item.finishedAt });
    if (item.include) expected.add(row.id);
  }
  const { body } = await call();
  assert.deepEqual(new Set(body.today.map((row) => row.routineId)), expected);
  assert.ok(body.today.every((row) => row.runCount === 1));
});

test("today counts every terminal Run except skipped ticks and retains the latest completion", async () => {
  const statuses: RunStatus[] = [
    "completed",
    "reviewed",
    "failed",
    "error",
    "timeout",
    "interrupted",
  ];
  for (const [index, status] of statuses.entries()) {
    await seedRun({ status, startedAt: at(index), finishedAt: at(index + 0.5) });
  }
  const latest = await seedRun({ startedAt: at(-1), finishedAt: at(7), status: "failed" });
  await seedRun({ status: "skipped", startedAt: at(9), finishedAt: at(10) });
  await seedRun({ status: "running", startedAt: at(11), finishedAt: null });
  const { body } = await call();
  assert.equal(body.today.length, 1);
  assert.equal(body.today[0].runCount, statuses.length + 1);
  assert.equal(body.today[0].latestRun.id, latest.id);
  assert.equal(body.today[0].latestRun.status, "failed");
});

test("latest Run ties are deterministic and older full history does not affect the daily count", async () => {
  await seedRun({ startedAt: at(-24), finishedAt: at(-23) });
  await seedRun({ id: "00000000-0000-4000-8000-000000000001", startedAt: at(9), finishedAt: null });
  const latest = await seedRun({
    id: "00000000-0000-4000-8000-000000000002",
    startedAt: at(9),
    finishedAt: null,
  });
  const { body } = await call();
  assert.equal(body.today.length, 1);
  assert.equal(body.today[0].runCount, 2);
  assert.equal(body.today[0].latestRun.id, latest.id);
});

test("summaries contain only safe metadata and preserve independent outcome and Check verdicts", async () => {
  await seedRun({ outcomeVerdict: "unverified", checksVerdict: "failed" });
  await seedRun({ status: "running", finishedAt: null });
  const { body } = await call();
  const fields = [
    "id",
    "routineId",
    "status",
    "errorKind",
    "startedAt",
    "finishedAt",
    "exitCode",
    "attempt",
    "retryAt",
    "missedSlots",
    "outcomeVerdict",
    "checksVerdict",
  ].sort();
  assert.deepEqual(Object.keys(body.running[0]).sort(), fields);
  assert.deepEqual(Object.keys(body.today[0].latestRun).sort(), fields);
  assert.equal(body.today[0].latestRun.outcomeVerdict, "unverified");
  assert.equal(body.today[0].latestRun.checksVerdict, "failed");
  assert.doesNotMatch(
    JSON.stringify(body),
    /private|logContent|failureReason|outcomeNote|soulBody|body/,
  );
});

test("the API requires valid instants, a company UUID, and a bounded forward interval", async () => {
  const invalid: Record<string, string>[] = [
    {},
    { from },
    { to },
    { from: "bad", to },
    { from: "2026-09-17", to },
    { from: "2026-09-17T00:00:00", to },
    { from, to: from },
    { from: to, to: from },
    { from, to: at(26.1).toISOString() },
    { from, to, hours: "100" },
  ];
  for (const query of invalid) {
    assert.equal((await call(query)).status, 400, JSON.stringify(query));
  }
  assert.equal((await call({ from, to }, "invalid-company-id")).status, 400);
  assert.equal((await call({ from, to: at(26).toISOString() })).status, 200);
});

test("a 25-hour day spanning the autumn clock change is accepted", async () => {
  const autumnFrom = "2026-10-25T00:00:00+01:00";
  const autumnTo = "2026-10-26T00:00:00+00:00";
  const latest = await seedRun({
    startedAt: new Date("2026-10-25T23:30:00Z"),
    finishedAt: new Date("2026-10-25T23:45:00Z"),
  });
  const { status, body } = await call({ from: autumnFrom, to: autumnTo });
  assert.equal(status, 200);
  assert.equal(body.today[0].latestRun.id, latest.id);
});
