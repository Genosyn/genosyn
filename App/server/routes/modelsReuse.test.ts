import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { listReusableModels, reuseModelForEmployee } from "../services/modelReuse.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { modelsRouter } from "./models.js";

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

const mutableConfig = config as unknown as {
  sessionSecret: string;
  security: { multiTenant: boolean; encryptionSecret: string };
};
const originalSecrets = {
  sessionSecret: mutableConfig.sessionSecret,
  encryptionSecret: mutableConfig.security.encryptionSecret,
};

const SOURCE_KEY = "sk-source-private-key-0123456789";
const OTHER_KEY = "sk-other-private-key-9876543210";
const ENDPOINT_URL = "http://gpu-box.internal:8000/v1";
const ENDPOINT_KEY = "endpoint-private-key-abcdef";
const CODEX_TOKEN = "codex-private-access-token-abcdef";

let server: Server;
let baseUrl: string;
let actingUser: User;
let owner: User;
let company: Company;
let source: AIEmployee;
let target: AIEmployee;

before(async () => {
  mutableConfig.sessionSecret = "models-reuse-session-secret-0123456789abcdef";
  mutableConfig.security.encryptionSecret = "models-reuse-encryption-secret-0123456789abcdef";
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: req.header("x-test-user"),
      sessionVersion: 0,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  mutableConfig.sessionSecret = originalSecrets.sessionSecret;
  mutableConfig.security.encryptionSecret = originalSecrets.encryptionSecret;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function makeUser(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
}

async function makeCompany(label: string, ownerId: string): Promise<Company> {
  const created = await insert(Company, {
    name: label,
    slug: `${label.toLowerCase()}-${randomUUID()}`,
    ownerId,
  });
  await insert(Membership, { companyId: created.id, userId: ownerId, role: "owner" });
  return created;
}

async function makeEmployee(companyId: string, name: string): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: `${name.toLowerCase()}-${randomUUID()}`,
    role: "Researcher",
    soulBody: "",
  });
}

beforeEach(async () => {
  await resetTestDb();
  owner = await makeUser("Owner");
  actingUser = owner;
  company = await makeCompany("Acme", owner.id);
  source = await makeEmployee(company.id, "Avery");
  target = await makeEmployee(company.id, "Sam");
});

/** Act as another Member of the company, with the given role. */
async function actAs(role: Role): Promise<User> {
  const user = await makeUser(role);
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  actingUser = user;
  return user;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  employee: AIEmployee = target,
  companyId: string = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(
    `${baseUrl}/api/companies/${companyId}/employees/${employee.id}/models${path}`,
    {
      method,
      headers: {
        "x-test-user": actingUser.id,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function reuse(sourceModelId: string, employee: AIEmployee = target) {
  return call("POST", "/reuse", { sourceModelId }, employee);
}

async function apiKeyModel(
  employee: AIEmployee,
  overrides: Partial<AIModel> & { key?: string; companyId?: string } = {},
): Promise<AIModel> {
  const { key = SOURCE_KEY, companyId = company.id, ...rest } = overrides;
  return insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "gpt-5.4",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({
      apiKeyEncrypted: encryptSecret(key, companyId),
      apiKeyPreview: maskSecret(key),
    }),
    connectedAt: new Date("2026-09-01T10:00:00.000Z"),
    contextWindow: null,
    contextWindowSource: null,
    ...rest,
  });
}

async function customModel(
  employee: AIEmployee,
  overrides: Partial<AIModel> = {},
): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "qwen3-27b",
    authMode: "customEndpoint",
    isActive: false,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(ENDPOINT_URL, company.id),
      baseURLPreview: "gpu-box.internal:8000",
      modelId: "qwen3-27b",
      apiKeyEncrypted: encryptSecret(ENDPOINT_KEY, company.id),
      apiKeyPreview: maskSecret(ENDPOINT_KEY),
    }),
    connectedAt: new Date("2026-09-02T10:00:00.000Z"),
    // A number someone typed in for the server: carried over, never probed away.
    contextWindow: 32_768,
    contextWindowSource: "manual",
    maxConcurrentRuns: 2,
    ...overrides,
  });
}

