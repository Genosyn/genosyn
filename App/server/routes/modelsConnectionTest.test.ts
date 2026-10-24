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
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { agentRuntime } from "../services/agent/runtime.js";
import { decryptApiKeys, newStoredApiKey, writeApiKeys } from "../services/modelApiKeys.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { persistTestSession } from "../test/userSession.js";
import { companyModelsRouter } from "./companyModels.js";

/**
 * Test connection and the model list for changing a model, through the real
 * models router: who may, what comes back, and that neither writes anything
 * or lets a key out.
 */

type PublicModel = {
  id: string;
  apiKeys: Array<{ preview: string }>;
  status: string;
  employees: Array<{ name: string }>;
};
type TestReply = { ok: true; elapsedMs: number; model: PublicModel };
type Catalog = { models: Array<{ id: string; label: string }>; recommendedModel: string };
type ApiResponse<T> = { status: number; body: T; text: string };

const mutableConfig = config as unknown as {
  sessionSecret: string;
  security: { encryptionSecret: string };
};
const originalSecrets = {
  sessionSecret: mutableConfig.sessionSecret,
  encryptionSecret: mutableConfig.security.encryptionSecret,
};

const PRIMARY = "sk-ant-api03-route-test-primary-key-aaaa1111";
const BACKUP = "sk-ant-api03-route-test-backup-key-bbbb2222";
const SECRETS = [PRIMARY, BACKUP, "custom-endpoint-route-key"];

let server: Server;
let baseUrl: string;
let realFetch: typeof fetch;
let actingUser: User;
let company: Company;
let employee: AIEmployee;

