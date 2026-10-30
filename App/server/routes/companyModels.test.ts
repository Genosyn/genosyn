import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test, type TestContext } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../db/entities/AIModelKeyHealth.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { agentRuntime } from "../services/agent/runtime.js";
import { decryptApiKeys, newStoredApiKey, readApiKeys, writeApiKeys } from "../services/modelApiKeys.js";
import { resetKeyHealthMemory } from "../services/modelKeyHealth.js";
import { getActiveModel } from "../services/models.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { attachExistingModel, flaggedActiveModel } from "../test/modelFixtures.js";
import { persistTestSession } from "../test/userSession.js";
import { companyModelsRouter } from "./companyModels.js";
import { modelsRouter } from "./models.js";

/**
 * Settings → AI Models through the real company models router: listing every
 * model with who uses it, creating one for several AI Employees at once,
 * attaching and detaching, removing (guarded while anyone uses it), merging
 * exact duplicates, and that a shared model is one row whose keys, settings
 * and test serve every employee on it. Owners and admins only, scoped to the
 * company, and no key, ciphertext or endpoint URL ever comes back.
 */

type ModelUser = { id: string; name: string; slug: string; isActive: boolean };
type PublicModel = {
  id: string;
  companyId: string;
  provider: string;
  model: string;
  authMode: string;
  status: string;
  isActive: boolean;
  apiKeys: Array<{ id: string; preview: string }>;
  employees: ModelUser[];
  duplicateIds: string[];
  maxConcurrentRuns: number | null;
  effectiveMaxConcurrentRuns: number | null;
  concurrencySource: string;
  customEndpointHost: string | null;
};
type ApiResponse<T> = { status: number; body: T; text: string };

const mutableConfig = config as unknown as {
  sessionSecret: string;
  security: { encryptionSecret: string; outboundPrivateHostAllowlist: string[] };
};
const original = {
  sessionSecret: mutableConfig.sessionSecret,
  encryptionSecret: mutableConfig.security.encryptionSecret,
  allowlist: [...mutableConfig.security.outboundPrivateHostAllowlist],
};

const KEY_A = "sk-ant-api03-company-models-key-aaaa0001";
const KEY_B = "sk-ant-api03-company-models-key-bbbb0002";
const BACKUP = "sk-ant-api03-company-models-backup-cccc0003";
const NEW_KEY = "sk-ant-api03-company-models-new-eeee0005";
const ENDPOINT = "https://gpu-box.example.test:8443/v1";
const ENDPOINT_KEY = "company-models-endpoint-key-dddd0004";
const SECRETS = [KEY_A, KEY_B, BACKUP, NEW_KEY, ENDPOINT, ENDPOINT_KEY];

let server: Server;
let baseUrl: string;
let realFetch: typeof fetch;
let actingUser: User;
let owner: User;
let company: Company;
let ada: AIEmployee;
let grace: AIEmployee;
let linus: AIEmployee;

before(async () => {
  mutableConfig.sessionSecret = "company-models-session-secret-0123456789abcdef";
  mutableConfig.security.encryptionSecret = "company-models-encryption-secret-0123456789abcdef";
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
  app.use("/api/companies/:cid/models", companyModelsRouter);
  app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  realFetch = globalThis.fetch;
});

after(async () => {
  mutableConfig.sessionSecret = original.sessionSecret;
  mutableConfig.security.encryptionSecret = original.encryptionSecret;
  mutableConfig.security.outboundPrivateHostAllowlist = original.allowlist;
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
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "Researcher",
    soulBody: "",
  });
}

beforeEach(async () => {
  await resetTestDb();
  resetKeyHealthMemory();
  owner = await makeUser("Owner");
  actingUser = owner;
  company = await makeCompany("Acme", owner.id);
  ada = await makeEmployee(company.id, "Ada");
  grace = await makeEmployee(company.id, "Grace");
  linus = await makeEmployee(company.id, "Linus");
});

async function actAs(role: Role): Promise<User> {
  const user = await makeUser(role);
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  actingUser = user;
  return user;
}

function assertNoSecrets(text: string): void {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `response leaked ${secret}`);
  for (const field of ["apiKeyEncrypted", "baseURLEncrypted", "configJson", "v2."]) {
    assert.ok(!text.includes(field), `response exposed ${field}`);
  }
}

