import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { refreshStanddowns, workBlocked } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { standdownsRouter } from "./standdowns.js";

/**
 * M58's stop button at the HTTP boundary: every Member may see that work has
 * stopped, only an admin may stop or resume it, the scope rules are refused
 * before they reach the service, and pressing an already-pressed button twice
 * is unambiguous in both directions.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;
let routine: Routine;
let owner: User;
let viewer: User;

/** A second company, for the cross-company scoping assertions. */
let otherCompany: Company;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", standdownsRouter);
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

beforeEach(async () => {
  await resetTestDb();
  // The enforcement cache is module state and outlives the rows the harness
  // just dropped. Reloading it here is what stops one test's standdown from
  // still blocking work in the next one.
  await refreshStanddowns();

  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: founder.id });
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, {
    companyId: otherCompany.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  viewer = await insert(User, {
    email: "viewer@example.com",
    name: "Viewer",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: viewer.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Collections",
    slug: "collections",
    cronExpr: "0 9 * * *",
    body: "",
  });
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId: string = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type SerializedStanddown = {
  id: string;
  scope: string;
  scopeId: string | null;
  reason: string;
  source: string;
  active: boolean;
  liftedAt: string | null;
};

describe("placing and lifting a standdown", () => {
  test("admin places and lifts; a member may read but never touch either lever", async () => {
    const placed = await call<SerializedStanddown>("POST", "/standdowns", {
      scope: "company",
      reason: "The mail automation went haywire overnight",
    });
    assert.equal(placed.status, 200);
    assert.equal(placed.body.scope, "company");
    assert.equal(placed.body.source, "human");
    assert.equal(placed.body.active, true);
    // The button's own replica enforces the stop immediately, not at the next
    // refresh — the whole reason `placeStanddown` writes through the cache.
    assert.equal(workBlocked(company.id).blocked, true);

    actingUserId = viewer.id;
    const listed = await call<{ standdowns: SerializedStanddown[] }>("GET", "/standdowns");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.standdowns.length, 1);

    const refusedPlace = await call("POST", "/standdowns", {
      scope: "company",
      reason: "me too",
    });
    assert.equal(refusedPlace.status, 403);
    const refusedLift = await call("POST", `/standdowns/${placed.body.id}/lift`, {});
    assert.equal(refusedLift.status, 403);

    actingUserId = owner.id;
    const lifted = await call<SerializedStanddown>("POST", `/standdowns/${placed.body.id}/lift`, {
      reason: "Root cause fixed",
    });
    assert.equal(lifted.status, 200);
    assert.equal(lifted.body.active, false);
    assert.ok(lifted.body.liftedAt);
    assert.equal(workBlocked(company.id).blocked, false);
  });

  test("placing the same scope twice returns the standing row rather than stacking a second", async () => {
    const first = await call<SerializedStanddown>("POST", "/standdowns", {
      scope: "employee",
      scopeId: employee.id,
      reason: "Ada is emailing the wrong list",
    });
    const second = await call<SerializedStanddown>("POST", "/standdowns", {
      scope: "employee",
      scopeId: employee.id,
      reason: "pressing it again",
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.reason, "Ada is emailing the wrong list");

    const listed = await call<{ standdowns: SerializedStanddown[] }>(
      "GET",
      "/standdowns?active=true",
    );
    assert.equal(listed.body.standdowns.length, 1);
  });

  test("lifting twice is refused — a second press must not read as success", async () => {
    const placed = await call<SerializedStanddown>("POST", "/standdowns", {
      scope: "routine",
      scopeId: routine.id,
      reason: "Collections double-charged",
    });
    assert.equal((await call("POST", `/standdowns/${placed.body.id}/lift`, {})).status, 200);
    const again = await call<{ error: string }>("POST", `/standdowns/${placed.body.id}/lift`, {});
    assert.equal(again.status, 404);
  });

  test("the history keeps lifted rows; ?active=true does not", async () => {
    const placed = await call<SerializedStanddown>("POST", "/standdowns", {
      scope: "company",
      reason: "drill",
    });
    await call("POST", `/standdowns/${placed.body.id}/lift`, {});
    const all = await call<{ standdowns: SerializedStanddown[] }>("GET", "/standdowns");
    assert.equal(all.body.standdowns.length, 1);
    const active = await call<{ standdowns: SerializedStanddown[] }>(
      "GET",
      "/standdowns?active=true",
    );
    assert.equal(active.body.standdowns.length, 0);
  });
});

describe("scope validation", () => {
  test("a reason is mandatory", async () => {
    const missing = await call<{ error: string }>("POST", "/standdowns", { scope: "company" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "ValidationError");

    const blank = await call<{ error: string }>("POST", "/standdowns", {
      scope: "company",
      reason: "   ",
    });
    assert.equal(blank.status, 400);
  });

  test("a company standdown names nothing and the narrower two must", async () => {
    const named = await call<{ error: string }>("POST", "/standdowns", {
      scope: "company",
      scopeId: employee.id,
      reason: "stop everything",
    });
    assert.equal(named.status, 400);
    assert.equal(named.body.error, "ValidationError");

    const unnamed = await call<{ error: string }>("POST", "/standdowns", {
      scope: "employee",
      reason: "stop somebody",
    });
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.error, "ValidationError");
  });

  test("a target in another company is refused", async () => {
    const foreign = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Bob",
      slug: "bob",
      role: "Analyst",
      soulBody: "",
    });
    const refused = await call<{ error: string }>("POST", "/standdowns", {
      scope: "employee",
      scopeId: foreign.id,
      reason: "not mine to stop",
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not in this company/);
  });

  test("another company's standdown id is 404, not somebody else's lever", async () => {
    const theirs = await call<SerializedStanddown>(
      "POST",
      "/standdowns",
      { scope: "company", reason: "their incident" },
      otherCompany.id,
    );
    assert.equal(theirs.status, 200);
    const lift = await call("POST", `/standdowns/${theirs.body.id}/lift`, {});
    assert.equal(lift.status, 404);
    const stillActive = await call<{ standdowns: SerializedStanddown[] }>(
      "GET",
      "/standdowns?active=true",
      undefined,
      otherCompany.id,
    );
    assert.equal(stillActive.body.standdowns.length, 1);
  });
});

