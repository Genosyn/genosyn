import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { config } from "../../config.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../db/entities/AIModelKeyHealth.js";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/secret.js";
import {
  LEGACY_PRIMARY_KEY_ID,
  decryptApiKey,
  decryptApiKeys,
  findApiKey,
  holdsApiKeys,
  newStoredApiKey,
  publicApiKeys,
  readApiKeys,
  writeApiKeys,
  type StoredApiKey,
} from "./modelApiKeys.js";
import { isModelConnected } from "./providers.js";

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(() => {
  security.encryptionSecret = "model-api-keys-tests-encryption-secret-0123456789";
});
after(() => {
  security.encryptionSecret = originalSecret;
});

const COMPANY = "company-a";
const plaintext = (n: number) =>
  `sk-ant-api03-backup-key-${String(n).padStart(3, "0")}-abcdefghijklmnop`;

function keys(count: number): { stored: StoredApiKey[]; secrets: string[] } {
  const secrets = Array.from({ length: count }, (_, i) => plaintext(i));
  return { stored: secrets.map((s) => newStoredApiKey(s, COMPANY)), secrets };
}

function model(configJson: string, overrides: Partial<AIModel> = {}): AIModel {
  return Object.assign(new AIModel(), {
    id: "model-1",
    employeeId: "employee",
    provider: "anthropic",
    authMode: "apikey",
    model: "claude-opus-5-5",
    configJson,
    ...overrides,
  });
}

