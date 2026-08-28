import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AutonomyWaiver } from "../db/entities/AutonomyWaiver.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { autonomyRouter } from "./autonomy.js";
import { decisionPoliciesRouter } from "./decisionPolicies.js";

/**
 * The distributed-judgment HTTP boundary: rules and waivers are readable by
 * any Member, mutable only by admins, and every id is company-scoped.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;
let decider: AIEmployee;

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
  app.use("/api/companies/:cid", decisionPoliciesRouter);
  app.use("/api/companies/:cid", autonomyRouter);
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
  decider = await insert(AIEmployee, {
    companyId: company.id,
    name: "Meredith",
    slug: "meredith",
    role: "Head of Ops",
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

describe("decision policies over HTTP", () => {
  test("members read; only admins write", async () => {
    const created = await call<{ id: string }>("POST", "/decision-policies", {
      deciderKind: "employee",
      deciderEmployeeId: decider.id,
    });
    assert.equal(created.status, 200);
    actingUserId = viewer.id;
    const listed = await call<Array<{ id: string }>>("GET", "/decision-policies");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(
      (await call("POST", "/decision-policies", { deciderKind: "manager" })).status,
      403,
    );
    assert.equal((await call("DELETE", `/decision-policies/${created.body.id}`)).status, 403);
  });

  test("a named-employee rule needs a decider, and self-answering is refused", async () => {
    assert.equal(
      (await call("POST", "/decision-policies", { deciderKind: "employee" })).status,
      400,
    );
    assert.equal(
      (
        await call("POST", "/decision-policies", {
          deciderKind: "manager",
          deciderEmployeeId: decider.id,
        })
      ).status,
      400,
    );
    const refused = await call("POST", "/decision-policies", {
      askingEmployeeId: employee.id,
      deciderKind: "employee",
      deciderEmployeeId: employee.id,
    });
    assert.equal(refused.status, 400);
  });

  test("employees from another company are refused", async () => {
    const stranger = await insert(AIEmployee, {
      companyId: testId("other-co"),
      name: "Eve",
      slug: "eve",
      role: "Spy",
      soulBody: "",
    });
    const refused = await call("POST", "/decision-policies", {
      deciderKind: "employee",
      deciderEmployeeId: stranger.id,
    });
    assert.equal(refused.status, 400);
  });

  test("PATCH re-validates the rule shape it produces", async () => {
    const created = await call<{ id: string }>("POST", "/decision-policies", {
      deciderKind: "employee",
      deciderEmployeeId: decider.id,
    });
    const broken = await call("PATCH", `/decision-policies/${created.body.id}`, {
      deciderEmployeeId: null,
    });
    assert.equal(broken.status, 400);
    const disabled = await call<{ enabled: boolean }>(
      "PATCH",
      `/decision-policies/${created.body.id}`,
      { enabled: false },
    );
    assert.equal(disabled.body.enabled, false);
  });
});

describe("autonomy over HTTP", () => {
  test("any member reads the overview; only admins revoke; revoke re-arms", async () => {
    employee.browserApprovalRequired = false;
    await AppDataSource.getRepository(AIEmployee).save(employee);
    const waiver = await insert(AutonomyWaiver, {
      companyId: company.id,
      employeeId: employee.id,
      kind: "browser_approval",
      routineId: null,
    });

    actingUserId = viewer.id;
    const overview = await call<{ waivers: Array<{ id: string; revokedAt: string | null }> }>(
      "GET",
      `/employees/${employee.id}/autonomy`,
    );
    assert.equal(overview.status, 200);
    assert.equal(overview.body.waivers[0].id, waiver.id);
    assert.equal((await call("DELETE", `/autonomy-waivers/${waiver.id}`)).status, 403);

    actingUserId = owner.id;
    assert.equal((await call("DELETE", `/autonomy-waivers/${waiver.id}`)).status, 200);
    assert.equal((await call("DELETE", `/autonomy-waivers/${waiver.id}`)).status, 409);
    const fresh = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(fresh.browserApprovalRequired, true);
  });
});
