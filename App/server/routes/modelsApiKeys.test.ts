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
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { agentRuntime } from "../services/agent/runtime.js";
import {
  LEGACY_PRIMARY_KEY_ID,
  decryptApiKeys,
  newStoredApiKey,
  readApiKeys,
  writeApiKeys,
} from "../services/modelApiKeys.js";
import { resetKeyHealthMemory } from "../services/modelKeyHealth.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { modelsRouter } from "./models.js";

/**
 * Backup API keys on an AI Model, through the real models router: adding,
 * reordering and removing keys, who may, and that no key ever comes back.
 */

type PublicKey = {
  id: string;
  preview: string;
  addedAt: string | null;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorStatus: number | null;
  lastErrorKind: string | null;
  lastError: string | null;
  restingUntil: string | null;
};
type PublicModel = {
  id: string;
  apiKeys: PublicKey[];
  status: string;
  model: string;
  provider: string;
};
type ApiResponse<T> = { status: number; body: T; text: string };

const mutableConfig = config as unknown as {
  sessionSecret: string;
  security: { encryptionSecret: string };
};
const originalSecrets = {
  sessionSecret: mutableConfig.sessionSecret,
  encryptionSecret: mutableConfig.security.encryptionSecret,
};

const PRIMARY = "sk-ant-api03-primary-route-key-aaaa0001";
const backupKey = (n: number) => `sk-ant-api03-backup-route-key-${String(n).padStart(4, "0")}`;
/** Every plaintext key a test in this file ever sends. */
const SENT = new Set<string>([PRIMARY]);

let server: Server;
let baseUrl: string;
let realFetch: typeof fetch;
let actingUser: User;
let owner: User;
let company: Company;
let employee: AIEmployee;

before(async () => {
  mutableConfig.sessionSecret = "model-api-keys-session-secret-0123456789abcdef";
  mutableConfig.security.encryptionSecret = "model-api-keys-encryption-secret-0123456789abcdef";
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
  realFetch = globalThis.fetch;
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
  resetKeyHealthMemory();
  owner = await makeUser("Owner");
  actingUser = owner;
  company = await makeCompany("Acme", owner.id);
  employee = await makeEmployee(company.id, "Avery");
});

async function actAs(role: Role): Promise<User> {
  const user = await makeUser(role);
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  actingUser = user;
  return user;
}

/** Every key this file sends, and every ciphertext, must stay out of what comes back. */
function assertNoSecrets(text: string): void {
  for (const secret of SENT) assert.ok(!text.includes(secret), `response leaked ${secret}`);
  for (const field of ["apiKeyEncrypted", "configJson", "backupKeys", "v2."]) {
    assert.ok(!text.includes(field), `response exposed ${field}`);
  }
}

async function call<T = PublicModel>(
  method: string,
  path: string,
  body?: unknown,
  options: { employee?: AIEmployee; companyId?: string } = {},
): Promise<ApiResponse<T>> {
  const response = await realFetch(
    `${baseUrl}/api/companies/${options.companyId ?? company.id}/employees/${
      (options.employee ?? employee).id
    }/models${path}`,
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

const addKey = (modelId: string, apiKey: string) => {
  SENT.add(apiKey);
  return call("POST", `/${modelId}/keys`, { apiKey });
};

/** An Anthropic model connected with `keys`, the first as the primary. */
async function claudeModel(
  keys: string[] = [PRIMARY],
  overrides: Partial<AIModel> & { owner?: AIEmployee; companyId?: string } = {},
): Promise<AIModel> {
  const { owner: holder = employee, companyId = company.id, ...rest } = overrides;
  for (const key of keys) SENT.add(key);
  return insert(AIModel, {
    employeeId: holder.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      keys.map((key) => newStoredApiKey(key, companyId)),
    ),
    connectedAt: new Date("2026-10-01T10:00:00.000Z"),
    ...rest,
  });
}

/** Stub the connection test: every key passes unless `refuse` says otherwise. */
function stubVerification(
  t: TestContext,
  refuse: (keys: string[]) => number | null = () => null,
): Array<{ keys: string[]; model: string }> {
  const calls: Array<{ keys: string[]; model: string }> = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const keys = decryptApiKeys(params.model.configJson).map((key) => key.apiKey);
    calls.push({ keys, model: params.model.model });
    const status = refuse(keys);
    if (status) throw Object.assign(new Error("The AI Model request failed."), { status });
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  // The context-window probe asks the provider; answer it without a network.
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    return Promise.resolve(Response.json({ id: "claude-opus-5-5", max_input_tokens: 200_000 }));
  });
  return calls;
}