describe("API key storage", () => {
  test("a primary saved before backup keys reads as one key called primary", () => {
    const configJson = JSON.stringify({
      apiKeyEncrypted: encryptSecret("sk-legacy-primary-key-0001", COMPANY),
      apiKeyPreview: maskSecret("sk-legacy-primary-key-0001"),
    });
    const [primary, ...rest] = readApiKeys(configJson);
    assert.equal(rest.length, 0);
    assert.equal(primary.id, LEGACY_PRIMARY_KEY_ID);
    assert.equal(primary.addedAt, null);
    assert.equal(primary.apiKeyPreview, "sk-…0001");
    assert.equal(decryptApiKey(primary), "sk-legacy-primary-key-0001");
  });

  test("thirty keys round-trip in order with no cap, each encrypted like the primary", () => {
    const { stored, secrets } = keys(30);
    const configJson = writeApiKeys("{}", stored);
    const read = readApiKeys(configJson);
    assert.equal(read.length, 30);
    assert.deepEqual(
      read.map((key) => key.id),
      stored.map((key) => key.id),
    );
    read.forEach((key, index) => {
      // Scoped v2 ciphertext for the company, decrypting to its own key.
      assert.match(key.apiKeyEncrypted, /^v2\./);
      assert.equal(decryptSecret(key.apiKeyEncrypted), secrets[index]);
      assert.equal(key.apiKeyPreview, maskSecret(secrets[index]));
      assert.ok(key.addedAt && !Number.isNaN(Date.parse(key.addedAt)));
    });
    for (const secret of secrets) assert.ok(!configJson.includes(secret), "no plaintext at rest");
    // The primary stays where every older reader looks for it.
    const cfg = JSON.parse(configJson);
    assert.equal(decryptSecret(cfg.apiKeyEncrypted), secrets[0]);
    assert.equal(cfg.apiKeyId, stored[0].id);
    assert.equal(cfg.backupKeys.length, 29);
    assert.equal(isModelConnected(model(configJson)), true);
  });

  test("a hundred keys still round-trip — the count is never capped", () => {
    const { stored, secrets } = keys(100);
    const read = decryptApiKeys(writeApiKeys("{}", stored));
    assert.deepEqual(
      read.map((key) => key.apiKey),
      secrets,
    );
  });

  test("every key gets its own id and its own ciphertext, even for the same company", () => {
    const a = newStoredApiKey("sk-same-company-key-a-0001", COMPANY);
    const b = newStoredApiKey("sk-same-company-key-a-0001", COMPANY);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.apiKeyEncrypted, b.apiKeyEncrypted);
    assert.match(a.id, /^[0-9a-f-]{36}$/);
  });

  test("writing keys keeps every other field and drops none of the order", () => {
    const { stored } = keys(3);
    const configJson = writeApiKeys(JSON.stringify({ unrelated: "kept", backupKeys: "junk" }), [
      stored[2],
      stored[0],
      stored[1],
    ]);
    const cfg = JSON.parse(configJson);
    assert.equal(cfg.unrelated, "kept");
    assert.deepEqual(
      readApiKeys(configJson).map((key) => key.id),
      [stored[2].id, stored[0].id, stored[1].id],
    );
  });

  test("a legacy primary keeps its name wherever it moves", () => {
    const legacy: StoredApiKey = {
      id: LEGACY_PRIMARY_KEY_ID,
      apiKeyEncrypted: encryptSecret("sk-legacy-key-moving-0001", COMPANY),
      apiKeyPreview: "sk-…0001",
      addedAt: null,
    };
    const backup = newStoredApiKey("sk-new-backup-key-0002", COMPANY);
    const demoted = writeApiKeys("{}", [backup, legacy]);
    assert.deepEqual(
      readApiKeys(demoted).map((key) => key.id),
      [backup.id, LEGACY_PRIMARY_KEY_ID],
    );
    const promoted = writeApiKeys(demoted, [legacy, backup]);
    assert.equal(JSON.parse(promoted).apiKeyId, undefined, "no stored id for a legacy primary");
    assert.deepEqual(
      readApiKeys(promoted).map((key) => key.id),
      [LEGACY_PRIMARY_KEY_ID, backup.id],
    );
  });

  test("writing no keys leaves no key fields at all", () => {
    const { stored } = keys(2);
    const cfg = JSON.parse(writeApiKeys(writeApiKeys("{}", stored), []));
    assert.deepEqual(cfg, {});
  });

  test("malformed configs and entries read as no key rather than throwing", () => {
    assert.deepEqual(readApiKeys("not json"), []);
    assert.deepEqual(readApiKeys(""), []);
    assert.deepEqual(readApiKeys(null), []);
    assert.deepEqual(readApiKeys("[1,2]"), []);
    const primary = newStoredApiKey("sk-primary-key-ok-0001", COMPANY);
    const configJson = JSON.stringify({
      apiKeyEncrypted: primary.apiKeyEncrypted,
      apiKeyId: primary.id,
      backupKeys: [
        null,
        "string",
        { id: "no-ciphertext" },
        { apiKeyEncrypted: "no-id" },
        { id: primary.id, apiKeyEncrypted: primary.apiKeyEncrypted },
        { id: "fine", apiKeyEncrypted: primary.apiKeyEncrypted },
      ],
    });
    assert.deepEqual(
      readApiKeys(configJson).map((key) => key.id),
      [primary.id, "fine"],
    );
  });

  test("a key that no longer decrypts is skipped, not fatal for the rest", () => {
    const { stored, secrets } = keys(3);
    stored[1] = { ...stored[1], apiKeyEncrypted: "v2.broken.cipher.text.here" };
    const decrypted = decryptApiKeys(writeApiKeys("{}", stored));
    assert.deepEqual(
      decrypted.map((key) => key.apiKey),
      [secrets[0], secrets[2]],
    );
    assert.equal(decryptApiKey(stored[1]), null);
  });

  test("findApiKey matches on the key itself, never on the preview", () => {
    const { stored, secrets } = keys(3);
    assert.equal(findApiKey(stored, secrets[1])?.id, stored[1].id);
    assert.equal(findApiKey(stored, "sk-ant-api03-backup-key-999-abcdefghijklmnop"), undefined);
    // Same preview, different key.
    assert.equal(findApiKey(stored, secrets[1].replace("backup", "bakcup")), undefined);
  });

  test("only Claude and OpenAI API-key models hold a pool of API keys", () => {
    assert.equal(holdsApiKeys({ provider: "anthropic", authMode: "apikey" }), true);
    assert.equal(holdsApiKeys({ provider: "openai", authMode: "apikey" }), true);
    assert.equal(holdsApiKeys({ provider: "openai", authMode: "subscription" }), false);
    assert.equal(holdsApiKeys({ provider: "custom", authMode: "customEndpoint" }), false);
  });
});

