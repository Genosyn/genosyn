import assert from "node:assert/strict";
import test from "node:test";
import {
  ORPHAN_GRACE_MS,
  RETRY_MAX_BACKOFF_MS,
  backoffDelayMs,
  countMissedSlots,
  isRunOrphaned,
  isSlotStale,
  shouldRetry,
} from "./cronMath.js";

const HOURLY = "0 * * * *";
const at = (iso: string): Date => new Date(iso);

test("counts no missed slots when the window is empty or inverted", () => {
  assert.deepEqual(countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T10:00:00Z"), 100), {
    count: 0,
    capped: false,
  });
  assert.deepEqual(countMissedSlots(HOURLY, at("2026-01-01T12:00:00Z"), at("2026-01-01T10:00:00Z"), 100), {
    count: 0,
    capped: false,
  });
});

test("counts occurrences strictly after the due slot and up to now", () => {
  // 10:00 is the slot being served, so it isn't counted; 30 minutes later
  // nothing else has come due.
  assert.deepEqual(countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T10:30:00Z"), 100), {
    count: 0,
    capped: false,
  });
  // 11:00 through 15:00 elapsed while we were down.
  assert.deepEqual(countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T15:01:00Z"), 100), {
    count: 5,
    capped: false,
  });
  // A slot landing exactly on `until` is included.
  assert.deepEqual(countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T11:00:00Z"), 100), {
    count: 1,
    capped: false,
  });
});

test("caps the missed-slot count instead of enumerating a week of minutes", () => {
  const res = countMissedSlots("* * * * *", at("2026-01-01T00:00:00Z"), at("2026-01-02T00:00:00Z"), 100);
  assert.equal(res.count, 100);
  assert.equal(res.capped, true);
});

test("treats an unschedulable expression as zero missed slots, not a throw", () => {
  // node-cron's validate() accepts this, so routines.ts used to let it through;
  // cron-parser throws on it. The heartbeat must not die on that.
  assert.deepEqual(countMissedSlots("5-1 9 * * *", at("2026-01-01T00:00:00Z"), at("2026-01-02T00:00:00Z"), 100), {
    count: 0,
    capped: false,
  });
});

test("only calls a slot stale once it is past the grace window", () => {
  const slot = at("2026-01-01T10:00:00Z");
  assert.equal(isSlotStale(slot, at("2026-01-01T10:00:10Z")), false);
  assert.equal(isSlotStale(slot, at("2026-01-01T13:00:00Z")), true);
  // Exactly at the boundary is not stale — the comparison is strict.
  assert.equal(isSlotStale(slot, at("2026-01-01T10:01:00Z")), false);
  assert.equal(isSlotStale(slot, at("2026-01-01T09:00:00Z")), false);
});

test("only calls a run orphaned once it outlived its own timeout plus grace", () => {
  const started = at("2026-01-01T10:00:00Z");
  assert.equal(isRunOrphaned(started, 3600, at("2026-01-01T10:00:01Z")), false);
  assert.equal(isRunOrphaned(started, 60, at("2026-01-01T12:00:00Z")), true);
  const boundary = new Date(started.getTime() + 60_000 + ORPHAN_GRACE_MS);
  assert.equal(isRunOrphaned(started, 60, boundary), false);
  assert.equal(isRunOrphaned(started, 60, new Date(boundary.getTime() + 1)), true);
});

test("clamps a nonsensical timeout rather than declaring a fresh run dead", () => {
  const started = at("2026-01-01T10:00:00Z");
  assert.equal(isRunOrphaned(started, 0, at("2026-01-01T10:00:30Z")), false);
  assert.equal(isRunOrphaned(started, -5, at("2026-01-01T10:00:30Z")), false);
  // Clock skew: a startedAt in the future is not evidence of a crash.
  assert.equal(isRunOrphaned(at("2026-01-01T12:00:00Z"), 60, at("2026-01-01T10:00:00Z")), false);
});

test("doubles the backoff ceiling on each attempt", () => {
  const top = { baseMs: 1000, rng: () => 1 };
  assert.equal(backoffDelayMs(1, top), 1000);
  assert.equal(backoffDelayMs(2, top), 2000);
  assert.equal(backoffDelayMs(3, top), 4000);
  assert.equal(backoffDelayMs(4, top), 8000);
});

test("jitters the whole band, so the low end is zero", () => {
  const bottom = { baseMs: 1000, rng: () => 0 };
  for (const attempt of [1, 2, 3, 10]) assert.equal(backoffDelayMs(attempt, bottom), 0);
});

test("caps the backoff and stays capped for every higher attempt", () => {
  const opts = { baseMs: 1000, maxMs: 5000, rng: () => 1 };
  assert.equal(backoffDelayMs(3, opts), 4000);
  assert.equal(backoffDelayMs(4, opts), 5000);
  assert.equal(backoffDelayMs(50, opts), 5000);
});

test("stays finite at absurd attempt numbers", () => {
  // The exponent is clamped before the `**`; without that, 2 ** 1000 is
  // Infinity and the delay becomes NaN.
  const delay = backoffDelayMs(1000, { baseMs: 1000, rng: () => 1 });
  assert.equal(Number.isFinite(delay), true);
  assert.equal(delay <= RETRY_MAX_BACKOFF_MS, true);
  assert.equal(Number.isInteger(delay), true);
});

test("treats a zero or negative attempt as the first tier", () => {
  const top = { baseMs: 1000, rng: () => 1 };
  assert.equal(backoffDelayMs(0, top), 1000);
  assert.equal(backoffDelayMs(-3, top), 1000);
});

const base = {
  triggerKind: "schedule" as const,
  attempt: 1,
  maxAttempts: 3,
  retryOnTimeout: false,
};

test("never retries on the default settings", () => {
  // The load-bearing assertion for the upgrade: an install nobody has touched
  // behaves exactly as it did before retries existed.
  for (const status of ["running", "completed", "failed", "skipped", "timeout", "interrupted"] as const) {
    assert.equal(shouldRetry({ ...base, status, maxAttempts: 1 }), false);
  }
});

test("retries failed and interrupted runs, but not clean or skipped ones", () => {
  assert.equal(shouldRetry({ ...base, status: "failed" }), true);
  assert.equal(shouldRetry({ ...base, status: "interrupted" }), true);
  assert.equal(shouldRetry({ ...base, status: "completed" }), false);
  assert.equal(shouldRetry({ ...base, status: "skipped" }), false);
  assert.equal(shouldRetry({ ...base, status: "running" }), false);
});

test("gates timeout retries on their own flag", () => {
  assert.equal(shouldRetry({ ...base, status: "timeout" }), false);
  assert.equal(shouldRetry({ ...base, status: "timeout", retryOnTimeout: true }), true);
});

test("stops once the attempt budget is spent", () => {
  assert.equal(shouldRetry({ ...base, status: "failed", attempt: 2 }), true);
  assert.equal(shouldRetry({ ...base, status: "failed", attempt: 3 }), false);
  assert.equal(shouldRetry({ ...base, status: "failed", attempt: 4 }), false);
});

test("leaves human- and caller-triggered runs alone", () => {
  for (const triggerKind of ["manual", "webhook", "approval"] as const) {
    assert.equal(shouldRetry({ ...base, status: "failed", triggerKind }), false);
  }
  // A retry may itself be retried, up to the budget.
  assert.equal(shouldRetry({ ...base, status: "failed", triggerKind: "retry" }), true);
});
