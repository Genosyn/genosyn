import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIModelOutage } from "../db/entities/AIModelOutage.js";
import type { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "../services/agent/modelOutage.js";
import {
  flushModelAvailabilityWrites,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "../services/modelAvailability.js";
import type { PublicModelAvailability } from "../../shared/modelAvailability.js";

/**
 * Seeing an unavailable AI Model and asking it again, end to end through
 * `createApp()`. The bar: owners and admins see since when, why, what waits and
 * when the next check is, on the AI Models page; "Check now" is theirs alone,
 * from a signed-in browser — never a Member's, never an API key's — validated,
 * documented in the API reference, and never hands back a secret.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let owner: User;
let employee: AIEmployee;
let model: AIModel;
const SECRET = "sk-ant-api03-ROUTE-TEST-SECRET-KEY-0001";
/** The key as stored: encrypted with this run's instance secret. */
let storedKey = "";

beforeEach(async () => {
  resetModelAvailabilityForTests();
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  storedKey = encryptSecret(SECRET);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
  });
  model = await insertEmployeeModel({
    employeeId: employee.id,
    companyId: company.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({ apiKeyEncrypted: storedKey, apiKeyPreview: "sk-…0001" }),
  });
});
afterEach(() => resetModelAvailabilityForTests());

async function request(
  method: string,
  path: string,
  auth: { token?: string; cookie?: string },
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: {
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth.cookie ? { cookie: auth.cookie, origin: baseUrl } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : {} };
}

function makeUnavailable(): void {
  recordModelFailure(
    model,
    modelUnavailability("overloaded", { status: 529, code: "overloaded_error" }),
    { terminal: true },
  );
}

async function memberCookie(role: "member" | "admin"): Promise<string> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name: role,
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return sessionCookieFor(user);
}

test("the AI Models page says the model is unavailable, since when, why, what waits and when it is checked", async () => {
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily digest",
    slug: "daily-digest",
    cronExpr: "0 9 * * *",
    body: "Write the digest.",
  });
  await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "queued",
    startedAt: new Date(),
    triggerKind: "schedule",
    pauseCount: 1,
    pauseReason: "outage",
    outagePauses: 1,
  });
  const cookie = await sessionCookieFor(owner);
  const healthy = await request("GET", "/models", { cookie });
  assert.deepEqual(
    (healthy.body as Array<{ availability: PublicModelAvailability }>)[0].availability,
    { state: "available" },
  );

  makeUnavailable();
  await flushModelAvailabilityWrites();
  const listed = await request("GET", "/models", { cookie });
  assert.equal(listed.status, 200);
  assert.ok(!listed.text.includes(SECRET) && !listed.text.includes(storedKey), "no key listed");
  const availability = (listed.body as Array<{ availability: PublicModelAvailability }>)[0]
    .availability;
  assert.equal(availability.state, "unavailable");
  if (availability.state === "unavailable") {
    assert.equal(availability.reason, "overloaded");
    assert.match(availability.detail, /overloaded/);
    assert.ok(Date.parse(availability.since) <= Date.now());
    assert.ok(Date.parse(availability.nextCheckAt) > Date.now());
    assert.equal(availability.checks, 0);
    assert.deepEqual(availability.waiting, { runs: 1, chats: 0 });
  }
});

test("Check now: an owner or admin asks the model again and reads what the check found", async () => {
  makeUnavailable();
  const owners = await sessionCookieFor(owner);
  setModelCheckForTests(async () => ({
    kind: "unavailable",
    unavailability: modelUnavailability("server_error", { status: 503 }),
  }));
  const still = await request("POST", `/models/${model.id}/availability/check`, { cookie: owners });
  assert.equal(still.status, 200, still.text);
  assert.equal(still.body.id, model.id);
  assert.equal(still.body.availability.state, "unavailable");
  assert.equal(still.body.availability.checks, 1);
  assert.equal(still.body.availability.reason, "server_error");
  assert.ok(!still.text.includes(SECRET), "no key in the answer");
  assert.ok(!still.text.includes(storedKey), "nor the key as stored");

  setModelCheckForTests(async () => ({ kind: "available" }));
  const admins = await memberCookie("admin");
  const backAgain = await request("POST", `/models/${model.id}/availability/check`, {
    cookie: admins,
  });
  assert.equal(backAgain.status, 200);
  assert.deepEqual(backAgain.body.availability, { state: "available" });
  await flushModelAvailabilityWrites();
  const [row] = await AppDataSource.getRepository(AIModelOutage).find();
  assert.equal(row.recoveredBy, "check");
});

test("Check now on an available model checks nothing and returns it as it is", async () => {
  let checks = 0;
  setModelCheckForTests(async () => {
    checks += 1;
    return { kind: "available" };
  });
  const result = await request("POST", `/models/${model.id}/availability/check`, {
    cookie: await sessionCookieFor(owner),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.availability, { state: "available" });
  assert.equal(checks, 0);
});

test("a Member, an API key and a stranger cannot press Check now", async () => {
  makeUnavailable();
  let checks = 0;
  setModelCheckForTests(async () => {
    checks += 1;
    return { kind: "available" };
  });
  const path = `/models/${model.id}/availability/check`;
  const member = await request("POST", path, { cookie: await memberCookie("member") });
  assert.equal(member.status, 403);
  const { token } = await mintTestApiKey(owner.id, company.id);
  const keyed = await request("POST", path, { token });
  assert.equal(keyed.status, 403);
  assert.match(String(keyed.body.error), /browser session/);
  const anonymous = await request("POST", path, {});
  assert.equal(anonymous.status, 401);
  assert.equal(checks, 0, "nobody without the right asked the model");
});

test("Check now validates its parameters and finds only the company's own models", async () => {
  const cookie = await sessionCookieFor(owner);
  const malformed = await request("POST", "/models/not-a-uuid/availability/check", { cookie });
  assert.equal(malformed.status, 400);
  const missing = await request("POST", `/models/${randomUUID()}/availability/check`, { cookie });
  assert.equal(missing.status, 404);
  const { company: other } = await createMemberOfNewCompany("owner");
  const elsewhere = await insertEmployeeModel({
    employeeId: (await insert(AIEmployee, {
      companyId: other.id,
      name: "Bo",
      slug: "bo",
      role: "Ops",
    })).id,
    companyId: other.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    connectedAt: new Date(),
    configJson: "{}",
  });
  const foreign = await request("POST", `/models/${elsewhere.id}/availability/check`, { cookie });
  assert.equal(foreign.status, 404, "another company's model is not found here");
});

test("the API reference documents Check now as an admin's, cookie-only, under AI Models", () => {
  const document = buildOpenApiDocument(app) as unknown as {
    paths: Record<
      string,
      Record<string, { security?: unknown; tags?: string[]; "x-genosyn-access"?: Record<string, unknown> }>
    >;
  };
  const operation = document.paths["/api/companies/{cid}/models/{id}/availability/check"]?.post;
  assert.ok(operation, "documented");
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.deepEqual(operation.tags, ["AI Models"]);
  assert.equal(operation["x-genosyn-access"]?.minimumRole, "admin");
  assert.equal(operation["x-genosyn-access"]?.apiKey, false);
});
