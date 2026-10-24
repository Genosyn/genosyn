import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIModel, ReusableModel } from "./api.js";
import {
  activeFirst,
  answeredInLine,
  canManageModels,
  describeModel,
  modelAdvancedHint,
  modelAdvancedSummary,
  modelConnectionLine,
  modelListLine,
  modelName,
  modelService,
  offersNotHeld,
  runLimitNote,
  testPassedLine,
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

describe("what a card's closed Advanced line says", () => {
  test("names what the section holds while every setting is at its default", () => {
    assert.deepEqual(tuningNotes(base), []);
    assert.equal(modelAdvancedSummary(base), "API keys, model, context window and Run limit");
  });

  test("the hint follows the kind of model, so it says where its keys, endpoint or sign-in are", () => {
    assert.equal(
      modelAdvancedHint({ authMode: "apikey", status: "connected" }),
      "API keys, model, context window and Run limit",
    );
    assert.equal(
      modelAdvancedHint({ authMode: "customEndpoint", status: "connected" }),
      "Endpoint, context window and Run limit",
    );
    assert.equal(
      modelAdvancedHint({ authMode: "subscription", status: "connected" }),
      "ChatGPT sign-in and model",
    );
    for (const authMode of ["apikey", "customEndpoint", "subscription"] as const) {
      assert.equal(modelAdvancedHint({ authMode, status: "not_connected" }), "Service and model");
    }
  });

  test("names a context window set by hand and a Run limit instead of the hint", () => {
    assert.equal(
      modelAdvancedSummary({
        ...base,
        contextWindow: 32_768,
        contextWindowSource: "manual",
        maxConcurrentRuns: 2,
      }),
      "Context window set manually · 2 concurrent Runs",
    );
  });

  test("a probed window and the default Run limit are not news", () => {
    assert.equal(
      modelAdvancedSummary({ ...base, contextWindow: 200_000, contextWindowSource: "probed" }),
      "API keys, model, context window and Run limit",
    );
  });

  test("reads the singular, and zero as no limit", () => {
    assert.equal(runLimitNote(1), "1 concurrent Run");
    assert.equal(runLimitNote(0), "No limit on concurrent Runs");
    assert.equal(
      modelAdvancedSummary({ ...base, maxConcurrentRuns: 0 }),
      "No limit on concurrent Runs",
    );
    assert.equal(modelAdvancedSummary({ ...base, maxConcurrentRuns: 4 }), "4 concurrent Runs");
  });

  test("an unknown window is named for a server you run, not for an OpenAI key", () => {
    assert.equal(modelAdvancedSummary(base), "API keys, model, context window and Run limit");
    assert.equal(
      modelAdvancedSummary({ ...base, authMode: "customEndpoint" }),
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

  test("backup keys and a Run limit, the owner's own example", () => {
    const keys = [0, 1, 2].map((n) => ({
      id: String(n),
      preview: `sk-…${n}`,
      addedAt: null,
      lastUsedAt: "2026-10-20T10:00:00.000Z",
      lastErrorAt: null,
      lastErrorStatus: null,
      lastErrorKind: null,
      lastError: null,
      restingUntil: null,
    }));
    assert.equal(
      modelAdvancedSummary({
        ...base,
        provider: "anthropic",
        apiKeys: keys,
        maxConcurrentRuns: 4,
      }),
      "2 backup API keys · 4 concurrent Runs",
    );
  });

  test("each card reports its own model alone: no count of the others, nothing borrowed", () => {
    const tuned = { ...base, maxConcurrentRuns: 3 };
    assert.equal(modelAdvancedSummary(tuned), "3 concurrent Runs");
    assert.equal(modelAdvancedSummary(base), "API keys, model, context window and Run limit");
    assert.doesNotMatch(modelAdvancedSummary(tuned), /other AI Model/);
  });

  test("a ChatGPT sign-in and an unconnected model have nothing to tune, so they show their hint", () => {
    assert.deepEqual(tuningNotes({ ...base, authMode: "subscription", maxConcurrentRuns: 4 }), []);
    assert.deepEqual(tuningNotes({ ...base, status: "not_connected", maxConcurrentRuns: 4 }), []);
    assert.equal(
      modelAdvancedSummary({ ...base, authMode: "subscription", maxConcurrentRuns: 4 }),
      "ChatGPT sign-in and model",
    );
    assert.equal(
      modelAdvancedSummary({ ...base, status: "not_connected", maxConcurrentRuns: 4 }),
      "Service and model",
    );
  });
});

describe("the line under a model's name", () => {
  const day = (iso: string) => `day(${iso.slice(0, 10)})`;
  const connected = {
    status: "connected" as const,
    authMode: "apikey" as const,
    connectedAt: "2026-10-09T07:00:00.000Z",
    customEndpointHost: null,
    subscriptionCredentialKind: null,
    subscriptionAvailable: false,
    subscriptionUnavailableReason: null,
  };

  test("an API key model counts its keys and says since when", () => {
    assert.equal(
      modelConnectionLine({ ...connected, apiKeys: [{}] }, day),
      "Connected with an API key · since day(2026-10-09)",
    );
    assert.equal(
      modelConnectionLine({ ...connected, apiKeys: [{}, {}, {}] }, day),
      "Connected with 3 API keys · since day(2026-10-09)",
    );
    assert.equal(
      modelConnectionLine({ ...connected, apiKeys: [] }, day),
      "Connected with an API key · since day(2026-10-09)",
      "a connected key model always has its key, even when the list is not sent",
    );
  });

  test("a custom endpoint names the server it reaches", () => {
    assert.equal(
      modelConnectionLine(
        { ...connected, authMode: "customEndpoint", customEndpointHost: "34.57.23.218:46455" },
        day,
      ),
      "Connected to 34.57.23.218:46455 · since day(2026-10-09)",
    );
    assert.equal(
      modelConnectionLine({ ...connected, authMode: "customEndpoint" }, day),
      "Connected to a custom endpoint · since day(2026-10-09)",
    );
  });

  test("a ChatGPT sign-in says how it signed in", () => {
    assert.equal(
      modelConnectionLine({ ...connected, authMode: "subscription" }, day),
      "Signed in with ChatGPT · since day(2026-10-09)",
    );
    assert.equal(
      modelConnectionLine(
        { ...connected, authMode: "subscription", subscriptionCredentialKind: "accessToken" },
        day,
      ),
      "Signed in with a Business or Enterprise access token · since day(2026-10-09)",
    );
  });

  test("no connection time, no 'since'", () => {
    assert.equal(
      modelConnectionLine({ ...connected, connectedAt: null }, day),
      "Connected with an API key",
    );
  });

  test("a model still waiting says what for, the same for everyone who reads it", () => {
    const waiting = { ...connected, status: "not_connected" as const, connectedAt: null };
    assert.equal(modelConnectionLine(waiting, day), "Waiting for an API key");
    assert.equal(
      modelConnectionLine({ ...waiting, authMode: "customEndpoint" }, day),
      "Waiting for the server's details",
    );
    assert.equal(
      modelConnectionLine(
        { ...waiting, authMode: "subscription", subscriptionAvailable: true },
        day,
      ),
      "Waiting for a ChatGPT sign-in",
    );
    assert.equal(
      modelConnectionLine(
        {
          ...waiting,
          authMode: "subscription",
          subscriptionUnavailableReason: "Multi-tenant installs can't use ChatGPT sign-in.",
        },
        day,
      ),
      "Multi-tenant installs can't use ChatGPT sign-in.",
    );
    assert.equal(
      modelConnectionLine({ ...waiting, authMode: "subscription" }, day),
      "ChatGPT sign-in is unavailable on this install.",
    );
  });
});

describe("who may change a model", () => {
  test("owners and admins; a Member reads", () => {
    assert.equal(canManageModels("owner"), true);
    assert.equal(canManageModels("admin"), true);
    assert.equal(canManageModels("member"), false);
    assert.equal(canManageModels(undefined), false);
  });
});

describe("the page's own words", () => {
  test("the line over several models says which one does the work", () => {
    assert.equal(
      modelListLine(2, "Ada"),
      "2 AI Models — Ada uses the active one for chat and Routines.",
    );
  });

  test("a passed test says how long the reply took, in plain units", () => {
    assert.equal(answeredInLine(0), "answered in under a second");
    assert.equal(answeredInLine(950), "answered in under a second");
    assert.equal(answeredInLine(1_000), "answered in 1.0 s");
    assert.equal(answeredInLine(2_449), "answered in 2.4 s");
    assert.equal(answeredInLine(59_940), "answered in 59.9 s");
    assert.equal(answeredInLine(95_000), "answered in 1 min 35 s");
    assert.equal(answeredInLine(Number.NaN), "answered in under a second");
    assert.equal(answeredInLine(-5), "answered in under a second");
    assert.equal(testPassedLine(2_449), "Working — the model answered in 2.4 s.");
  });
});

describe("the company's models offered when adding one", () => {
  const offer = (values: Partial<ReusableModel>): ReusableModel => ({
    id: "offer",
    employeeId: "casey",
    employeeName: "Casey",
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    endpointHost: null,
    isActive: true,
    ...values,
  });
  const held = (
    values: Partial<AIModel>,
  ): Pick<
    AIModel,
    "provider" | "authMode" | "model" | "customEndpointModelId" | "customEndpointHost"
  > => ({
    provider: "anthropic",
    authMode: "apikey",
    model: "claude-opus-5-5",
    customEndpointModelId: null,
    customEndpointHost: null,
    ...values,
  });

  test("leaves out a model this employee already runs", () => {
    const claude = offer({ id: "claude" });
    const gpt = offer({ id: "gpt", provider: "openai", model: "gpt-5" });
    assert.deepEqual(
      offersNotHeld([claude, gpt], [held({})]).map((entry) => entry.id),
      ["gpt"],
    );
  });

  test("keeps another model from the same service", () => {
    assert.equal(offersNotHeld([offer({ model: "claude-sonnet-5" })], [held({})]).length, 1);
  });

  test("tells custom endpoints apart by their server, and matches case-insensitively", () => {
    const sameServer = offer({
      id: "same",
      provider: "custom",
      authMode: "customEndpoint",
      model: "Qwen/Qwen3-27B",
      endpointHost: "GPU-box.internal:8000",
    });
    const otherServer = offer({
      id: "other",
      provider: "custom",
      authMode: "customEndpoint",
      model: "Qwen/Qwen3-27B",
      endpointHost: "other-box.internal:8000",
    });
    const mine = held({
      provider: "custom",
      authMode: "customEndpoint",
      model: "qwen3",
      customEndpointModelId: "qwen/qwen3-27b",
      customEndpointHost: "gpu-box.internal:8000",
    });
    assert.deepEqual(
      offersNotHeld([sameServer, otherServer], [mine]).map((entry) => entry.id),
      ["other"],
    );
  });

  test("offers everything to an employee with no models", () => {
    assert.equal(offersNotHeld([offer({})], []).length, 1);
  });
});