describe("the banner's query", () => {
  test("a routine standdown answers for that routine only", async () => {
    await call("POST", "/standdowns", {
      scope: "routine",
      scopeId: routine.id,
      reason: "Collections is misfiring",
    });
    actingUserId = viewer.id;
    const forRoutine = await call<{ standdown: SerializedStanddown | null }>(
      "GET",
      `/standdowns/active?routineId=${routine.id}`,
    );
    assert.equal(forRoutine.status, 200);
    assert.equal(forRoutine.body.standdown?.scope, "routine");

    const forEmployee = await call<{ standdown: SerializedStanddown | null }>(
      "GET",
      `/standdowns/active?employeeId=${employee.id}`,
    );
    assert.equal(forEmployee.body.standdown, null);

    const forCompany = await call<{ standdown: SerializedStanddown | null }>(
      "GET",
      "/standdowns/active",
    );
    assert.equal(forCompany.body.standdown, null);
  });

  test("an employee standdown answers for the employee; a company one answers for everything", async () => {
    await call("POST", "/standdowns", {
      scope: "employee",
      scopeId: employee.id,
      reason: "Ada is off",
    });
    const forEmployee = await call<{ standdown: SerializedStanddown | null }>(
      "GET",
      `/standdowns/active?employeeId=${employee.id}`,
    );
    assert.equal(forEmployee.body.standdown?.scope, "employee");
    const bare = await call<{ standdown: SerializedStanddown | null }>("GET", "/standdowns/active");
    assert.equal(bare.body.standdown, null);

    await call("POST", "/standdowns", { scope: "company", reason: "everything off" });
    // A wider scope subsumes the narrower one, so every form of the question
    // now answers with the company row.
    const widened = await call<{ standdown: SerializedStanddown | null }>(
      "GET",
      `/standdowns/active?routineId=${routine.id}`,
    );
    assert.equal(widened.body.standdown?.scope, "company");
  });
});
