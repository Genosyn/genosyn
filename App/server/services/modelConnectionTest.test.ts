import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test, type TestContext } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { fakeCodexVerification } from "../test/modelVerification.js";
import { CodexAppServer } from "./agent/codexAppServer.js";
import { agentRuntime } from "./agent/runtime.js";
import {
  configWithSubscriptionAccessToken,
  withSubscriptionModelLock,
} from "./codexSubscription.js";
import { readCustomEndpoint } from "./customEndpoint.js";
import { decryptApiKeys, newStoredApiKey, writeApiKeys } from "./modelApiKeys.js";
import { ModelSetupError } from "./modelCatalog.js";
import { testModelConnection } from "./modelConnectionTest.js";

/**
 * Test connection on a connected AI Model: the same small reply it gave when it
 * was connected, through the runtime its work uses, and nothing written.
 */

const mutable = config as unknown as {
  sessionSecret: string;
  security: { multiTenant: boolean; encryptionSecret: string };
};
const original = {
  sessionSecret: mutable.sessionSecret,
  multiTenant: mutable.security.multiTenant,
  encryptionSecret: mutable.security.encryptionSecret,
  tmpdir: process.env.TMPDIR,
};

const PRIMARY = "sk-ant-api03-connection-test-primary-1111";
const BACKUP = "sk-ant-api03-connection-test-backup-2222";
let tempRoot: string;
let employee: AIEmployee;

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-connection-test-"));
  process.env.TMPDIR = tempRoot;
  mutable.sessionSecret = "connection-test-session-secret-0123456789";
  mutable.security.multiTenant = false;
  mutable.security.encryptionSecret = "connection-test-encryption-secret-0123456789";
  await initTestDb();
});

after(async () => {
  await closeTestDb();
  mutable.sessionSecret = original.sessionSecret;
  mutable.security.multiTenant = original.multiTenant;
  mutable.security.encryptionSecret = original.encryptionSecret;
  if (original.tmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = original.tmpdir;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  employee = await insert(AIEmployee, {
    companyId: "company",
    name: "Avery",
    slug: `avery-${randomUUID()}`,
    role: "Operations",
    soulBody: "",
  });
});

const CONNECTED_AT = new Date("2026-10-01T10:00:00.000Z");

function claude(keys: string[] = [PRIMARY], overrides: Partial<AIModel> = {}): Promise<AIModel> {
  return insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      keys.map((key) => newStoredApiKey(key, "company")),
    ),
    connectedAt: CONNECTED_AT,
    contextWindow: 200_000,
    contextWindowSource: "probed",
    ...overrides,
  });
}

const saved = (id: string) => AppDataSource.getRepository(AIModel).findOneByOrFail({ id });

/** A clock that reads `start`, then `end`: the test measures the gap. */
function clock(start: number, end: number): () => number {
  const readings = [start, end];
  return () => readings.shift() ?? end;
}

/** The OpenCode runtime, answering the connection test the way a working model does. */
function answers(
  t: TestContext,
  behaviour: (params: Parameters<typeof agentRuntime.run>[0]) => Promise<void> | void = () =>
    undefined,
) {
  const calls: Array<Parameters<typeof agentRuntime.run>[0]> = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    calls.push(params);
    await behaviour(params);
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  return calls;
}

