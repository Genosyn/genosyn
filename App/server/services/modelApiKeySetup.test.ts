import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../db/entities/AIModelKeyHealth.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import { ModelSetupError } from "./modelCatalog.js";
import { addBackupKey, removeApiKey, reorderApiKeys } from "./modelApiKeySetup.js";
import {
  LEGACY_PRIMARY_KEY_ID,
  decryptApiKeys,
  newStoredApiKey,
  readApiKeys,
  writeApiKeys,
} from "./modelApiKeys.js";
import { keyRestingUntil, resetKeyHealthMemory, restKey } from "./modelKeyHealth.js";
import { configWithApiKey, editApiModel, replaceApiKey } from "./modelSetup.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "model-api-key-setup-tests-encryption-secret-01";
  await initTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  resetKeyHealthMemory();
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

const COMPANY = "company";
const PRIMARY = "sk-ant-api03-service-primary-key-00001";
const key = (n: number) => `sk-ant-api03-service-backup-key-${String(n).padStart(5, "0")}`;

async function claudeModel(keys: string[] = [PRIMARY], overrides: Partial<AIModel> = {}) {
  return insertEmployeeModel({
    employeeId: "employee",
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      keys.map((k) => newStoredApiKey(k, COMPANY)),
    ),
    connectedAt: new Date("2026-10-01T10:00:00.000Z"),
    ...overrides,
  });
}

/** The connection test passes; `during` runs while it is "talking to the provider". */
function stubVerification(
  t: TestContext,
  options: { during?: () => Promise<void>; refuse?: (keys: string[]) => number | null } = {},
) {
  const tested: string[][] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const keys = decryptApiKeys(params.model.configJson).map((k) => k.apiKey);
    tested.push(keys);
    await options.during?.();
    const status = options.refuse?.(keys);
    if (status) throw Object.assign(new Error("refused"), { status });
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  return tested;
}

const keysOf = async (id: string) =>
  decryptApiKeys(
    (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id })).configJson,
  ).map((k) => k.apiKey);

describe("adding a backup key", () => {
  test("fifty keys, one after another — there is no cap", async (t) => {
    stubVerification(t);
    let model = await claudeModel();
    for (let n = 1; n <= 50; n++) model = (await addBackupKey(model, key(n), COMPANY)).model;
    const keys = await keysOf(model.id);
    assert.equal(keys.length, 51);
    assert.deepEqual(keys, [PRIMARY, ...Array.from({ length: 50 }, (_, i) => key(i + 1))]);
  });

  test("two keys added at once both land; neither edit undoes the other", async (t) => {
    stubVerification(t, { during: () => delay(30) });
    const model = await claudeModel();
    await Promise.all([addBackupKey(model, key(1), COMPANY), addBackupKey(model, key(2), COMPANY)]);
    const keys = await keysOf(model.id);
    assert.equal(keys.length, 3);
    assert.deepEqual(new Set(keys), new Set([PRIMARY, key(1), key(2)]));
  });

  test("the same key added twice at once lands once", async (t) => {
    stubVerification(t, { during: () => delay(30) });
    const model = await claudeModel();
    const results = await Promise.allSettled([
      addBackupKey(model, key(1), COMPANY),
      addBackupKey(model, key(1), COMPANY),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ModelSetupError);
    assert.equal(rejected.reason.status, 400);
    assert.deepEqual(await keysOf(model.id), [PRIMARY, key(1)]);
  });

  test("a key removed while another is being tested stays removed", async (t) => {
    const model = await claudeModel([PRIMARY, key(1)]);
    const [, first] = readApiKeys(model.configJson);
    stubVerification(t, {
      during: async () => {
        await removeApiKey(model, first.id);
      },
    });
    await addBackupKey(model, key(2), COMPANY);
    assert.deepEqual(await keysOf(model.id), [PRIMARY, key(2)]);
  });

  test("a key tested against a model that changed meanwhile is not added", async (t) => {
    const model = await claudeModel();
    stubVerification(t, {
      during: async () => {
        await AppDataSource.getRepository(AIModel).update(
          { id: model.id },
          { model: "claude-sonnet-5-5" },
        );
      },
    });
    await assert.rejects(addBackupKey(model, key(1), COMPANY), (error: unknown) => {
      assert.ok(error instanceof ModelSetupError);
      assert.equal(error.status, 409);
      return true;
    });
    assert.deepEqual(await keysOf(model.id), [PRIMARY]);
  });

  test("a model switched to another service meanwhile takes no key", async (t) => {
    const model = await claudeModel();
    stubVerification(t, {
      during: async () => {
        await AppDataSource.getRepository(AIModel).update(
          { id: model.id },
          { provider: "openai", authMode: "subscription", configJson: "{}" },
        );
      },
    });
    await assert.rejects(
      addBackupKey(model, key(1), COMPANY),
      /no longer connects with an API key/,
    );
  });

  test("a model deleted meanwhile is not found", async (t) => {
    const model = await claudeModel();
    stubVerification(t, {
      during: async () => {
        await AppDataSource.getRepository(AIModel).delete({ id: model.id });
      },
    });
    await assert.rejects(addBackupKey(model, key(1), COMPANY), (error: unknown) => {
      assert.ok(error instanceof ModelSetupError);
      assert.equal(error.status, 404);
      return true;
    });
  });
});

describe("removing and reordering", () => {
  test("a removed key's rest and health are forgotten", async () => {
    const model = await claudeModel([PRIMARY, key(1)]);
    const [, backup] = readApiKeys(model.configJson);
    restKey(model.id, backup.id, Date.now() + 60_000);
    await insert(AIModelKeyHealth, { modelId: model.id, keyId: backup.id, lastUsedAt: new Date() });
    await removeApiKey(model, backup.id);
    assert.equal(keyRestingUntil(model.id, backup.id), 0);
    assert.equal(await AppDataSource.getRepository(AIModelKeyHealth).count(), 0);
  });

  test("the remaining keys keep their rests and health", async () => {
    const model = await claudeModel([PRIMARY, key(1), key(2)]);
    const [primary, first, second] = readApiKeys(model.configJson);
    restKey(model.id, second.id, Date.now() + 60_000);
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: primary.id,
      lastUsedAt: new Date(),
    });
    await removeApiKey(model, first.id);
    assert.ok(keyRestingUntil(model.id, second.id) > 0);
    assert.equal(
      await AppDataSource.getRepository(AIModelKeyHealth).countBy({ keyId: primary.id }),
      1,
    );
  });

  test("reordering keeps every key's id, ciphertext and preview", async () => {
    const model = await claudeModel([PRIMARY, key(1), key(2)]);
    const before = readApiKeys(model.configJson);
    const saved = await reorderApiKeys(model, [before[1].id, before[2].id, before[0].id]);
    const after = readApiKeys(saved.configJson);
    assert.deepEqual(after, [before[1], before[2], before[0]]);
  });

  test("a model with no API key can't be edited this way", async () => {
    const custom = await claudeModel([], { provider: "custom", authMode: "customEndpoint" });
    await assert.rejects(removeApiKey(custom, LEGACY_PRIMARY_KEY_ID), /Only Claude/);
    await assert.rejects(reorderApiKeys(custom, []), /Only Claude/);
  });
});