async function call<T = PublicModel>(
  method: string,
  path: string,
  body?: unknown,
  options: { companyId?: string; employee?: AIEmployee } = {},
): Promise<ApiResponse<T>> {
  const scope = options.employee ? `/employees/${options.employee.id}` : "";
  const response = await realFetch(
    `${baseUrl}/api/companies/${options.companyId ?? company.id}${scope}/models${path}`,
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
  assertNoSecrets(text);
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, text };
}

/** A connected Claude company model holding `keys`, attached to `users` (the first active). */
async function claudeModel(
  keys: string[],
  users: Array<{ employee: AIEmployee; active?: boolean }> = [],
  values: Partial<AIModel> = {},
): Promise<AIModel> {
  const model = await insert(AIModel, {
    companyId: values.companyId ?? company.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    configJson: writeApiKeys(
      "{}",
      keys.map((key) => newStoredApiKey(key, values.companyId ?? company.id)),
    ),
    connectedAt: new Date("2026-10-01T10:00:00.000Z"),
    ...values,
  });
  for (const { employee, active } of users) {
    await attachExistingModel({ employeeId: employee.id, modelId: model.id, isActive: active ?? true });
  }
  return model;
}

/** A connected custom endpoint company model. */
async function endpointModel(values: Partial<AIModel> = {}): Promise<AIModel> {
  return insert(AIModel, {
    companyId: company.id,
    provider: "custom",
    model: "qwen3",
    authMode: "customEndpoint",
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(ENDPOINT, company.id),
      baseURLPreview: "gpu-box.example.test:8443",
      modelId: "qwen3",
      apiKeyEncrypted: encryptSecret(ENDPOINT_KEY, company.id),
      apiKeyPreview: maskSecret(ENDPOINT_KEY),
    }),
    connectedAt: new Date("2026-10-02T10:00:00.000Z"),
    ...values,
  });
}

/** The connection test passes unless `refuse` says otherwise; the provider answers offline. */
function stubProvider(t: TestContext, refuse: (keys: string[]) => number | null = () => null) {
  const calls: string[][] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const keys = decryptApiKeys(params.model.configJson).map((key) => key.apiKey);
    calls.push(keys);
    const status = refuse(keys);
    if (status) throw Object.assign(new Error("The AI Model request failed."), { status });
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/models") {
      return Promise.resolve(
        Response.json({
          data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01" }],
          has_more: false,
        }),
      );
    }
    return Promise.resolve(Response.json({ id: "claude-opus-5-5", max_input_tokens: 1_000_000 }));
  });
  return calls;
}

const attachmentsOf = (employeeId: string) =>
  AppDataSource.getRepository(EmployeeModel).find({ where: { employeeId } });
const audits = (action: string) => AppDataSource.getRepository(AuditEvent).findBy({ action });
const names = (users: ModelUser[]) => users.map((user) => user.name);

