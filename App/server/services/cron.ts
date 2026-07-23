import parser from "cron-parser";
import { IsNull, LessThanOrEqual, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { runRoutine } from "./runner.js";
import { notifyApprovalPending } from "./notifications.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { findDueRetries, reconcileOrphanedRuns } from "./runRecovery.js";
import { ORPHAN_GRACE_MS, STALE_SLOT_MS, countMissedSlots, isSlotStale } from "./cronMath.js";
import { EmployeeWorkloadBusyError, WorkloadLimitError } from "./workloadLeases.js";

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

/** How far out to push a routine whose run was refused a workload lease. */
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
  const inFlightSince = new Date(
    Date.now() - (Math.max(1, fresh.timeoutSec) * 1000 + ORPHAN_GRACE_MS),
  );
  const inFlight = await AppDataSource.getRepository(Run).findOne({
    where: {
      routineId: fresh.id,
      status: "running",
      startedAt: MoreThan(inFlightSince),
    },
  });
  if (inFlight) {
    // eslint-disable-next-line no-console
    console.log(
      `[cron] routine "${fresh.name}" (${fresh.id}) skipped — run ${inFlight.id} still in flight`,
    );
    return;
  }
  await runRoutine(fresh, { triggerKind: "schedule", missedSlots: meta.missedSlots });
}

/**
 * Pull a routine's next fire back to a near moment after its run was refused a
 * workload lease. The lease is taken before the Run row exists, so a refusal
 * leaves no trace anywhere — without this the occurrence is simply lost until
 * the next natural slot, which for a weekly routine is a week.
 *
 * Only ever moves `nextRunAt` earlier, never later.
 */
async function rearmAfterBusy(routineId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  const r = await repo.findOneBy({ id: routineId });
  if (!r || !r.enabled) return;
  const soon = new Date(Date.now() + BUSY_RETRY_MS);
  if (r.nextRunAt && r.nextRunAt <= soon) return;
  r.nextRunAt = soon;
  await repo.save(r);
}

/** True for the two errors that mean "no capacity right now", not "broken". */
function isCapacityError(err: unknown): boolean {
  return err instanceof EmployeeWorkloadBusyError || err instanceof WorkloadLimitError;
}

function onDispatchError(routineId: string) {
  return (err: unknown) => {
    if (isCapacityError(err)) {
      // eslint-disable-next-line no-console
      console.log(`[cron] routine ${routineId} deferred — ${(err as Error).message}`);
      void rearmAfterBusy(routineId).catch(() => {});
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[cron] routine ${routineId} failed:`, err);
  };
}

/**
 * A retry refused for capacity must not consume an attempt — re-stamp the
 * parent's `retryAt` so the next pass tries again.
 */
function onRetryError(parentRunId: string) {
  return async (err: unknown) => {
    if (!isCapacityError(err)) {
      // eslint-disable-next-line no-console
      console.error(`[cron] retry of run ${parentRunId} failed:`, err);
      return;
    }
    const repo = AppDataSource.getRepository(Run);
    const parent = await repo.findOneBy({ id: parentRunId });
    if (!parent) return;
    parent.retryAt = new Date(Date.now() + BUSY_RETRY_MS);
    await repo.save(parent);
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
        tickRoutine(r.id, { missedSlots: count }).catch(onDispatchError(r.id));
      }

      // Phase 3 — retries owed by earlier failures.
      const runRepo = AppDataSource.getRepository(Run);
      for (const parent of await findDueRetries(now, MAX_RETRIES_PER_TICK)) {
        // Clear first: a crash between here and the start loses one retry
        // rather than looping on it forever.
        parent.retryAt = null;
        await runRepo.save(parent);
        const routine = await repo.findOneBy({ id: parent.routineId });
        if (!routine || !routine.enabled) continue;
        runRoutine(routine, {
          triggerKind: "retry",
          attempt: parent.attempt + 1,
          parentRunId: parent.id,
          missedSlots: 0,
        }).catch((err) => void onRetryError(parent.id)(err));
      }
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
  if (orphans.length === 0) return;
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
  // Kick an immediate pass so a just-rebooted server catches up without
  // waiting a full heartbeat interval first.
  tick().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[cron] initial tick failed:", err);
  });
}
