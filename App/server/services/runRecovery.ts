import {
  Between,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  type FindOperator,
} from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { contractAutonomyOnBadRun } from "./autonomy.js";
import { Run } from "../db/entities/Run.js";
import { DEFAULT_ROUTINE_TIMEOUT_SEC, Routine } from "../db/entities/Routine.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import {
  automaticRetryDelayMs,
  automaticRetryLimit,
  isRunOrphaned,
  ORPHAN_GRACE_MS,
  shouldRetry,
} from "./cronMath.js";
import { config } from "../../config.js";
import {
  recoverBrowserRecordingsForRun,
  releaseBrowserRecordingRunFinalizing,
} from "./browserRecordings.js";
import { finalizeBrowserRecordingsForRun } from "./browserSessions.js";
import { notifyRunFailure } from "./runAlerts.js";
import { readRunDiagnostics } from "./runDiagnostics.js";
import { readRunCheckpoint } from "./runContinuation.js";
import {
  hasLiveRoutineRunLease,
  ownsRoutineRunClaim,
  releaseOrphanedQueueSlots,
} from "./routineQueue.js";
import { interruptRun } from "./standdowns.js";
import { HOLD_MARGIN_MS, releaseRoutineQueue, routineQueueHoldEnd } from "./routineQueueHold.js";
import {
  clearExpiredRunRestartMarks,
  clearLocalRunPause,
  clearRunPauseRequest,
  clearRunRestartMark,
  MAX_RUN_PAUSES,
  runRestartMarks,
} from "./runPause.js";

/**
 * Crash recovery for Runs.
 *
 * Routine dispatch claims `status: "running"` before it does any work, and
 * the writes that move the row off that status live in a detached async block
 * that a `kill -9` or a power cut never reaches. Nothing used to reconcile the
 * leftovers: the Run stayed `running` forever and System Health flagged it as
 * stuck without ever clearing it. This startup pass also cleans abandoned
 * chat-reply leases, which a dead process cannot release itself.
 *
 * Expiry alone does not prove a crash: cancellation can still be draining a
 * live runtime. Exact local ownership lets us record its timeout truthfully,
 * while retaining the claim until cleanup settles. Another replica's live
 * lease is never reclassified or released by this process.
 *
 * On sqlite the process is the only executor — `withSchedulerLease` degrades
 * to a passthrough for exactly that reason — so on the first heartbeat of a
 * fresh process every `running` row and chat-reply lease is debris regardless
 * of age, and we don't make an employee wait six hours for the obvious. On
 * Postgres another replica may legitimately own either, so recovery requires
 * both expiry and no live ownership lease.
 *
 * This module must not import `services/cron.ts` — cron imports this. The
 * retry delay takes the routine as an argument instead.
 */

export const ORPHAN_LOG_MARKER =
  "\n[interrupted] The server stopped while this run was executing. " +
  "Nothing is known about work done after the last line above.\n";
export const STALE_RUN_LOG_MARKER =
  "\n[interrupted] Recovery found this Run past its time limit without a live owner. " +
  "A server restart is not confirmed. Work after the last durable line is unknown.\n";
/** Appended to a Run a restart cut off, which goes back to the queue to continue. */
export const CUT_OFF_PAUSE_LOG_MARKER =
  "\n[paused] Genosyn restarted before this Run could pause on its own. " +
  "It keeps everything above and continues once Genosyn is back; a step in flight at the " +
  "restart may or may not have taken effect.\n";
export const OVERDUE_RUN_LOG_MARKER =
  "\n[timeout] The Run exceeded its original time limit. Cancellation was requested; " +
  "another Run of this Routine must wait for its runtime cleanup to finish.\n";