before(async () => {
  mutableConfig.sessionSecret = "models-connection-test-session-secret-0123456789";
  mutableConfig.security.encryptionSecret = "models-connection-test-encryption-secret-0123456789";
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

beforeEach(async () => {
  await resetTestDb();
  const owner = await makeUser("Owner");
  actingUser = owner;
  company = await insert(Company, {
    name: "Acme",
    slug: `acme-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Avery",
    slug: `avery-${randomUUID()}`,
    role: "Operations",
    soulBody: "",
  });
});

async function actAs(role: Role): Promise<void> {
  const user = await makeUser(role);
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  actingUser = user;
}

async function call<T>(
  method: string,
  path: string,
  options: { companyId?: string } = {},
): Promise<ApiResponse<T>> {
  const response = await realFetch(
    `${baseUrl}/api/companies/${options.companyId ?? company.id}/models${path}`,
    { method, headers: { "x-test-user": actingUser.id } },
  );
  const text = await response.text();
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `response leaked ${secret}`);
  for (const field of ["apiKeyEncrypted", "configJson", "baseURLEncrypted"]) {
    assert.ok(!text.includes(field), `response exposed ${field}`);
  }
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, text };
}

function claude(
  keys: string[] = [PRIMARY],
  overrides: Partial<AIModel> & { holder?: AIEmployee; isActive?: boolean } = {},
): Promise<AIModel> {
  const { holder = employee, ...rest } = overrides;
  return insertEmployeeModel({
    employeeId: holder.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      keys.map((key) => newStoredApiKey(key, company.id)),
    ),
    connectedAt: new Date("2026-10-01T10:00:00.000Z"),
    ...rest,
  });
}

/** The connection test, answering like a working model unless `refuse` names a status. */
function stubRuntime(t: TestContext, refuse: number | null = null): Array<string[]> {
  const calls: Array<string[]> = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    calls.push(decryptApiKeys(params.model.configJson).map((key) => key.apiKey));
    if (refuse) {
      throw Object.assign(new Error("The AI Model request failed."), {
        status: refuse,
        providerDetail: `HTTP ${refuse} · authentication_error\ninvalid x-api-key`,
      });
    }
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  return calls;
}

/**
 * Anthropic's model list, without a network: a key in `refused` gets a 401,
 * any other the two models below. Records which key asked.
 */
function stubCatalog(t: TestContext, refused: string[] = []): string[] {
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    const key = new Headers(init?.headers).get("x-api-key") ?? "";
    asked.push(key);
    if (refused.includes(key)) return Promise.resolve(new Response("{}", { status: 401 }));
    return Promise.resolve(
      Response.json({
        data: [
          {
            id: "claude-opus-5-5",
            display_name: "Claude Opus 5.5",
            created_at: "2026-09-01T00:00:00Z",
          },
          {
            id: "claude-sonnet-5",
            display_name: "Claude Sonnet 5",
            created_at: "2026-08-01T00:00:00Z",
          },
        ],
        has_more: false,
        last_id: "claude-sonnet-5",
      }),
    );
  });
  return asked;
}

const savedModel = (id: string) => AppDataSource.getRepository(AIModel).findOneByOrFail({ id });

describe("POST /:id/test", () => {
  test("an owner tests a connected model: it answers, nothing is written, the card comes back", async (t) => {
    const calls = stubRuntime(t);
    const model = await claude([PRIMARY, BACKUP]);
    const before = await savedModel(model.id);
    const reply = await call<TestReply>("POST", `/${model.id}/test`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ok, true);
    assert.equal(typeof reply.body.elapsedMs, "number");
    assert.ok(reply.body.elapsedMs >= 0);
    assert.equal(reply.body.model.id, model.id);
    assert.equal(reply.body.model.status, "connected");
    assert.deepEqual(
      reply.body.model.apiKeys.map((key) => key.preview),
      [maskSecret(PRIMARY), maskSecret(BACKUP)],
    );
    // Asked once, with every key in order — as a Run sends it.
    assert.deepEqual(calls, [[PRIMARY, BACKUP]]);
    assert.deepEqual(await savedModel(model.id), before);
    // A test configures nothing, so it leaves no audit row.
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  });

  test("an admin may test too", async (t) => {
    stubRuntime(t);
    await actAs("admin");
    const model = await claude();
    assert.equal((await call<TestReply>("POST", `/${model.id}/test`)).status, 200);
  });

  test("a Member can't: the test spends the company's allowance", async (t) => {
    const calls = stubRuntime(t);
    await actAs("member");
    const model = await claude();
    assert.equal((await call("POST", `/${model.id}/test`)).status, 403);
    assert.equal(calls.length, 0);
  });

  test("a refused key answers with the reason, and the provider's words as detail", async (t) => {
    stubRuntime(t, 401);
    const model = await claude();
    const before = await savedModel(model.id);
    const reply = await call<{ error: string; detail?: string }>("POST", `/${model.id}/test`);
    assert.equal(reply.status, 422);
    assert.match(reply.body.error, /rejected this credential/);
    assert.equal(reply.body.detail, "HTTP 401 · authentication_error\ninvalid x-api-key");
    assert.deepEqual(await savedModel(model.id), before);
  });

  test("a model that never finished connecting is not tested", async (t) => {
    const calls = stubRuntime(t);
    const model = await claude([], { configJson: "{}", connectedAt: null });
    const reply = await call<{ error: string }>("POST", `/${model.id}/test`);
    assert.equal(reply.status, 400);
    assert.match(reply.body.error, /Finish connecting/);
    assert.equal(calls.length, 0);
  });

  test("another company's model, or one that does not exist, is not found", async (t) => {
    const calls = stubRuntime(t);
    const globex = await insert(Company, {
      name: "Globex",
      slug: `globex-${randomUUID()}`,
      ownerId: actingUser.id,
    });
    const other = await insert(AIEmployee, {
      companyId: globex.id,
      name: "Casey",
      slug: `casey-${randomUUID()}`,
      role: "Sales",
      soulBody: "",
    });
    const theirs = await claude([PRIMARY], { holder: other });
    assert.equal((await call("POST", `/${theirs.id}/test`)).status, 404);
    assert.equal((await call("POST", `/${randomUUID()}/test`)).status, 404);
    assert.equal(calls.length, 0);
  });

  test("a model another AI Employee shares is tested once, for everyone on it", async (t) => {
    const calls = stubRuntime(t);
    const other = await insert(AIEmployee, {
      companyId: company.id,
      name: "Casey",
      slug: `casey-${randomUUID()}`,
      role: "Sales",
      soulBody: "",
    });
    const shared = await claude([PRIMARY], { holder: other });
    const reply = await call<TestReply>("POST", `/${shared.id}/test`);
    assert.equal(reply.status, 200);
    assert.deepEqual(
      reply.body.model.employees.map((user) => user.name),
      ["Casey"],
    );
    assert.deepEqual(calls, [[PRIMARY]]);
  });

  test("a custom endpoint is tested at its saved endpoint", async (t) => {
    const asked: string[] = [];
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      asked.push(params.model.id);
      await params.registry.resolve("connection_test")!.run({ ok: true });
      return { finalText: "OK", steps: 2, stopReason: "end_turn" };
    });
    const model = await insertEmployeeModel({
      employeeId: employee.id,
      provider: "custom",
      model: "qwen3-27b",
      authMode: "customEndpoint",
      isActive: true,
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret("https://8.8.8.8/v1", company.id),
        baseURLPreview: "8.8.8.8",
        modelId: "qwen3-27b",
        apiKeyEncrypted: encryptSecret("custom-endpoint-route-key", company.id),
        apiKeyPreview: "cust…-key",
      }),
      connectedAt: new Date("2026-10-01T10:00:00.000Z"),
    });
    const reply = await call<TestReply>("POST", `/${model.id}/test`);
    assert.equal(reply.status, 200);
    assert.deepEqual(asked, [model.id]);
  });
});

describe("GET /:id/catalog", () => {
  test("lists the models the primary key can reach, newest first, with nothing stored", async (t) => {
    const asked = stubCatalog(t);
    const model = await claude([PRIMARY, BACKUP]);
    const before = await savedModel(model.id);
    const reply = await call<Catalog>("GET", `/${model.id}/catalog`);
    assert.equal(reply.status, 200);
    assert.deepEqual(
      reply.body.models.map((entry) => entry.id),
      ["claude-opus-5-5", "claude-sonnet-5"],
    );
    assert.equal(reply.body.recommendedModel, "claude-opus-5-5");
    assert.deepEqual(asked, [PRIMARY]);
    assert.deepEqual(await savedModel(model.id), before);
  });

  test("a primary the provider now refuses does not hide the list a backup can read", async (t) => {
    const asked = stubCatalog(t, [PRIMARY]);
    const model = await claude([PRIMARY, BACKUP]);
    const reply = await call<Catalog>("GET", `/${model.id}/catalog`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.models.length, 2);
    assert.deepEqual(asked, [PRIMARY, BACKUP]);
  });

  test("when every key is refused, the primary's reason is the answer", async (t) => {
    stubCatalog(t, [PRIMARY, BACKUP]);
    const model = await claude([PRIMARY, BACKUP]);
    const reply = await call<{ error: string }>("GET", `/${model.id}/catalog`);
    assert.equal(reply.status, 422);
    assert.match(reply.body.error, /rejected this credential/);
  });

  test("a Member can't read it: only owners and admins change a model", async (t) => {
    const asked = stubCatalog(t);
    await actAs("member");
    const model = await claude();
    assert.equal((await call("GET", `/${model.id}/catalog`)).status, 403);
    assert.deepEqual(asked, []);
  });

  test("a custom endpoint or a ChatGPT sign-in has no key to list models with", async (t) => {
    const asked = stubCatalog(t);
    const custom = await insertEmployeeModel({
      employeeId: employee.id,
      provider: "custom",
      model: "qwen3-27b",
      authMode: "customEndpoint",
      isActive: false,
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret("https://8.8.8.8/v1", company.id),
        baseURLPreview: "8.8.8.8",
        modelId: "qwen3-27b",
      }),
      connectedAt: new Date(),
    });
    const chatgpt = await insertEmployeeModel({
      employeeId: employee.id,
      provider: "openai",
      model: "auto",
      authMode: "subscription",
      isActive: false,
      configJson: "{}",
      connectedAt: null,
    });
    for (const model of [custom, chatgpt]) {
      const reply = await call<{ error: string }>("GET", `/${model.id}/catalog`);
      assert.equal(reply.status, 400);
      assert.match(reply.body.error, /connected with an API key/);
    }
    assert.deepEqual(asked, []);
  });
});

describe("PUT /:id — changing the model", () => {
  /** The connection test passes, and the provider reports `window` for any model. */
  function stubProvider(t: TestContext, window: number): string[] {
    stubRuntime(t);
    const probed: string[] = [];
    t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      probed.push(new URL(url).pathname);
      return Promise.resolve(
        Response.json({ id: new URL(url).pathname.split("/").pop(), max_input_tokens: window }),
      );
    });
    return probed;
  }

  async function change(model: AIModel, to: string) {
    const response = await realFetch(
      `${baseUrl}/api/companies/${company.id}/models/${model.id}`,
      {
        method: "PUT",
        headers: { "x-test-user": actingUser.id, "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", authMode: "apikey", model: to }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        contextWindow: number | null;
        contextWindowSource: string | null;
      },
    };
  }

  test("asks for the new model's context window at once, instead of leaving it unknown", async (t) => {
    const probed = stubProvider(t, 400_000);
    const model = await claude([PRIMARY], {
      contextWindow: 200_000,
      contextWindowSource: "probed",
    });
    const reply = await change(model, "claude-sonnet-5");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.contextWindow, 400_000);
    assert.equal(reply.body.contextWindowSource, "probed");
    assert.deepEqual(probed, ["/v1/models/claude-sonnet-5"]);
    assert.equal((await savedModel(model.id)).contextWindow, 400_000);
  });

  test("a window set by hand for the old model gives way to the new model's", async (t) => {
    // The number belonged to the model it was typed for; the edit clears it,
    // and the new model's own window is read in its place.
    const probed = stubProvider(t, 400_000);
    const model = await claude([PRIMARY], { contextWindow: 65_536, contextWindowSource: "manual" });
    const reply = await change(model, "claude-sonnet-5");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.contextWindow, 400_000);
    assert.equal(reply.body.contextWindowSource, "probed");
    assert.deepEqual(probed, ["/v1/models/claude-sonnet-5"]);
  });

  test("a provider that can't be reached leaves the window unknown, and the change saved", async (t) => {
    stubRuntime(t);
    t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.reject(new TypeError("fetch failed"));
    });
    const model = await claude([PRIMARY], {
      contextWindow: 200_000,
      contextWindowSource: "probed",
    });
    const reply = await change(model, "claude-sonnet-5");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.contextWindow, null);
    assert.equal((await savedModel(model.id)).model, "claude-sonnet-5");
  });

  test("saving the same model asks nothing", async (t) => {
    const probed = stubProvider(t, 400_000);
    const model = await claude([PRIMARY], {
      contextWindow: 200_000,
      contextWindowSource: "probed",
    });
    const reply = await change(model, "claude-opus-5-5");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.contextWindow, 200_000);
    assert.deepEqual(probed, []);
  });
});
