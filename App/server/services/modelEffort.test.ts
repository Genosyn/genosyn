import assert from "node:assert/strict";
import { test } from "node:test";
import { modelEffortLevels, requireModelEffort } from "./modelEffort.js";
import type { ModelEffort } from "../../shared/modelEffort.js";

test("effort choices distinguish model generations and dated snapshots", () => {
  assert.deepEqual(modelEffortLevels({ provider: "openai", model: "gpt-5.6-sol" }), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(modelEffortLevels({ provider: "openai", model: "gpt-6-astra" }), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(modelEffortLevels({ provider: "openai", model: "gpt-5.4-2026-03-05" }), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(modelEffortLevels({ provider: "openai", model: "gpt-5.3-codex" }), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(
    modelEffortLevels({ provider: "anthropic", model: "claude-opus-4-5-20251101" }),
    ["low", "medium", "high"],
  );
  assert.deepEqual(modelEffortLevels({ provider: "anthropic", model: "claude-sonnet-4-6" }), [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.deepEqual(modelEffortLevels({ provider: "anthropic", model: "claude-opus-4-7" }), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("unknown, non-reasoning, and custom models retain their default without guessed options", () => {
  for (const model of ["gpt-4o", "gpt-7", "gpt-5.4-chat-latest", "__proto__", "constructor"]) {
    assert.deepEqual(modelEffortLevels({ provider: "openai", model }), []);
    assert.equal(requireModelEffort({ provider: "openai", model }), null);
    assert.equal(requireModelEffort({ provider: "openai", model }, null), null);
  }
  assert.deepEqual(modelEffortLevels({ provider: "custom", model: "gpt-5.6-sol" }), []);
  assert.deepEqual(modelEffortLevels({ provider: "anthropic", model: "claude-sonnet-4-5" }), []);
});

test("effort validation rejects unsupported and malformed explicit values", () => {
  const model = { provider: "openai" as const, model: "gpt-6-astra" };
  assert.equal(requireModelEffort(model, "max"), "max");
  for (const effort of ["none", "minimal", "ultra", "", {}, 7]) {
    assert.throws(
      () => requireModelEffort(model, effort as ModelEffort),
      /does not support this effort/,
    );
  }
});

test("subscription choices match the pinned runtime instead of the API", () => {
  const model = {
    provider: "openai" as const,
    model: "gpt-5.6-sol",
    authMode: "subscription" as const,
  };
  assert.deepEqual(modelEffortLevels(model), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(requireModelEffort(model, "ultra"), "ultra");
  assert.throws(() => requireModelEffort(model, "none"), /does not support this effort/);
  assert.throws(
    () => requireModelEffort({ ...model, authMode: "apikey" }, "ultra"),
    /does not support this effort/,
  );
  assert.deepEqual(modelEffortLevels({ ...model, model: "gpt-5.6-luna" }), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(modelEffortLevels({ ...model, model: "gpt-5.4" }), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(modelEffortLevels({ ...model, model: "unknown-subscription-model" }), []);
});
