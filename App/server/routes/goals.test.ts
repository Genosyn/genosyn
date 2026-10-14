import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { Goal } from "../db/entities/Goal.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { goalsRouter } from "./goals.js";
import { routinesRouter } from "./routines.js";

/**
 * The goal endpoints over real HTTP. `services/goals.test.ts` covers the tree
 * and settling invariants; this covers the boundary — reads are member-level,
 * every mutation (confirming a reported number included) is admin-gated, and a
 * goal of another company is unreachable whichever route carries the id.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;

before(async () => {
  // Deleting an AI Employee removes its working tree; keep that off `./data`.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-goals-routes-"));
  mutableConfig.dataDir = path.join(root, "data");
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
  app.use("/api/companies/:cid", goalsRouter);
  app.use("/api/companies/:cid", routinesRouter);
  app.use("/api/companies/:cid/employees", employeesRouter);
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
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

async function member(email: string, role: Role, companyId: string): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await member("owner@example.com", "owner" as Role, company.id);
  viewer = await member("viewer@example.com", "member" as Role, company.id);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type GoalRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  progress: number | null;
  met: boolean;
  currentValue: number | null;
  awaitingConfirmation: boolean;
};

/** A goal whose met number came from an AI Employee's report. */
async function reportedByEmployee(): Promise<Goal> {
  return insert(Goal, {
    companyId: company.id,
    title: "Signups",
    slug: "signups",
    targetValue: 10,
    ownerEmployeeId: employee.id,
    currentValue: 12,
    currentValueSource: "employee",
  });
}

describe("goal reads", () => {
  test("any member can list goals with computed progress", async () => {
    await call("POST", "/goals", { title: "Grow MRR", targetValue: 100, currentValue: 25 });
    actingUserId = viewer.id;
    const listed = await call<GoalRow[]>("GET", "/goals");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].progress, 0.25);
  });

  test("a missing goal is a 404, not an empty 200", async () => {
    const got = await call("GET", "/goals/00000000-0000-4000-8000-000000000000");
    assert.equal(got.status, 404);
  });
});

describe("goal mutations", () => {
  test("a plain member cannot create, edit, or delete a goal", async () => {
    const created = await call<GoalRow>("POST", "/goals", { title: "G", targetValue: 1 });
    assert.equal(created.status, 200);
    actingUserId = viewer.id;
    assert.equal((await call("POST", "/goals", { title: "X", targetValue: 1 })).status, 403);
    assert.equal(
      (await call("PATCH", `/goals/${created.body.id}`, { title: "X" })).status,
      403,
    );
    assert.equal((await call("DELETE", `/goals/${created.body.id}`)).status, 403);
    assert.equal(
      (await call("POST", `/goals/${created.body.id}/progress`, { value: 2 })).status,
      403,
    );
    const reported = await reportedByEmployee();
    assert.equal(
      (await call("POST", `/goals/${reported.id}/confirm`, { value: 12 })).status,
      403,
    );
  });

  test("a malformed body is a zod 400, before any write", async () => {
    const bad = await call("POST", "/goals", { title: "", targetValue: "many" });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: string }).error, "ValidationError");
  });

  test("another company's goal is unreachable through this company's routes", async () => {
    const otherFounder = await insert(User, {
      email: "other@example.com",
      name: "Other",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const otherCompany = await insert(Company, {
      name: "Rival",
      slug: "rival",
      ownerId: otherFounder.id,
    });
    const foreign = await insert(Goal, {
      companyId: otherCompany.id,
      title: "Theirs",
      slug: "theirs",
      targetValue: 1,
    });
    assert.equal((await call("PATCH", `/goals/${foreign.id}`, { title: "Mine" })).status, 400);
    assert.equal((await call("GET", `/goals/${foreign.id}`)).status, 404);
  });

  test("progress reports settle a manual goal and refuse a chart goal", async () => {
    const manual = await call<GoalRow>("POST", "/goals", { title: "Signups", targetValue: 10 });
    const reported = await call<GoalRow>("POST", `/goals/${manual.body.id}/progress`, {
      value: 12,
    });
    assert.equal(reported.status, 200);
    assert.equal(reported.body.status, "achieved");
    assert.equal(reported.body.met, true);

    const chart = await insert(Chart, {
      companyId: company.id,
      title: "MRR",
      slug: "mrr",
      connectionId: testId("conn"),
      sql: "select 1",
    });
    const bound = await call<GoalRow>("POST", "/goals", {
      title: "MRR",
      targetValue: 100,
      metricKind: "chart",
      chartId: chart.id,
    });
    assert.equal(bound.status, 200);
    const refused = await call("POST", `/goals/${bound.body.id}/progress`, { value: 5 });
    assert.equal(refused.status, 400);
  });
});

