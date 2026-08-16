import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { encryptSecret } from "../../lib/secret.js";
import { sweepContextWindows } from "./contextWindowRefresh.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const companyId = "co_context_window_sweep";

/** A custom-endpoint model: probeable, and connected once it has a base URL. */
async function customModel(
  overrides: Partial<AIModel> = {},
  endpoint: { baseURL: string; modelId: string } | null = {
    baseURL: "http://gpu.internal:8000/v1",
    modelId: "Qwen/Qwen3.8-27B",
  },
) {
  return insert(AIModel, {
    employeeId: "employee-context-window",
    provider: "custom",
    model: endpoint?.modelId ?? "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    configJson: endpoint
      ? JSON.stringify({
          baseURLEncrypted: encryptSecret(endpoint.baseURL, companyId),
          baseURLPreview: "gpu.internal:8000",
          modelId: endpoint.modelId,
        })
      : "{}",
    connectedAt: new Date("2026-08-15T20:36:00.000Z"),
    contextWindow: null,
    contextWindowSource: null,
    ...overrides,
  });
}

async function reload(id: string): Promise<AIModel> {
  const found = await AppDataSource.getRepository(AIModel).findOneBy({ id });
  assert.ok(found, "model row disappeared");
  return found;
}

describe("context window sweep", () => {
  test("stores a window the provider now reports", async () => {
    const m = await customModel();

    const changed = await sweepContextWindows({ probe: async () => 262_144 });

    assert.equal(changed, 1);
    const saved = await reload(m.id);
    assert.equal(saved.contextWindow, 262_144);
    assert.equal(saved.contextWindowSource, "probed");
  });

  test("adopts a window that moved since the last check", async () => {
    const m = await customModel({ contextWindow: 32_768, contextWindowSource: "probed" });

    const changed = await sweepContextWindows({ probe: async () => 131_072 });

    assert.equal(changed, 1);
    assert.equal((await reload(m.id)).contextWindow, 131_072);
  });

  test("keeps the known window when the endpoint is unreachable", async () => {
    const m = await customModel({ contextWindow: 32_768, contextWindowSource: "probed" });

    const changed = await sweepContextWindows({ probe: async () => null });

    assert.equal(changed, 0);
    const saved = await reload(m.id);
    assert.equal(saved.contextWindow, 32_768);
    assert.equal(saved.contextWindowSource, "probed");
  });

  test("never overwrites a window an operator typed in", async () => {
    const m = await customModel({ contextWindow: 8_192, contextWindowSource: "manual" });

    const changed = await sweepContextWindows({
      probe: async () => assert.fail("a manual window must not be probed"),
    });

    assert.equal(changed, 0);
    const saved = await reload(m.id);
    assert.equal(saved.contextWindow, 8_192);
    assert.equal(saved.contextWindowSource, "manual");
  });

  test("skips models with no credential and providers with nothing to ask", async () => {
    const unconfigured = await customModel({}, null);
    const openai = await insert(AIModel, {
      employeeId: "employee-context-window",
      provider: "openai",
      model: "gpt-5",
      authMode: "apikey",
      isActive: false,
      configJson: JSON.stringify({ apiKeyEncrypted: encryptSecret("sk-test", companyId) }),
      connectedAt: new Date("2026-08-15T20:36:00.000Z"),
      contextWindow: null,
      contextWindowSource: null,
    });

    const changed = await sweepContextWindows({
      probe: async () => assert.fail("nothing here is worth asking"),
    });

    assert.equal(changed, 0);
    assert.equal((await reload(unconfigured.id)).contextWindow, null);
    assert.equal((await reload(openai.id)).contextWindow, null);
  });

  test("one failing model does not cost the rest their refresh", async () => {
    const first = await customModel();
    const second = await customModel();
    const failed: string[] = [];

    const changed = await sweepContextWindows({
      probe: async (m) => {
        if (m.id === first.id) {
          failed.push(m.id);
          throw new Error("connect ECONNREFUSED");
        }
        return 65_536;
      },
    });

    assert.deepEqual(failed, [first.id]);
    assert.equal(changed, 1);
    assert.equal((await reload(first.id)).contextWindow, null);
    assert.equal((await reload(second.id)).contextWindow, 65_536);
  });

  test("stops mid-sweep once the scheduler lease is lost", async () => {
    await customModel();
    await customModel();
    let probes = 0;

    const changed = await sweepContextWindows({
      probe: async () => {
        probes++;
        return 65_536;
      },
      isHeld: () => probes === 0,
    });

    assert.equal(probes, 1);
    assert.equal(changed, 1);
  });
});
