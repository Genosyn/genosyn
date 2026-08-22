import parser from "cron-parser";
import { IsNull, LessThanOrEqual, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { startRoutineRun, type StartRunOptions } from "./runner.js";
import { notifyApprovalPending } from "./notifications.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import {
  claimRetryDispatch,
  findDueRetries,
  reconcileOrphanedRuns,
  settleRetryDispatchClaim,
} from "./runRecovery.js";
import {
  ORPHAN_GRACE_MS,
  STALE_SLOT_MS,
  automaticRetryLimit,
  countMissedSlots,
  isSlotStale,
  shouldRetry,
} from "./cronMath.js";
import { dispatchDueFollowUpReminders } from "./revenue/followUpReminders.js";
import {
  dispatchDueTldrs,
  reconcileStaleTldrs,
  resetTldrSchedulesAfterRestore,
  sweepTldrSchedules,
} from "./tldrs.js";
import { releaseInterruptedTldrQuestionActions } from "./tldrQuestionActions.js";
import {
  retireStaleStandingClaims,
  sweepPendingStandingQuestions,
} from "./tldrStandingQuestions.js";

/**
 * Heartbeat-based routine scheduler.
 *
 * Instead of holding one in-memory `node-cron` timer per routine, we persist
 * the next due time on each `Routine` row (`nextRunAt`) and poll every
 * {@link HEARTBEAT_INTERVAL_MS}. Each pass runs three ordered phases:
 *
 *   1. **Reconcile** — clear crash debris (see `services/runRecovery.ts`).
 *   2. **Schedule** — advance and fire due routines, oldest slot first.
 *   3. **Retry** — start attempts that earlier failures scheduled.
 *
 * Catch-up after downtime is **fire-at-most-once**: if the server was down
 * across many scheduled ticks, the routine fires once on the next heartbeat
 * (not N times). This is implemented by advancing `nextRunAt` from *now*
 * rather than from the stale `nextRunAt`, so we skip past all missed slots.
 * How many slots that skipped is counted onto the catch-up Run
 * (`Run.missedSlots`), and a routine set to `catchUpPolicy: "skip"` declines
 * the catch-up entirely rather than doing yesterday's work today.
 */

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;
/**
 * Set by {@link bootCron} so the first pass of a fresh process (and the pass
 * after a backup restore) knows it may treat every `running` row as debris on
 * sqlite, where this process is the only thing that could have written one.
 */
let pendingBootReconcile = true;

/**
 * Ceiling on scheduled runs dispatched per pass, oldest slot first. A restart
 * with a large overdue set drains at roughly this rate per heartbeat instead
 * of firing every routine in the same millisecond; undispatched rows keep
 * their stale `nextRunAt` and are picked up next pass.
 */
const MAX_DISPATCH_PER_TICK = 10;

/** Ceiling on retries per pass, separate so neither phase can starve the other. */
const MAX_RETRIES_PER_TICK = 5;

/** How far out to push a retry after a setup failure or overlap. */
const BUSY_RETRY_MS = 60 * 1000;

/**
 * Bound on slot enumeration for the missed-occurrence count. The number is
 * only ever a record, so a saturated count reads as "1000+" and costs nothing.
 */
const MISSED_SLOT_CAP = 1000;

/**
 * Compute the next scheduled fire time for a cron expression, or null if the
 * expression is invalid. `from` defaults to now; callers pass a specific
 * moment when they want "next after this run" semantics.
 */