describe("listing the company's AI Models", () => {
  test("every model, newest first, with who uses it and whose active model it is", async () => {
    const shared = await claudeModel([KEY_A], [{ employee: ada }, { employee: grace }], {
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
    });
    const standby = await claudeModel([KEY_B], [{ employee: grace, active: false }], {
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
    });
    const spare = await endpointModel({ createdAt: new Date("2026-10-03T10:00:00.000Z") });

    const listed = await call<PublicModel[]>("GET", "");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.map((model) => model.id),
      [spare.id, standby.id, shared.id],
    );
    const byId = new Map(listed.body.map((model) => [model.id, model]));
    assert.deepEqual(
      byId.get(shared.id)!.employees.map((user) => [user.name, user.isActive]),
      [
        ["Ada", true],
        ["Grace", true],
      ],
    );
    assert.deepEqual(
      byId.get(standby.id)!.employees.map((user) => [user.name, user.isActive]),
      [["Grace", false]],
    );
    assert.deepEqual(byId.get(spare.id)!.employees, []);
    assert.equal(byId.get(spare.id)!.customEndpointHost, "gpu-box.example.test:8443");
    assert.deepEqual(
      byId.get(shared.id)!.apiKeys.map((key) => key.preview),
      [maskSecret(KEY_A)],
    );
    // The company list never claims a model is "the" active one.
    assert.ok(listed.body.every((model) => model.isActive === false));
    assert.ok(listed.body.every((model) => model.companyId === company.id));
  });

  test("an empty company lists nothing", async () => {
    const listed = await call<PublicModel[]>("GET", "");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, []);
  });

  test("only this company's models, never another's", async () => {
    const stranger = await makeUser("Stranger");
    const globex = await makeCompany("Globex", stranger.id);
    const theirs = await claudeModel([KEY_B], [], { companyId: globex.id });
    const ours = await claudeModel([KEY_A]);
    const listed = await call<PublicModel[]>("GET", "");
    assert.deepEqual(
      listed.body.map((model) => model.id),
      [ours.id],
    );
    assert.equal((await call("GET", `/${theirs.id}`)).status, 404);
    assert.equal((await call("GET", `/${ours.id}`)).status, 200);
  });

  test("exact duplicates name each other; a different key or model does not", async () => {
    const first = await claudeModel([KEY_A], [{ employee: ada }], {
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
    });
    // The same key pasted again for Grace: a different ciphertext, the same key.
    const copy = await claudeModel([KEY_A], [{ employee: grace }], {
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
    });
    const otherKey = await claudeModel([KEY_B], [{ employee: linus }]);
    const otherModel = await claudeModel([KEY_A], [], { model: "claude-sonnet-5" });
    assert.notEqual(
      JSON.parse(first.configJson).apiKeyEncrypted,
      JSON.parse(copy.configJson).apiKeyEncrypted,
    );
    const byId = new Map(
      (await call<PublicModel[]>("GET", "")).body.map((model) => [model.id, model]),
    );
    assert.deepEqual(byId.get(first.id)!.duplicateIds, [copy.id]);
    assert.deepEqual(byId.get(copy.id)!.duplicateIds, [first.id]);
    assert.deepEqual(byId.get(otherKey.id)!.duplicateIds, []);
    assert.deepEqual(byId.get(otherModel.id)!.duplicateIds, []);
  });

  test("the same pool of keys in another order is still a duplicate: order means nothing", async () => {
    const first = await claudeModel([KEY_A, KEY_B, BACKUP], [{ employee: ada }], {
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
    });
    const reordered = await claudeModel([BACKUP, KEY_A, KEY_B], [{ employee: grace }], {
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
    });
    const fewer = await claudeModel([KEY_A, KEY_B], [{ employee: linus }]);
    const byId = new Map(
      (await call<PublicModel[]>("GET", "")).body.map((model) => [model.id, model]),
    );
    assert.deepEqual(byId.get(first.id)!.duplicateIds, [reordered.id]);
    assert.deepEqual(byId.get(reordered.id)!.duplicateIds, [first.id]);
    assert.deepEqual(byId.get(fewer.id)!.duplicateIds, []);
  });
});

describe("who may manage the company's AI Models", () => {
  test("a Member reads an employee's models but not the company's list, and changes nothing", async (t) => {
    stubProvider(t);
    const shared = await claudeModel([KEY_A], [{ employee: ada }]);
    await actAs("member");
    assert.equal((await call("GET", "")).status, 403);
    assert.equal((await call("GET", `/${shared.id}`)).status, 403);
    assert.equal(
      (await call("POST", `/${shared.id}/attach`, { employeeIds: [grace.id] })).status,
      403,
    );
    assert.equal(
      (await call("POST", `/${shared.id}/detach`, { employeeIds: [ada.id] })).status,
      403,
    );
    assert.equal((await call("DELETE", `/${shared.id}?detach=true`)).status, 403);
    assert.equal((await call("POST", `/${shared.id}/test`)).status, 403);
    const own = await call<PublicModel[]>("GET", "", undefined, { employee: ada });
    assert.equal(own.status, 200);
    assert.deepEqual(
      own.body.map((model) => model.id),
      [shared.id],
    );
    assert.equal(
      (await call("POST", "/attach", { modelId: shared.id }, { employee: grace })).status,
      403,
    );
    assert.deepEqual(await attachmentsOf(grace.id), []);
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }));
  });

  test("an admin manages them like an owner", async (t) => {
    stubProvider(t);
    const shared = await claudeModel([KEY_A], [{ employee: ada }]);
    await actAs("admin");
    assert.equal((await call("GET", "")).status, 200);
    assert.equal(
      (await call("POST", `/${shared.id}/attach`, { employeeIds: [grace.id] })).status,
      200,
    );
  });

  test("someone outside the company reaches nothing", async () => {
    const shared = await claudeModel([KEY_A], [{ employee: ada }]);
    actingUser = await makeUser("Outsider");
    assert.equal((await call("GET", "")).status, 403);
    assert.equal(
      (await call("POST", `/${shared.id}/attach`, { employeeIds: [grace.id] })).status,
      403,
    );
  });
});