const savedModel = (id: string) => AppDataSource.getRepository(AIModel).findOneByOrFail({ id });
const savedKeys = async (id: string) =>
  decryptApiKeys((await savedModel(id)).configJson).map((key) => key.apiKey);
const audits = (action: string) => AppDataSource.getRepository(AuditEvent).findBy({ action });

describe("adding backup keys", () => {
  test("an owner adds a backup key: tested on its own, stored encrypted, shown as a preview", async (t) => {
    const calls = stubVerification(t);
    const model = await claudeModel();
    const response = await addKey(model.id, backupKey(1));
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.apiKeys.map((key) => key.preview),
      [maskSecret(PRIMARY), maskSecret(backupKey(1))],
    );
    assert.ok(response.body.apiKeys[1].addedAt);
    // Tested with that key alone: the primary could not have answered for it.
    assert.deepEqual(calls, [{ keys: [backupKey(1)], model: "claude-opus-5-5" }]);
    const row = await savedModel(model.id);
    const cfg = JSON.parse(row.configJson);
    assert.equal(cfg.backupKeys.length, 1);
    assert.match(cfg.backupKeys[0].apiKeyEncrypted, /^v2\./);
    assert.equal(decryptSecret(cfg.backupKeys[0].apiKeyEncrypted), backupKey(1));
    assert.ok(!row.configJson.includes(backupKey(1)));
    // The primary is untouched.
    assert.equal(decryptSecret(cfg.apiKeyEncrypted), PRIMARY);
    const [audit] = await audits("model.apikey.add");
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit).includes(backupKey(1)));
    const metadata = JSON.parse(String(audit.metadataJson ?? "{}"));
    assert.equal(metadata.keyPreview, maskSecret(backupKey(1)));
    assert.equal(metadata.keyCount, 2);
  });

  test("there is no limit: thirty backup keys, kept in the order they were added", async (t) => {
    stubVerification(t);
    const model = await claudeModel();
    for (let n = 1; n <= 30; n++) assert.equal((await addKey(model.id, backupKey(n))).status, 200);
    const listed = await call<PublicModel[]>("GET", "");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].apiKeys.length, 31);
    assert.deepEqual(await savedKeys(model.id), [
      PRIMARY,
      ...Array.from({ length: 30 }, (_, i) => backupKey(i + 1)),
    ]);
  });

  test("a key that fails its test is not added", async (t) => {
    stubVerification(t, (keys) => (keys.includes(backupKey(9)) ? 401 : null));
    const model = await claudeModel();
    const response = await addKey(model.id, backupKey(9));
    assert.equal(response.status, 422);
    assert.match((response.body as unknown as { error: string }).error, /rejected this credential/);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY]);
    assert.equal((await audits("model.apikey.add")).length, 0);
  });

  test("an out-of-credit key (402) is turned away with the billing explanation", async (t) => {
    stubVerification(t, () => 402);
    const model = await claudeModel();
    const response = await addKey(model.id, backupKey(2));
    assert.equal(response.status, 422);
    assert.match(
      (response.body as unknown as { error: string }).error,
      /billing, quota, or a rate limit/,
    );
  });

  test("a key the AI Model already holds is refused before any test", async (t) => {
    const calls = stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    for (const duplicate of [PRIMARY, backupKey(1), `  ${backupKey(1)}  `]) {
      const response = await addKey(model.id, duplicate);
      assert.equal(response.status, 400);
      assert.match(
        (response.body as unknown as { error: string }).error,
        /already on this AI Model/,
      );
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1)]);
  });

  test("an older model's primary, saved before keys had ids, gains backups", async (t) => {
    stubVerification(t);
    const model = await insert(AIModel, {
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      isActive: true,
      configJson: JSON.stringify({
        apiKeyEncrypted: encryptSecret(PRIMARY, company.id),
        apiKeyPreview: maskSecret(PRIMARY),
      }),
      connectedAt: new Date(),
    });
    const response = await addKey(model.id, backupKey(3));
    assert.equal(response.status, 200);
    assert.equal(response.body.apiKeys[0].id, LEGACY_PRIMARY_KEY_ID);
    assert.equal(response.body.apiKeys[0].addedAt, null);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(3)]);
  });

  test("OpenAI API-key models take backup keys too", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY], { provider: "openai", model: "gpt-5.4" });
    assert.equal((await addKey(model.id, backupKey(4))).status, 200);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(4)]);
  });

  test("models that don't connect with an API key refuse backup keys", async (t) => {
    const calls = stubVerification(t);
    const custom = await insert(AIModel, {
      employeeId: employee.id,
      provider: "custom",
      model: "qwen3",
      authMode: "customEndpoint",
      isActive: false,
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret("http://gpu-box:8000/v1", company.id),
        baseURLPreview: "gpu-box:8000",
        modelId: "qwen3",
      }),
      connectedAt: new Date(),
    });
    const subscription = await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
      isActive: false,
      configJson: "{}",
    });
    const notConnected = await claudeModel([], { isActive: false });
    for (const model of [custom, subscription, notConnected]) {
      const response = await addKey(model.id, backupKey(5));
      assert.equal(response.status, 400, model.authMode);
    }
    assert.equal(calls.length, 0);
  });

  test("the request body is validated", async (t) => {
    stubVerification(t);
    const model = await claudeModel();
    for (const body of [
      {},
      { apiKey: "" },
      { apiKey: "   " },
      { apiKey: "x".repeat(501) },
      { apiKey: 42 },
      { apiKey: backupKey(6), primary: true },
    ]) {
      const response = await call("POST", `/${model.id}/keys`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((response.body as unknown as { error: string }).error, "ValidationError");
    }
    assert.equal((await call("POST", `/not-a-uuid/keys`, { apiKey: backupKey(6) })).status, 400);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY]);
  });

  test("an unknown model is not found", async (t) => {
    stubVerification(t);
    await claudeModel();
    assert.equal((await addKey(randomUUID(), backupKey(7))).status, 404);
  });
});

