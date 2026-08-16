import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CONTEXT_WARN_PCT,
  contextUsage,
  contextUsagePercent,
  isContextUsageHigh,
} from "./contextUsage.js";

describe("context usage percentage", () => {
  test("reports the prompt's share of the window, rounded", () => {
    assert.equal(contextUsagePercent(100_000, 200_000), 50);
    assert.equal(contextUsagePercent(1, 200_000), 0);
    assert.equal(contextUsagePercent(200_000, 200_000), 100);
    // 0.4995 -> 49.95% -> 50, so rounding is half-up on the percentage itself
    // rather than on the ratio.
    assert.equal(contextUsagePercent(99_900, 200_000), 50);
    assert.equal(contextUsagePercent(85_000, 128_000), 66);
  });

  test("returns null for every shape of unknown window", () => {
    assert.equal(contextUsagePercent(50_000, null), null);
    assert.equal(contextUsagePercent(50_000, 0), null);
    assert.equal(contextUsagePercent(50_000, -1), null);
    assert.equal(contextUsagePercent(50_000, Number.NaN), null);
    assert.equal(contextUsagePercent(50_000, Number.POSITIVE_INFINITY), null);
  });

  test("returns null for a prompt count we cannot trust", () => {
    assert.equal(contextUsagePercent(Number.NaN, 200_000), null);
    assert.equal(contextUsagePercent(Number.POSITIVE_INFINITY, 200_000), null);
    assert.equal(contextUsagePercent(-1, 200_000), null);
  });

  test("a zero-token prompt is zero, not unknown", () => {
    assert.equal(contextUsagePercent(0, 200_000), 0);
  });

  test("does not clamp above 100 — a window set too low is real", () => {
    // Someone typed 8000 into the manual field for a 200k model. Reporting
    // "100%" would hide the misconfiguration behind a plausible number.
    assert.equal(contextUsagePercent(16_000, 8_000), 200);
  });
});

describe("context usage bundle", () => {
  test("carries the provider count alongside the window it fits inside", () => {
    assert.deepEqual(contextUsage(120_000, 200_000), {
      promptTokens: 120_000,
      contextWindow: 200_000,
      percent: 60,
    });
  });

  test("normalizes an unusable window to null so no surface has to re-check", () => {
    assert.deepEqual(contextUsage(120_000, null), {
      promptTokens: 120_000,
      contextWindow: null,
      percent: null,
    });
    assert.deepEqual(contextUsage(120_000, 0), {
      promptTokens: 120_000,
      contextWindow: null,
      percent: null,
    });
  });

  test("keeps the token count even when the window is unknown", () => {
    // The OpenAI subscription case: never a percentage, always a token count.
    const usage = contextUsage(142_311, null);
    assert.equal(usage.promptTokens, 142_311);
    assert.equal(usage.percent, null);
  });
});

describe("high context warning", () => {
  test("fires at the shared threshold and not below it", () => {
    assert.equal(isContextUsageHigh(CONTEXT_WARN_PCT - 1), false);
    assert.equal(isContextUsageHigh(CONTEXT_WARN_PCT), true);
    assert.equal(isContextUsageHigh(CONTEXT_WARN_PCT + 1), true);
  });

  test("an unknown share is never high", () => {
    assert.equal(isContextUsageHigh(null), false);
  });

  test("warns before the loop starts compacting", () => {
    // contextBudget reserves 15% of the window for the reply, so compaction
    // begins around 85%. The warning has to land under that or it would only
    // ever appear alongside the history loss it is supposed to precede.
    assert.ok(CONTEXT_WARN_PCT < 85);
  });
});
