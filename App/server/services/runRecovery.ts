import { Between, In, LessThanOrEqual, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Run } from "../db/entities/Run.js";
import { Routine } from "../db/entities/Routine.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import {
  automaticRetryDelayMs,
  automaticRetryLimit,
  isRunOrphaned,
  shouldRetry,
} from "./cronMath.js";
import { config } from "../../config.js";
import {
  recoverBrowserRecordingsForRun,
  releaseBrowserRecordingRunFinalizing,
} from "./browserRecordings.js";
import { finalizeBrowserRecordingsForRun } from "./browserSessions.js";
import { notifyRunFailure } from "./runAlerts.js";

/**
 * Crash recovery for Runs.
 *
 * `startRoutineRun` commits `status: "running"` before it does any work, and
 * the writes that move the row off that status live in a detached async block
 * that a `kill -9` or a power cut never reaches. Nothing used to reconcile the
 * leftovers: the Run stayed `running` forever and System Health flagged it as
 * stuck without ever clearing it. This startup pass also cleans abandoned
 * chat-reply leases, which a dead process cannot release itself.
 *
 * The predicate for "this row is debris" is deliberately the same one the
 * scheduler's overlap guard already uses to decide it may fire again: a run
 * cannot outlive its own timeout because the runner aborts it. So reconciling
 * can never mark a run dead that the scheduler still considers alive.
 *
 * On sqlite the process is the only executor — `withSchedulerLease` degrades
 * to a passthrough for exactly that reason — so on the first heartbeat of a
 * fresh process every `running` row and chat-reply lease is debris regardless
 * of age, and we don't make an employee wait six hours for the obvious. On
 * Postgres another replica may legitimately own either, so only the age test
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
 * Durable claim stored in `retryAt` while a scheduler owns dispatch.
 *
 * Claim dates live in a reserved historical window and encode when the claim
 * was taken. That gives the compare-and-set a distinct value per dispatch,
 * while a claim abandoned by a dead scheduler becomes eligible again after a
 * short lease. A member-facing cancellation refuses an active claim, so either
 * cancellation or dispatch wins — never both.
 */
export const RETRY_DISPATCH_CLAIM_TTL_MS = 5 * 60 * 1000;
const RETRY_DISPATCH_CLAIM_STORAGE_MS = Date.UTC(1900, 0, 1);
const RETRY_DISPATCH_CLAIM_CLOCK_MS = Date.UTC(2020, 0, 1);
const RETRY_DISPATCH_CLAIM_END_MS = Date.UTC(2000, 0, 1);

export function isRetryDispatchClaimed(retryAt: Date | null): boolean {
  const value = retryAt?.getTime();
  return (
    value !== undefined &&
    value >= RETRY_DISPATCH_CLAIM_STORAGE_MS &&
    value < RETRY_DISPATCH_CLAIM_END_MS
  );
}

function retryDispatchClaimDate(claimedAt: Date): Date {
  return new Date(
    RETRY_DISPATCH_CLAIM_STORAGE_MS + (claimedAt.getTime() - RETRY_DISPATCH_CLAIM_CLOCK_MS),
  );
}

/** Atomically claim one observed queue stamp. */
export async function claimRetryDispatch(
  runId: string,
  expectedRetryAt: Date,
  claimedAt: Date = new Date(),
): Promise<Date | null> {
  const claim = retryDispatchClaimDate(claimedAt);
  const result = await AppDataSource.getRepository(Run).update(
    { id: runId, retryAt: expectedRetryAt },
    { retryAt: claim },
  );
  return result.affected === 1 ? claim : null;
}

/** Release a claim to either a later due time or the completed `null` state. */
export async function settleRetryDispatchClaim(
  runId: string,
  routineId: string,
  claim: Date,
  nextRetryAt: Date | null,
): Promise<boolean> {
  const result = await AppDataSource.getRepository(Run).update(
    { id: runId, retryAt: claim },
    { routineId, retryAt: nextRetryAt },
  );
  return result.affected === 1;
}

export type CancelPendingRetryResult = "cancelled" | "none" | "dispatching" | "changed";

/**
 * Cancel a queued retry with a compare-and-set so dispatch and cancellation
 * have a deterministic winner. The short retry handles scheduler recovery
 * moving `retryAt` between the route's read and write.
 */
export async function cancelPendingRetry(runId: string): Promise<CancelPendingRetryResult> {
  const repo = AppDataSource.getRepository(Run);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = await repo.findOneBy({ id: runId });
    if (!run?.retryAt) return "none";
    // A stale claim is recovered by the scheduler, never cancelled directly:
    // the original dispatcher may still resume. Refusing every claim means a
    // member is only told "cancelled" when no claimed dispatcher can start it.
    if (isRetryDispatchClaimed(run.retryAt)) return "dispatching";
    const result = await repo.update(
      { id: run.id, retryAt: run.retryAt },
      { routineId: run.routineId, retryAt: null },
    );
    if (result.affected === 1) return "cancelled";
  }
  return "changed";
}