describe("reordering keys", () => {
  test("moving a backup to the top makes it the primary", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1), backupKey(2)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    const response = await call("POST", `/${model.id}/keys/reorder`, {
      orderedIds: [ids[2], ids[0], ids[1]],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.apiKeys.map((key) => key.id),
      [ids[2], ids[0], ids[1]],
    );
    assert.deepEqual(await savedKeys(model.id), [backupKey(2), PRIMARY, backupKey(1)]);
    const cfg = JSON.parse((await savedModel(model.id)).configJson);
    assert.equal(
      decryptSecret(cfg.apiKeyEncrypted),
      backupKey(2),
      "the new primary is where every reader looks",
    );
    assert.equal(response.body.status, "connected");
    const [audit] = await audits("model.apikey.reorder");
    const metadata = JSON.parse(String(audit.metadataJson ?? "{}"));
    assert.deepEqual(metadata.orderedKeyIds, [ids[2], ids[0], ids[1]]);
    assert.equal(metadata.orderedPreviews.length, 3);
  });

  test("a list that no longer matches the saved keys is refused, not guessed at", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1), backupKey(2)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    for (const orderedIds of [
      [ids[0], ids[1]],
      [ids[0], ids[1], randomUUID()],
      [...ids, randomUUID()],
    ]) {
      const response = await call("POST", `/${model.id}/keys/reorder`, { orderedIds });
      assert.equal(response.status, 409, JSON.stringify(orderedIds));
    }
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1), backupKey(2)]);
  });

  test("the order is validated", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    for (const body of [
      {},
      { orderedIds: [] },
      { orderedIds: [ids[0], ids[0]] },
      { orderedIds: ["not-an-id", ids[1]] },
      { orderedIds: ids, extra: 1 },
    ]) {
      const response = await call("POST", `/${model.id}/keys/reorder`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });

  test("an older primary is named `primary` in an order", async (t) => {
    stubVerification(t);
    // A primary saved before keys had ids, with a backup added since.
    const legacy = JSON.stringify({
      apiKeyEncrypted: encryptSecret(PRIMARY, company.id),
      apiKeyPreview: maskSecret(PRIMARY),
    });
    const model = await insert(AIModel, {
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      isActive: true,
      configJson: writeApiKeys(legacy, [
        ...readApiKeys(legacy),
        newStoredApiKey(backupKey(1), company.id),
      ]),
      connectedAt: new Date(),
    });
    const [primary, backup] = readApiKeys(model.configJson);
    assert.equal(primary.id, LEGACY_PRIMARY_KEY_ID);
    const response = await call("POST", `/${model.id}/keys/reorder`, {
      orderedIds: [backup.id, LEGACY_PRIMARY_KEY_ID],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await savedKeys(model.id), [backupKey(1), PRIMARY]);
  });
});