export type RunRecoveryResult = {
  interrupted: number;
  timedOut: number;
  retriesScheduled: number;
  leasesCleared: number;
  /** Runs an upgrade restart cut off, put back in the queue to continue. */
  paused: number;
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

/**
 * Matches every Run with a `retryAt`: a due time or a dispatch claim stamp,
 * which is never earlier than 1900. A range the `retryAt` index answers, where
 * `IS NOT NULL` would read every Run in the table.
 */
export function anyRetryAt(): FindOperator<Date> {
  return MoreThanOrEqual(new Date(RETRY_DISPATCH_CLAIM_STORAGE_MS));
}

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
 * Mark crash-orphaned `running` Runs `error`, stamp a retry on the ones
 * that are owed another attempt, and clear abandoned chat-reply leases.
 *
 * @param opts.boot true on the first pass of a freshly started process.
 */
export async function reconcileOrphanedRuns(opts?: {
  boot?: boolean;
  now?: Date;
}): Promise<RunRecoveryResult> {
  const now = opts?.now ?? new Date();
  // Only sound on sqlite: a Postgres row may belong to a live sibling replica.
  const singleProcessBoot = opts?.boot === true && config.db.driver !== "postgres";

  const runRepo = AppDataSource.getRepository(Run);
  const routineRepo = AppDataSource.getRepository(Routine);
  const result: RunRecoveryResult = {
    interrupted: 0,
    timedOut: 0,
    retriesScheduled: 0,
    leasesCleared: 0,
    paused: 0,
  };

  const running = await runRepo.find({ where: { status: "running" } });
  // A Run still marked running that a restart cut off goes back to the queue
  // to continue, as a paused Run, rather than failing (`runPause.ts`). Its
  // stopping process marked it before trying to pause it, or an upgrade was
  // holding the queue — the only record an image too old to mark it leaves.
  const restartMarks =
    running.length > 0
      ? await runRestartMarks(
          running.map((run) => run.id),
          now,
        )
      : new Map<string, Date>();
  const holdEnd = running.length > 0 ? await routineQueueHoldEnd() : null;
  if (running.length > 0) {
    const routineIds = [...new Set(running.map((r) => r.routineId))];
    const routines = await routineRepo.find({ where: { id: In(routineIds) } });
    const byId = new Map(routines.map((r) => [r.id, r]));

    for (const run of running) {
      const routine = byId.get(run.routineId) ?? null;
      // A routine deleted out from under a live run leaves no timeout to reason
      // about; fall back to the column default rather than stranding the row.
      const timeoutSec = routine?.timeoutSec ?? DEFAULT_ROUTINE_TIMEOUT_SEC;
      // A Member may edit timeoutSec while this Run is active. Its captured
      // absolute deadline stays authoritative, with an age fallback only for
      // legacy rows that did not persist one.
      const expired = run.continuationDeadlineAt
        ? run.continuationDeadlineAt.getTime() + ORPHAN_GRACE_MS < now.getTime()
        : isRunOrphaned(run.startedAt, timeoutSec, now);
      const locallyOwned = ownsRoutineRunClaim(run.id, run.queueActiveEmployeeId);
      const cutOffAt = restartCutOffAt(run, {
        mark: restartMarks.get(run.id) ?? null,
        holdEnd,
        boot: opts?.boot === true,
        now,
      });
      if (
        cutOffAt &&
        !locallyOwned &&
        (run.pauseCount ?? 0) < MAX_RUN_PAUSES &&
        // SQLite has one process, so its boot settles every Run a restart cut
        // off; a later pass could only catch one this process is still
        // claiming. On Postgres a lapsed lease says the owner is gone.
        (singleProcessBoot ||
          (config.db.driver === "postgres" && !(await hasLiveRoutineRunLease(run, now))))
      ) {
        if (await pauseCutOffRun(run, routine, cutOffAt)) result.paused += 1;
        continue;
      }
      // Boot/restore must not mistake a Run already started by this process
      // for crash debris. Remote live leases retain their owner's lifecycle.
      if (!expired && (!singleProcessBoot || locallyOwned)) continue;
      if (!locallyOwned && !singleProcessBoot && (await hasLiveRoutineRunLease(run, now))) continue;
      const marker = locallyOwned
        ? OVERDUE_RUN_LOG_MARKER
        : singleProcessBoot
          ? ORPHAN_LOG_MARKER
          : STALE_RUN_LOG_MARKER;
      if (locallyOwned) interruptRun(run.id);

      run.status = "error";
      run.errorKind = locallyOwned ? "timeout" : "interrupted";
      run.exitCode = null;
      run.finishedAt = now;
      run.logContent = (run.logContent ?? "") + marker;

      let retryDelayMs: number | null = null;
      const checkpoint = readRunCheckpoint(run);
      const continuationInterrupted =
        run.triggerKind === "continuation" ||
        run.continuationCount > 0 ||
        checkpoint?.state === "continue" ||
        checkpoint?.state === "blocked";
      if (continuationInterrupted) {
        // A partial occurrence cannot escape its shared budget through the
        // ordinary crash-retry policy. Its last durable checkpoint survives
        // for inspection, but an interrupted chunk needs attention.
        run.retryAt = null;
        run.continuationStopReason = locallyOwned
          ? "The original Routine time limit ended before its unfinished work completed."
          : "The Run was interrupted before its next checkpoint could be safely continued.";
      }
      if (
        !continuationInterrupted &&
        routine?.enabled &&
        !routine.requiresApproval &&
        shouldRetry({
          status: run.status,
          errorKind: run.errorKind,
          triggerKind: run.triggerKind,
          attempt: run.attempt,
          maxAttempts: routine.maxAttempts,
          retryOnTimeout: routine.retryOnTimeout,
        })
      ) {
        retryDelayMs = automaticRetryDelayMs({
          status: run.status,
          errorKind: run.errorKind,
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
      // Recording shutdown can take time. Preserve any checkpoint that landed
      // meanwhile; a still newer checkpoint wins this CAS and is revisited on
      // the next sweep rather than being erased by this stale snapshot.
      const latest = await runRepo.findOneBy({ id: run.id });
      if (
        !latest ||
        latest.status !== "running" ||
        latest.queueActiveEmployeeId !== run.queueActiveEmployeeId ||
        latest.checkpointJson !== run.checkpointJson ||
        ownsRoutineRunClaim(run.id, latest.queueActiveEmployeeId) !== locallyOwned ||
        (!locallyOwned && !singleProcessBoot && (await hasLiveRoutineRunLease(latest, now)))
      ) {
        releaseBrowserRecordingRunFinalizing(run.id);
        continue;
      }
      run.logContent = (latest.logContent ?? "") + marker;
      run.diagnosticsJson = latest.diagnosticsJson;
      const recovered = await runRepo.update(
        {
          id: run.id,
          status: "running",
          queueActiveEmployeeId: latest.queueActiveEmployeeId ?? IsNull(),
          checkpointJson: latest.checkpointJson ?? IsNull(),
          logContent: latest.logContent,
          diagnosticsJson: latest.diagnosticsJson ?? IsNull(),
        },
        {
          status: run.status,
          errorKind: run.errorKind,
          diagnosticsJson: JSON.stringify(readRunDiagnostics(run)),
          routineId: run.routineId,
          // Only the lifecycle owner or the ownership-aware orphan sweep may
          // release this claim. A terminal row can still have active cleanup.
          exitCode: run.exitCode,
          finishedAt: run.finishedAt,
          logContent: run.logContent,
          retryAt: run.retryAt,
          continuationStopReason: run.continuationStopReason,
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
      if (locallyOwned) result.timedOut += 1;
      else result.interrupted += 1;

      if (routine) {
        const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
          id: routine.employeeId,
        });
        if (employee) await contractAutonomyOnBadRun({ run, employee });
        await journalRecovery(routine, run, retryDelayMs, singleProcessBoot).catch((error) => {
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
    // An upgrade held the queue so running Runs could pause before this
    // restart. The restart has happened; queued and paused Runs may start.
    await releaseRoutineQueue();
    // The pause request was for the process being replaced. Left in force, it
    // would pause the very Runs this one is about to resume.
    await clearRunPauseRequest();
    clearLocalRunPause();
    await clearExpiredRunRestartMarks(now);
    // A process can die after the Run's terminal compare-and-set but before
    // its fragmented recording is promoted. Those Runs are no longer in the
    // `running` query above, so retry their artifact recovery idempotently on
    // every boot rather than leaving the UI on `recording`/`finalizing`.
    const rows = await AppDataSource.getRepository(BrowserSession)
      .createQueryBuilder("session")
      .select("DISTINCT session.runId", "runId")
      .innerJoin(Run, "run", "CAST(run.id AS text) = session.runId")
      // A Run paused for the restart may also have left a recording partial.
      .where(
        "(run.status IN (:...statuses) OR (run.status = :queued AND run.pauseCount > 0))",
        { statuses: ["error", "interrupted"], queued: "queued" },
      )
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

  await releaseOrphanedQueueSlots(singleProcessBoot, now);
  result.leasesCleared = await clearLeases(singleProcessBoot, now);

  if (
    result.interrupted ||
    result.timedOut ||
    result.retriesScheduled ||
    result.leasesCleared ||
    result.paused
  ) {
    // eslint-disable-next-line no-console
    console.log(
      `[recovery] interrupted=${result.interrupted} timedOut=${result.timedOut} retries=${result.retriesScheduled} leases=${result.leasesCleared} paused=${result.paused}`,
    );
  }
  return result;
}

/**
 * When a restart cut this Run off, or null when nothing says one did.
 *
 * A restart mark is the stopping process's own record, and counts unless the
 * Run has paused since — then it resumed, and that restart is behind it. An
 * upgrade's hold is the fallback: a Run that started before the hold ended was
 * running when the upgrade came. Only a boot or a cancelled upgrade releases
 * a hold, so at boot one that expired meanwhile — a long backup, a long stop
 * — still names the restart this boot follows; a later pass needs it live,
 * since a hold an aborted upgrade left behind names no restart at all. A hold
 * ends a margin after the latest the restart was due, so counting from there
 * charges a Run at most the wait before it, never the downtime after.
 */
export function restartCutOffAt(
  run: Pick<Run, "startedAt" | "pausedAt">,
  args: { mark: Date | null; holdEnd: Date | null; boot: boolean; now: Date },
): Date | null {
  const started = run.startedAt.getTime();
  const lastPaused = run.pausedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const { mark, holdEnd, now } = args;
  let at: number | null = null;
  if (mark && mark.getTime() > lastPaused) {
    at = mark.getTime();
  } else if (
    holdEnd &&
    started < holdEnd.getTime() &&
    (args.boot || holdEnd.getTime() > now.getTime())
  ) {
    at = holdEnd.getTime() - HOLD_MARGIN_MS;
  }
  if (at === null) return null;
  return new Date(Math.min(now.getTime(), Math.max(started, at)));
}

/**
 * Put a Run a restart cut off back in the queue to continue — the same state
 * a Run that paused on its own reaches (`runPause.ts`), minus the checkpoint
 * it had no chance to save. Its transcript is durable to within a second, so
 * the resumed turn sees nearly everything it had done, and its Effects are
 * the server's own record. The time it gets back is what was left of its
 * limit when it was cut off, never less than a resume needs.
 */
async function pauseCutOffRun(
  run: Run,
  routine: Routine | null,
  cutOffAt: Date,
): Promise<boolean> {
  const runRepo = AppDataSource.getRepository(Run);
  const deadline =
    run.continuationDeadlineAt?.getTime() ??
    run.startedAt.getTime() + Math.max(1, routine?.timeoutSec ?? DEFAULT_ROUTINE_TIMEOUT_SEC) * 1000;
  // Close any browser session the Run left open, as a terminal Run's would be.
  await finalizeBrowserRecordingsForRun(run.id).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[recovery] failed to finalize browser recordings for run ${run.id}:`, error);
  });
  try {
    const latest = await runRepo.findOneBy({ id: run.id });
    if (
      !latest ||
      latest.status !== "running" ||
      latest.queueActiveEmployeeId !== run.queueActiveEmployeeId
    )
      return false;
    const paused = await runRepo.update(
      {
        id: run.id,
        status: "running",
        queueActiveEmployeeId: latest.queueActiveEmployeeId ?? IsNull(),
        logContent: latest.logContent,
      },
      {
        routineId: run.routineId,
        status: "queued",
        queueActiveEmployeeId: null,
        logContent: (latest.logContent ?? "") + CUT_OFF_PAUSE_LOG_MARKER,
        pausedAt: cutOffAt,
        pauseCount: (latest.pauseCount ?? 0) + 1,
        pauseRemainingMs: Math.max(0, deadline - cutOffAt.getTime()),
      },
    );
    if (paused.affected !== 1) return false;
    await clearRunRestartMark(run.id).catch(() => undefined);
    await recoverBrowserRecordingsForRun(run.id).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[recovery] failed to recover browser recordings for run ${run.id}:`, error);
    });
    return true;
  } finally {
    releaseBrowserRecordingRunFinalizing(run.id);
  }
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

async function journalRecovery(
  routine: Routine,
  run: Run,
  retryDelayMs: number | null,
  singleProcessBoot: boolean,
): Promise<void> {
  const repo = AppDataSource.getRepository(JournalEntry);
  const cause =
    run.errorKind === "timeout"
      ? "exceeded its original time limit"
      : singleProcessBoot
        ? "was interrupted by a server restart"
        : "was recovered after losing its runtime owner";
  const explanation =
    run.errorKind === "timeout"
      ? "The Run ended with a timeout Error. Cancellation was requested, and its cleanup claim remains until the runtime finishes stopping."
      : singleProcessBoot
        ? "The Run ended with an Error after a server interruption."
        : "The Run ended with an Error after its time limit with no live owner. This does not confirm a server restart.";
  const body =
    retryDelayMs === null
      ? run.continuationStopReason
        ? `${explanation} ${run.continuationStopReason} Its saved progress is preserved; no automatic retry was scheduled.`
        : !routine.enabled
          ? `${explanation} No recovery was scheduled because the Routine is disabled.`
          : routine.requiresApproval
            ? `${explanation} No recovery was scheduled because the Routine now requires approval.`
            : `${explanation} No automatic retry is permitted by this Run's trigger and retry policy.`
      : `${explanation} A retry is scheduled in about ${Math.max(1, Math.round(retryDelayMs / 1000))}s (attempt ${run.attempt + 1} of ${automaticRetryLimit(run.status, routine.maxAttempts, run.errorKind)}), after cleanup releases the Run's claim.`;
  await repo.save(
    repo.create({
      employeeId: routine.employeeId,
      kind: "system",
      title: `Routine "${routine.name}" ${cause}`,
      body,
      routineId: routine.id,
      runId: run.id,
      authorUserId: null,
    }),
  );
}