describe("adding a company AI Model", () => {
  test("connecting a key attaches the new model, active, to every employee named", async (t) => {
    const calls = stubProvider(t);
    const previous = await claudeModel([KEY_B], [{ employee: ada }]);
    const created = await call("POST", "/connect", {
      provider: "anthropic",
      apiKey: KEY_A,
      employeeIds: [ada.id, grace.id],
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.status, "connected");
    assert.deepEqual(names(created.body.employees), ["Ada", "Grace"]);
    assert.ok(created.body.employees.every((user) => user.isActive));
    assert.deepEqual(calls, [[KEY_A]]);
    assert.equal((await getActiveModel(ada.id))?.id, created.body.id);
    assert.equal((await getActiveModel(grace.id))?.id, created.body.id);
    // Ada keeps what she had as a standby, and there is one new row for both.
    assert.equal((await attachmentsOf(ada.id)).length, 2);
    assert.ok((await attachmentsOf(ada.id)).some((row) => row.modelId === previous.id));
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 2);
    assert.equal((await audits("model.configure"))[0].targetType, "ai_model");
    assert.deepEqual(
      (await audits("model.attach")).map((row) => row.targetLabel).sort(),
      ["Ada", "Grace"],
    );
  });

  test("a model connected for nobody waits in the company's list", async (t) => {
    stubProvider(t);
    const created = await call("POST", "/connect", { provider: "anthropic", apiKey: KEY_A });
    assert.equal(created.status, 200, created.text);
    assert.deepEqual(created.body.employees, []);
    assert.equal(await AppDataSource.getRepository(EmployeeModel).count(), 0);
    const listed = await call<PublicModel[]>("GET", "");
    assert.deepEqual(
      listed.body.map((model) => model.id),
      [created.body.id],
    );
  });

  test("a key that fails its test saves nothing and attaches nobody", async (t) => {
    stubProvider(t, () => 401);
    const refused = await call("POST", "/connect", {
      provider: "anthropic",
      apiKey: KEY_A,
      employeeIds: [ada.id],
    });
    assert.equal(refused.status, 422);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
    assert.deepEqual(await attachmentsOf(ada.id), []);
  });

  test("an employee of another company is refused, and nothing is saved", async (t) => {
    stubProvider(t);
    const stranger = await makeUser("Stranger");
    const globex = await makeCompany("Globex", stranger.id);
    const outsider = await makeEmployee(globex.id, "Outsider");
    const refused = await call("POST", "/connect", {
      provider: "anthropic",
      apiKey: KEY_A,
      employeeIds: [ada.id, outsider.id],
    });
    assert.equal(refused.status, 409);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
    assert.deepEqual(await attachmentsOf(ada.id), []);
  });

  test("a ChatGPT sign-in still to come is created waiting, attached to who it is for", async () => {
    const created = await call("POST", "/", {
      provider: "openai",
      model: "auto",
      authMode: "subscription",
      employeeIds: [ada.id],
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.status, "not_connected");
    assert.deepEqual(names(created.body.employees), ["Ada"]);
  });

  test("the request is validated at the boundary", async () => {
    for (const body of [
      { provider: "anthropic", apiKey: KEY_A, employeeIds: ["not-a-uuid"] },
      { provider: "anthropic", apiKey: KEY_A, employeeIds: [ada.id, ada.id] },
      { provider: "custom", apiKey: KEY_A },
      { provider: "anthropic", apiKey: "" },
    ]) {
      assert.equal((await call("POST", "/connect", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(
      (await call("POST", "/", { provider: "anthropic", model: "x", authMode: "subscription" }))
        .status,
      400,
    );
  });
});

describe("attaching and detaching", () => {
  test("one model attached to two employees is both employees' model, with one set of keys", async () => {
    const shared = await claudeModel([KEY_A, BACKUP]);
    const attached = await call("POST", `/${shared.id}/attach`, {
      employeeIds: [ada.id, grace.id],
    });
    assert.equal(attached.status, 200, attached.text);
    assert.deepEqual(names(attached.body.employees), ["Ada", "Grace"]);
    for (const employee of [ada, grace]) {
      const own = await call<PublicModel[]>("GET", "", undefined, { employee });
      assert.deepEqual(
        own.body.map((model) => [model.id, model.isActive]),
        [[shared.id, true]],
      );
      assert.deepEqual(
        own.body[0].apiKeys.map((key) => key.preview),
        [maskSecret(KEY_A), maskSecret(BACKUP)],
      );
      assert.deepEqual(names(own.body[0].employees), ["Ada", "Grace"]);
    }
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 1);
  });

  test("detaching from one leaves the model, its keys, and the other employee's use alone", async () => {
    const shared = await claudeModel([KEY_A], [{ employee: ada }, { employee: grace }]);
    const before = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: shared.id });
    const detached = await call("POST", `/${shared.id}/detach`, { employeeIds: [ada.id] });
    assert.equal(detached.status, 200, detached.text);
    assert.deepEqual(names(detached.body.employees), ["Grace"]);
    assert.equal(await getActiveModel(ada.id), null);
    assert.equal((await getActiveModel(grace.id))?.id, shared.id);
    const after = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: shared.id });
    assert.equal(after.configJson, before.configJson);
    assert.equal((await audits("model.detach"))[0].targetLabel, "Ada");
  });

  test("attaching makes it active; an employee switched to it keeps its old model as a standby", async () => {
    const own = await claudeModel([KEY_B], [{ employee: ada }]);
    const shared = await claudeModel([KEY_A]);
    await call("POST", `/${shared.id}/attach`, { employeeIds: [ada.id] });
    assert.equal((await flaggedActiveModel(ada.id))?.id, shared.id);
    await call("POST", `/${own.id}/activate`, undefined, { employee: ada });
    assert.equal((await flaggedActiveModel(ada.id))?.id, own.id);
    // makeActive false leaves the brain alone.
    await call("POST", `/${shared.id}/detach`, { employeeIds: [ada.id] });
    await call("POST", `/${shared.id}/attach`, { employeeIds: [ada.id], makeActive: false });
    assert.equal((await flaggedActiveModel(ada.id))?.id, own.id);
  });

  test("a model still waiting to connect can't be attached", async () => {
    const waiting = await insert(AIModel, {
      companyId: company.id,
      provider: "openai",
      model: "auto",
      authMode: "subscription",
      configJson: "{}",
    });
    const refused = await call<{ error: string }>("POST", `/${waiting.id}/attach`, {
      employeeIds: [ada.id],
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /isn't connected yet/);
  });

  test("another company's model or employee is not found, and nothing changes", async () => {
    const stranger = await makeUser("Stranger");
    const globex = await makeCompany("Globex", stranger.id);
    const outsider = await makeEmployee(globex.id, "Outsider");
    const theirs = await claudeModel([KEY_B], [], { companyId: globex.id });
    const ours = await claudeModel([KEY_A]);
    assert.equal(
      (await call("POST", `/${theirs.id}/attach`, { employeeIds: [ada.id] })).status,
      404,
    );
    assert.equal(
      (await call("POST", `/${ours.id}/attach`, { employeeIds: [ada.id, outsider.id] })).status,
      404,
    );
    assert.deepEqual(await attachmentsOf(ada.id), []);
    assert.deepEqual(await attachmentsOf(outsider.id), []);
  });

  test("detaching an employee that doesn't use it is refused", async () => {
    const shared = await claudeModel([KEY_A], [{ employee: ada }]);
    const refused = await call<{ error: string }>("POST", `/${shared.id}/detach`, {
      employeeIds: [ada.id, grace.id],
    });
    assert.equal(refused.status, 404);
    assert.match(refused.body.error, /Grace doesn't use this AI Model/);
    assert.equal((await getActiveModel(ada.id))?.id, shared.id);
  });

  test("attach and detach validate their request", async () => {
    const shared = await claudeModel([KEY_A]);
    for (const body of [
      {},
      { employeeIds: [] },
      { employeeIds: ["nope"] },
      { employeeIds: [ada.id, ada.id] },
      { employeeIds: [ada.id], extra: true },
    ]) {
      assert.equal((await call("POST", `/${shared.id}/attach`, body)).status, 400);
      assert.equal((await call("POST", `/${shared.id}/detach`, body)).status, 400);
    }
  });
});

describe("removing a company AI Model", () => {
  test("is refused while anyone uses it, naming them, and changes nothing", async () => {
    const shared = await claudeModel([KEY_A], [{ employee: ada }, { employee: grace }]);
    const refused = await call<{ error: string; employees: Array<{ name: string }> }>(
      "DELETE",
      `/${shared.id}`,
    );
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Ada and Grace still use this AI Model/);
    assert.deepEqual(
      refused.body.employees.map((user) => user.name),
      ["Ada", "Grace"],
    );
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }));
    assert.equal(await AppDataSource.getRepository(EmployeeModel).count(), 2);
  });

  test("with detach=true it goes from everyone, who switch to another model, keys and pins with it", async () => {
    const shared = await claudeModel([KEY_A, BACKUP], [{ employee: ada }, { employee: grace }]);
    const fallback = await claudeModel([KEY_B], [{ employee: ada, active: false }]);
    for (const key of readApiKeys(shared.configJson)) {
      await insert(AIModelKeyHealth, { modelId: shared.id, keyId: key.id, lastUsedAt: new Date() });
    }
    const pinned = await insert(Routine, {
      employeeId: grace.id,
      name: "Nightly",
      slug: `nightly-${randomUUID().slice(0, 8)}`,
      cronExpr: "0 3 * * *",
      modelId: shared.id,
    });
    const removed = await call("DELETE", `/${shared.id}?detach=true`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }), null);
    assert.equal(await AppDataSource.getRepository(AIModelKeyHealth).countBy({ modelId: shared.id }), 0);
    assert.equal((await flaggedActiveModel(ada.id))?.id, fallback.id);
    assert.equal(await getActiveModel(grace.id), null);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: pinned.id })).modelId,
      null,
    );
    assert.equal((await audits("model.delete")).length, 1);
    assert.deepEqual(
      (await audits("model.detach")).map((row) => row.targetLabel).sort(),
      ["Ada", "Grace"],
    );
  });

  test("a model nobody uses is removed straight away", async () => {
    const spare = await endpointModel();
    assert.equal((await call("DELETE", `/${spare.id}`)).status, 200);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
  });

  test("another company's model can't be removed through this company", async () => {
    const stranger = await makeUser("Stranger");
    const globex = await makeCompany("Globex", stranger.id);
    const theirs = await claudeModel([KEY_B], [], { companyId: globex.id });
    assert.equal((await call("DELETE", `/${theirs.id}?detach=true`)).status, 404);
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: theirs.id }));
  });
});

