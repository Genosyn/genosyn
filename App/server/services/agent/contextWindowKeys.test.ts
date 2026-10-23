import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { config } from "../../../config.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { newStoredApiKey, readApiKeys, writeApiKeys } from "../modelApiKeys.js";
import { resetKeyHealthMemory, restKey } from "../modelKeyHealth.js";
import { probeContextWindow } from "./contextWindow.js";

/**
 * The context-window probe asks Anthropic with the AI Model's keys in the
 * order a Run would try them, and moves on only when a key itself is refused.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "context-window-keys-tests-encryption-secret-01";
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

const PRIMARY = "sk-ant-api03-probe-primary-key-000001";
const BACKUP = "sk-ant-api03-probe-backup-key-0000002";

async function claude(): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: "employee",
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      [PRIMARY, BACKUP].map((key) => newStoredApiKey(key, "co")),
    ),
    connectedAt: new Date(),
  });
}

/** Anthropic's models API, answering by key. */
function anthropicModels(t: TestContext, answer: (key: string) => Response): string[] {
  const asked: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const key = headers.get("x-api-key") ?? "";
      asked.push(key);
      return answer(key);
    },
  );
  return asked;
}

const window = (tokens: number) =>
  Response.json({ id: "claude-opus-5-5", type: "model", max_input_tokens: tokens });
const refused = (status: number) =>
  Response.json(
    { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    { status },
  );

test("a refused primary hands the probe to the backup", async (t) => {
  const asked = anthropicModels(t, (key) => (key === PRIMARY ? refused(401) : window(500_000)));
  assert.equal(await probeContextWindow(await claude()), 500_000);
  assert.deepEqual(asked, [PRIMARY, BACKUP]);
});

for (const status of [402, 403, 429]) {
  test(`a primary refused with ${status} also hands the probe on`, async (t) => {
    const asked = anthropicModels(t, (key) =>
      key === PRIMARY ? refused(status) : window(200_000),
    );
    assert.equal(await probeContextWindow(await claude()), 200_000);
    assert.deepEqual(asked, [PRIMARY, BACKUP]);
  });
}

test("a failure that is not about the key ends the probe as unknown", async (t) => {
  const asked = anthropicModels(t, () =>
    Response.json(
      { type: "error", error: { type: "api_error", message: "boom" } },
      { status: 500 },
    ),
  );
  assert.equal(await probeContextWindow(await claude()), null);
  assert.deepEqual(asked, [PRIMARY]);
});

test("a resting primary is asked last", async (t) => {
  const model = await claude();
  const [primary] = readApiKeys(model.configJson);
  restKey(model.id, primary.id, Date.now() + 60_000);
  const asked = anthropicModels(t, () => window(300_000));
  assert.equal(await probeContextWindow(model), 300_000);
  assert.deepEqual(asked, [BACKUP]);
});

test("every key refused is simply unknown", async (t) => {
  const asked = anthropicModels(t, () => refused(401));
  assert.equal(await probeContextWindow(await claude()), null);
  assert.deepEqual(asked, [PRIMARY, BACKUP]);
});
