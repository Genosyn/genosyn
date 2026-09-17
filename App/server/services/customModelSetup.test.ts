import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { readCustomEndpoint } from "./customEndpoint.js";
import { connectCustomModel } from "./customModelSetup.js";
import { agentRuntime } from "./agent/runtime.js";
import { ModelSetupError } from "./modelCatalog.js";

const security = config.security as {
  encryptionSecret: string;
  outboundPrivateHostAllowlist: string[];
};
const originalSecret = security.encryptionSecret;
const originalHosts = security.outboundPrivateHostAllowlist;
before(async () => {
  security.encryptionSecret = "custom-model-test-encryption-secret";
  security.outboundPrivateHostAllowlist = [];
  await initTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  await insert(AIEmployee, {
    id: "employee",
    companyId: "company",
    name: "Avery",
    slug: "avery",
    role: "Operations",
  });
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
  security.outboundPrivateHostAllowlist = originalHosts;
});
const setup = {
  employeeId: "employee",
  companyId: "company",
  baseURL: "https://8.8.8.8/v1",
  modelId: "local-model",
  apiKey: "private-custom-key",
};
async function reply(params: Parameters<typeof agentRuntime.run>[0]) {
  await params.registry.resolve("connection_test")!.run({ ok: true });
  return { finalText: "OK", steps: 2, stopReason: "end_turn" };
}

test("custom setup verifies through OpenCode with only its connection tool before activating", async (t) => {
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    assert.deepEqual(readCustomEndpoint(params.model), {
      baseURL: setup.baseURL,
      modelId: setup.modelId,
      apiKey: setup.apiKey,
    });
    assert.equal(params.registry.resident[0].name, "connection_test");
    assert.equal(params.nativeCoding, false);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
    return reply(params);
  });
  const saved = await connectCustomModel(setup);
  assert.equal(saved.isActive, true);
  assert.ok(saved.connectedAt);
  assert.doesNotMatch(saved.configJson, /private-custom-key|https:/);
  assert.deepEqual(readCustomEndpoint(saved), {
    baseURL: setup.baseURL,
    modelId: setup.modelId,
    apiKey: setup.apiKey,
  });
});

test("failed custom setup never leaves an active placeholder", async (t) => {
  t.mock.method(agentRuntime, "run", async () => {
    throw Object.assign(new Error("private-custom-key"), { status: 401 });
  });
  await assert.rejects(connectCustomModel(setup), /rejected this credential/);
  assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
});

test("failed endpoint replacement preserves credentials, target, connection time and manual context", async (t) => {
  const fetch = t.mock.method(agentRuntime, "run", reply);
  const saved = await connectCustomModel(setup);
  await AppDataSource.getRepository(AIModel).update(
    { id: saved.id },
    { contextWindow: 40000, contextWindowSource: "manual" },
  );
  const previous = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: saved.id });
  fetch.mock.mockImplementation(async () => {
    throw Object.assign(new Error("unavailable"), { status: 500 });
  });
  await assert.rejects(
    connectCustomModel(
      { ...setup, baseURL: "https://1.1.1.1/v1", apiKey: "bad-new-key" },
      previous,
    ),
    ModelSetupError,
  );
  assert.deepEqual(
    await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: saved.id }),
    previous,
  );
});

test("valid key removal preserves manual context while changing the target resets it", async (t) => {
  t.mock.method(agentRuntime, "run", reply);
  const saved = await connectCustomModel(setup);
  await AppDataSource.getRepository(AIModel).update(
    { id: saved.id },
    { contextWindow: 40000, contextWindowSource: "manual" },
  );
  const previous = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: saved.id });
  const keyRemoved = await connectCustomModel({ ...setup, apiKey: undefined }, previous);
  assert.equal(readCustomEndpoint(keyRemoved)?.apiKey, null);
  assert.equal(keyRemoved.contextWindow, 40000);
  const changed = await connectCustomModel({ ...setup, modelId: "different-model" }, keyRemoved);
  assert.equal(changed.contextWindow, null);
  assert.equal(changed.model, "different-model");
});

test("a custom key update preserves manual context changed during verification", async (t) => {
  const fetch = t.mock.method(agentRuntime, "run", reply);
  const previous = await connectCustomModel(setup);
  fetch.mock.mockImplementation(async (params: Parameters<typeof agentRuntime.run>[0]) => {
    await AppDataSource.getRepository(AIModel).update(
      { id: previous.id },
      { contextWindow: 80000, contextWindowSource: "manual" },
    );
    return reply(params);
  });
  const current = await connectCustomModel({ ...setup, apiKey: "replacement" }, previous);
  assert.equal(current.contextWindow, 80000);
  assert.equal(current.contextWindowSource, "manual");
  assert.equal(readCustomEndpoint(current)?.apiKey, "replacement");
});

test("concurrent first custom connections leave exactly one active model", async (t) => {
  t.mock.method(agentRuntime, "run", reply);
  await Promise.all(
    ["first", "second"].map((modelId) => connectCustomModel({ ...setup, modelId })),
  );
  const models = await AppDataSource.getRepository(AIModel).findBy({ employeeId: "employee" });
  assert.equal(models.length, 2);
  assert.equal(models.filter((model) => model.isActive).length, 1);
});

test("custom probe still enforces private-address and embedded-credential SSRF restrictions", async (t) => {
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    calls++;
    return reply(params);
  });
  for (const baseURL of [
    "http://127.0.0.1/v1",
    "http://169.254.169.254/v1",
    "https://user:secret@8.8.8.8/v1",
    "file:///tmp/model",
  ]) {
    await assert.rejects(
      connectCustomModel({ ...setup, baseURL }),
      (error: unknown) => error instanceof ModelSetupError && error.status === 400,
    );
  }
  assert.equal(calls, 0);
  assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
});
