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
import { Standdown } from "../db/entities/Standdown.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  registerResourceChangeSink,
  registerRoutineTriggerSink,
} from "../services/resourceEvents.js";
import {
  liftStanddown,
  placeStanddown,
  refreshStanddowns,
  serializeStanddown,
  stopStanddowns,
  workBlocked,
} from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

let server: Server;
let baseUrl = "";
let memberId = "";
let company: Company;
let employee: AIEmployee;
let routine: Routine;
let siblingRoutine: Routine;
let unaffectedRoutine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      userId: memberId,
      sessionVersion: 0,
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", routinesRouter);
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
  stopStanddowns();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  await refreshStanddowns();
  const member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  memberId = member.id;
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  const otherEmployee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Grace",
    slug: "grace",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Collections",
    slug: "collections",
    cronExpr: "0 9 * * *",
    enabled: true,
    body: "",
  });
  siblingRoutine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily report",
    slug: "daily-report",
    cronExpr: "0 10 * * *",
    enabled: false,
    body: "",
  });
  unaffectedRoutine = await insert(Routine, {
    employeeId: otherEmployee.id,
    name: "Inbox",
    slug: "inbox",
    cronExpr: "0 11 * * *",
    enabled: true,
    body: "",
  });
});

type RoutineResponse = {
  id: string;
  employeeId: string;
  enabled: boolean;
  standdown: ReturnType<typeof serializeStanddown> | null;
};

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`);
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}

async function list(): Promise<Map<string, RoutineResponse>> {
  const rows = await get<RoutineResponse[]>("/routines");
  assert.equal(rows.length, 3);
  return new Map(rows.map((row) => [row.id, row]));
}

test("ordinary Members see a Routine standdown on only the affected list row and detail", async () => {
  const standdown = await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: routine.id,
    reason: "Check duplicate collections",
    source: "breaker",
  });

  const rows = await list();
  assert.deepEqual(rows.get(routine.id)?.standdown, serializeStanddown(standdown));
  assert.equal(rows.get(routine.id)?.enabled, true);
  assert.equal(rows.get(siblingRoutine.id)?.standdown, null);
  assert.equal(rows.get(unaffectedRoutine.id)?.standdown, null);
  const detail = await get<RoutineResponse>(`/routines/${routine.id}`);
  assert.deepEqual(detail.standdown, rows.get(routine.id)?.standdown);
});

test("an employee Standdown covers their enabled and paused Routines without changing the switches", async () => {
  const standdown = await placeStanddown({
    companyId: company.id,
    scope: "employee",
    scopeId: employee.id,
    reason: "Review this employee's work",
  });

  const rows = await list();
  assert.equal(rows.get(routine.id)?.standdown?.id, standdown.id);
  assert.equal(rows.get(siblingRoutine.id)?.standdown?.id, standdown.id);
  assert.equal(rows.get(routine.id)?.enabled, true);
  assert.equal(rows.get(siblingRoutine.id)?.enabled, false);
  assert.equal(rows.get(unaffectedRoutine.id)?.standdown, null);
});

test("company coverage takes precedence and lifting wider Standdowns reveals the remaining stop", async () => {
  const routineStop = await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: routine.id,
    reason: "Review collections",
  });
  const employeeStop = await placeStanddown({
    companyId: company.id,
    scope: "employee",
    scopeId: employee.id,
    reason: "Review employee",
  });
  const companyStop = await placeStanddown({
    companyId: company.id,
    scope: "company",
    reason: "Company incident",
  });

  for (const row of (await list()).values()) assert.equal(row.standdown?.id, companyStop.id);
  assert.equal((await get<RoutineResponse>(`/routines/${routine.id}`)).standdown?.id, companyStop.id);

  await liftStanddown({ standdown: companyStop });
  let rows = await list();
  assert.equal(rows.get(routine.id)?.standdown?.id, employeeStop.id);
  assert.equal(rows.get(siblingRoutine.id)?.standdown?.id, employeeStop.id);
  assert.equal(rows.get(unaffectedRoutine.id)?.standdown, null);

  await liftStanddown({ standdown: employeeStop });
  rows = await list();
  assert.equal(rows.get(routine.id)?.standdown?.id, routineStop.id);
  assert.equal(rows.get(siblingRoutine.id)?.standdown, null);

  await liftStanddown({ standdown: routineStop });
  for (const row of (await list()).values()) assert.equal(row.standdown, null);
  assert.equal((await get<RoutineResponse>(`/routines/${routine.id}`)).standdown, null);
});

test("the list follows the enforcement cache and never applies another company's Standdown", async () => {
  // A row another replica wrote becomes effective here only when the cache
  // refreshes. The list must agree with dispatch on both sides of that refresh.
  const standdown = await insert(Standdown, {
    companyId: company.id,
    scope: "routine",
    scopeId: routine.id,
    reason: "Remote stop",
    placedAt: new Date(),
  });
  await insert(Standdown, {
    companyId: "another-company",
    scope: "company",
    reason: "Other company's incident",
    placedAt: new Date(),
  });
  for (const row of (await list()).values()) assert.equal(row.standdown, null);

  await refreshStanddowns();
  const rows = await list();
  assert.equal(rows.get(routine.id)?.standdown?.id, standdown.id);
  assert.equal(rows.get(siblingRoutine.id)?.standdown, null);
  assert.equal(rows.get(unaffectedRoutine.id)?.standdown, null);
});

test("placement and lifting refresh open lists after enforcement changes without firing Routine Triggers", async () => {
  const changes: Array<{ companyId: string; kind: string; scopes: string[]; blocked: boolean }> = [];
  const triggers: string[] = [];
  registerResourceChangeSink((companyId, kind, scopes) => {
    changes.push({
      companyId,
      kind,
      scopes,
      blocked: workBlocked(company.id, { employeeId: employee.id, routineId: routine.id }).blocked,
    });
  });
  registerRoutineTriggerSink((_companyId, kind) => triggers.push(kind));
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

  try {
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "Review collections",
    });
    await drain();
    assert.deepEqual(changes, [
      { companyId: company.id, kind: "standdown", scopes: [], blocked: true },
    ]);
    assert.equal((await list()).get(routine.id)?.standdown?.id, standdown.id);
    await refreshStanddowns();
    await drain();
    assert.equal(changes.length, 1, "refresh must not repeat the local placement event");

    await liftStanddown({ standdown });
    await drain();
    assert.deepEqual(changes, [
      { companyId: company.id, kind: "standdown", scopes: [], blocked: true },
      { companyId: company.id, kind: "standdown", scopes: [], blocked: false },
    ]);
    assert.equal((await list()).get(routine.id)?.standdown, null);
    await refreshStanddowns();
    await drain();
    assert.equal(changes.length, 2, "refresh must not repeat the local lift event");
    assert.deepEqual(triggers, []);
  } finally {
    registerResourceChangeSink(() => {});
    registerRoutineTriggerSink(() => {});
  }
});

test("remote Standdown changes refresh only affected companies after the cache catches up", async () => {
  const changes: Array<{ companyId: string; kind: string; scopes: string[]; blocked: boolean }> = [];
  const triggers: string[] = [];
  registerResourceChangeSink((companyId, kind, scopes) => {
    changes.push({
      companyId,
      kind,
      scopes,
      blocked: workBlocked(companyId, { employeeId: employee.id, routineId: routine.id }).blocked,
    });
  });
  registerRoutineTriggerSink((_companyId, kind) => triggers.push(kind));
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

  try {
    const standdown = await insert(Standdown, {
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "Remote stop",
      placedAt: new Date(),
    });
    await insert(Standdown, {
      companyId: "another-company",
      scope: "company",
      reason: "Other company's incident",
      placedAt: new Date(),
    });
    await drain();
    assert.deepEqual(changes, []);
    assert.equal((await list()).get(routine.id)?.standdown, null);

    await refreshStanddowns();
    await drain();
    assert.deepEqual(
      [...changes].sort((a, b) => a.companyId.localeCompare(b.companyId)),
      [
        { companyId: company.id, kind: "standdown", scopes: [], blocked: true },
        { companyId: "another-company", kind: "standdown", scopes: [], blocked: true },
      ].sort((a, b) => a.companyId.localeCompare(b.companyId)),
    );
    assert.equal((await list()).get(routine.id)?.standdown?.id, standdown.id);

    await refreshStanddowns();
    await drain();
    assert.equal(changes.length, 2, "unchanged refresh must not emit another event");

    await AppDataSource.getRepository(Standdown).update(standdown.id, { liftedAt: new Date() });
    assert.equal((await list()).get(routine.id)?.standdown?.id, standdown.id);
    await refreshStanddowns();
    await drain();
    assert.deepEqual(changes.slice(2), [
      { companyId: company.id, kind: "standdown", scopes: [], blocked: false },
    ]);
    assert.equal((await list()).get(routine.id)?.standdown, null);

    await refreshStanddowns();
    await drain();
    assert.equal(changes.length, 3, "unchanged refresh after a lift must not emit another event");
    assert.deepEqual(triggers, []);
  } finally {
    registerResourceChangeSink(() => {});
    registerRoutineTriggerSink(() => {});
  }
});