export function nextRunFor(cronExpr: string, from: Date = new Date()): Date | null {
  try {
    const interval = parser.parseExpression(cronExpr, { currentDate: from });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Mutate a routine's `nextRunAt` based on its current cron/enabled state.
 * Callers save the row afterward. When disabled or when the expression is
 * unparseable we clear `nextRunAt` so the heartbeat ignores the row.
 */
export function registerRoutine(routine: Routine): void {
  if (!routine.enabled) {
    routine.nextRunAt = null;
    return;
  }
  routine.nextRunAt = nextRunFor(routine.cronExpr);
}

/**
 * Return a recent Run that still owns this routine's execution window.
 * Reconciliation and this guard share the same timeout-plus-grace boundary,
 * so a row is never simultaneously considered live here and crash debris
 * there.
 */
async function findInFlightRun(routine: Routine, now: Date = new Date()): Promise<Run | null> {
  const inFlightSince = new Date(
    now.getTime() - (Math.max(1, routine.timeoutSec) * 1000 + ORPHAN_GRACE_MS),
  );
  return AppDataSource.getRepository(Run).findOne({
    where: {
      routineId: routine.id,
      status: "running",
      startedAt: MoreThan(inFlightSince),
    },
  });
}

async function tickRoutine(routineId: string, meta: { missedSlots: number }): Promise<void> {
  // Re-fetch each tick so edits (including flipping requiresApproval or
  // disabling the routine) take effect without restarting the process.
  const repo = AppDataSource.getRepository(Routine);
  const fresh = await repo.findOneBy({ id: routineId });
  if (!fresh || !fresh.enabled) return;
  if (fresh.requiresApproval) {
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: fresh.employeeId,
    });
    if (!emp) return;
    const approvalRepo = AppDataSource.getRepository(Approval);
    const pending = approvalRepo.create({
      companyId: emp.companyId,
      routineId: fresh.id,
      employeeId: emp.id,
      status: "pending",
    });
    await approvalRepo.save(pending);
    void notifyApprovalPending(pending).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[cron] notify approval pending failed:", e);
    });
    await AppDataSource.getRepository(JournalEntry).save(
      AppDataSource.getRepository(JournalEntry).create({
        employeeId: emp.id,
        kind: "system",
        title: `Approval requested for routine "${fresh.name}"`,
        body: "Cron tick was gated; waiting for a human to approve or reject.",
        routineId: fresh.id,
        runId: null,
        authorUserId: null,
      }),
    );
    return;
  }
  // Overlap guard: don't stack a second scheduled run on top of one that's
  // still executing — each spawn holds an AI license / API quota. Bounded by
  // the routine's own timeout (plus grace) so a run orphaned by a crash can't
  // block the schedule forever. Manual "Run now" / webhooks bypass this on
  // purpose: a human (or external caller) explicitly asked for that run.
  const inFlight = await findInFlightRun(fresh);
  if (inFlight) {
    // eslint-disable-next-line no-console
    console.log(
      `[cron] routine "${fresh.name}" (${fresh.id}) skipped — run ${inFlight.id} still in flight`,
    );
    return;
  }
  const { completion } = await startRoutineRun(fresh, {
    triggerKind: "schedule",
    missedSlots: meta.missedSlots,
  });
  // The heartbeat only waits until the durable Run row exists. The agent work
  // continues independently, just as it did when this whole function was
  // detached, but the retry phase below can now see the row and avoid overlap.
  void completion.catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[cron] routine ${fresh.id} failed after starting:`, err);
  });
}

function onDispatchError(routineId: string) {
  return (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[cron] routine ${routineId} failed:`, err);
  };
}

/**
 * A retry that fails before its child Run exists must not consume an attempt.
 * Re-stamp the parent's `retryAt` so a transient capacity or setup failure is
 * retried without turning into a tight heartbeat loop.
 */
function onRetryError(parentRunId: string, routineId: string, claim: Date) {
  return async (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[cron] retry of run ${parentRunId} failed:`, err);
    await settleRetryDispatchClaim(
      parentRunId,
      routineId,
      claim,
      new Date(Date.now() + BUSY_RETRY_MS),
    );
  };
}

/**
 * The only durable record that a `"skip"` routine declined a catch-up — no Run
 * row is created, so without this the missed work is invisible.
 */
async function journalSkippedCatchUp(
  routine: Routine,
  slot: Date,
  total: number,
  capped: boolean,
): Promise<void> {
  const repo = AppDataSource.getRepository(JournalEntry);
  await repo.save(
    repo.create({
      employeeId: routine.employeeId,
      kind: "system",
      title: `Skipped ${capped ? `${total}+` : total} missed occurrence${total === 1 ? "" : "s"} of "${routine.name}"`,
      body:
        `The server was unavailable from ${slot.toISOString()} and this routine's catch-up ` +
        "policy is Skip, so no catch-up run was started. The next run happens on schedule.",
      routineId: routine.id,
      runId: null,
      authorUserId: null,
    }),
  );
}