describe("testing an API-key AI Model", () => {
  test("it answers on every key in order, as a Run would send it, and says how long it took", async (t) => {
    const calls = answers(t);
    const model = await claude([PRIMARY, BACKUP]);
    const result = await testModelConnection(await saved(model.id), clock(1_000, 3_400));
    assert.deepEqual(result, { elapsedMs: 2_400 });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      decryptApiKeys(calls[0].model.configJson).map((key) => key.apiKey),
      [PRIMARY, BACKUP],
    );
    // The harmless tool is the only one offered, and coding stays off.
    assert.deepEqual(
      calls[0].registry.resident.map((tool) => tool.name),
      ["connection_test"],
    );
    assert.equal(calls[0].nativeCoding, false);
  });

  test("nothing about the model is written: credentials, model, connection time, context window", async (t) => {
    answers(t);
    const model = await claude([PRIMARY, BACKUP], {
      contextWindow: 65_536,
      contextWindowSource: "manual",
      maxConcurrentRuns: 2,
    });
    const before = await saved(model.id);
    await testModelConnection(before);
    assert.deepEqual(await saved(model.id), before);
  });

  test("a refused key fails the test with the provider's own words behind View details", async (t) => {
    t.mock.method(agentRuntime, "run", async () => {
      throw Object.assign(new Error("request failed"), {
        status: 401,
        providerDetail: "HTTP 401 · authentication_error\ninvalid x-api-key",
      });
    });
    const model = await claude();
    const before = await saved(model.id);
    await assert.rejects(testModelConnection(before), (error: unknown) => {
      assert.ok(error instanceof ModelSetupError);
      assert.equal(error.status, 422);
      assert.match(error.message, /rejected this credential/);
      assert.equal(error.detail, "HTTP 401 · authentication_error\ninvalid x-api-key");
      return true;
    });
    assert.deepEqual(await saved(model.id), before);
  });

  test("an account out of credit says so", async (t) => {
    t.mock.method(agentRuntime, "run", async () => {
      throw Object.assign(new Error("request failed"), { status: 402 });
    });
    const model = await claude();
    await assert.rejects(
      testModelConnection(await saved(model.id)),
      /billing, quota, or a rate limit/,
    );
  });

  test("a model that replies but never uses the test tool does not pass", async (t) => {
    t.mock.method(agentRuntime, "run", async () => ({
      finalText: "Sure!",
      steps: 1,
      stopReason: "end_turn",
    }));
    const model = await claude();
    await assert.rejects(testModelConnection(await saved(model.id)), /tool-use test/);
  });

  test("a model with no credential yet is not tested at all", async (t) => {
    const calls = answers(t);
    const model = await claude([], { configJson: "{}", connectedAt: null });
    await assert.rejects(testModelConnection(await saved(model.id)), (error: unknown) => {
      assert.ok(error instanceof ModelSetupError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Finish connecting/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("testing a custom endpoint", () => {
  test("it is asked at the endpoint saved on the card, with its key", async (t) => {
    const calls = answers(t);
    const model = await insertEmployeeModel({
      employeeId: employee.id,
      provider: "custom",
      model: "qwen3-27b",
      authMode: "customEndpoint",
      isActive: true,
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret("https://8.8.8.8/v1", "company"),
        baseURLPreview: "8.8.8.8",
        modelId: "qwen3-27b",
        apiKeyEncrypted: encryptSecret("custom-endpoint-key", "company"),
        apiKeyPreview: "cust…-key",
      }),
      connectedAt: CONNECTED_AT,
    });
    const before = await saved(model.id);
    await testModelConnection(before);
    assert.deepEqual(readCustomEndpoint(calls[0].model), {
      baseURL: "https://8.8.8.8/v1",
      modelId: "qwen3-27b",
      apiKey: "custom-endpoint-key",
    });
    assert.deepEqual(await saved(model.id), before);
  });
});

describe("testing a ChatGPT sign-in", () => {
  async function chatgpt(model = "auto"): Promise<AIModel> {
    const row = await insertEmployeeModel({
      employeeId: employee.id,
      provider: "openai",
      model,
      authMode: "subscription",
      isActive: true,
      configJson: "{}",
      connectedAt: CONNECTED_AT,
    });
    await AppDataSource.getRepository(AIModel).update(
      { id: row.id },
      { configJson: configWithSubscriptionAccessToken(row, "connection-test-access-token") },
    );
    return saved(row.id);
  }

  test("it replies in an isolated turn, and a model left on the default stays on it", async (t) => {
    const started: string[] = [];
    t.mock.method(
      CodexAppServer,
      "start",
      async (options: Parameters<typeof CodexAppServer.start>[0]) => {
        started.push(options.cwd);
        return fakeCodexVerification(options.cwd, { model: "gpt-workspace-default" });
      },
    );
    const before = await chatgpt("auto");
    const result = await testModelConnection(before, clock(10, 1_510));
    assert.deepEqual(result, { elapsedMs: 1_500 });
    assert.equal(started.length, 1);
    const after = await saved(before.id);
    assert.equal(after.model, "auto", "the test does not pin today's default");
    assert.deepEqual(after.connectedAt, before.connectedAt);
    assert.equal(after.configJson, before.configJson);
    // The temporary Codex homes are gone.
    assert.deepEqual(await fs.readdir(tempRoot), []);
  });

  test("a ChatGPT reply that fails reports what to check and changes nothing", async (t) => {
    t.mock.method(
      CodexAppServer,
      "start",
      async (options: Parameters<typeof CodexAppServer.start>[0]) =>
        fakeCodexVerification(options.cwd, { status: "failed" }),
    );
    const before = await chatgpt("gpt-chosen");
    await assert.rejects(testModelConnection(before), /could not answer/);
    assert.deepEqual(await saved(before.id), before);
    assert.deepEqual(await fs.readdir(tempRoot), []);
  });

  test("while a chat or Run holds the sign-in, the test says so instead of waiting behind it", async (t) => {
    const start = t.mock.method(CodexAppServer, "start", async () => {
      throw new Error("the test must not start Codex while the sign-in is busy");
    });
    const model = await chatgpt("gpt-chosen");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = withSubscriptionModelLock(model.id, undefined, () => held);
    try {
      await assert.rejects(testModelConnection(model), (error: unknown) => {
        assert.ok(error instanceof ModelSetupError);
        assert.equal(error.status, 409);
        assert.match(error.message, /answering a chat or Run right now/);
        return true;
      });
      assert.equal(start.mock.callCount(), 0);
    } finally {
      release();
      await turn;
    }
  });
});