describe("removing keys", () => {
  test("removing a backup leaves the rest, in order, and forgets its health", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1), backupKey(2)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    await insert(AIModelKeyHealth, { modelId: model.id, keyId: ids[1], lastUsedAt: new Date() });
    await insert(AIModelKeyHealth, { modelId: model.id, keyId: ids[2], lastUsedAt: new Date() });
    const response = await call("DELETE", `/${model.id}/keys/${ids[1]}`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.apiKeys.map((key) => key.id),
      [ids[0], ids[2]],
    );
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(2)]);
    const health = await AppDataSource.getRepository(AIModelKeyHealth).findBy({
      modelId: model.id,
    });
    assert.deepEqual(
      health.map((row) => row.keyId),
      [ids[2]],
    );
    const [audit] = await audits("model.apikey.remove");
    const metadata = JSON.parse(String(audit.metadataJson ?? "{}"));
    assert.equal(metadata.keyId, ids[1]);
    assert.equal(metadata.keyCount, 2);
  });

  test("removing the primary makes the next key the primary", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const [primary, backup] = readApiKeys(model.configJson);
    const response = await call("DELETE", `/${model.id}/keys/${primary.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.apiKeys.map((key) => key.id),
      [backup.id],
    );
    assert.equal(response.body.status, "connected");
    assert.equal(
      decryptSecret(JSON.parse((await savedModel(model.id)).configJson).apiKeyEncrypted),
      backupKey(1),
    );
  });

  test("the only key can't be removed", async (t) => {
    stubVerification(t);
    const model = await claudeModel();
    const [only] = readApiKeys(model.configJson);
    const response = await call("DELETE", `/${model.id}/keys/${only.id}`);
    assert.equal(response.status, 400);
    assert.match((response.body as unknown as { error: string }).error, /only API key/);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY]);
  });

  test("an unknown key is not found, and a malformed id is refused", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    assert.equal((await call("DELETE", `/${model.id}/keys/${randomUUID()}`)).status, 404);
    assert.equal((await call("DELETE", `/${model.id}/keys/not-a-key`)).status, 400);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1)]);
  });
});

describe("replacing the primary keeps the backups", () => {
  test("a new primary is tested alone and the backups stay behind it", async (t) => {
    const calls = stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1), backupKey(2)]);
    const [oldPrimary] = readApiKeys(model.configJson);
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: oldPrimary.id,
      lastUsedAt: new Date(),
    });
    const replacement = "sk-ant-api03-replacement-primary-00009";
    SENT.add(replacement);
    const response = await call("POST", `/${model.id}/apikey`, { apiKey: replacement });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0].keys, [replacement]);
    assert.deepEqual(await savedKeys(model.id), [replacement, backupKey(1), backupKey(2)]);
    assert.notEqual(response.body.apiKeys[0].id, oldPrimary.id);
    assert.equal(
      await AppDataSource.getRepository(AIModelKeyHealth).countBy({ keyId: oldPrimary.id }),
      0,
      "the replaced key's health goes with it",
    );
  });

  test("a primary that would only answer through a backup is not accepted", async (t) => {
    // The backup works, the new primary doesn't: tested together, the backup
    // would have vouched for it.
    stubVerification(t, (keys) => (keys.includes(backupKey(1)) ? null : 401));
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const bad = "sk-ant-api03-replacement-that-is-dead-01";
    SENT.add(bad);
    const response = await call("POST", `/${model.id}/apikey`, { apiKey: bad });
    assert.equal(response.status, 422);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1)]);
  });

  test("one of the backups can't also become the primary", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const response = await call("POST", `/${model.id}/apikey`, { apiKey: backupKey(1) });
    assert.equal(response.status, 400);
    assert.match((response.body as unknown as { error: string }).error, /Move it to the top/);
  });

  test("changing only the model tests every key, as a Run would, and keeps them", async (t) => {
    const calls = stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const response = await call("PUT", `/${model.id}`, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      authMode: "apikey",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ keys: [PRIMARY, backupKey(1)], model: "claude-sonnet-5-5" }]);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1)]);
  });

  test("switching to another service drops the old service's keys and their health", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const [, backup] = readApiKeys(model.configJson);
    await insert(AIModelKeyHealth, { modelId: model.id, keyId: backup.id, lastUsedAt: new Date() });
    const openaiKey = "sk-proj-openai-switch-key-000000000001";
    SENT.add(openaiKey);
    const response = await call("PUT", `/${model.id}`, {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "apikey",
      apiKey: openaiKey,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await savedKeys(model.id), [openaiKey]);
    assert.equal(response.body.apiKeys.length, 1);
    assert.equal(
      await AppDataSource.getRepository(AIModelKeyHealth).countBy({ modelId: model.id }),
      0,
    );
  });
});

describe("who can see and change keys", () => {
  test("a Member reads the previews and health but changes nothing", async (t) => {
    const calls = stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    await actAs("member");
    const listed = await call<PublicModel[]>("GET", "");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].apiKeys.length, 2);
    assert.equal((await addKey(model.id, backupKey(2))).status, 403);
    assert.equal(
      (await call("POST", `/${model.id}/keys/reorder`, { orderedIds: [ids[1], ids[0]] })).status,
      403,
    );
    assert.equal((await call("DELETE", `/${model.id}/keys/${ids[1]}`)).status, 403);
    assert.equal(calls.length, 0);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1)]);
  });

  test("an admin manages keys like the owner", async (t) => {
    stubVerification(t);
    const model = await claudeModel();
    await actAs("admin");
    assert.equal((await addKey(model.id, backupKey(1))).status, 200);
  });

  test("someone outside the company reaches nothing", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    actingUser = await makeUser("Outsider");
    assert.equal((await call("GET", "")).status, 403);
    assert.equal((await addKey(model.id, backupKey(2))).status, 403);
    const [, backup] = readApiKeys(model.configJson);
    assert.equal((await call("DELETE", `/${model.id}/keys/${backup.id}`)).status, 403);
    assert.deepEqual(await savedKeys(model.id), [PRIMARY, backupKey(1)]);
  });

  test("another company's AI Model can't be reached through this company", async (t) => {
    stubVerification(t);
    const stranger = await makeUser("Stranger");
    const globex = await makeCompany("Globex", stranger.id);
    const mallory = await makeEmployee(globex.id, "Mallory");
    const theirs = await claudeModel([PRIMARY, backupKey(1)], {
      owner: mallory,
      companyId: globex.id,
    });
    const [, backup] = readApiKeys(theirs.configJson);
    // Their model id under our employee, and their employee under our company.
    assert.equal((await addKey(theirs.id, backupKey(2))).status, 404);
    assert.equal((await call("DELETE", `/${theirs.id}/keys/${backup.id}`)).status, 404);
    assert.equal(
      (
        await call(
          "POST",
          `/${theirs.id}/keys/reorder`,
          { orderedIds: [backup.id] },
          { employee: mallory },
        )
      ).status,
      404,
    );
    assert.deepEqual(await savedKeys(theirs.id), [PRIMARY, backupKey(1)]);
  });
});

describe("each key's health in the model's settings", () => {
  test("shows when each key was last used, last refused and why, and whether it rests", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1), backupKey(2)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    const now = Date.now();
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: ids[0],
      lastErrorAt: new Date(now - 30_000),
      lastErrorStatus: 401,
      lastErrorKind: "auth",
      lastErrorMessage: "invalid x-api-key",
      coolDownUntil: new Date(now + 240_000),
    });
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: ids[1],
      lastUsedAt: new Date(now - 5_000),
    });
    const [listed] = (await call<PublicModel[]>("GET", "")).body;
    assert.equal(listed.apiKeys[0].lastErrorStatus, 401);
    assert.equal(listed.apiKeys[0].lastErrorKind, "auth");
    assert.equal(listed.apiKeys[0].lastError, "invalid x-api-key");
    assert.ok(listed.apiKeys[0].restingUntil);
    assert.equal(listed.apiKeys[1].lastUsedAt, new Date(now - 5_000).toISOString());
    assert.equal(listed.apiKeys[1].restingUntil, null);
    assert.equal(listed.apiKeys[2].lastUsedAt, null);
  });

  test("removing the AI Model removes its keys' health", async (t) => {
    stubVerification(t);
    const model = await claudeModel([PRIMARY, backupKey(1)]);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    for (const keyId of ids)
      await insert(AIModelKeyHealth, { modelId: model.id, keyId, lastUsedAt: new Date() });
    const other = await claudeModel([backupKey(3)], { isActive: false });
    await insert(AIModelKeyHealth, {
      modelId: other.id,
      keyId: readApiKeys(other.configJson)[0].id,
      lastUsedAt: new Date(),
    });
    assert.equal((await call("DELETE", `/${model.id}`)).status, 200);
    const left = await AppDataSource.getRepository(AIModelKeyHealth).find();
    assert.deepEqual(
      left.map((row) => row.modelId),
      [other.id],
    );
  });

  test("subscription and custom models list no API keys", async () => {
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
      isActive: true,
      configJson: "{}",
    });
    const [listed] = (await call<PublicModel[]>("GET", "")).body;
    assert.deepEqual(listed.apiKeys, []);
  });
});