export type RetryDispatchResult = {
  started: number;
  /** Exposed so service tests can let detached no-model Runs settle cleanly. */
  completions: Array<Promise<Run>>;
};

/** A retry became ineligible while its start prerequisites were resolving. */
class RetryDispatchIneligibleError extends Error {}

function isRetryDispatchEligible(parent: Run, routine: Routine): boolean {
  return (
    routine.enabled &&
    !routine.requiresApproval &&
    shouldRetry({
      status: parent.status,
      triggerKind: parent.triggerKind,
      attempt: parent.attempt,
      maxAttempts: routine.maxAttempts,
      retryOnTimeout: routine.retryOnTimeout,
    })
  );
}

/**
 * Start the retry attempts whose durable `retryAt` stamps are due.
 *
 * The scheduler lease around the caller serializes this across replicas. An
 * atomic, expiring claim makes cancellation and dispatch deterministic and
 * stops concurrent schedulers from starting the same parent. A child lookup
 * closes the process-crash window: once a retry Run row exists, a stale claim
 * is cleared instead of dispatching that attempt twice. The claim is settled
 * only after child creation, favoring at-least-once recovery over silent loss.
 */
export async function dispatchDueRetries(now: Date): Promise<RetryDispatchResult> {
  const routineRepo = AppDataSource.getRepository(Routine);
  const runRepo = AppDataSource.getRepository(Run);
  const completions: Array<Promise<Run>> = [];
  let started = 0;

  for (const queuedParent of await findDueRetries(now, MAX_RETRIES_PER_TICK)) {
    // Re-read after the queue scan so a member cancelling a retry does not
    // lose a race to stale scheduler state.
    const parent = await runRepo.findOneBy({ id: queuedParent.id });
    if (
      !parent?.retryAt ||
      !queuedParent.retryAt ||
      parent.retryAt > now ||
      parent.retryAt.getTime() !== queuedParent.retryAt.getTime()
    ) {
      continue;
    }
    const initialClaim = await claimRetryDispatch(parent.id, queuedParent.retryAt);
    if (!initialClaim) continue;
    let claim = initialClaim;

    const routine = await routineRepo.findOneBy({ id: parent.routineId });
    if (!routine || !isRetryDispatchEligible(parent, routine)) {
      await settleRetryDispatchClaim(parent.id, parent.routineId, claim, null);
      continue;
    }

    // A child row proves this retry was already dispatched. This closes the
    // crash window between creating the child and clearing retryAt.
    const existingChild = await runRepo.findOneBy({ parentRunId: parent.id });
    if (existingChild) {
      await settleRetryDispatchClaim(parent.id, parent.routineId, claim, null);
      continue;
    }

    // A one-hour recovery commonly lands near the routine's next natural
    // hourly slot. Let the current Run finish before starting another copy.
    if (await findInFlightRun(routine, now)) {
      await settleRetryDispatchClaim(
        parent.id,
        parent.routineId,
        claim,
        new Date(now.getTime() + BUSY_RETRY_MS),
      );
      continue;
    }

    let completion: Promise<Run>;
    try {
      const startOptions: StartRunOptions = {
        triggerKind: "retry",
        attempt: parent.attempt + 1,
        attemptLimit: automaticRetryLimit(parent.status, routine.maxAttempts),
        parentRunId: parent.id,
        missedSlots: 0,
      };
      startOptions.beforeRunPersist = async () => {
        // Renew and verify ownership after setup, so a scheduler that
        // resumed after its claim expired cannot start work behind a newer
        // dispatcher.
        const renewed = await claimRetryDispatch(parent.id, claim);
        if (!renewed) throw new Error("Retry dispatch claim was lost before child creation");
        claim = renewed;

        // Setup happens before the child row is inserted. Re-read the
        // Routine after renewing the claim, at the last safe point before
        // persistence, so a pause, approval gate, or deletion that landed
        // during preparation cannot be bypassed by the stale object this
        // dispatch started with.
        const currentRoutine = await routineRepo.findOneBy({ id: routine.id });
        if (!currentRoutine || !isRetryDispatchEligible(parent, currentRoutine)) {
          throw new RetryDispatchIneligibleError(
            "Routine became ineligible before retry child creation",
          );
        }

        // The child owns the current reliability policy from this point on.
        // Keep both its transcript ceiling and any later retry stamp aligned
        // with settings changed while preparation was in progress.
        routine.maxAttempts = currentRoutine.maxAttempts;
        routine.retryBackoffSec = currentRoutine.retryBackoffSec;
        routine.retryOnTimeout = currentRoutine.retryOnTimeout;
        startOptions.attemptLimit = automaticRetryLimit(parent.status, currentRoutine.maxAttempts);
      };
      ({ completion } = await startRoutineRun(routine, startOptions));
    } catch (err) {
      // `startRoutineRun` persists its child before flushing the framing log.
      // If setup failed after that insert, the child owns the attempt and the
      // parent must not be re-armed. Its terminal cleanup schedules any later
      // configured attempt on the child itself.
      const durableChild = await runRepo.findOneBy({ parentRunId: parent.id });
      if (durableChild) {
        await settleRetryDispatchClaim(parent.id, parent.routineId, claim, null);
      } else if (err instanceof RetryDispatchIneligibleError) {
        await settleRetryDispatchClaim(parent.id, parent.routineId, claim, null);
      } else {
        await onRetryError(parent.id, parent.routineId, claim)(err);
      }
      continue;
    }

    completions.push(completion);
    started += 1;
    void completion.catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[cron] retry of run ${parent.id} failed after starting:`, err);
    });
    // Clear only after the child Run is durable. If the process dies first,
    // the claim expires and the existing-child guard self-heals it.
    await settleRetryDispatchClaim(parent.id, parent.routineId, claim, null);
  }

  return { started, completions };
}

/**
 * One heartbeat pass: reconcile crash debris, fire due routines, then start
 * any retries that have come due.
 *
 * The outer guard (`ticking`) prevents overlapping passes if a heartbeat
 * interval fires while the previous pass is still writing rows — cheap
 * insurance, since a single SQLite connection serializes writes anyway.
 *
 * Recovery lives inside the pass, not in a boot-only hook, on purpose: a
 * boot-only recovery guarded by a long lease is skipped precisely when it is
 * needed most, because the process that crashed is still holding the lease.
 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await withSchedulerLease("routines", HEARTBEAT_INTERVAL_MS * 3, async () => {
      const repo = AppDataSource.getRepository(Routine);
      const now = new Date();

      // Phase 1 — reconcile. Never starts work; only writes terminal statuses,
      // the retry stamps that go with them, and lease deletes.
      const boot = pendingBootReconcile;
      pendingBootReconcile = false;
      await reconcileOrphanedRuns({ boot, now }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] run recovery failed:", err);
      });
      await reconcileStaleTldrs(now).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] TLDR recovery failed:", err);
      });

      // Phase 2 — schedule. Oldest due slot first and capped, so a restart
      // with a big overdue set can't fire everything at once (and can't keep
      // starving the same routines the way an unordered scan did).
      const due = await repo.find({
        where: { enabled: true, nextRunAt: LessThanOrEqual(now) },
        order: { nextRunAt: "ASC" },
        take: MAX_DISPATCH_PER_TICK,
      });
      for (const r of due) {
        const slot = r.nextRunAt as Date; // non-null by the query predicate
        const { count, capped } = countMissedSlots(r.cronExpr, slot, now, MISSED_SLOT_CAP);
        const stale = isSlotStale(slot, now, STALE_SLOT_MS);
        // Advance BEFORE firing so a long-running routine doesn't re-trigger.
        r.nextRunAt = nextRunFor(r.cronExpr, now);
        await repo.save(r);
        if (r.catchUpPolicy === "skip" && stale) {
          // `count` excludes the due slot itself, which is also not being run.
          await journalSkippedCatchUp(r, slot, count + 1, capped);
          continue;
        }
        try {
          // Wait only until the Run row is durable (not for the agent to
          // finish) so phase 3 can see it and defer a colliding retry.
          await tickRoutine(r.id, { missedSlots: count });
        } catch (err) {
          onDispatchError(r.id)(err);
        }
      }

      // Phase 3 — retries owed by earlier failures.
      await dispatchDueRetries(now);

      // Phase 4 — durable Revenue reminders. The notification entity key
      // makes this idempotent across heartbeats; the scheduler lease prevents
      // two app instances racing the same reminder.
      await dispatchDueFollowUpReminders(now).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] revenue follow-up reminders failed:", err);
      });

      // Phase 5 — claim due TLDR windows. The claim and schedule advance are
      // durable before the restricted model turn continues in the background,
      // so this heartbeat never waits for prose generation.
      await dispatchDueTldrs(now).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] TLDR dispatch failed:", err);
      });

      // Phase 6 — finish the standing questions a brief is still owed. The
      // pass normally runs behind its own generation; this only picks up
      // briefs whose process died before it could, and gives up on ones too
      // old to be worth answering rather than re-scanning them forever.
      //
      // The sweep hands off rather than waiting: a pass is several model turns
      // per brief, and this tick holds the scheduler lease for as long as its
      // body runs. The two awaits here are a bounded SELECT and a single
      // UPDATE. Same reason a button left mid-press is released from here —
      // one guarded UPDATE, so a replica that died without a peer restarting
      // does not leave its buttons stuck until one does.
      await sweepPendingStandingQuestions(now).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] TLDR standing question sweep failed:", err);
      });
      await retireStaleStandingClaims(now).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] TLDR standing question retirement failed:", err);
      });
      await releaseInterruptedTldrQuestionActions(now).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[cron] TLDR suggested action release failed:", err);
      });
    });
  } finally {
    ticking = false;
  }
}

/**
 * Fill in `nextRunAt` for any enabled routine that doesn't have one. Runs on
 * boot to handle (a) rows created before this column existed, and (b) rows
 * where a prior boot failed to compute a schedule (e.g. transient parse
 * error). Sets the next time relative to *now* so we don't try to fabricate
 * a missed history.
 */
async function initialSweep(): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  const orphans = await repo.find({
    where: { enabled: true, nextRunAt: IsNull() },
  });
  if (orphans.length === 0) {
    await sweepTldrSchedules();
    return;
  }
  const now = new Date();
  for (const r of orphans) {
    r.nextRunAt = nextRunFor(r.cronExpr, now);
    // A null here means the expression no longer parses, so the row stays
    // permanently invisible to the heartbeat. Say so — otherwise a routine
    // that silently stopped firing has no server-side signal at all.
    if (r.nextRunAt === null) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cron] routine "${r.name}" (${r.id}) has an unschedulable expression "${r.cronExpr}" — it will never fire`,
      );
    }
    await repo.save(r);
  }
  await sweepTldrSchedules(now);
}

