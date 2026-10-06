import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AutonomyWaiver } from "../db/entities/AutonomyWaiver.js";
import { Company } from "../db/entities/Company.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { autonomyRouter } from "./autonomy.js";
import { decisionPoliciesRouter } from "./decisionPolicies.js";

/**
 * The distributed-judgment HTTP boundary: rules and waivers are readable by
 * any Member, mutable only by admins, and every id is company-scoped. Every
 * rule names its decider: the "their manager" kind left with reporting lines,
 * so no request can create one, and one an upgraded database still holds can
 * only be switched, renamed to a decider, or deleted.
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
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
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

type Rule = {
  id: string;
  askingEmployeeId: string | null;
  deciderKind: string;
  deciderEmployeeId: string | null;
  sortOrder: number;
  enabled: boolean;
};
type ValidationBody = { error: string; issues?: Array<{ message: string; path: unknown[] }> };

const storedRules = () =>
  AppDataSource.getRepository(DecisionPolicy).find({ order: { createdAt: "ASC" } });

/** A rule as an upgraded database holds it: "their manager", naming nobody. */
function retiredManagerRule(over: Partial<DecisionPolicy> = {}): Promise<DecisionPolicy> {
  return insert(DecisionPolicy, {
    companyId: company.id,
    askingEmployeeId: null,
    deciderKind: "manager",
    deciderEmployeeId: null,
    sortOrder: 0,
    enabled: true,
    ...over,
  });
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
      (
        await call("POST", "/decision-policies", {
          deciderKind: "employee",
          deciderEmployeeId: decider.id,
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("PATCH", `/decision-policies/${created.body.id}`, { enabled: false })).status,
      403,
    );
    assert.equal((await call("DELETE", `/decision-policies/${created.body.id}`)).status, 403);
    assert.equal((await storedRules()).length, 1);
  });

  test("a rule needs the employee who answers, and self-answering is refused", async () => {
    for (const payload of [{}, { deciderKind: "employee" }, { deciderEmployeeId: null }]) {
      const refused = await call<ValidationBody>("POST", "/decision-policies", payload);
      assert.equal(refused.status, 400, JSON.stringify(payload));
      assert.ok(
        refused.body.issues?.some(
          (issue) => issue.message === "A rule needs the employee who answers",
        ),
        JSON.stringify(refused.body),
      );
    }
    const refused = await call("POST", "/decision-policies", {
      askingEmployeeId: employee.id,
      deciderKind: "employee",
      deciderEmployeeId: employee.id,
    });
    assert.equal(refused.status, 400);
    assert.equal((await storedRules()).length, 0);
  });

  test("deciderKind may be left out; a rule is always a named-employee rule", async () => {
    const created = await call<Rule>("POST", "/decision-policies", {
      askingEmployeeId: employee.id,
      deciderEmployeeId: decider.id,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.deciderKind, "employee");
    assert.equal(created.body.deciderEmployeeId, decider.id);
    assert.equal(created.body.askingEmployeeId, employee.id);
    const [stored] = await storedRules();
    assert.equal(stored.deciderKind, "employee");
  });

  test("the removed manager kind is refused by name on create, with or without a decider", async () => {
    for (const payload of [
      { deciderKind: "manager" },
      { deciderKind: "manager", deciderEmployeeId: null },
      { deciderKind: "manager", deciderEmployeeId: decider.id },
      { askingEmployeeId: employee.id, deciderKind: "manager" },
    ]) {
      const refused = await call<ValidationBody>("POST", "/decision-policies", payload);
      assert.equal(refused.status, 400, JSON.stringify(payload));
      assert.equal(refused.body.error, "ValidationError");
      const kindIssue = refused.body.issues?.find((issue) => issue.path[0] === "deciderKind");
      assert.ok(kindIssue, JSON.stringify(refused.body));
      assert.match(kindIssue.message, /must be "employee"/);
      assert.match(kindIssue.message, /removed with reporting lines/);
    }
    assert.equal((await storedRules()).length, 0, "nothing was saved");
  });

  test("PATCH cannot turn a named rule back into a manager rule", async () => {
    const created = await call<Rule>("POST", "/decision-policies", {
      deciderEmployeeId: decider.id,
    });
    const refused = await call("PATCH", `/decision-policies/${created.body.id}`, {
      deciderKind: "manager",
      deciderEmployeeId: null,
    });
    assert.equal(refused.status, 400);
    const [stored] = await storedRules();
    assert.equal(stored.deciderKind, "employee");
    assert.equal(stored.deciderEmployeeId, decider.id);
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

  test("another company's rule is not found, whichever way it is reached", async () => {
    const otherCompany = await insert(Company, {
      name: "Elsewhere",
      slug: "elsewhere",
      ownerId: owner.id,
    });
    const foreign = await insert(DecisionPolicy, {
      companyId: otherCompany.id,
      askingEmployeeId: null,
      deciderKind: "employee",
      deciderEmployeeId: decider.id,
      sortOrder: 0,
      enabled: true,
    });
    assert.deepEqual((await call<Rule[]>("GET", "/decision-policies")).body, []);
    assert.equal(
      (await call("PATCH", `/decision-policies/${foreign.id}`, { enabled: false })).status,
      404,
    );
    assert.equal((await call("DELETE", `/decision-policies/${foreign.id}`)).status, 404);
    const untouched = await AppDataSource.getRepository(DecisionPolicy).findOneByOrFail({
      id: foreign.id,
    });
    assert.equal(untouched.enabled, true);
  });
});

describe("a retired manager rule over HTTP", () => {
  test("still lists, as itself, so an admin can see why it no longer routes", async () => {
    const legacy = await retiredManagerRule({ askingEmployeeId: employee.id });
    actingUserId = viewer.id;
    const listed = await call<Rule[]>("GET", "/decision-policies");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.map(({ id, deciderKind, deciderEmployeeId, askingEmployeeId }) => ({
        id,
        deciderKind,
        deciderEmployeeId,
        askingEmployeeId,
      })),
      [
        {
          id: legacy.id,
          deciderKind: "manager",
          deciderEmployeeId: null,
          askingEmployeeId: employee.id,
        },
      ],
    );
  });

  test("can be switched off and on, and stays a manager rule", async () => {
    const legacy = await retiredManagerRule();
    const off = await call<Rule>("PATCH", `/decision-policies/${legacy.id}`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.deciderKind, "manager");
    const on = await call<Rule>("PATCH", `/decision-policies/${legacy.id}`, { enabled: true });
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.deciderKind, "manager");
  });

  test("naming a decider turns it into an ordinary named-employee rule", async () => {
    const legacy = await retiredManagerRule({ askingEmployeeId: employee.id, sortOrder: 3 });
    const named = await call<Rule>("PATCH", `/decision-policies/${legacy.id}`, {
      deciderEmployeeId: decider.id,
    });
    assert.equal(named.status, 200);
    assert.equal(named.body.deciderKind, "employee");
    assert.equal(named.body.deciderEmployeeId, decider.id);
    assert.equal(named.body.sortOrder, 3, "it keeps its place in the order");
    const [stored] = await storedRules();
    assert.equal(stored.deciderKind, "employee");
  });

  test("cannot be renamed into a rule with no decider, or into one that answers itself", async () => {
    const legacy = await retiredManagerRule({ askingEmployeeId: employee.id });
    const noDecider = await call<{ error: string }>("PATCH", `/decision-policies/${legacy.id}`, {
      deciderKind: "employee",
    });
    assert.equal(noDecider.status, 400);
    assert.equal(noDecider.body.error, "A rule needs the employee who answers");
    const selfAnswer = await call("PATCH", `/decision-policies/${legacy.id}`, {
      deciderEmployeeId: employee.id,
    });
    assert.equal(selfAnswer.status, 400);
    const stranger = await insert(AIEmployee, {
      companyId: testId("other-co"),
      name: "Eve",
      slug: "eve",
      role: "Spy",
      soulBody: "",
    });
    const foreignDecider = await call("PATCH", `/decision-policies/${legacy.id}`, {
      deciderEmployeeId: stranger.id,
    });
    assert.equal(foreignDecider.status, 400);
    const [stored] = await storedRules();
    assert.equal(stored.deciderKind, "manager");
    assert.equal(stored.deciderEmployeeId, null);
  });

  test("can be deleted", async () => {
    const legacy = await retiredManagerRule();
    assert.equal((await call("DELETE", `/decision-policies/${legacy.id}`)).status, 200);
    assert.deepEqual(await storedRules(), []);
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
