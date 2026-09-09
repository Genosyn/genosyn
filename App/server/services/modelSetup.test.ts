import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { successfulModelStream } from "../test/modelVerification.js";
import {
  connectApiModel,
  editApiModel,
  replaceApiKey,
  verifyDirectModel,
  verifyModelEdit,
} from "./modelSetup.js";
import { ModelSetupError } from "./modelCatalog.js";

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "model-setup-tests-encryption-secret";
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
});

function mockModel(
  t: TestContext,
  provider: "openai" | "anthropic",
  options: { status?: number; textOnly?: boolean; tool?: string; ok?: boolean } = {},
) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models") || url.includes("/models?"))
      return Response.json(
        provider === "openai"
          ? { data: [{ id: "gpt-live-default", created: 100 }] }
          : { data: [{ id: "claude-live-default", created_at: "2026-09-01" }], has_more: false },
      );
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    if (options.status)
      return Response.json(
        { error: { message: "secret-key-DO-NOT-ECHO" } },
        { status: options.status },
      );
    return successfulModelStream(provider, options);
  });
  return requests;
}

async function existing(provider: "openai" | "anthropic" = "openai") {
  return insert(AIModel, {
    employeeId: "employee",
    provider,
    model: "chosen-model",
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: encryptSecret("old-key") }),
    connectedAt: new Date(),
    isActive: true,
    contextWindow: 40000,
    contextWindowSource: "manual",
  });
}

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} discover + tool reply saves encrypted credentials and activates only after verification`, async (t) => {
    const sibling = await existing();
    const calls = mockModel(t, provider);
    const saved = await connectApiModel({
      employeeId: "employee",
      companyId: "company",
      provider,
      apiKey: "secret-key",
    });
    assert.equal(saved.model, provider === "openai" ? "gpt-live-default" : "claude-live-default");
    assert.ok(saved.connectedAt instanceof Date);
    assert.equal(saved.isActive, true);
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: sibling.id })).isActive,
      false,
    );
    assert.equal(decryptSecret(JSON.parse(saved.configJson).apiKeyEncrypted), "secret-key");
    assert.ok(!saved.configJson.includes("secret-key"));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, provider === "openai" ? /\/responses$/ : /\/messages$/);
    assert.equal(calls[0].body[provider === "openai" ? "max_output_tokens" : "max_tokens"], 1024);
    assert.equal((calls[0].body.tools as unknown[]).length, 1);
  });
}

test("an explicit model bypasses catalog permission and is never replaced", async (t) => {
  const calls = mockModel(t, "openai");
  const model = await connectApiModel({
    employeeId: "employee",
    companyId: "company",
    provider: "openai",
    apiKey: "key",
    model: "gpt-explicit",
  });
  assert.equal(model.model, "gpt-explicit");
  assert.equal(calls[0].body.model, "gpt-explicit");
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`failed connection (${status}) never saves a model or changes the active sibling`, async (t) => {
    const sibling = await existing();
    mockModel(t, "openai", { status });
    await assert.rejects(
      connectApiModel({
        employeeId: "employee",
        companyId: "company",
        provider: "openai",
        apiKey: "secret-key-DO-NOT-ECHO",
        model: "gpt-new",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ModelSetupError);
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 1);
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: sibling.id })).isActive,
      true,
    );
  });
}

for (const options of [{ textOnly: true }, { tool: "wrong_tool" }, { ok: false }]) {
  test(`a reply without successful harmless tool use fails verification: ${JSON.stringify(options)}`, async (t) => {
    const model = await existing();
    mockModel(t, "openai", options);
    await assert.rejects(verifyDirectModel(model), /tool-use test/);
  });
}

test("failed key replacement leaves the original working credential and timestamp intact", async (t) => {
  const model = await existing();
  mockModel(t, "openai", { status: 401 });
  await assert.rejects(replaceApiKey(model, "bad-key", "company"), ModelSetupError);
  const unchanged = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id });
  assert.equal(unchanged.configJson, model.configJson);
  assert.deepEqual(unchanged.connectedAt, model.connectedAt);
});

test("atomic provider/key edits verify the entire candidate before replacing old config", async (t) => {
  const model = await existing();
  mockModel(t, "anthropic", { status: 401 });
  await assert.rejects(
    editApiModel(model, {
      provider: "anthropic",
      model: "claude-new",
      apiKey: "bad-key",
      companyId: "company",
    }),
    ModelSetupError,
  );
  assert.deepEqual(
    await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id }),
    model,
  );
});

test("a successful model edit preserves manual context only when the model is unchanged", async (t) => {
  const model = await existing();
  mockModel(t, "openai");
  const keyOnly = await editApiModel(model, {
    provider: "openai",
    model: model.model,
    apiKey: "new-key",
    companyId: "company",
  });
  assert.equal(keyOnly.contextWindow, 40000);
  const changed = await editApiModel(keyOnly, {
    provider: "openai",
    model: "different-model",
    companyId: "company",
  });
  assert.equal(changed.contextWindow, null);
  assert.equal(changed.contextWindowSource, null);
});

test("a concurrent credential replacement cannot be overwritten by a stale successful test", async (t) => {
  const model = await existing();
  t.mock.method(globalThis, "fetch", async () => {
    await AppDataSource.getRepository(AIModel).update({ id: model.id }, { configJson: "{}" });
    return successfulModelStream("openai");
  });
  await assert.rejects(
    replaceApiKey(model, "new-key", "company"),
    (error: unknown) => error instanceof ModelSetupError && error.status === 409,
  );
  assert.equal(
    (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id })).configJson,
    "{}",
  );
});

for (const method of ["replace-key", "edit-key"] as const) {
  test(`${method} preserves a manual context edit made while the connection test is running`, async (t) => {
    const model = await existing();
    t.mock.method(globalThis, "fetch", async () => {
      await AppDataSource.getRepository(AIModel).update(
        { id: model.id },
        { contextWindow: 80000, contextWindowSource: "manual" },
      );
      return successfulModelStream("openai");
    });
    const saved =
      method === "replace-key"
        ? await replaceApiKey(model, "new-key", "company")
        : await editApiModel(model, {
            provider: "openai",
            model: model.model,
            apiKey: "new-key",
            companyId: "company",
          });
    assert.equal(saved.contextWindow, 80000);
    assert.equal(saved.contextWindowSource, "manual");
    const current = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id });
    assert.equal(current.contextWindow, 80000);
    assert.equal(decryptSecret(JSON.parse(current.configJson).apiKeyEncrypted), "new-key");
  });
}

test("concurrent first API connections leave exactly one active model", async (t) => {
  mockModel(t, "openai");
  await Promise.all(
    ["gpt-first", "gpt-second"].map((model) =>
      connectApiModel({
        employeeId: "employee",
        companyId: "company",
        provider: "openai",
        apiKey: "key",
        model,
      }),
    ),
  );
  const models = await AppDataSource.getRepository(AIModel).findBy({ employeeId: "employee" });
  assert.equal(models.length, 2);
  assert.equal(models.filter((model) => model.isActive).length, 1);
  assert.ok(models.every((model) => model.connectedAt !== null));
});

test("an employee deleted during verification cannot leave an orphan model", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    await AppDataSource.getRepository(AIEmployee).delete({ id: "employee" });
    return successfulModelStream("openai");
  });
  await assert.rejects(
    connectApiModel({
      employeeId: "employee",
      companyId: "company",
      provider: "openai",
      apiKey: "key",
      model: "gpt-chosen",
    }),
    /no longer exists/,
  );
  assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
});

test("switching API services requires a fresh key", async () => {
  await assert.rejects(
    editApiModel(await existing(), {
      provider: "anthropic",
      model: "claude-new",
      companyId: "company",
    }),
    /Enter the API key/,
  );
});

test("generic model edits cannot test an old custom endpoint model and save a different display ID", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return successfulModelStream("openai");
  });
  await assert.rejects(
    verifyModelEdit(
      Object.assign(new AIModel(), {
        model: "old",
        authMode: "customEndpoint",
        provider: "custom",
        configJson: "{}",
      }),
      "new",
    ),
    /Use the endpoint form/,
  );
  assert.equal(calls, 0);
});