/**
 * Stop the heartbeat. The backup restore path destroys the DataSource for
 * minutes while it extracts an archive; without this the 30s tick keeps firing
 * across the wipe and can start runs against a half-restored database.
 */
export function stopCron(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * Re-anchor every enabled routine to its next *future* slot after a restore.
 *
 * Restored rows carry the `nextRunAt` frozen when the archive was written — by
 * definition in the past, often by weeks — so without this the `bootCron()`
 * that follows a restore fires every routine in the company at once.
 */
export async function resetSchedulesAfterRestore(): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  const rows = await repo.find({ where: { enabled: true } });
  const now = new Date();
  for (const r of rows) {
    r.nextRunAt = nextRunFor(r.cronExpr, now);
    await repo.save(r);
  }
  await resetTldrSchedulesAfterRestore(now);
}

export async function bootCron(): Promise<void> {
  // The immediate tick below performs the boot reconciliation pass. This also
  // covers the post-restore re-boot, where every restored `running` row is
  // debris by definition.
  pendingBootReconcile = true;
  await initialSweep();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[cron] heartbeat failed:", err);
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Complete the initial reconciliation before startup launches any durable
  // chat recoveries. Otherwise the asynchronous boot pass could clear the
  // workload lease a recovered turn just acquired.
  await tick().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[cron] initial tick failed:", err);
  });
}
