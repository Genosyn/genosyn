import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeFirst,
  advancedSummary,
  describeModel,
  modelName,
  modelService,
  runLimitNote,
  tuningNotes,
} from "./modelSummary.js";

const base = {
  authMode: "apikey" as const,
  status: "connected" as const,
  contextWindow: null,
  contextWindowSource: null,
  maxConcurrentRuns: null,
};

describe("describing an AI Model in plain words", () => {
  test("names the service the way a Member would, never the provider value", () => {
    assert.equal(modelService({ provider: "anthropic", authMode: "apikey" }), "Claude (Anthropic)");
    assert.equal(modelService({ provider: "openai", authMode: "apikey" }), "OpenAI");
    assert.equal(
      modelService({ provider: "openai", authMode: "subscription" }),
      "OpenAI (ChatGPT sign-in)",
    );
    assert.equal(
      modelService({ provider: "custom", authMode: "customEndpoint" }),
      "Custom endpoint",
    );
  });

  test("puts the service and the model on one line", () => {
    assert.equal(
      describeModel({ provider: "anthropic", authMode: "apikey", model: "claude-sonnet-4-5" }),
      "Claude (Anthropic) · claude-sonnet-4-5",
    );
  });

  test("a ChatGPT sign-in left on automatic reads as the default, not as 'auto'", () => {
    assert.equal(
      describeModel({ provider: "openai", authMode: "subscription", model: "auto" }),
      "OpenAI (ChatGPT sign-in) · default model",
    );
  });

  test("a custom endpoint is named by the model its server serves", () => {
    assert.equal(
      modelName({
        provider: "custom",
        authMode: "customEndpoint",
        model: "qwen3",
        customEndpointModelId: "Qwen/Qwen3-27B",
      }),
      "Qwen/Qwen3-27B",
    );
    assert.equal(
      modelName({ provider: "custom", authMode: "customEndpoint", model: "qwen3" }),
      "qwen3",
    );
  });
});

describe("the active model leads", () => {
  test("without disturbing the order of the rest", () => {
    const models = [
      { id: "a", isActive: false },
      { id: "b", isActive: true },
      { id: "c", isActive: false },
    ];
    assert.deepEqual(
      activeFirst(models).map((model) => model.id),
      ["b", "a", "c"],
    );
    assert.deepEqual(
      models.map((model) => model.id),
      ["a", "b", "c"],
      "the input is left alone",
    );
  });
});

describe("what the Advanced line names", () => {
  test("says nothing while every setting is at its default", () => {
    assert.equal(advancedSummary([base]), "");
    assert.deepEqual(tuningNotes(base), []);
  });

  test("names a context window set by hand and a Run limit", () => {
    assert.equal(
      advancedSummary([
        { ...base, contextWindow: 32_768, contextWindowSource: "manual", maxConcurrentRuns: 2 },
      ]),
      "Context window set manually · 2 concurrent Runs",
    );
  });

  test("a probed window and the default Run limit are not news", () => {
    assert.equal(
      advancedSummary([{ ...base, contextWindow: 200_000, contextWindowSource: "probed" }]),
      "",
    );
  });

  test("reads the singular, and zero as no limit", () => {
    assert.equal(runLimitNote(1), "1 concurrent Run");
    assert.equal(runLimitNote(0), "No limit on concurrent Runs");
    assert.equal(
      advancedSummary([{ ...base, maxConcurrentRuns: 0 }]),
      "No limit on concurrent Runs",
    );
  });

  test("an unknown window is named for a server you run, not for an OpenAI key", () => {
    assert.equal(advancedSummary([base]), "");
    assert.equal(
      advancedSummary([{ ...base, authMode: "customEndpoint" }]),
      "Context window unknown",
    );
  });

  test("a hand-set window wins over 'unknown'", () => {
    assert.deepEqual(
      tuningNotes({
        ...base,
        authMode: "customEndpoint",
        contextWindow: 8_192,
        contextWindowSource: "manual",
      }),
      ["Context window set manually"],
    );
  });

  test("counts the other AI Models first", () => {
    assert.equal(advancedSummary([base, base]), "1 other AI Model");
    assert.equal(
      advancedSummary([{ ...base, maxConcurrentRuns: 3 }, base, base]),
      "2 other AI Models · 3 concurrent Runs",
    );
  });

  test("never repeats a note two models share", () => {
    const tuned = { ...base, contextWindow: 16_384, contextWindowSource: "manual" as const };
    assert.equal(advancedSummary([tuned, tuned]), "1 other AI Model · Context window set manually");
  });

  test("a ChatGPT sign-in and an unconnected model have nothing to tune", () => {
    assert.deepEqual(tuningNotes({ ...base, authMode: "subscription", maxConcurrentRuns: 4 }), []);
    assert.deepEqual(tuningNotes({ ...base, status: "not_connected", maxConcurrentRuns: 4 }), []);
  });
});
