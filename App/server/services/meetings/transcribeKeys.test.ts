import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../../config.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { newStoredApiKey, readApiKeys, writeApiKeys } from "../modelApiKeys.js";
import { resetKeyHealthMemory, restKey } from "../modelKeyHealth.js";
import { resetKeyPoolMemory } from "../modelKeyPool.js";
import { resolveTranscriptionTarget } from "./transcribe.js";

/**
 * Transcription with an OpenAI API-key model is work on the model's keys like
 * a session: each one takes the next key in turn, skipping a key that rests
 * after being refused.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "transcribe-keys-tests-encryption-secret-000001";
  await initTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  resetKeyHealthMemory();
  resetKeyPoolMemory({ random: () => 0 });
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

const PRIMARY = "sk-proj-transcribe-primary-key-0000001";
const BACKUP = "sk-proj-transcribe-backup-key-00000002";

async function openai(configJson: string): Promise<AIModel> {
  return insertEmployeeModel({
    employeeId: "notetaker",
    provider: "openai",
    model: "gpt-5.4",
    authMode: "apikey",
    isActive: true,
    configJson,
    connectedAt: new Date(),
  });
}

test("each transcription takes the next key in turn", async () => {
  await openai(
    writeApiKeys(
      "{}",
      [PRIMARY, BACKUP].map((key) => newStoredApiKey(key, "co")),
    ),
  );
  const used: string[] = [];
  for (let meeting = 0; meeting < 4; meeting++) {
    const resolved = await resolveTranscriptionTarget("notetaker");
    assert.ok("target" in resolved);
    assert.equal(resolved.target.baseURL, "https://api.openai.com/v1");
    used.push(resolved.target.apiKey);
  }
  assert.deepEqual(used, [PRIMARY, BACKUP, PRIMARY, BACKUP]);
});

test("a single key transcribes every meeting", async () => {
  await openai(writeApiKeys("{}", [newStoredApiKey(PRIMARY, "co")]));
  for (let meeting = 0; meeting < 3; meeting++) {
    const resolved = await resolveTranscriptionTarget("notetaker");
    assert.ok("target" in resolved);
    assert.equal(resolved.target.apiKey, PRIMARY);
  }
});

test("a resting key is skipped: transcription goes to a key that isn't", async () => {
  const model = await openai(
    writeApiKeys(
      "{}",
      [PRIMARY, BACKUP].map((key) => newStoredApiKey(key, "co")),
    ),
  );
  restKey(model.id, readApiKeys(model.configJson)[0].id, Date.now() + 60_000);
  const resolved = await resolveTranscriptionTarget("notetaker");
  assert.ok("target" in resolved);
  assert.equal(resolved.target.apiKey, BACKUP);
});

test("keys that no longer decrypt are explained, not thrown", async () => {
  await openai(JSON.stringify({ apiKeyEncrypted: "v2.not.a.real.cipher" }));
  assert.deepEqual(await resolveTranscriptionTarget("notetaker"), {
    error: "The OpenAI API key could not be decrypted.",
  });
});

test("a model with no key says so", async () => {
  await openai("{}");
  assert.deepEqual(await resolveTranscriptionTarget("notetaker"), {
    error: "The OpenAI model has no stored API key. Reconnect it.",
  });
});
