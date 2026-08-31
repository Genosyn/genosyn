import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_SURFACE_PROVIDER_IDS,
  isChatSurfaceProvider,
  truncateForSurface,
} from "./types.js";

/**
 * The contract's own small behaviours.
 *
 * `truncateForSurface` looks trivial and is not: every surface caps message
 * length, each cap is different, and a reply cut one character over the line
 * is rejected by the platform rather than shortened by it.
 */

describe("truncateForSurface", () => {
  test("leaves a short reply alone, minus surrounding whitespace", () => {
    assert.equal(truncateForSurface("  hello  ", 100), "hello");
  });

  test("substitutes a placeholder rather than sending nothing", () => {
    assert.equal(truncateForSurface("", 100), "(no reply)");
    assert.equal(truncateForSurface("   \n  ", 100), "(no reply)");
  });

  test("never exceeds the cap, and says it truncated", () => {
    const long = "x".repeat(500);
    const out = truncateForSurface(long, 100);
    assert.ok(out.length <= 100, `got ${out.length}`);
    assert.match(out, /truncated/);
  });

  test("a reply exactly at the cap is untouched", () => {
    const exact = "y".repeat(64);
    assert.equal(truncateForSurface(exact, 64), exact);
  });

  test("one character over the cap is truncated", () => {
    const over = "y".repeat(65);
    const out = truncateForSurface(over, 64);
    assert.notEqual(out, over);
    assert.ok(out.length <= 64);
  });

  test("survives a cap smaller than the truncation notice itself", () => {
    const out = truncateForSurface("hello world", 4);
    assert.ok(out.length <= 4 + "\n\n…(truncated)".length);
    assert.ok(typeof out === "string" && out.length > 0);
  });

  test("counts characters, not bytes, so multibyte text is not mangled at the cap", () => {
    const emoji = "🙂".repeat(50);
    const out = truncateForSurface(emoji, 20);
    assert.ok(out.length <= 20);
  });
});

describe("provider ids", () => {
  test("the four shipped surfaces are the four registered ids", () => {
    assert.deepEqual([...CHAT_SURFACE_PROVIDER_IDS].sort(), [
      "microsoft-teams",
      "slack",
      "telegram",
      "whatsapp",
    ]);
  });

  test("the guard accepts exactly those and nothing else", () => {
    for (const id of CHAT_SURFACE_PROVIDER_IDS) {
      assert.equal(isChatSurfaceProvider(id), true);
    }
    for (const id of ["discord", "teams", "Slack", "", "stripe"]) {
      assert.equal(isChatSurfaceProvider(id), false, `${id} must not pass`);
    }
  });

  test("'teams' alone is not a provider id — Team is the org-chart entity", () => {
    assert.equal(isChatSurfaceProvider("teams"), false);
    assert.ok(CHAT_SURFACE_PROVIDER_IDS.includes("microsoft-teams"));
  });
});