/**
 * Mark crash-orphaned `running` Runs `interrupted`, stamp a retry on the ones
 * that are owed another attempt, and clear abandoned chat-reply leases.
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
        routine?.enabled &&
        !routine.requiresApproval &&
        shouldRetry({
          status: "interrupted",
          triggerKind: run.triggerKind,
          attempt: run.attempt,
          maxAttempts: routine.maxAttempts,
          retryOnTimeout: routine.retryOnTimeout,
        })
      ) {
        retryDelayMs = automaticRetryDelayMs({
          status: "interrupted",
          attempt: run.attempt,
          maxAttempts: routine.maxAttempts,
          baseMs: routine.retryBackoffSec * 1000,
        });
        run.retryAt = new Date(now.getTime() + retryDelayMs);
      }
      // Use the same terminal boundary as a normally completed Run. This
      // claims the Run recording tombstone synchronously, drains browser RPC
      // and live-view mutations that were already authorized, freezes frame
      // intake, performs the final privacy scan, and closes the runtime. On a
      // fresh process there is no runtime to drain; the post-CAS recovery
      // below then fails any unverified `recording` partial closed.
      await finalizeBrowserRecordingsForRun(run.id).catch((error) => {
        // Recording finalization is auxiliary to making the orphaned Run
        // durable. Keep the tombstone through the CAS so no late browser
        // activity can reopen capture while the Run is still `running`.
        // eslint-disable-next-line no-console
        console.error(`[recovery] failed to finalize browser recordings for run ${run.id}:`, error);
      });
      // One conditional write so a second crash cannot land the terminal
      // status without its retry, and a live sibling that finalized first can
      // never be overwritten back to `interrupted`.
      const recovered = await runRepo.update(
        { id: run.id, status: "running" },
        {
          status: run.status,
          routineId: run.routineId,
          exitCode: run.exitCode,
          finishedAt: run.finishedAt,
          logContent: run.logContent,
          retryAt: run.retryAt,
        },
      );
      if (recovered.affected !== 1) {
        releaseBrowserRecordingRunFinalizing(run.id);
        continue;
      }
      await recoverBrowserRecordingsForRun(run.id).catch((error) => {
        // Fragmented MP4 partials are auxiliary. Keep recovering later Runs
        // even if one recording cannot be promoted after a crash.
        // eslint-disable-next-line no-console
        console.error(`[recovery] failed to recover browser recordings for run ${run.id}:`, error);
      });
      releaseBrowserRecordingRunFinalizing(run.id);
      if (retryDelayMs !== null) result.retriesScheduled += 1;
      result.interrupted += 1;

      if (routine) {
        await journalInterrupted(routine, run, retryDelayMs).catch((error) => {
          // The Run and its durable retry are already saved. A journal outage
          // must not abort reconciliation and strand later orphaned Runs.
          // eslint-disable-next-line no-console
          console.error(`[recovery] failed to journal interrupted run ${run.id}:`, error);
        });
      }
      if (!run.retryAt) {
        // Interrupted with no recovery attempt owed — the same "work silently
        // stopped" verdict a terminal failure carries, so it gets the same bell.
        void notifyRunFailure(run).catch((error) => {
          // eslint-disable-next-line no-console
          console.error(`[recovery] failed to notify interrupted run ${run.id}:`, error);
        });
      }
    }
  }

  if (opts?.boot === true) {
    // A process can die after the Run's terminal compare-and-set but before
    // its fragmented recording is promoted. Those Runs are no longer in the
    // `running` query above, so retry their artifact recovery idempotently on
    // every boot rather than leaving the UI on `recording`/`finalizing`.
    const rows = await AppDataSource.getRepository(BrowserSession)
      .createQueryBuilder("session")
      .select("DISTINCT session.runId", "runId")
      .innerJoin(Run, "run", "run.id = session.runId")
      .where("run.status = :status", { status: "interrupted" })
      .andWhere("session.runId IS NOT NULL")
      .getRawMany<{ runId: string }>();
    await Promise.all(
      rows.map(({ runId }) =>
        recoverBrowserRecordingsForRun(runId).catch((error) => {
          // eslint-disable-next-line no-console
          console.error(`[recovery] failed to recover browser recordings for run ${runId}:`, error);
        }),
      ),
    );
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
  const staleClaimCutoff = retryDispatchClaimDate(
    new Date(now.getTime() - RETRY_DISPATCH_CLAIM_TTL_MS),
  );
  return AppDataSource.getRepository(Run).find({
    where: [
      {
        retryAt: Between(new Date(RETRY_DISPATCH_CLAIM_END_MS), now),
        status: Not("running"),
      },
      {
        retryAt: Between(new Date(RETRY_DISPATCH_CLAIM_STORAGE_MS), staleClaimCutoff),
        status: Not("running"),
      },
    ],
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
  // Strictly narrower than the lazy purge `acquireChatWorkloadLease` already does
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
      ? !routine.enabled
        ? "The run is marked interrupted. No recovery was scheduled because the routine is disabled."
        : routine.requiresApproval
          ? "The run is marked interrupted. No recovery was scheduled because the routine now requires approval."
          : "The run is marked interrupted. Its automatic recovery attempt budget is exhausted."
      : `A retry is scheduled in about ${Math.max(1, Math.round(retryDelayMs / 1000))}s (attempt ${run.attempt + 1} of ${automaticRetryLimit("interrupted", routine.maxAttempts)}).`;
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
