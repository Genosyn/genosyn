import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableModelError,
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
  assert.equal(MODEL_TURN_MAX_ATTEMPTS, 5);
});

test("recognizes transport failures through their nested cause", () => {
  const error = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
  });
  assert.equal(isRetryableModelError(error), true);
  assert.equal(modelRetryReason(error), "transport error ECONNRESET");
});

test("uses exponential jitter when the provider supplies no delay", () => {
  assert.equal(modelRetryDelayMs(new Error("network"), 1, { rng: () => 0 }), 750);
  assert.equal(modelRetryDelayMs(new Error("network"), 2, { rng: () => 1 }), 2_000);
  assert.equal(modelRetryDelayMs(new Error("network"), 9, { rng: () => 1 }), 8_000);
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
