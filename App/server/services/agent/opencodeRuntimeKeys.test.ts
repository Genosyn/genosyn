import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { config } from "../../../config.js";
import { maskSecret } from "../../lib/secret.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { newStoredApiKey, writeApiKeys } from "../modelApiKeys.js";
import { resetKeyHealthMemory } from "../modelKeyHealth.js";
import { resetKeyPoolMemory } from "../modelKeyPool.js";
import { runOpenCodeTurn } from "./opencodeRuntime.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";

/**
 * Every turn `runOpenCodeTurn` runs on an API-key AI Model is a session in its
 * key pool: it opens on the next key in turn and says which, for the Run log.
 * Each turn here is stopped as soon as it has opened — before OpenCode starts —
 * so nothing leaves the machine.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "runtime-keys-tests-encryption-secret-0123456789";
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

const KEYS = [
  "sk-ant-api03-runtime-pool-key-a-00001",
  "sk-ant-api03-runtime-pool-key-b-00002",
  "sk-ant-api03-runtime-pool-key-c-00003",
];

test("each turn opens a session on the next key in turn, and names it by preview", async () => {
  const model = await insertEmployeeModel({
    employeeId: "employee",
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      KEYS.map((key) => newStoredApiKey(key, "company")),
    ),
    connectedAt: new Date(),
  });
  const opened: Array<{ preview: string; keys: number }> = [];
  for (let turn = 0; turn < 4; turn++) {
    const controller = new AbortController();
    const result = await runOpenCodeTurn({
      model,
      system: "Test",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
      signal: controller.signal,
      callbacks: {
        onApiKeySession: (session) => {
          opened.push(session);
          // Stop the turn before OpenCode starts: it has opened, which is all this checks.
          controller.abort();
        },
      },
    });
    assert.equal(result.stopReason, "aborted");
  }
  assert.deepEqual(opened, [
    { preview: maskSecret(KEYS[0]), keys: 3 },
    { preview: maskSecret(KEYS[1]), keys: 3 },
    { preview: maskSecret(KEYS[2]), keys: 3 },
    { preview: maskSecret(KEYS[0]), keys: 3 },
  ]);
  for (const session of opened) {
    for (const key of KEYS) assert.ok(!JSON.stringify(session).includes(key));
  }
});
