import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  modelEffortLevels,
  modelThinking,
  modelThinkingProfile,
  requireAllowedEffort,
  requireModelEffort,
  thinkingSettingsProblem,
} from "./modelEffort.js";
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
    ["none", "low", "medium", "high"],
  );
  assert.deepEqual(modelEffortLevels({ provider: "anthropic", model: "claude-sonnet-4-6" }), [
    "none",
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.deepEqual(modelEffortLevels({ provider: "anthropic", model: "claude-opus-4-7" }), [
    "none",
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
  for (const model of ["claude-3-5-sonnet-20241022", "claude-3-haiku-20240307", "claude-9"]) {
    assert.deepEqual(modelEffortLevels({ provider: "anthropic", model }), []);
  }
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

describe("how each kind of AI Model thinks", () => {
  test("Claude 5-family models always think, at the API's own default effort", () => {
    for (const [model, nativeDefault] of [
      ["claude-opus-5-5", "medium"],
      ["claude-haiku-5-5", "medium"],
      ["claude-opus-5", "high"],
      ["claude-sonnet-5-5", "high"],
      ["claude-sonnet-5", "high"],
      ["claude-fable-5-1", "high"],
      ["claude-mythos-5-1", "high"],
    ] as const) {
      const profile = modelThinkingProfile({ provider: "anthropic", model });
      assert.equal(profile.wire, "anthropic-adaptive", model);
      assert.equal(profile.nativeDefault, nativeDefault, model);
      assert.equal(profile.levels.includes("none"), false, `${model} cannot turn thinking off`);
      assert.deepEqual(profile.levels, ["low", "medium", "high", "xhigh", "max"], model);
    }
  });

  test("Claude 4.6 to 4.8 think only when asked, so Off is their own default", () => {
    for (const model of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      const profile = modelThinkingProfile({ provider: "anthropic", model });
      assert.equal(profile.wire, "anthropic-adaptive", model);
      assert.equal(profile.nativeDefault, "none", model);
      assert.equal(profile.levels[0], "none", model);
    }
    // Extra high arrived with Claude Opus 4.7.
    assert.equal(
      modelEffortLevels({ provider: "anthropic", model: "claude-opus-4-6" }).includes("xhigh"),
      false,
    );
  });

  test("older Claude models think within a budget, and Opus 4.5 adds its effort", () => {
    for (const model of [
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-latest",
    ]) {
      const profile = modelThinkingProfile({ provider: "anthropic", model });
      assert.equal(profile.wire, "anthropic-budget", model);
      assert.deepEqual(profile.levels, ["none", "low", "medium", "high", "max"], model);
      assert.equal(profile.nativeDefault, "none", model);
    }
    assert.equal(
      modelThinkingProfile({ provider: "anthropic", model: "claude-opus-4-5" }).wire,
      "anthropic-effort-budget",
    );
  });

  test("OpenAI models through OpenCode run at medium by themselves; GPT-6 Astra's is unknown", () => {
    assert.equal(modelThinkingProfile({ provider: "openai", model: "gpt-5.5" }).nativeDefault, "medium");
    assert.equal(modelThinkingProfile({ provider: "openai", model: "o3" }).nativeDefault, "medium");
    assert.equal(
      modelThinkingProfile({ provider: "openai", model: "gpt-6-astra" }).nativeDefault,
      null,
    );
    assert.equal(modelThinkingProfile({ provider: "openai", model: "gpt-5.5" }).wire, "openai");
  });

  test("ChatGPT sign-ins take the bundled Codex catalogue's defaults", () => {
    const sub = (model: string) =>
      modelThinkingProfile({ provider: "openai", model, authMode: "subscription" });
    assert.equal(sub("gpt-5.6-sol").nativeDefault, "low");
    assert.equal(sub("gpt-5.6-terra").nativeDefault, "medium");
    assert.equal(sub("gpt-5.5").wire, "codex");
  });

  test("a custom endpoint offers Off to High only once its owners turn levels on", () => {
    const off = modelThinkingProfile({
      provider: "custom",
      model: "qwen3",
      authMode: "customEndpoint",
    });
    assert.deepEqual(off, { levels: [], nativeDefault: null, wire: null });
    const on = modelThinkingProfile({
      provider: "custom",
      model: "qwen3",
      authMode: "customEndpoint",
      customThinkingLevels: true,
    });
    assert.deepEqual(on, {
      levels: ["none", "low", "medium", "high"],
      nativeDefault: null,
      wire: "openai-compatible",
    });
    // The switch means nothing on a hosted model.
    assert.deepEqual(
      modelEffortLevels({ provider: "openai", model: "gpt-4o", customThinkingLevels: true }),
      [],
    );
  });
});

describe("a model's thinking as the chat sees it", () => {
  test("carries its owners' default and ceiling with what it offers", () => {
    assert.deepEqual(
      modelThinking({
        provider: "anthropic",
        model: "claude-opus-4-7",
        defaultEffort: "high",
        effortCeiling: "xhigh",
      }),
      {
        levels: ["none", "low", "medium", "high", "xhigh", "max"],
        nativeDefault: "none",
        defaultLevel: "high",
        ceiling: "xhigh",
        unavailableReason: null,
      },
    );
  });

  test("a model with no levels drops stale settings and says why it has none", () => {
    const custom = modelThinking({
      provider: "custom",
      model: "qwen3",
      authMode: "customEndpoint",
      defaultEffort: "high",
      effortCeiling: "high",
    });
    assert.equal(custom.defaultLevel, null);
    assert.equal(custom.ceiling, null);
    assert.match(String(custom.unavailableReason), /Owners can turn them on in Settings → AI Models/);
    assert.match(
      String(modelThinking({ provider: "openai", model: "gpt-4o" }).unavailableReason),
      /doesn't know which thinking levels/,
    );
  });
});

describe("owners' thinking settings", () => {
  const claude = { provider: "anthropic" as const, model: "claude-opus-4-7" };

  test("accepts levels the model offers with the default at or under the ceiling", () => {
    assert.equal(thinkingSettingsProblem(claude, { defaultEffort: null, effortCeiling: null }), null);
    assert.equal(
      thinkingSettingsProblem(claude, { defaultEffort: "high", effortCeiling: "high" }),
      null,
    );
    assert.equal(thinkingSettingsProblem(claude, { defaultEffort: "none", effortCeiling: "max" }), null);
  });

  test("refuses a level the model does not offer, naming it", () => {
    assert.equal(
      thinkingSettingsProblem(claude, { defaultEffort: "ultra", effortCeiling: null }),
      "This AI Model doesn't offer Ultra as a default. Choose one of the levels it offers.",
    );
    assert.equal(
      thinkingSettingsProblem(claude, { defaultEffort: null, effortCeiling: "minimal" }),
      "This AI Model doesn't offer Minimal as a highest level. Choose one of the levels it offers.",
    );
    assert.equal(
      thinkingSettingsProblem(
        { provider: "custom", model: "qwen3", authMode: "customEndpoint" },
        { defaultEffort: "low", effortCeiling: null },
      ),
      "This AI Model doesn't offer thinking levels.",
    );
  });

  test("refuses a default above the ceiling", () => {
    assert.equal(
      thinkingSettingsProblem(claude, { defaultEffort: "max", effortCeiling: "high" }),
      "The default can't be above the highest level Members may choose.",
    );
  });

  test("an explicit level a Member starts work with must be under the ceiling", () => {
    const capped = { ...claude, effortCeiling: "medium" as ModelEffort };
    assert.equal(requireAllowedEffort(capped, "low"), "low");
    assert.equal(requireAllowedEffort(capped, null), null);
    assert.throws(
      () => requireAllowedEffort(capped, "high"),
      /allows thinking levels up to Medium on this AI Model/,
    );
    assert.throws(() => requireAllowedEffort(capped, "ultra"), /does not support this effort/);
  });
});
