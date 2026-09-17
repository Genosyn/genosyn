import assert from "node:assert/strict";
import test from "node:test";
import { APIConnectionTimeoutError as OpenAITimeout } from "openai";
import { APIConnectionTimeoutError as AnthropicTimeout } from "@anthropic-ai/sdk";
import {
  isModelRequestTimeout,
  isRetryableModelError,
  MODEL_TIMEOUT_MAX_ATTEMPTS,
  MODEL_TURN_MAX_ATTEMPTS,
  modelRetryDelayMs,
  modelRetryReason,
  waitForModelRetry,
} from "./modelRetry.js";

test("retries transient HTTP statuses and fails permanent request errors immediately", () => {
  for (const status of [408, 409, 429, 500, 502, 503, 504]) {
    assert.equal(
      isRetryableModelError(Object.assign(new Error("provider error"), { status })),
      true,
    );
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(
      isRetryableModelError(Object.assign(new Error("request error"), { status })),
      false,
    );
  }
  assert.equal(MODEL_TURN_MAX_ATTEMPTS, 11);
});

test("recognizes transport failures through their nested cause", () => {
  const error = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
  });
  assert.equal(isRetryableModelError(error), true);
  assert.equal(modelRetryReason(error), "transport error ECONNRESET");
});

test("recognizes HTTP, SDK, native and nested model request timeouts", () => {
  const timeouts = [
    { status: 408, message: "Request timeout" },
    { statusCode: 504, message: "Gateway" },
    new OpenAITimeout(),
    new AnthropicTimeout(),
    new DOMException("The operation exceeded its deadline", "TimeoutError"),
    new Error("The model request timed out"),
    { code: "request_timeout", message: "The response failed" },
    new Error("The response failed", { cause: { code: "UND_ERR_BODY_TIMEOUT" } }),
    new Error("The response failed", {
      cause: new Error("socket failed", { cause: { code: "ETIMEDOUT" } }),
    }),
    "The model request timed out",
  ];
  for (const error of timeouts) {
    assert.equal(isModelRequestTimeout(error), true, String(error));
    assert.equal(isRetryableModelError(error), true, String(error));
  }
  assert.equal(modelRetryReason(new OpenAITimeout()), "model request timed out");
  assert.equal(modelRetryReason({ status: 504 }), "HTTP 504");
});

test("does not mistake cancellation or permanent request errors for retryable timeouts", () => {
  for (const error of [
    new DOMException("The operation was aborted", "AbortError"),
    { status: 400, message: "Invalid timeout parameter" },
    { statusCode: 401, message: "The authentication request timed out" },
  ]) {
    assert.equal(isModelRequestTimeout(error), false);
    assert.equal(isRetryableModelError(error), false);
  }
  assert.equal(isModelRequestTimeout({ status: 503, message: "Service unavailable" }), false);
});

test("bounds five timeout retries to the 1, 2, 4, 8 and 16 second backoff schedule", () => {
  assert.equal(MODEL_TIMEOUT_MAX_ATTEMPTS, 6);
  const waits = Array.from({ length: MODEL_TIMEOUT_MAX_ATTEMPTS - 1 }, (_, index) =>
    modelRetryDelayMs(new OpenAITimeout(), index + 1, { rng: () => 1 }),
  );
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("uses exponential jitter when the provider supplies no delay", () => {
  assert.equal(modelRetryDelayMs(new Error("network"), 1, { rng: () => 0 }), 750);
  assert.equal(modelRetryDelayMs(new Error("network"), 2, { rng: () => 1 }), 2_000);
  assert.equal(modelRetryDelayMs(new Error("network"), 5, { rng: () => 1 }), 16_000);
  assert.equal(modelRetryDelayMs(new Error("network"), 6, { rng: () => 1 }), 30_000);
  assert.equal(modelRetryDelayMs(new Error("network"), 10, { rng: () => 1 }), 30_000);
  assert.equal(modelRetryDelayMs(new Error("network"), 20, { rng: () => 0 }), 22_500);
});

test("keeps a full retry budget of waits inside the turn deadline", () => {
  let total = 0;
  for (let retry = 1; retry < MODEL_TURN_MAX_ATTEMPTS; retry += 1) {
    total += modelRetryDelayMs(new Error("network"), retry, { rng: () => 1 });
  }
  assert.equal(total, 181_000);
});

test("honors Retry-After seconds and date while capping an excessive wait", () => {
  const seconds = Object.assign(new Error("busy"), {
    status: 503,
    headers: new Headers({ "retry-after": "2.5" }),
  });
  assert.equal(modelRetryDelayMs(seconds, 1), 2_500);

  const nowMs = Date.parse("2026-07-25T12:00:00Z");
  const date = Object.assign(new Error("busy"), {
    status: 503,
    headers: new Headers({ "retry-after": "Sat, 25 Jul 2026 12:00:04 GMT" }),
  });
  assert.equal(modelRetryDelayMs(date, 1, { nowMs }), 4_000);

  const excessive = Object.assign(new Error("busy"), {
    status: 429,
    headers: new Headers({ "retry-after": "120" }),
  });
  assert.equal(modelRetryDelayMs(excessive, 1), 30_000);
});

test("an abort interrupts the retry wait", async () => {
  const controller = new AbortController();
  const waiting = waitForModelRetry(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
