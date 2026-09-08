import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkSessionModel } from "./api.js";
import { resolveWorkSessionModelId } from "./workSessionModel.js";

const CLAUDE: WorkSessionModel = {
  id: "claude",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  label: "Claude Sonnet",
  status: "connected",
  isActive: true,
};
const GPT: WorkSessionModel = {
  id: "gpt",
  provider: "openai",
  model: "gpt-5.4",
  label: "GPT",
  status: "connected",
  isActive: false,
};
const LOCAL: WorkSessionModel = {
  id: "local",
  provider: "custom",
  model: "local-model",
  label: "Local model",
  status: "not_connected",
  isActive: false,
};
const MODELS = [GPT, CLAUDE, LOCAL];

function resolve(overrides: Partial<Parameters<typeof resolveWorkSessionModelId>[0]> = {}) {
  return resolveWorkSessionModelId({
    employeeId: "alex",
    models: MODELS,
    override: null,
    ...overrides,
  });
}

describe("Work session model selection", () => {
  test("starts with the employee's connected default, even when it is not listed first", () => {
    assert.equal(resolve(), CLAUDE.id);
  });

  test("respects a connected model chosen for this employee", () => {
    assert.equal(resolve({ override: { employeeId: "alex", modelId: GPT.id } }), GPT.id);
  });

  test("keeps an explicit choice when the employee's default changes", () => {
    assert.equal(
      resolve({
        models: [
          { ...GPT, isActive: true },
          { ...CLAUDE, isActive: false },
        ],
        override: { employeeId: "alex", modelId: CLAUDE.id },
      }),
      CLAUDE.id,
    );
  });

  test("does not carry a model choice to another employee, even if the id appears there", () => {
    assert.equal(
      resolve({ employeeId: "jamie", override: { employeeId: "alex", modelId: GPT.id } }),
      CLAUDE.id,
    );
  });

  test("falls back when a selected model is removed from the employee", () => {
    assert.equal(
      resolve({
        models: [CLAUDE, LOCAL],
        override: { employeeId: "alex", modelId: GPT.id },
      }),
      CLAUDE.id,
    );
  });

  test("falls back when the selected model disconnects", () => {
    assert.equal(
      resolve({
        models: [{ ...GPT, status: "not_connected" }, CLAUDE],
        override: { employeeId: "alex", modelId: GPT.id },
      }),
      CLAUDE.id,
    );
  });

  test("rejects a disconnected selection even if it remains in the response", () => {
    assert.equal(resolve({ override: { employeeId: "alex", modelId: LOCAL.id } }), CLAUDE.id);
  });

  test("rejects an unknown model id", () => {
    assert.equal(
      resolve({ override: { employeeId: "alex", modelId: "somebody-elses-model" } }),
      CLAUDE.id,
    );
  });

  test("treats an empty override as no selection", () => {
    assert.equal(resolve({ override: { employeeId: "alex", modelId: "" } }), CLAUDE.id);
  });

  test("uses the first connected model if there is no default", () => {
    assert.equal(resolve({ models: [LOCAL, GPT, { ...CLAUDE, isActive: false }] }), GPT.id);
  });

  test("skips a disconnected default", () => {
    assert.equal(resolve({ models: [{ ...CLAUDE, status: "not_connected" }, LOCAL, GPT] }), GPT.id);
  });

  test("prefers a connected default over a disconnected default in inconsistent data", () => {
    assert.equal(resolve({ models: [{ ...LOCAL, isActive: true }, GPT, CLAUDE] }), CLAUDE.id);
  });

  test("chooses the first connected default if more than one is flagged", () => {
    assert.equal(resolve({ models: [{ ...GPT, isActive: true }, CLAUDE] }), GPT.id);
  });

  test("selects a sole connected model without requiring a default flag", () => {
    assert.equal(resolve({ models: [GPT] }), GPT.id);
  });

  test("a single disconnected model cannot be selected", () => {
    assert.equal(resolve({ models: [LOCAL] }), null);
  });

  test("an employee without models has no selection", () => {
    assert.equal(resolve({ models: [] }), null);
  });

  test("stale choices cannot survive an empty model response", () => {
    assert.equal(resolve({ models: [], override: { employeeId: "alex", modelId: GPT.id } }), null);
  });

  test("an employee whose models are all disconnected has no selection", () => {
    assert.equal(
      resolve({ models: MODELS.map((model) => ({ ...model, status: "not_connected" })) }),
      null,
    );
  });

  test("refreshing the response retains a valid choice regardless of row order", () => {
    assert.equal(
      resolve({ models: [...MODELS].reverse(), override: { employeeId: "alex", modelId: GPT.id } }),
      GPT.id,
    );
  });

  test("model reconnection makes the current employee's explicit choice eligible again", () => {
    assert.equal(
      resolve({
        models: [CLAUDE, { ...LOCAL, status: "connected" }],
        override: { employeeId: "alex", modelId: LOCAL.id },
      }),
      LOCAL.id,
    );
  });

  test("does not reorder or mutate the response while resolving a model", () => {
    const models = structuredClone(MODELS);
    const before = structuredClone(models);
    resolve({ models, override: { employeeId: "alex", modelId: GPT.id } });
    assert.deepEqual(models, before);
  });
});
