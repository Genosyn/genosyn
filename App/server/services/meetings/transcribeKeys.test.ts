import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../../config.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { newStoredApiKey, readApiKeys, writeApiKeys } from "../modelApiKeys.js";
import { resetKeyHealthMemory, restKey } from "../modelKeyHealth.js";
import { resolveTranscriptionTarget } from "./transcribe.js";

/**
 * Transcription with an OpenAI API-key model uses the key a Run would try
 * first right now — a backup while the primary rests after being refused.
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
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

const PRIMARY = "sk-proj-transcribe-primary-key-0000001";
const BACKUP = "sk-proj-transcribe-backup-key-00000002";

async function openai(configJson: string): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: "notetaker",
    provider: "openai",
    model: "gpt-5.4",
    authMode: "apikey",
    isActive: true,
    configJson,
    connectedAt: new Date(),
  });
}

test("the primary key transcribes while it works", async () => {
  await openai(
    writeApiKeys(
      "{}",
      [PRIMARY, BACKUP].map((key) => newStoredApiKey(key, "co")),
    ),
  );
  const resolved = await resolveTranscriptionTarget("notetaker");
  assert.ok("target" in resolved);
  assert.equal(resolved.target.apiKey, PRIMARY);
  assert.equal(resolved.target.baseURL, "https://api.openai.com/v1");
});

test("a resting primary hands transcription to the backup", async () => {
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
