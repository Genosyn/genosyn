import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDuration, formatRelative } from "./relative";

/**
 * The stack shows four timestamps per row and two of them are in the future
 * (an expiry, a scheduled run), so the past/future split is the part worth
 * pinning down — "-4h ago" on a deadline is the kind of thing that makes
 * people stop trusting the row.
 */

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

describe("formatRelative", () => {
  test("recent past reads as just now", () => {
    assert.equal(formatRelative(iso(-5_000)), "just now");
  });

  test("past minutes, hours and days each get their own unit", () => {
    assert.equal(formatRelative(iso(-5 * 60_000)), "5m ago");
    assert.equal(formatRelative(iso(-3 * 3_600_000)), "3h ago");
    assert.equal(formatRelative(iso(-2 * 86_400_000)), "2d ago");
  });

  test("a future time reads as future, never as a negative age", () => {
    assert.equal(formatRelative(iso(30 * 60_000)), "in 30m");
    assert.equal(formatRelative(iso(4 * 3_600_000)), "in 4h");
    assert.equal(formatRelative(iso(3 * 86_400_000)), "in 3d");
  });

  test("anything over a week falls back to a real date", () => {
    const out = formatRelative(iso(-30 * 86_400_000));
    assert.ok(!out.includes("ago"), out);
    assert.ok(/\d/.test(out), out);
  });
});

describe("formatDuration", () => {
  test("sub-minute sessions do not round down to zero", () => {
    assert.equal(formatDuration(iso(0), iso(20_000)), "under a minute");
  });

  test("minutes and hours read the way a human would say them", () => {
    assert.equal(formatDuration(iso(0), iso(7 * 60_000)), "7m");
    assert.equal(formatDuration(iso(0), iso(72 * 60_000)), "1h 12m");
    assert.equal(formatDuration(iso(0), iso(120 * 60_000)), "2h");
  });

  test("a finish before its start is refused rather than rendered backwards", () => {
    assert.equal(formatDuration(iso(0), iso(-60_000)), null);
  });
});