describe("merging exact duplicates", () => {
  test("moves every employee onto the kept model, keeping each one's active choice", async () => {
    const kept = await claudeModel([KEY_A], [{ employee: ada }], {
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
    });
    const copy = await claudeModel([KEY_A], [{ employee: grace }, { employee: linus, active: false }], {
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
    });
    const linusOwn = await claudeModel([KEY_B], []);
    await attachExistingModel({ employeeId: linus.id, modelId: linusOwn.id, isActive: true });
    // Ada had both copies; her active one was the duplicate.
    await attachExistingModel({ employeeId: ada.id, modelId: copy.id, isActive: true });
    const pinned = await insert(Routine, {
      employeeId: grace.id,
      name: "Weekly",
      slug: `weekly-${randomUUID().slice(0, 8)}`,
      cronExpr: "0 9 * * 1",
      modelId: copy.id,
    });
    const mailbox = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "ops@example.test",
      aiAnalysisEmployeeId: grace.id,
      aiAnalysisModelId: copy.id,
    });
    const session = await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: randomUUID(),
      employeeId: grace.id,
      requestedByUserId: owner.id,
      title: "Plan",
      instruction: "Draft the plan",
      modelId: copy.id,
    });
    const merged = await call("POST", `/${kept.id}/merge`, { duplicateIds: [copy.id] });
    assert.equal(merged.status, 200, merged.text);
    assert.deepEqual(names(merged.body.employees), ["Ada", "Grace", "Linus"]);
    assert.deepEqual(merged.body.duplicateIds, []);
    assert.equal(await AppDataSource.getRepository(AIModel).findOneBy({ id: copy.id }), null);
    // Ada keeps one attachment, now to the kept model, still active.
    assert.deepEqual(
      (await attachmentsOf(ada.id)).map((row) => [row.modelId, row.isActive]),
      [[kept.id, true]],
    );
    assert.equal((await flaggedActiveModel(grace.id))?.id, kept.id);
    // Linus keeps his own model active; the merged copy stays a standby.
    assert.equal((await flaggedActiveModel(linus.id))?.id, linusOwn.id);
    assert.ok((await attachmentsOf(linus.id)).some((row) => row.modelId === kept.id && !row.isActive));
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: pinned.id })).modelId,
      kept.id,
    );
    assert.equal(
      (await AppDataSource.getRepository(MailAccount).findOneByOrFail({ id: mailbox.id }))
        .aiAnalysisModelId,
      kept.id,
    );
    assert.equal(
      (await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({ id: session.id }))
        .modelId,
      kept.id,
    );
    const [audit] = await audits("model.merge");
    assert.equal(audit.targetId, kept.id);
    assert.ok(!JSON.stringify(audit).includes(KEY_A));
  });

  test("folds each key's health into the kept model's", async () => {
    const kept = await claudeModel([KEY_A], [{ employee: ada }]);
    const copy = await claudeModel([KEY_A], [{ employee: grace }]);
    const keptKey = readApiKeys(kept.configJson)[0].id;
    const copyKey = readApiKeys(copy.configJson)[0].id;
    await insert(AIModelKeyHealth, {
      modelId: kept.id,
      keyId: keptKey,
      lastUsedAt: new Date("2026-10-05T10:00:00.000Z"),
    });
    await insert(AIModelKeyHealth, {
      modelId: copy.id,
      keyId: copyKey,
      lastUsedAt: new Date("2026-10-06T10:00:00.000Z"),
      lastErrorAt: new Date("2026-10-07T10:00:00.000Z"),
      lastErrorStatus: 402,
      lastErrorKind: "billing",
      lastErrorMessage: "Out of credit",
    });
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [copy.id] })).status,
      200,
    );
    const rows = await AppDataSource.getRepository(AIModelKeyHealth).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].modelId, kept.id);
    assert.equal(rows[0].keyId, keptKey);
    assert.equal(rows[0].lastUsedAt?.toISOString(), "2026-10-06T10:00:00.000Z");
    assert.equal(rows[0].lastErrorStatus, 402);
    assert.equal(rows[0].lastErrorKind, "billing");
  });

  test("folds health key by key, whatever order each copy lists its keys in, sessions added up", async () => {
    const kept = await claudeModel([KEY_A, KEY_B], [{ employee: ada }]);
    const copy = await claudeModel([KEY_B, KEY_A], [{ employee: grace }]);
    const [keptA, keptB] = readApiKeys(kept.configJson).map((key) => key.id);
    const [copyB, copyA] = readApiKeys(copy.configJson).map((key) => key.id);
    const hour = Math.floor(Date.now() / 3_600_000);
    await insert(AIModelKeyHealth, {
      modelId: kept.id,
      keyId: keptA,
      sessionsByHour: JSON.stringify([[hour, 2]]),
    });
    await insert(AIModelKeyHealth, {
      modelId: copy.id,
      keyId: copyA,
      sessionsByHour: JSON.stringify([[hour, 3]]),
    });
    await insert(AIModelKeyHealth, {
      modelId: copy.id,
      keyId: copyB,
      lastErrorAt: new Date("2026-10-07T10:00:00.000Z"),
      lastErrorStatus: 401,
      lastErrorKind: "auth",
      lastErrorMessage: "invalid x-api-key",
    });
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [copy.id] })).status,
      200,
    );
    const rows = await AppDataSource.getRepository(AIModelKeyHealth).find();
    const byKey = new Map(rows.map((row) => [row.keyId, row]));
    assert.ok(rows.every((row) => row.modelId === kept.id));
    // KEY_A's sessions from both copies, on KEY_A — not on whatever sat in its place.
    assert.equal(byKey.get(keptA)?.sessionsByHour, JSON.stringify([[hour, 5]]));
    assert.equal(byKey.get(keptA)?.lastErrorStatus ?? null, null);
    // KEY_B's refusal lands on KEY_B.
    assert.equal(byKey.get(keptB)?.lastErrorStatus, 401);
    assert.equal(byKey.get(keptB)?.lastErrorKind, "auth");
  });

  test("custom endpoints with the same server, model and key are duplicates too", async () => {
    const kept = await endpointModel();
    const copy = await endpointModel();
    await attachExistingModel({ employeeId: grace.id, modelId: copy.id, isActive: true });
    const listed = await call<PublicModel[]>("GET", "");
    assert.deepEqual(
      listed.body.find((model) => model.id === kept.id)?.duplicateIds,
      [copy.id],
    );
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [copy.id] })).status,
      200,
    );
    assert.equal((await flaggedActiveModel(grace.id))?.id, kept.id);
  });

  test("refuses anything that is not an exact duplicate right now, merging nothing", async () => {
    const kept = await claudeModel([KEY_A], [{ employee: ada }]);
    const differentKey = await claudeModel([KEY_B], [{ employee: grace }]);
    const refused = await call<{ error: string }>("POST", `/${kept.id}/merge`, {
      duplicateIds: [differentKey.id],
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /no longer exact duplicates/);
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: differentKey.id }));
    assert.equal((await flaggedActiveModel(grace.id))?.id, differentKey.id);
    // A copy with an extra key in its pool is a different setup.
    const withBackup = await claudeModel([KEY_A, BACKUP]);
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [withBackup.id] })).status,
      409,
    );
  });

  test("never merges a ChatGPT sign-in, another company's model, or a model into itself", async () => {
    const kept = await claudeModel([KEY_A]);
    const signIn = await insert(AIModel, {
      companyId: company.id,
      provider: "openai",
      model: "auto",
      authMode: "subscription",
      configJson: JSON.stringify({ codexAccessTokenEncrypted: encryptSecret("token", "x") }),
    });
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [signIn.id] })).status,
      409,
    );
    const stranger = await makeUser("Stranger");
    const globex = await makeCompany("Globex", stranger.id);
    const theirs = await claudeModel([KEY_A], [], { companyId: globex.id });
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [theirs.id] })).status,
      404,
    );
    assert.equal(
      (await call("POST", `/${kept.id}/merge`, { duplicateIds: [kept.id] })).status,
      400,
    );
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 3);
  });
});