async function subscriptionModel(employee: AIEmployee): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "gpt-5.4",
    authMode: "subscription",
    isActive: true,
    configJson: JSON.stringify({
      codexAccessTokenEncrypted: encryptSecret(CODEX_TOKEN, company.id),
      subscriptionCredentialKind: "accessToken",
    }),
    connectedAt: new Date("2026-09-03T10:00:00.000Z"),
  });
}

/** Nothing a credential is, was, or looks like may appear in what a browser receives. */
function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [SOURCE_KEY, OTHER_KEY, ENDPOINT_KEY, ENDPOINT_URL, CODEX_TOKEN]) {
    assert.ok(!text.includes(secret), `response leaked ${secret}`);
  }
  for (const field of [
    "configJson",
    "apiKeyEncrypted",
    "baseURLEncrypted",
    "codexAuthEncrypted",
    "codexAccessTokenEncrypted",
    "v2.",
  ]) {
    assert.ok(!text.includes(field), `response exposed ${field}`);
  }
}

const modelRows = () => AppDataSource.getRepository(AIModel).find({ order: { createdAt: "ASC" } });

describe("listing the AI Models a company can reuse", () => {
  test("offers other employees' connected API-key and custom models, and nothing secret", async () => {
    const avery = await apiKeyModel(source);
    const endpoint = await customModel(source);
    await subscriptionModel(await makeEmployee(company.id, "Casey"));
    // Not connected: a key was never saved.
    await apiKeyModel(await makeEmployee(company.id, "Drew"), { configJson: "{}" });
    // The target's own model is not an offer to itself.
    await apiKeyModel(target, { key: OTHER_KEY });
    // Another company's connected model is invisible from here.
    const stranger = await makeUser("Stranger");
    const otherCompany = await makeCompany("Globex", stranger.id);
    await apiKeyModel(await makeEmployee(otherCompany.id, "Mallory"), {
      companyId: otherCompany.id,
      key: OTHER_KEY,
    });

    const response = await call<Array<Record<string, unknown>>>("GET", "/reusable");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [
      {
        id: avery.id,
        employeeId: source.id,
        employeeName: "Avery",
        provider: "openai",
        model: "gpt-5.4",
        authMode: "apikey",
        endpointHost: null,
        isActive: true,
      },
      {
        id: endpoint.id,
        employeeId: source.id,
        employeeName: "Avery",
        provider: "custom",
        model: "qwen3-27b",
        authMode: "customEndpoint",
        endpointHost: "gpu-box.internal:8000",
        isActive: false,
      },
    ]);
    assertNoSecrets(response.body);
  });

  test("a company with nothing to reuse gets an empty list", async () => {
    await apiKeyModel(target);
    const response = await call<unknown[]>("GET", "/reusable");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
  });

  test("any Member can read it, and only for an employee of their company", async () => {
    await apiKeyModel(source);
    await actAs("member");
    assert.equal((await call<unknown[]>("GET", "/reusable")).body.length, 1);

    const stranger = await makeUser("Stranger");
    const otherCompany = await makeCompany("Globex", stranger.id);
    const outsider = await makeEmployee(otherCompany.id, "Mallory");
    const crossed = await call("GET", "/reusable", undefined, outsider);
    assert.equal(crossed.status, 404);
  });

  test("one credential shared by several employees is offered once, led by what most of them use", async () => {
    const casey = await makeEmployee(company.id, "Casey");
    const drew = await makeEmployee(company.id, "Drew");
    await apiKeyModel(source, { key: OTHER_KEY, model: "gpt-lite", isActive: true });
    const shared = await apiKeyModel(casey, { isActive: true });
    await apiKeyModel(drew, { isActive: false });

    const offers = await listReusableModels(company.id, { excludeEmployeeId: target.id });

    assert.deepEqual(
      offers.map((offer) => [offer.employeeName, offer.model]),
      [
        ["Casey", "gpt-5.4"],
        ["Avery", "gpt-lite"],
      ],
    );
    assert.equal(offers[0].id, shared.id);
  });
});