describe("the primary key", () => {
  test("re-entering the current primary keeps its id, so its health carries on", () => {
    const configJson = writeApiKeys("{}", [newStoredApiKey(PRIMARY, COMPANY)]);
    const [current] = readApiKeys(configJson);
    const same = configWithApiKey(configJson, PRIMARY, COMPANY);
    assert.equal(same.key.id, current.id);
    const other = configWithApiKey(configJson, key(1), COMPANY);
    assert.notEqual(other.key.id, current.id);
  });

  test("a legacy primary becomes a key with an id when replaced", async (t) => {
    stubVerification(t);
    const model = await insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      isActive: true,
      configJson: JSON.stringify({
        apiKeyEncrypted: encryptSecret(PRIMARY, COMPANY),
        apiKeyPreview: maskSecret(PRIMARY),
      }),
      connectedAt: new Date(),
    });
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: LEGACY_PRIMARY_KEY_ID,
      lastUsedAt: new Date(),
    });
    const saved = await replaceApiKey(model, key(1), COMPANY);
    const [primary] = readApiKeys(saved.configJson);
    assert.notEqual(primary.id, LEGACY_PRIMARY_KEY_ID);
    assert.ok(primary.addedAt);
    assert.equal(await AppDataSource.getRepository(AIModelKeyHealth).count(), 0);
  });

  test("a model edit with a new key tests that key alone and keeps the backups", async (t) => {
    const tested = stubVerification(t);
    const model = await claudeModel([PRIMARY, key(1)]);
    const saved = await editApiModel(model, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      apiKey: key(2),
      companyId: COMPANY,
    });
    assert.deepEqual(tested, [[key(2)]]);
    assert.deepEqual(
      decryptApiKeys(saved.configJson).map((k) => k.apiKey),
      [key(2), key(1)],
    );
    assert.equal(saved.model, "claude-sonnet-5-5");
  });

  test("a model-only edit is tested on every key, as a Run would send it", async (t) => {
    // In production the test turn goes through the proxy's failover, so a
    // refused primary does not fail an edit the backups can answer.
    const tested = stubVerification(t);
    const model = await claudeModel([PRIMARY, key(1)]);
    await editApiModel(model, {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      companyId: COMPANY,
    });
    assert.deepEqual(tested, [[PRIMARY, key(1)]]);
  });
});