describe("a shared model's settings serve everyone on it", () => {
  test("a key added once is in every employee's pool", async (t) => {
    const calls = stubProvider(t);
    const shared = await claudeModel([KEY_A], [{ employee: ada }, { employee: grace }]);
    const added = await call("POST", `/${shared.id}/keys`, { apiKey: BACKUP });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual(calls, [[BACKUP]]);
    for (const employee of [ada, grace]) {
      const own = await call<PublicModel[]>("GET", "", undefined, { employee });
      assert.deepEqual(
        own.body[0].apiKeys.map((key) => key.preview),
        [maskSecret(KEY_A), maskSecret(BACKUP)],
      );
    }
  });

  test("changing the model changes it for every employee on it", async (t) => {
    stubProvider(t);
    const shared = await claudeModel([KEY_A], [{ employee: ada }, { employee: grace }]);
    const edited = await call("PUT", `/${shared.id}`, {
      provider: "anthropic",
      authMode: "apikey",
      model: "claude-sonnet-5",
    });
    assert.equal(edited.status, 200, edited.text);
    assert.equal((await getActiveModel(ada.id))?.model, "claude-sonnet-5");
    assert.equal((await getActiveModel(grace.id))?.model, "claude-sonnet-5");
  });

  test("a concurrent-Run limit is one limit for the whole model", async () => {
    const shared = await endpointModel();
    await attachExistingModel({ employeeId: ada.id, modelId: shared.id, isActive: true });
    await attachExistingModel({ employeeId: grace.id, modelId: shared.id, isActive: true });
    const set = await call("PUT", `/${shared.id}/run-concurrency`, { maxConcurrentRuns: 2 });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.effectiveMaxConcurrentRuns, 2);
    for (const employee of [ada, grace]) {
      const own = await call<PublicModel[]>("GET", "", undefined, { employee });
      assert.equal(own.body[0].effectiveMaxConcurrentRuns, 2);
    }
  });

  test("Test connection runs once, on the model, whoever uses it", async (t) => {
    const calls = stubProvider(t);
    const shared = await claudeModel([KEY_A], [{ employee: ada }, { employee: grace }]);
    const reply = await call<{ ok: boolean; model: PublicModel }>("POST", `/${shared.id}/test`);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(names(reply.body.model.employees), ["Ada", "Grace"]);
    assert.deepEqual(calls, [[KEY_A]]);
  });

  test("a ChatGPT sign-in defaults to one Run at a time across its employees", async () => {
    const signIn = await insert(AIModel, {
      companyId: company.id,
      provider: "openai",
      model: "auto",
      authMode: "subscription",
      configJson: JSON.stringify({ codexAccessTokenEncrypted: encryptSecret("token", "x") }),
      connectedAt: new Date(),
    });
    const shown = await call("GET", `/${signIn.id}`);
    assert.equal(shown.body.effectiveMaxConcurrentRuns, 1);
    assert.equal(shown.body.concurrencySource, "subscription-default");
  });
});