describe("reusing an AI Model", () => {
  test("copies the credential on the server and makes it the employee's active AI Model", async () => {
    const original = await apiKeyModel(source);
    const previous = await apiKeyModel(target, { key: OTHER_KEY, model: "gpt-lite" });

    const response = await reuse(original.id);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.employeeId, target.id);
    assert.equal(response.body.provider, "openai");
    assert.equal(response.body.model, "gpt-5.4");
    assert.equal(response.body.authMode, "apikey");
    assert.equal(response.body.status, "connected");
    assert.equal(response.body.isActive, true);
    assert.notEqual(response.body.id, original.id);
    assertNoSecrets(response.body);

    const rows = await modelRows();
    assert.equal(rows.length, 3);
    const copy = rows.find((row) => row.id === response.body.id)!;
    assert.equal(copy.employeeId, target.id);
    assert.equal(copy.isActive, true);
    assert.ok(copy.connectedAt instanceof Date);
    assert.equal(decryptSecret(JSON.parse(copy.configJson).apiKeyEncrypted), SOURCE_KEY);
    assert.equal(JSON.parse(copy.configJson).apiKeyPreview, maskSecret(SOURCE_KEY));
    // The employee's earlier model stays, switched off; the source is untouched.
    assert.equal(rows.find((row) => row.id === previous.id)!.isActive, false);
    const untouched = rows.find((row) => row.id === original.id)!;
    assert.equal(untouched.isActive, true);
    assert.equal(untouched.employeeId, source.id);
    assert.equal(untouched.configJson, original.configJson);
  });

  test("a custom endpoint keeps its URL, key, hand-set context window and Run limit", async () => {
    const endpoint = await customModel(source, { isActive: true });

    const response = await reuse(endpoint.id);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.provider, "custom");
    assert.equal(response.body.authMode, "customEndpoint");
    assert.equal(response.body.customEndpointHost, "gpu-box.internal:8000");
    assert.equal(response.body.customEndpointHasApiKey, true);
    assert.equal(response.body.contextWindow, 32_768);
    assert.equal(response.body.contextWindowSource, "manual");
    assert.equal(response.body.maxConcurrentRuns, 2);
    assertNoSecrets(response.body);

    const copy = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: String(response.body.id),
    });
    const stored = JSON.parse(copy.configJson);
    assert.equal(decryptSecret(stored.baseURLEncrypted), ENDPOINT_URL);
    assert.equal(decryptSecret(stored.apiKeyEncrypted), ENDPOINT_KEY);
    assert.equal(stored.modelId, "qwen3-27b");
  });

  test("only the credential fields travel; anything else on the source row stays behind", async () => {
    const original = await apiKeyModel(source, {
      configJson: JSON.stringify({
        apiKeyEncrypted: encryptSecret(SOURCE_KEY, company.id),
        apiKeyPreview: maskSecret(SOURCE_KEY),
        codexAccessTokenEncrypted: encryptSecret(CODEX_TOKEN, company.id),
        somethingElse: "left behind",
      }),
    });

    const response = await reuse(original.id);

    assert.equal(response.status, 200);
    const copy = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: String(response.body.id),
    });
    assert.deepEqual(Object.keys(JSON.parse(copy.configJson)).sort(), [
      "apiKeyEncrypted",
      "apiKeyPreview",
    ]);
  });

  test("records the audit entry a fresh connection would, naming the source and no secret", async () => {
    const original = await apiKeyModel(source);

    const response = await reuse(original.id);
    assert.equal(response.status, 200);

    const events = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id, action: "model.configure" },
    });
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.targetType, "employee");
    assert.equal(event.targetId, target.id);
    assert.equal(event.targetLabel, "Sam");
    assert.equal(event.actorUserId, owner.id);
    assert.deepEqual(JSON.parse(event.metadataJson), {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "apikey",
      reusedFromEmployeeId: source.id,
      reusedFromEmployee: "Avery",
    });
    assertNoSecrets(event);
  });

  test("probes the context window the way a fresh connection does", async () => {
    const original = await apiKeyModel(source, {
      contextWindow: 200_000,
      contextWindowSource: "probed",
    });
    const probed: AIModel[] = [];

    const reused = await reuseModelForEmployee({
      companyId: company.id,
      employee: target,
      sourceModelId: original.id,
      actorUserId: owner.id,
      refresh: async (model) => {
        probed.push(model);
      },
    });

    assert.equal(probed.length, 1);
    assert.equal(probed[0].id, reused.model.id);
    assert.equal(probed[0].employeeId, target.id);
    assert.deepEqual(reused.source, { employeeId: source.id, employeeName: "Avery" });
    // What the source already knew stands until the probe finds something better.
    assert.equal(reused.model.contextWindow, 200_000);
    assert.equal(reused.model.contextWindowSource, "probed");
  });

  test("refuses a ChatGPT subscription and saves nothing", async () => {
    const signedIn = await subscriptionModel(source);

    const response = await reuse(signedIn.id);

    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /ChatGPT sign-in can't be shared/);
    assertNoSecrets(response.body);
    assert.equal((await modelRows()).length, 1);
  });

  test("refuses another company's AI Model exactly as it refuses one that does not exist", async () => {
    const stranger = await makeUser("Stranger");
    const otherCompany = await makeCompany("Globex", stranger.id);
    const foreign = await apiKeyModel(await makeEmployee(otherCompany.id, "Mallory"), {
      companyId: otherCompany.id,
      key: OTHER_KEY,
    });

    const crossed = await reuse(foreign.id);
    const missing = await reuse(randomUUID());

    assert.equal(crossed.status, 404);
    assert.deepEqual(crossed.body, missing.body);
    assertNoSecrets(crossed.body);
    assert.equal(await AppDataSource.getRepository(AIModel).countBy({ employeeId: target.id }), 0);
  });

  test("refuses an employee from another company as the one to connect", async () => {
    const original = await apiKeyModel(source);
    const stranger = await makeUser("Stranger");
    const otherCompany = await makeCompany("Globex", stranger.id);
    const outsider = await makeEmployee(otherCompany.id, "Mallory");

    // The employee to connect has to belong to the company in the path.
    const response = await call("POST", "/reuse", { sourceModelId: original.id }, outsider);

    assert.equal(response.status, 404);
    assert.equal(
      await AppDataSource.getRepository(AIModel).countBy({ employeeId: outsider.id }),
      0,
    );
  });

  test("refuses a source that is not connected and an employee's own AI Model", async () => {
    const unconnected = await apiKeyModel(source, { configJson: "{}", connectedAt: null });
    const own = await apiKeyModel(target, { key: OTHER_KEY });

    const first = await reuse(unconnected.id);
    assert.equal(first.status, 400);
    assert.match(String(first.body.error), /isn't connected yet/);

    const second = await reuse(own.id);
    assert.equal(second.status, 400);
    assert.match(String(second.body.error), /already has this AI Model/);

    assert.equal((await modelRows()).length, 2);
  });

  test("only owners and admins may reuse an AI Model", async () => {
    const original = await apiKeyModel(source);

    await actAs("member");
    const refused = await reuse(original.id);
    assert.equal(refused.status, 403);
    assertNoSecrets(refused.body);
    assert.equal(await AppDataSource.getRepository(AIModel).countBy({ employeeId: target.id }), 0);

    await actAs("admin");
    assert.equal((await reuse(original.id)).status, 200);
    assert.equal(await AppDataSource.getRepository(AIModel).countBy({ employeeId: target.id }), 1);
  });

  test("validates the request at the boundary", async () => {
    const original = await apiKeyModel(source);

    for (const body of [
      {},
      { sourceModelId: "not-a-uuid" },
      { sourceModelId: original.id, provider: "anthropic" },
    ]) {
      const response = await call("POST", "/reuse", body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    const badEmployee = await fetch(
      `${baseUrl}/api/companies/${company.id}/employees/not-a-uuid/models/reuse`,
      {
        method: "POST",
        headers: { "x-test-user": owner.id, "content-type": "application/json" },
        body: JSON.stringify({ sourceModelId: original.id }),
      },
    );
    assert.equal(badEmployee.status, 400);
    assert.equal(await AppDataSource.getRepository(AIModel).countBy({ employeeId: target.id }), 0);
  });
});
