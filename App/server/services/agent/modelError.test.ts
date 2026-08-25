import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIModel, Provider } from "../../db/entities/AIModel.js";
import { formatModelError } from "./modelError.js";

function model(provider: Provider, overrides: Partial<AIModel> = {}): AIModel {
  return {
    provider,
    model: provider === "custom" ? "qwen/local" : "model-id",
    authMode: provider === "custom" ? "customEndpoint" : "apikey",
    configJson: "{}",
    ...overrides,
  } as AIModel;
}

describe("formatModelError classification", () => {
  test("explains authentication failures without duplicating embedded metadata", () => {
    const out = formatModelError(model("openai"), {
      status: 401,
      code: "invalid_api_key",
      request_id: "req_123",
      message: "401 invalid_api_key",
    });
    assert.match(out, /^The selected AI Model rejected its credentials\./);
    assert.match(out, /Endpoint: api\.openai\.com/);
    assert.doesNotMatch(out, /HTTP status:/);
    assert.doesNotMatch(out, /^Code:/m);
    assert.match(out, /Request ID: req_123/);
    assert.match(out, /Replace the saved API key/);
  });

  test("recognizes rate limits by status and quota prose", () => {
    assert.match(
      formatModelError(model("anthropic"), { status: 429, message: "slow down" }),
      /rate-limited or out of quota/,
    );
    assert.match(
      formatModelError(model("anthropic"), new Error("Account quota exhausted")),
      /rate-limited or out of quota/,
    );
  });

  test("gives subscription-specific authentication recovery without API-key advice", () => {
    const out = formatModelError(model("openai", { authMode: "subscription" }), {
      status: 401,
      message: "token expired",
    });
    assert.match(out, /Endpoint: OpenAI Codex subscription/);
    assert.match(out, /Reconnect the ChatGPT subscription/);
    assert.match(out, /Codex access/);
    assert.doesNotMatch(out, /Replace the saved API key/);
  });

  test("recognizes timeouts by status, name, and message", () => {
    const gateway = formatModelError(model("openai"), { statusCode: 504, message: "gateway" });
    assert.match(gateway, /did not respond in time/);
    assert.match(gateway, /retries an unanswered turn ten times with backoff/);
    assert.match(
      formatModelError(model("openai"), { name: "AbortError", message: "cancelled" }),
      /did not respond in time/,
    );

    const subscription = formatModelError(model("openai", { authMode: "subscription" }), {
      statusCode: 504,
      message: "gateway",
    });
    assert.match(subscription, /Codex app-server manages retries/);
    assert.doesNotMatch(subscription, /Genosyn retries an unanswered turn/);
  });

  test("recognizes context-window failures before treating them as generic requests", () => {
    const out = formatModelError(model("anthropic"), {
      status: 400,
      message: "Maximum context length exceeded: too many tokens",
    });
    assert.match(out, /rejected an over-long prompt/);
    assert.match(out, /Set the model’s context window accurately/);
  });

  test("does not offer unavailable context controls or Genosyn retries for subscriptions", () => {
    const subscription = model("openai", { authMode: "subscription" });
    const context = formatModelError(subscription, {
      status: 400,
      message: "Maximum context length exceeded",
    });
    assert.match(context, /Codex manages the subscription model’s context budget/);
    assert.doesNotMatch(context, /Set the model’s context window/);

    const provider = formatModelError(subscription, {
      status: 503,
      message: "service unavailable",
    });
    assert.match(provider, /Codex app-server manages retries/);
    assert.doesNotMatch(provider, /Genosyn retries transient failures/);
  });

  test("finds a network code through a bounded cause chain", () => {
    const out = formatModelError(model("custom"), {
      message: "fetch failed",
      cause: { cause: { code: "ECONNREFUSED" } },
    });
    assert.match(out, /Couldn’t reach the selected AI Model/);
    assert.match(out, /Code: ECONNREFUSED/);
    assert.match(out, /host\.docker\.internal/);
  });

  test("distinguishes missing models, provider failures, and rejected requests", () => {
    assert.match(
      formatModelError(model("openai"), { status: 404, message: "missing" }),
      /AI Model or endpoint was not found/,
    );
    assert.match(
      formatModelError(model("openai"), { status: 503, message: "unavailable" }),
      /service failed this request/,
    );
    assert.match(
      formatModelError(model("openai"), { status: 422, message: "bad field" }),
      /rejected this request/,
    );
  });
});

describe("formatModelError output safety", () => {
  test("uses only the saved host preview for a custom endpoint", () => {
    const out = formatModelError(
      model("custom", {
        configJson: JSON.stringify({
          baseURLPreview: "models.internal:11434",
          baseURLEncrypted: "secret-ciphertext",
        }),
      }),
      new Error("offline"),
    );
    assert.match(out, /Endpoint: models\.internal:11434/);
    assert.doesNotMatch(out, /secret-ciphertext/);
  });

  test("falls back safely when custom endpoint config is absent or malformed", () => {
    assert.match(
      formatModelError(model("custom", { configJson: "{" }), new Error("bad")),
      /Endpoint: custom endpoint \(host unavailable\)/,
    );
    assert.match(
      formatModelError(model("custom"), new Error("bad")),
      /Endpoint: custom endpoint \(host unavailable\)/,
    );
  });

  test("collapses line breaks and truncates hostile model metadata", () => {
    const out = formatModelError(model("openai", { model: `gpt\n${"x".repeat(300)}` }), {
      message: `first\nsecond ${"y".repeat(1_500)}`,
    });
    assert.doesNotMatch(out, /gpt\n/);
    assert.ok(out.includes("…"));
    assert.ok(out.split("\n").find((line) => line.startsWith("Details: "))!.length <= 1_010);
  });

  test("renders primitive and null errors without throwing", () => {
    assert.match(formatModelError(model("openai"), "plain failure"), /Details: plain failure/);
    assert.match(formatModelError(model("openai"), null), /Details: null/);
  });
});
