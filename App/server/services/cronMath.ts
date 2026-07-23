import parser from "cron-parser";
import type { RunStatus, RunTrigger } from "../db/entities/Run.js";

/**
 * Pure scheduling arithmetic for downtime recovery and retries.
 *
 * These five functions are the entire decision logic behind "the server was
 * off — what now?": how many occurrences we missed, whether a stale slot is
 * still worth serving, whether a `running` row is crash debris, how long to
 * wait before another attempt, and whether another attempt is owed at all.
 * They live apart from `services/cron.ts` so they can be unit-tested without a
 * database, following the seam `nextRunFor()` already set by taking an explicit
 * `from: Date` instead of reading the clock. Nothing here may import
 * `cron.ts` — `cron.ts` imports this.
 */

/**
 * Grace added on top of a routine's own `timeoutSec` before a still-`running`
 * Run counts as crash debris. The runner aborts a run at its timeout, so a row
 * older than `timeoutSec + this` cannot legitimately still be executing —
 * either the process died or the row was orphaned by a restart.
 *
 * `services/cron.ts` imports this for its overlap guard rather than declaring
 * its own copy: the reconciler and the guard MUST agree about when a run is
 * dead, or one will resurrect the schedule while the other still blocks it.
 */
export const ORPHAN_GRACE_MS = 60 * 1000;

/**
 * How late a due slot has to be before the `"skip"` catch-up policy drops it.
 * Twice the heartbeat interval, so an ordinary on-time tick is never mistaken
 * for a catch-up.
 */
export const STALE_SLOT_MS = 60 * 1000;

/** Ceiling on any single retry delay, whatever the attempt or backoff base. */
export const RETRY_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * How many scheduled occurrences elapsed strictly after `after` and at or
 * before `until` — i.e. how much work a catch-up run is standing in for.
 *
 * Bounded by `cap` so a `* * * * *` routine that was down for a week cannot
 * materialize ten thousand Dates just to produce a number nobody reads past
 * "lots". Returns `{ count: 0, capped: false }` on an unparseable expression,
 * matching how `nextRunFor()` swallows parse errors rather than throwing into
 * the heartbeat.
 */
export function countMissedSlots(
  cronExpr: string,
  after: Date,
  until: Date,
  cap: number,
): { count: number; capped: boolean } {
  if (until.getTime() <= after.getTime() || cap <= 0) return { count: 0, capped: false };
  try {
    const it = parser.parseExpression(cronExpr, { currentDate: after, endDate: until });
    let count = 0;
    while (count < cap && it.hasNext()) {
      it.next();
      count += 1;
    }
    return { count, capped: count === cap };
  } catch {
    return { count: 0, capped: false };
  }
}

/**
 * True when a due slot is more than `staleMs` old — the test the `"skip"`
 * catch-up policy applies before deciding a run is no longer worth firing.
 */
export function isSlotStale(dueSlot: Date, now: Date, staleMs: number = STALE_SLOT_MS): boolean {
  return now.getTime() - dueSlot.getTime() > staleMs;
}

/**
 * True when a still-`running` Run row can only be crash debris.
 *
 * Lifted from the scheduler's overlap guard so the crash path is finally
 * testable, and so both places share one definition of "dead". A run cannot
 * outlive its own timeout — the runner aborts it — so anything past
 * `timeoutSec + graceMs` was orphaned. The `Math.max(1, …)` clamp guards a
 * zero or negative `timeoutSec`; a `startedAt` in the future (clock skew)
 * reads as not-orphaned rather than instantly dead.
 */
export function isRunOrphaned(
  startedAt: Date,
  timeoutSec: number,
  now: Date,
  graceMs: number = ORPHAN_GRACE_MS,
): boolean {
  return startedAt.getTime() + Math.max(1, timeoutSec) * 1000 + graceMs < now.getTime();
}

/**
 * Full-jitter exponential backoff. `attempt` is 1-based and names the attempt
 * that just failed, so attempt 1 yields the delay before the first retry.
 *
 * `rng` is injected rather than calling `Math.random()` internally — otherwise
 * the jitter makes this untestable. The exponent is clamped before the `**`,
 * not after: `2 ** attempt` overflows past `Number.MAX_SAFE_INTEGER` long
 * before a naive `Math.min()` on the product could bite.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs: number; maxMs?: number; rng?: () => number },
): number {
  const exp = Math.min(Math.max(0, Math.floor(attempt) - 1), 30);
  const ceiling = Math.min(
    opts.maxMs ?? RETRY_MAX_BACKOFF_MS,
    Math.max(0, opts.baseMs) * 2 ** exp,
  );
  const rng = opts.rng ?? Math.random;
  return Math.max(0, Math.floor(rng() * ceiling));
}

/**
 * The single authority on whether another attempt is owed.
 *
 * Deliberately excludes `manual`, `webhook` and `approval` triggers: someone
 * was present and saw the outcome, so a background respawn would surprise
 * them. `timeout` is gated separately because retrying one re-burns the whole
 * time budget — up to six hours of model spend.
 */
export function shouldRetry(a: {
  status: RunStatus;
  triggerKind: RunTrigger;
  attempt: number;
  maxAttempts: number;
  retryOnTimeout: boolean;
}): boolean {
  if (a.maxAttempts <= 1 || a.attempt >= a.maxAttempts) return false;
  if (a.triggerKind !== "schedule" && a.triggerKind !== "retry") return false;
  if (a.status === "failed" || a.status === "interrupted") return true;
  if (a.status === "timeout") return a.retryOnTimeout;
  return false;
}
