import { In, LessThanOrEqual, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Run } from "../db/entities/Run.js";
import { Routine } from "../db/entities/Routine.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { backoffDelayMs, isRunOrphaned, shouldRetry } from "./cronMath.js";
import { config } from "../../config.js";

/**
 * Crash recovery for Runs.
 *
 * `startRoutineRun` commits `status: "running"` before it does any work, and
 * the writes that move the row off that status live in a detached async block
 * that a `kill -9` or a power cut never reaches. Nothing used to reconcile the
 * leftovers: the Run stayed `running` forever, System Health flagged it as
 * stuck without ever clearing it, and — worse — the `WorkloadLease` the run
 * held stayed too, so the employee read as busy and refused chat for up to
 * `timeoutSec + grace` (61 minutes at the default).
 *
 * The predicate for "this row is debris" is deliberately the same one the
 * scheduler's overlap guard already uses to decide it may fire again: a run
 * cannot outlive its own timeout because the runner aborts it. So reconciling
 * can never mark a run dead that the scheduler still considers alive.
 *
 * On sqlite the process is the only executor — `withSchedulerLease` degrades
 * to a passthrough for exactly that reason — so on the first heartbeat of a
 * fresh process every `running` row and every lease is debris regardless of
 * age, and we don't make an employee wait an hour for the obvious. On Postgres
 * another replica may legitimately be running that row, so only the age test
 * applies.
 *
 * This module must not import `services/cron.ts` — cron imports this. The
 * retry delay takes the routine as an argument instead.
 */

export const ORPHAN_LOG_MARKER =
  "\n[interrupted] The server stopped while this run was executing. " +
  "Nothing is known about work done after the last line above.\n";

export type RunRecoveryResult = {
  interrupted: number;
  retriesScheduled: number;
  leasesCleared: number;
};

/**
 * Mark crash-orphaned `running` Runs `interrupted`, stamp a retry on the ones
 * that are owed another attempt, and clear the workload leases they stranded.
 *
 * @param opts.boot true on the first pass of a freshly started process.
 */
export async function reconcileOrphanedRuns(opts?: {
  boot?: boolean;
  now?: Date;
}): Promise<RunRecoveryResult> {
  const now = opts?.now ?? new Date();
  // Only sound on sqlite: with Postgres a `running` row may belong to a live
  // sibling replica, so age is the only safe evidence of death.
  const singleProcessBoot = opts?.boot === true && config.db.driver !== "postgres";

  const runRepo = AppDataSource.getRepository(Run);
  const routineRepo = AppDataSource.getRepository(Routine);
  const result: RunRecoveryResult = { interrupted: 0, retriesScheduled: 0, leasesCleared: 0 };

  const running = await runRepo.find({ where: { status: "running" } });
  if (running.length > 0) {
    const routineIds = [...new Set(running.map((r) => r.routineId))];
    const routines = await routineRepo.find({ where: { id: In(routineIds) } });
    const byId = new Map(routines.map((r) => [r.id, r]));

    for (const run of running) {
      const routine = byId.get(run.routineId) ?? null;
      // A routine deleted out from under a live run leaves no timeout to reason
      // about; fall back to the column default rather than stranding the row.
      const timeoutSec = routine?.timeoutSec ?? 3600;
      if (!singleProcessBoot && !isRunOrphaned(run.startedAt, timeoutSec, now)) continue;

      run.status = "interrupted";
      run.exitCode = null;
      run.finishedAt = now;
      run.logContent = (run.logContent ?? "") + ORPHAN_LOG_MARKER;

      let retryDelayMs: number | null = null;
      if (
        routine &&
        shouldRetry({
          status: "interrupted",
          triggerKind: run.triggerKind,
          attempt: run.attempt,
          maxAttempts: routine.maxAttempts,
          retryOnTimeout: routine.retryOnTimeout,
        })
      ) {
        retryDelayMs = backoffDelayMs(run.attempt, { baseMs: routine.retryBackoffSec * 1000 });
        run.retryAt = new Date(now.getTime() + retryDelayMs);
        result.retriesScheduled += 1;
      }
      // One save so a second crash cannot land the terminal status without the
      // retry that goes with it.
      await runRepo.save(run);
      result.interrupted += 1;

      if (routine) await journalInterrupted(routine, run, retryDelayMs);
    }
  }

  result.leasesCleared = await clearLeases(singleProcessBoot, now);

  if (result.interrupted || result.retriesScheduled || result.leasesCleared) {
    // eslint-disable-next-line no-console
    console.log(
      `[recovery] interrupted=${result.interrupted} retries=${result.retriesScheduled} leases=${result.leasesCleared}`,
    );
  }
  return result;
}

/**
 * Terminal Runs whose retry has come due, oldest first so a backlog drains in
 * the order it was created rather than by whatever the DB returns.
 */
export async function findDueRetries(now: Date, take: number): Promise<Run[]> {
  return AppDataSource.getRepository(Run).find({
    where: { retryAt: LessThanOrEqual(now), status: Not("running") },
    order: { retryAt: "ASC" },
    take,
  });
}

async function clearLeases(singleProcessBoot: boolean, now: Date): Promise<number> {
  // `repo.clear()` is TRUNCATE on Postgres and `delete({})` is rejected by
  // TypeORM, hence the explicit builder for the full clear.
  if (singleProcessBoot) {
    const res = await AppDataSource.createQueryBuilder()
      .delete()
      .from(WorkloadLease)
      .where("1 = 1")
      .execute();
    return res.affected ?? 0;
  }
  // Strictly narrower than the lazy purge `acquireWorkloadLease` already does
  // on every acquire — same criterion, just not scoped to one company, which
  // is why a quiet company's dead leases otherwise live forever.
  const res = await AppDataSource.getRepository(WorkloadLease).delete({
    expiresAt: LessThanOrEqual(now),
  });
  return res.affected ?? 0;
}

async function journalInterrupted(
  routine: Routine,
  run: Run,
  retryDelayMs: number | null,
): Promise<void> {
  const repo = AppDataSource.getRepository(JournalEntry);
  const body =
    retryDelayMs === null
      ? "The run is marked interrupted. Nothing was retried — this routine allows one attempt."
      : `A retry is scheduled in about ${Math.max(1, Math.round(retryDelayMs / 1000))}s (attempt ${run.attempt + 1} of ${routine.maxAttempts}).`;
  await repo.save(
    repo.create({
      employeeId: routine.employeeId,
      kind: "system",
      title: `Routine "${routine.name}" was interrupted by a server restart`,
      body,
      routineId: routine.id,
      runId: run.id,
      authorUserId: null,
    }),
  );
}
