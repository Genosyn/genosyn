import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { auditRouter } from "./audit.js";
import { workTimelineRouter } from "./workTimeline.js";

/**
 * Route-level contract for the work timeline.
 *
 * Two things are worth pinning here rather than at the service. The first is
 * the query boundary: every parameter is coerced from a string, so a schema
 * that silently accepts `hours=999` is the difference between "a glance at
 * today" and "the whole history through a route that is not the audit log".
 *
 * The second is the entitlement asymmetry, which is the whole reason this
 * endpoint exists separately at all. `GET /audit` is admin-gated and behind a
 * paid feature; this is neither, and the test that proves it sits next to the
 * test that proves the audit log still is.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    next();
  });
  app.use("/api/companies/:cid", workTimelineRouter);
  app.use("/api/companies/:cid", auditRouter);
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
let owner: User;
let member: User;
let outsider: User;
let employee: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
  owner = await createUser("owner@example.test", "Owner");
  member = await createUser("member@example.test", "Member");
  outsider = await createUser("outsider@example.test", "Outsider");
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Rival", slug: "rival", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "",
  });
  actingUserId = member.id;
});

async function createUser(email: string, name: string): Promise<User> {
  return insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
}

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type TimelineBody = {
  since: string;
  until: string;
  employeeId: string | null;
  entries: { id: string; kind: string }[];
  entryCount: number;
};

async function seedRun(): Promise<void> {
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "",
  });
  await insert(Run, {
    routineId: routine.id,
    status: "completed",
    logContent: "",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 60 * 60 * 1000),
    exitCode: 0,
  });
}

describe("work timeline authorization", () => {
  test("an unauthenticated caller is rejected", async () => {
    actingUserId = null;
    assert.equal((await call("GET", "/work-timeline")).status, 401);
  });

  test("a non-member of the company is rejected", async () => {
    actingUserId = outsider.id;
    assert.equal((await call("GET", "/work-timeline")).status, 403);
  });

  test("a member of another company cannot read this one", async () => {
    assert.equal((await call("GET", "/work-timeline", otherCompany.id)).status, 403);
  });

  test("an ordinary member reads it, while the audit log still refuses them", async () => {
    // The asymmetry is the point. Browsing the company's whole history is an
    // admin tool behind a paid feature; seeing what your own AI employees did
    // today is the minimum needed to trust them, and is neither.
    await seedRun();
    const timeline = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.entryCount, 1);

    assert.equal((await call("GET", "/audit")).status, 403);
  });
});

describe("work timeline responses", () => {
  test("returns the documented shape with the default 24-hour window", async () => {
    await seedRun();
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(status, 200);
    assert.equal(body.employeeId, null);
    assert.equal(body.entryCount, 1);
    assert.equal(body.entries[0].kind, "run");
    assert.equal(
      new Date(body.until).getTime() - new Date(body.since).getTime(),
      24 * 60 * 60 * 1000,
    );
  });

  test("honours hours and limit together", async () => {
    await seedRun();
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline?hours=48&limit=5");
    assert.equal(status, 200);
    assert.equal(
      new Date(body.until).getTime() - new Date(body.since).getTime(),
      48 * 60 * 60 * 1000,
    );
    assert.ok(body.entries.length <= 5);
  });

  test("narrows to one employee and echoes the id back", async () => {
    await seedRun();
    const { status, body } = await call<TimelineBody>(
      "GET",
      `/work-timeline?employeeId=${employee.id}`,
    );
    assert.equal(status, 200);
    assert.equal(body.employeeId, employee.id);
    assert.equal(body.entryCount, 1);
  });
});

describe("work timeline query validation", () => {
  const rejected = [
    "?hours=0",
    "?hours=169",
    "?hours=notanumber",
    "?limit=0",
    "?limit=201",
    "?employeeId=not-a-uuid",
    // `.strict()` — an unknown parameter is a caller bug, not something to
    // silently ignore.
    "?bogus=1",
  ];
  for (const query of rejected) {
    test(`rejects ${query}`, async () => {
      const { status, body } = await call<{ error: string }>("GET", `/work-timeline${query}`);
      assert.equal(status, 400);
      assert.equal(body.error, "ValidationError");
    });
  }

  test("accepts the boundary values on either end", async () => {
    assert.equal((await call("GET", "/work-timeline?hours=1&limit=1")).status, 200);
    assert.equal((await call("GET", "/work-timeline?hours=168&limit=200")).status, 200);
  });
});