describe("the keys a Member sees", () => {
  function health(values: Partial<AIModelKeyHealth>): AIModelKeyHealth {
    return Object.assign(new AIModelKeyHealth(), {
      modelId: "model-1",
      lastUsedAt: null,
      lastErrorAt: null,
      lastErrorStatus: null,
      lastErrorKind: null,
      lastErrorMessage: null,
      coolDownUntil: null,
      ...values,
    });
  }

  test("previews and health only — never a ciphertext or a key", () => {
    const { stored, secrets } = keys(3);
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const shown = publicApiKeys(
      model(writeApiKeys("{}", stored)),
      [
        health({ keyId: stored[0].id, lastUsedAt: new Date(now - 60_000) }),
        health({
          keyId: stored[1].id,
          lastErrorAt: new Date(now - 5_000),
          lastErrorStatus: 401,
          lastErrorKind: "auth",
          lastErrorMessage: "invalid x-api-key",
          coolDownUntil: new Date(now + 240_000),
        }),
        // An old rest is not a rest.
        health({ keyId: stored[2].id, coolDownUntil: new Date(now - 1) }),
        // Health for a key the model no longer holds is not shown.
        health({ keyId: "gone", lastUsedAt: new Date(now) }),
      ],
      { now },
    );
    assert.deepEqual(
      shown.map((key) => key.id),
      stored.map((key) => key.id),
    );
    assert.equal(shown[0].preview, maskSecret(secrets[0]));
    assert.equal(shown[0].lastUsedAt, new Date(now - 60_000).toISOString());
    assert.equal(shown[0].restingUntil, null);
    assert.equal(shown[1].lastErrorStatus, 401);
    assert.equal(shown[1].lastErrorKind, "auth");
    assert.equal(shown[1].lastError, "invalid x-api-key");
    assert.equal(shown[1].restingUntil, new Date(now + 240_000).toISOString());
    assert.equal(shown[2].restingUntil, null);
    const wire = JSON.stringify(shown);
    for (const secret of secrets) assert.ok(!wire.includes(secret));
    for (const key of stored) assert.ok(!wire.includes(key.apiKeyEncrypted));
    assert.doesNotMatch(wire, /apiKeyEncrypted|v2\./);
  });

  test("each key's sessions in the last 24 hours, and none for a key with no count yet", () => {
    const { stored } = keys(3);
    const now = Date.parse("2026-10-23T12:30:00.000Z");
    const hour = Math.floor(now / 3_600_000);
    const shown = publicApiKeys(
      model(writeApiKeys("{}", stored)),
      [
        health({
          keyId: stored[0].id,
          sessionsByHour: JSON.stringify([
            [hour - 24, 9],
            [hour - 23, 2],
            [hour, 5],
          ]),
        }),
        health({ keyId: stored[1].id, sessionsByHour: "not json" }),
      ],
      { now },
    );
    assert.deepEqual(
      shown.map((key) => key.sessionsLast24h),
      [7, 0, 0],
    );
  });

  test("a rest this process knows about shows even before it is saved", () => {
    const { stored } = keys(2);
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const shown = publicApiKeys(model(writeApiKeys("{}", stored)), [], {
      now,
      restingUntil: (keyId) => (keyId === stored[1].id ? now + 30_000 : 0),
    });
    assert.equal(shown[0].restingUntil, null);
    assert.equal(shown[1].restingUntil, new Date(now + 30_000).toISOString());
  });

  test("subscription and custom-endpoint models list no API keys", () => {
    const custom = model(
      JSON.stringify({
        baseURLEncrypted: encryptSecret("http://gpu:8000/v1", COMPANY),
        apiKeyEncrypted: encryptSecret("endpoint-key-0001", COMPANY),
      }),
      { provider: "custom", authMode: "customEndpoint" },
    );
    assert.deepEqual(publicApiKeys(custom, []), []);
    assert.deepEqual(
      publicApiKeys(model("{}", { provider: "openai", authMode: "subscription" }), []),
      [],
    );
  });
});