describe("confirming a number an AI Employee reported", () => {
  test("any member sees it waiting; an admin's confirmation settles it, once", async () => {
    const goal = await reportedByEmployee();
    actingUserId = viewer.id;
    const waiting = await call<GoalRow>("GET", `/goals/${goal.id}`);
    assert.equal(waiting.body.status, "active");
    assert.equal(waiting.body.awaitingConfirmation, true);

    actingUserId = owner.id;
    const confirmed = await call<GoalRow>("POST", `/goals/${goal.id}/confirm`, { value: 12 });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, "achieved");
    assert.equal(confirmed.body.awaitingConfirmation, false);
    const again = await call<{ error: string }>("POST", `/goals/${goal.id}/confirm`, { value: 12 });
    assert.equal(again.status, 400);
  });

  test("a number other than the one reported is refused, and nothing settles", async () => {
    const goal = await reportedByEmployee();
    const stale = await call<{ error: string }>("POST", `/goals/${goal.id}/confirm`, { value: 11 });
    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /changed/);
    const malformed = await call("POST", `/goals/${goal.id}/confirm`, {});
    assert.equal(malformed.status, 400);
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "active");
  });
});

describe("deleting an AI Employee", () => {
  test("leaves the goals it owned in place, unowned", async () => {
    const goal = await call<GoalRow>("POST", "/goals", {
      title: "Reply fast",
      targetValue: 4,
      ownerEmployeeId: employee.id,
    });
    const fired = await call("DELETE", `/employees/${employee.id}`);
    assert.equal(fired.status, 200);
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.body.id });
    assert.equal(after.ownerEmployeeId, null);
    assert.equal(after.status, "active");
  });
});

describe("routines declare the goal they serve", () => {
  async function addRoutine(): Promise<Routine> {
    return insert(Routine, {
      employeeId: employee.id,
      name: "Weekly report",
      slug: "weekly-report",
      cronExpr: "0 9 * * 1",
      enabled: true,
      body: "",
    });
  }

  test("PATCH /routines/:rid links and unlinks a company goal", async () => {
    const routine = await addRoutine();
    const goal = await call<GoalRow>("POST", "/goals", { title: "G", targetValue: 1 });
    const linked = await call<{ goalId: string | null }>(
      "PATCH",
      `/routines/${routine.id}`,
      { goalId: goal.body.id },
    );
    assert.equal(linked.status, 200);
    assert.equal(linked.body.goalId, goal.body.id);
    const unlinked = await call<{ goalId: string | null }>("PATCH", `/routines/${routine.id}`, {
      goalId: null,
    });
    assert.equal(unlinked.body.goalId, null);
  });

  test("a goal from another company is refused before the routine is touched", async () => {
    const routine = await addRoutine();
    const foreign = await insert(Goal, {
      companyId: testId("other-co"),
      title: "Theirs",
      slug: "theirs",
      targetValue: 1,
    });
    const refused = await call("PATCH", `/routines/${routine.id}`, { goalId: foreign.id });
    assert.equal(refused.status, 400);
  });
});
