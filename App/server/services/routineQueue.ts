import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Between,
  IsNull,
  LessThanOrEqual,
  Like,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type Repository,
} from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { DEFAULT_ROUTINE_TIMEOUT_SEC, Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { executeQueuedRoutineRun, type StartRunOptions } from "./runner.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { StanddownError, workBlockedForRoutine } from "./standdowns.js";
import { browserRunCreationBlocked } from "./browserRecordings.js";
import { automaticRetryDelayMs, ORPHAN_GRACE_MS, shouldRetry } from "./cronMath.js";
import { resolveRoutineModel } from "./models.js";
import { creditedQueueWaitMs, readRunCheckpoint } from "./runContinuation.js";
import { activeRunPause, resumeBudgetMs } from "./runPause.js";
import { modelAnswersForQueue, suspectModelOutage } from "./modelAvailability.js";
import { routineQueueHeldUntil } from "./routineQueueHold.js";
import { claimedRuns, queuedRunsInStartOrder } from "./routineQueueOrder.js";
import { isModelServiceUnavailable } from "./agent/modelError.js";
import {
  modelRunCapacity,
  modelRunSlotsInUse,
  withModelRunSlot,
  type ModelRunCapacity,
} from "./modelRunCapacity.js";

export class QueuedRoutineIneligibleError extends Error {}

/** Pending Runs are durable; these promises are only local callers waiting for their result. */
const waiters = new Map<
  string,
  { resolve: (run: Run) => void; reject: (error: unknown) => void }
>();
const workers = new Map<string, Promise<void>>();
const activeClaims = new Map<string, string>();
const admittingRoutines = new Set<string>();
/** Runs a pass offered while their worker was still finishing an earlier attempt. */
const requested = new Set<string>();
let dispatchEnabled = true;
let dispatchGeneration = 0;
/** The dispatch pass under way, and whether another was asked for since it began. */
let passing: Promise<void> | null = null;
let passWanted = false;

function canDispatch(): boolean {
  return dispatchEnabled && AppDataSource.isInitialized;
}

/** Stop new claims before restore closes the database; active Runs keep their existing lifecycle. */
export function stopRoutineQueue(): void {
  dispatchEnabled = false;
  dispatchGeneration++;
  requested.clear();
  passWanted = false;
}

/** Resume only after startup/restore has finished reconciling the initialized database. */
export async function resumeRoutineQueue(): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  dispatchEnabled = true;
  await dispatchQueuedRoutineRuns();
}

export function registerQueuedRun(run: Run): Promise<Run> {
  const completion = new Promise<Run>((resolve, reject) => {
    waiters.set(run.id, { resolve, reject });
  });
  // A caller may only need the accepted Run id. The durable result remains readable.
  void completion.catch(() => undefined);
  // Offered in queue order with everything already waiting, so a new Run never
  // takes an AI Model's slot from a Run ahead of it in the queue.
  void dispatchQueuedRoutineRuns().catch((error) => {
    // The next heartbeat offers it again.
    // eslint-disable-next-line no-console
    console.error(`[routine-dispatch] Run ${run.id} dispatch failed:`, error);
  });
  return completion;
}

/**
 * What one pass through the queue has learned so far. A pass offers waiting
 * Runs one at a time, in start order; once a Run finds its AI Model with no
 * free slot, the Runs behind it on that model wait too, even if a slot frees
 * before the pass reaches them. That slot belongs to the Run ahead, and the
 * pass the freed slot asks for offers it to that Run first.
 */
type DispatchPass = { full: Set<string> };

/**
 * How long a pass waits for one Run's start to be decided before offering the
 * next. A decision normally takes a few queries; this only keeps one Run stuck
 * on a lock from holding every other Run, and the heartbeat, behind it.
 */
const ADMISSION_WAIT_MS = 15_000;

/**
 * Offer one waiting Run its start. Resolves once that is decided — the Run
 * claimed its slot and is running, or it keeps waiting — not when it finishes.
 */
function requestRunDispatch(runId: string, pass: DispatchPass): Promise<void> {
  if (!canDispatch()) return Promise.resolve();
  if (workers.has(runId)) {
    // Its worker is finishing an earlier attempt; that worker asks for
    // another pass once it has, and the pass offers this Run in its turn.
    requested.add(runId);
    return Promise.resolve();
  }
  const generation = dispatchGeneration;
  const canClaim = (): boolean => canDispatch() && generation === dispatchGeneration;
  let decide!: () => void;
  const decided = new Promise<void>((resolve) => {
    decide = resolve;
  });
  const work = Promise.resolve()
    .then(() => attemptRunStart(runId, pass, canClaim, decide))
    .catch((error) => {
      // The next heartbeat resumes durable pending work after transient database failures.
      // eslint-disable-next-line no-console
      console.error(`[routine-dispatch] Run ${runId} dispatch failed:`, error);
    })
    .finally(async () => {
      // Run-specific leases must not accumulate one row per completed Run. A
      // competing owner may already have renewed this name, so delete only an
      // expired lease; its claim still provides the final duplicate-start fence.
      if (AppDataSource.isInitialized) {
        await AppDataSource.getRepository(SchedulerLease)
          .delete({
            name: `routine-run:${runId}`,
            expiresAt: LessThanOrEqual(new Date()),
          })
          .catch((error) => {
            // Recovery also sweeps expired dispatch leases after a crash or outage.
            // eslint-disable-next-line no-console
            console.error(`[routine-dispatch] Run ${runId} lease cleanup failed:`, error);
          });
      }
      workers.delete(runId);
      decide();
      // A pass reached this Run while its worker was still busy. Offer it
      // again, in queue order, rather than outside it.
      if (canDispatch() && requested.delete(runId))
        void dispatchQueuedRoutineRuns().catch(() => undefined);
    });
  workers.set(runId, work);
  const timeout = new AbortController();
  return Promise.race([
    decided.finally(() => timeout.abort()),
    sleep(ADMISSION_WAIT_MS, undefined, { ref: false, signal: timeout.signal }).catch(
      () => undefined,
    ),
  ]);
}

async function attemptRunStart(
  runId: string,
  pass: DispatchPass,
  canClaim: () => boolean,
  admitted: () => void,
): Promise<void> {
  if (!canClaim()) return;
  await withSchedulerLease(`routine-run:${runId}`, 90_000, async (lease) => {
    if (!canClaim()) return;
    lease.assertHeld();
    // An upgrade is about to restart Genosyn. This Run starts in the
    // upgraded process instead of being cut off by the restart.
    if (await routineQueueHeldUntil()) {
      await noteHeldForUpgrade(runId);
      return;
    }
    // Nothing starts while this process is pausing its Runs: one that
    // did would only be paused again on the spot.
    if (activeRunPause()) return;
    // A saturated model admits no more Runs. This one stays queued, and
    // because its deadline starts at the claim, waiting costs it nothing.
    const target = await queuedRunModel(runId);
    if (!canClaim()) return;
    if (target && !(await modelAnswersForQueue(target.capacity.key, target.model))) {
      await noteModelNotAnswering(runId, target);
      return;
    }
    const limited = target?.capacity.limit != null;
    // A Run ahead of this one in the queue already found this model full.
    if (target && limited && pass.full.has(target.capacity.key)) {
      await noteWaitingForModel(runId, target);
      return;
    }
    if (target && !target.continuation && (await slotHeldForContinuation(target))) {
      // Every new Run behind this one on the model meets the same hold.
      pass.full.add(target.capacity.key);
      await noteWaitingForContinuation(runId, target);
      return;
    }
    let started = false;
    const slot = await withModelRunSlot(target?.capacity ?? null, async () => {
      const next = await claimRun(runId, lease.assertHeld, canClaim);
      if (!next) return;
      started = true;
      // The pass offers the next Run while this one works.
      admitted();
      // Each Run owns its lifecycle independently, including assessment and cleanup.
      const claim = next.run.queueActiveEmployeeId!;
      activeClaims.set(runId, claim);
      try {
        await processRun(next.run, next.routine);
      } finally {
        if (activeClaims.get(runId) === claim) activeClaims.delete(runId);
      }
      if (target) await suspectOutageAfterModelFailure(runId, target);
    });
    if (!slot.admitted && target) {
      pass.full.add(target.capacity.key);
      await noteWaitingForModel(runId, target);
    }
    // Offer the slot this Run used to the next waiting Run now, not at
    // the next heartbeat — and before this worker ends, so anyone
    // awaiting an idle queue sees the next Run. A Run whose claim was
    // refused for another reason (an earlier Run still cleaning up, a
    // Standdown) used nothing: re-dispatching would only offer it the
    // same slot again, forever. A failure here waits for the heartbeat.
    if (started && limited) await dispatchQueuedRoutineRuns().catch(() => undefined);
  });
}

async function claimRun(
  runId: string,
  assertHeld: () => void,
  canClaim: () => boolean,
): Promise<{ run: Run; routine: Routine } | null> {
  if (!canClaim()) return null;
  const repo = AppDataSource.getRepository(Run);
  const run = await repo
    .createQueryBuilder("run")
    .addSelect("run.queueOptionsJson")
    .where("run.id = :runId AND run.status = :status", { runId, status: "queued" })
    .getOne();
  if (!run?.employeeId || !canClaim()) return null;
  assertHeld();
  const employeeId = run.employeeId;
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: run.routineId });
  if (!canClaim()) return null;
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
  if (!canClaim()) return null;
  if (!routine || !employee || routine.employeeId !== employeeId) {
    await skipQueuedRun(run, "The Routine or its AI Employee was removed or reassigned.");
    return null;
  }
  if (browserRunCreationBlocked({ employeeId, routineId: routine.id })) return null;
  if ((await workBlockedForRoutine(routine)).blocked) return null;
  if (!canClaim()) return null;
  const automatic = ["schedule", "retry", "event", "webhook", "continuation"].includes(
    run.triggerKind,
  );
  if (automatic && (!routine.enabled || routine.requiresApproval)) {
    await skipQueuedRun(
      run,
      routine.enabled
        ? "This Routine now requires human approval before starting."
        : "This Routine was disabled before its pending work started.",
    );
    return null;
  }
  return withRoutineAdmission(routine.id, async (claims) => {
    // A terminal verdict can precede runtime/assessment cleanup. Every origin,
    // including a fresh manual Run, must wait for that exact ownership to end.
    if (await routineHasOtherClaim(claims, routine.id, run.id)) return null;
    if (!canClaim()) return null;
    assertHeld();
    // The legacy column now identifies this Run's claim, never an employee slot.
    // The conditional status transition fences competing dispatchers even if a
    // scheduler lease expires while its owner is waiting on the database. A fresh
    // token also fences late cleanup after this occurrence is deferred and reclaimed.
    const claimId = `run:${run.id}:${randomUUID()}`;
    const startedAt = new Date();
    // Queue time consumes no allowance. Publish the actual deadline with
    // ownership, before preparation can await another service. An automatic
    // continuation keeps its inherited deadline, moved by any credited wait.
    // A Run paused for a restart gets back the time it had left: the restart
    // and its wait in the queue spend none of its limit.
    const continuationDeadlineAt =
      run.pauseCount > 0
        ? new Date(startedAt.getTime() + resumeBudgetMs(run, routine.timeoutSec))
        : run.continuationCount > 0
          ? run.continuationDeadlineAt &&
            new Date(
              run.continuationDeadlineAt.getTime() +
                creditedQueueWaitMs({ createdAt: run.createdAt, startedAt }),
            )
          : new Date(startedAt.getTime() + Math.max(1, routine.timeoutSec) * 1000);
    const claimed = await claims.update(
      { id: run.id, status: "queued", queueActiveEmployeeId: IsNull() },
      {
        routineId: run.routineId,
        status: "running",
        queueActiveEmployeeId: claimId,
        startedAt,
        continuationDeadlineAt,
      },
    );
    if (claimed.affected !== 1) return null;
    // A due occurrence may have folded into this Run after it was read above.
    const current = await claims
      .createQueryBuilder("run")
      .select(["run.id", "run.missedSlots"])
      .addSelect("run.queueOptionsJson")
      .where("run.id = :runId", { runId: run.id })
      .getOne();
    if (current) {
      run.missedSlots = current.missedSlots;
      run.queueOptionsJson = current.queueOptionsJson;
    }
    if (!canClaim()) {
      // A stop may arrive during the claim's database round trip. Restore
      // its pending state before returning whenever the connection remains open.
      if (AppDataSource.isInitialized) {
        await claims.update(
          { id: run.id, status: "running", queueActiveEmployeeId: claimId },
          {
            routineId: run.routineId,
            status: "queued",
            queueActiveEmployeeId: null,
            startedAt: run.startedAt,
            continuationDeadlineAt: run.continuationDeadlineAt,
          },
        );
      }
      return null;
    }
    run.status = "running";
    run.startedAt = startedAt;
    run.continuationDeadlineAt = continuationDeadlineAt;
    run.queueActiveEmployeeId = claimId;
    return { run, routine };
  });
}

async function routineHasOtherClaim(
  repo: Repository<Run>,
  routineId: string,
  runId: string,
): Promise<boolean> {
  return (await claimedRuns(repo)).some(
    (other) => other.routineId === routineId && other.id !== runId,
  );
}

/** Keep the sibling-claim check and write indivisible across dispatchers. */
async function withRoutineAdmission<T>(
  routineId: string,
  claim: (repo: Repository<Run>) => Promise<T>,
): Promise<T | null> {
  if (admittingRoutines.has(routineId)) return null;
  admittingRoutines.add(routineId);
  try {
    if (config.db.driver !== "postgres") return await claim(AppDataSource.getRepository(Run));
    return await AppDataSource.transaction("READ COMMITTED", async (manager) => {
      // All Runs of this Routine lock the same row. An expiring lease alone
      // would not fence a stalled sibling-check/write across different Runs.
      // The next statement must see claims committed while this lock waited.
      const routine = await manager.getRepository(Routine).findOne({
        where: { id: routineId },
        select: { id: true },
        lock: { mode: "pessimistic_write" },
      });
      return routine ? claim(manager.getRepository(Run)) : null;
    });
  } finally {
    admittingRoutines.delete(routineId);
  }
}

/** Exact ownership, rather than a dispatch request still waiting for its lease. */
export function ownsRoutineRunClaim(runId: string, claim: string | null): boolean {
  return claim !== null && activeClaims.get(runId) === claim;
}

export async function hasLiveRoutineRunLease(run: Run, now: Date): Promise<boolean> {
  if (!run.queueActiveEmployeeId) return false;
  const lease = await AppDataSource.getRepository(SchedulerLease).findOneBy({
    // Employee-valued claims and their leases may remain after an upgrade.
    name: run.queueActiveEmployeeId.startsWith("run:")
      ? `routine-run:${run.id}`
      : `routine-queue:${run.queueActiveEmployeeId}`,
  });
  return !!lease?.expiresAt && lease.expiresAt > now;
}

async function skipQueuedRun(run: Run, reason: string): Promise<void> {
  const repo = AppDataSource.getRepository(Run);
  await repo.update(
    { id: run.id, status: "queued" },
    run.pauseCount > 0
      ? {
          // It had already worked: its transcript stays, and the stop is an
          // interruption of work under way, not a Run that never started.
          routineId: run.routineId,
          status: "error",
          errorKind: "interrupted",
          finishedAt: new Date(),
          logContent: `${run.logContent ?? ""}\n[queue] Paused for a restart, this Run could not continue: ${reason}\n`,
        }
      : {
          routineId: run.routineId,
          status: "skipped",
          finishedAt: new Date(),
          logContent: `[queue] ${reason}\n`,
        },
  );
  await settleQueuedApproval(run);
  await settleWaiter(run.id);
}

async function processRun(run: Run, routine: Routine): Promise<void> {
  const repo = AppDataSource.getRepository(Run);
  let deferred = false;
  try {
    const opts = JSON.parse(run.queueOptionsJson ?? "{}") as StartRunOptions;
    await executeQueuedRoutineRun(routine, run, opts);
  } catch (error) {
    if (error instanceof StanddownError) {
      // A stop that lands during preparation preserves this exact occurrence.
      deferred = true;
      await repo.update(
        { id: run.id, status: "running", queueActiveEmployeeId: run.queueActiveEmployeeId! },
        {
          routineId: run.routineId,
          status: "queued",
          queueActiveEmployeeId: null,
          startedAt: run.createdAt,
          // Return the wait this claim credited, so the next claim credits the
          // whole time since the continuation queued exactly once.
          ...(run.continuationCount > 0 && run.continuationDeadlineAt
            ? {
                continuationDeadlineAt: new Date(
                  run.continuationDeadlineAt.getTime() - creditedQueueWaitMs(run),
                ),
              }
            : {}),
        },
      );
    } else {
      const ineligible = error instanceof QueuedRoutineIneligibleError;
      // Work already under way that can no longer continue is an interruption,
      // not a Run that was skipped before it began.
      const skipped = ineligible && run.pauseCount <= 0;
      const retry =
        !ineligible &&
        routine.enabled &&
        !routine.requiresApproval &&
        shouldRetry({
          status: "error",
          errorKind: "runtime",
          triggerKind: run.triggerKind,
          attempt: run.attempt,
          maxAttempts: routine.maxAttempts,
          retryOnTimeout: routine.retryOnTimeout,
        });
      await repo.update(
        { id: run.id, status: "running", queueActiveEmployeeId: run.queueActiveEmployeeId! },
        {
          routineId: run.routineId,
          status: skipped ? "skipped" : "error",
          errorKind: skipped ? null : ineligible ? "interrupted" : "runtime",
          finishedAt: new Date(),
          retryAt: retry
            ? new Date(
                Date.now() +
                  automaticRetryDelayMs({
                    status: "error",
                    errorKind: "runtime",
                    attempt: run.attempt,
                    maxAttempts: routine.maxAttempts,
                    baseMs: routine.retryBackoffSec * 1000,
                  }),
              )
            : null,
          logContent:
            // A Run paused for a restart keeps the transcript it would have resumed from.
            (run.pauseCount > 0 ? `${run.logContent ?? ""}\n` : "") +
            `[queue] Unable to ${run.pauseCount > 0 ? "resume" : "start"} this Run: ${error instanceof Error ? error.message : "Unexpected dispatch error"}\n`,
        },
      );
    }
  } finally {
    await repo.update(
      { id: run.id, queueActiveEmployeeId: run.queueActiveEmployeeId! },
      {
        routineId: run.routineId,
        queueActiveEmployeeId: null,
      },
    );
    if (!deferred) {
      await settleQueuedApproval(run);
      await settleWaiter(run.id);
    }
  }
}

async function settleQueuedApproval(run: Run): Promise<void> {
  if (!run.queueOptionsJson?.includes("proactiveApprovalId")) return;
  try {
    await (await import("./proactive/approvals.js")).settleQueuedProactiveRoutineRun(run.id);
  } catch (error) {
    // Persisted dispatch provenance lets the approval sweep repair this boundary.
    // eslint-disable-next-line no-console
    console.error(`[routine-queue] could not settle the approval for Run ${run.id}:`, error);
  }
}

async function settleWaiter(runId: string): Promise<void> {
  const waiter = waiters.get(runId);
  if (!waiter) return;
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: runId });
  if (run?.status === "queued" || run?.status === "running" || run?.queueActiveEmployeeId) return;
  waiters.delete(runId);
  if (run) waiter.resolve(run);
  else waiter.reject(new Error("The queued Run was removed."));
}

/**
 * Offer every waiting Run its start, in queue order. Called by the heartbeat
 * after crash reconciliation (including the first after a restart), when a Run
 * is queued, and when a Run on a limited AI Model frees its slot.
 *
 * One pass at a time: a call during a pass asks for one more after it, and
 * resolves when that one is done. Within a pass Runs are offered one by one —
 * each start decided before the next Run is asked — so the order is the one
 * the queue promises, not whichever Run's database reads happened to finish
 * first. The order (`routineQueueOrder.ts`): Runs paused for a restart, then
 * continuations, then new work; within each, High priority before Normal,
 * and otherwise the order they were queued in.
 *
 * The order holds within one process — every SQLite install, and a Postgres
 * install with one replica. Replicas each keep it for the Runs they offer;
 * two offering a model's last slot in the same instant can start a Run one
 * place out of turn, never one Run twice (the claim still fences that).
 */
export function dispatchQueuedRoutineRuns(): Promise<void> {
  if (!canDispatch()) return Promise.resolve();
  passWanted = true;
  if (!passing) {
    passing = (async () => {
      try {
        while (passWanted && canDispatch()) {
          passWanted = false;
          await dispatchPass();
        }
      } finally {
        passing = null;
      }
    })();
  }
  return passing;
}

async function dispatchPass(): Promise<void> {
  for (const runId of waiters.keys()) {
    if (!canDispatch()) return;
    await settleWaiter(runId);
  }
  if (!canDispatch()) return;
  const pass: DispatchPass = { full: new Set() };
  for (const run of await queuedRunsInStartOrder()) {
    if (!canDispatch()) return;
    await requestRunDispatch(run.id, pass);
  }
}

type QueuedRunModel = {
  capacity: ModelRunCapacity;
  label: string;
  model: AIModel;
  continuation: boolean;
};

/** The model a queued Run will use, read the same way its start will read it. */
async function queuedRunModel(runId: string): Promise<QueuedRunModel | null> {
  const run = await AppDataSource.getRepository(Run).findOne({
    where: { id: runId, status: "queued" },
    select: { id: true, routineId: true, continuationCount: true, pauseCount: true },
  });
  if (!run) return null;
  const capacity = await routineModelCapacity(run.routineId);
  // A paused Run, like a continuation, finishes work already under way.
  return (
    capacity && { ...capacity, continuation: run.continuationCount > 0 || run.pauseCount > 0 }
  );
}

async function routineModelCapacity(
  routineId: string,
): Promise<Omit<QueuedRunModel, "continuation"> | null> {
  const routine = await AppDataSource.getRepository(Routine).findOne({
    where: { id: routineId },
    select: { id: true, employeeId: true, modelId: true },
  });
  if (!routine) return null;
  const { model } = await resolveRoutineModel(routine);
  return model ? { capacity: modelRunCapacity(model), label: model.model, model } : null;
}

/**
 * A Run on a self-hosted endpoint that failed with a model error may mean the
 * server is down; the queue then asks it before starting the next Run there.
 */
async function suspectOutageAfterModelFailure(runId: string, target: QueuedRunModel) {
  if (target.model.authMode !== "customEndpoint") return;
  const run = await AppDataSource.getRepository(Run).findOne({
    where: { id: runId },
    select: { id: true, errorKind: true, diagnosticsJson: true },
  });
  if (run?.errorKind !== "runtime") return;
  let failure: { category?: unknown; message?: unknown } | undefined;
  try {
    failure = (JSON.parse(run.diagnosticsJson ?? "null") as { failure?: typeof failure })?.failure;
  } catch {
    return;
  }
  if (
    failure?.category === "model" &&
    typeof failure.message === "string" &&
    isModelServiceUnavailable(failure.message)
  )
    suspectModelOutage(target.capacity.key);
}

/**
 * Say why a queued Run has not started, in its log. Never over a Run paused
 * for a restart: its log is its transcript so far, which it resumes from, and
 * its paused state already says why it waits.
 */
async function noteQueueWait(runId: string, values: { logContent: string }): Promise<void> {
  await AppDataSource.getRepository(Run).update(
    { id: runId, status: "queued", pauseCount: 0 },
    values,
  );
}

/** Say why a queued Run waits while its model server does not answer. */
async function noteHeldForUpgrade(runId: string): Promise<void> {
  await noteQueueWait(
    runId,
    {
      logContent:
        "[queue] Waiting for Genosyn to restart for an upgrade. This Run starts after the restart; " +
        "waiting does not count against its time limit.\n",
    },
  );
}

async function noteModelNotAnswering(runId: string, target: QueuedRunModel): Promise<void> {
  await noteQueueWait(
    runId,
    {
      logContent:
        `[queue] Waiting for the AI Model ${target.label}: its server is not answering. ` +
        `This Run starts once it does; waiting does not count against its time limit.\n`,
    },
  );
}

/** Long enough for the heartbeat to queue a handed-off continuation, short enough never to starve. */
export const CONTINUATION_SLOT_HOLD_MS = 2 * 60_000;

/**
 * A Run that hands its unfinished work to a continuation frees its model slot
 * seconds before the heartbeat queues that continuation, and a fresh Run that
 * can take hours would otherwise claim the slot first. Until the continuation
 * is queued, a fresh Run leaves one slot per pending continuation free. The
 * hold ends once the continuation exists, and two minutes after the handoff
 * whatever happens.
 */
async function slotHeldForContinuation(target: QueuedRunModel): Promise<boolean> {
  const limit = target.capacity.limit;
  if (limit == null) return false;
  const now = Date.now();
  const handoffs = await AppDataSource.getRepository(Run).find({
    where: {
      status: "failed",
      errorKind: IsNull(),
      continuationStopReason: IsNull(),
      retryAt: Between(
        new Date(now - CONTINUATION_SLOT_HOLD_MS),
        new Date(now + CONTINUATION_SLOT_HOLD_MS),
      ),
      finishedAt: MoreThanOrEqual(new Date(now - CONTINUATION_SLOT_HOLD_MS)),
    },
    select: { id: true, routineId: true, checkpointJson: true },
  });
  let pending = 0;
  for (const parent of handoffs) {
    if (readRunCheckpoint(parent)?.state !== "continue") continue;
    if ((await routineModelCapacity(parent.routineId))?.capacity.key === target.capacity.key)
      pending++;
  }
  return pending > 0 && (await modelRunSlotsInUse(target.capacity)) + pending >= limit;
}

async function noteWaitingForContinuation(runId: string, target: QueuedRunModel): Promise<void> {
  await noteQueueWait(
    runId,
    {
      logContent:
        `[queue] Waiting for the AI Model ${target.label}: another Routine's unfinished work continues there first. ` +
        `This Run starts as soon as a slot is free; waiting does not count against its time limit.\n`,
    },
  );
}

/** Say why a queued Run has not started, where a Member opening its log will look. */
async function noteWaitingForModel(runId: string, target: QueuedRunModel): Promise<void> {
  const limit = target.capacity.limit ?? 0;
  const inUse = Math.max(limit, await modelRunSlotsInUse(target.capacity));
  await noteQueueWait(
    runId,
    {
      logContent:
        `[queue] Waiting for the AI Model ${target.label}: ${inUse} Run${inUse === 1 ? " is" : "s are"} already using it, ` +
        `and it serves ${limit} at a time. This Run starts as soon as one finishes; waiting does not count against its time limit.\n`,
    },
  );
}

/** Test/restore seam: await work already owned by this process, without creating new work. */
export async function waitForRoutineQueueIdle(): Promise<void> {
  while (workers.size || passing) {
    await Promise.all(
      [...workers.values(), passing ?? Promise.resolve()].map((work) =>
        work.catch(() => undefined),
      ),
    );
  }
}

/** Release a crashed worker's claim only after its bounded assessment work can finish. */
export async function releaseOrphanedQueueSlots(
  singleProcessBoot: boolean,
  now: Date,
): Promise<void> {
  const repo = AppDataSource.getRepository(Run);
  // Every heartbeat runs this. Through the claim index it reads the few Runs
  // holding a claim; `IS NOT NULL` read every Run's transcript to find them.
  const rows = await repo.find({
    where: { queueActiveEmployeeId: MoreThan("") },
    select: {
      id: true,
      routineId: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      continuationDeadlineAt: true,
      queueActiveEmployeeId: true,
    },
  });
  for (const run of rows) {
    if (run.status === "running") continue;
    if (workers.has(run.id)) continue;
    // A terminal verdict precedes assessment and reflection. A live owner still
    // holds this claim, however old the Routine's original timeout has become.
    if (!singleProcessBoot && (await hasLiveRoutineRunLease(run, now))) continue;
    const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: run.routineId });
    // Grading and reflection each have a two-minute runtime ceiling. Even a
    // lost renewal must not release the claim while either turn can still run.
    const postRunDeadline = (run.finishedAt?.getTime() ?? 0) + 4 * 60_000;
    const cutoff =
      Math.max(
        run.continuationDeadlineAt?.getTime() ??
          run.startedAt.getTime() + Math.max(1, routine?.timeoutSec ?? DEFAULT_ROUTINE_TIMEOUT_SEC) * 1000,
        postRunDeadline,
      ) + ORPHAN_GRACE_MS;
    if (!singleProcessBoot && now.getTime() <= cutoff) continue;
    await repo.update(
      {
        id: run.id,
        status: Not("running"),
        queueActiveEmployeeId: run.queueActiveEmployeeId!,
      },
      { routineId: run.routineId, queueActiveEmployeeId: null },
    );
  }
  await AppDataSource.getRepository(SchedulerLease).delete({
    name: Like("routine-run:%"),
    expiresAt: LessThanOrEqual(now),
  });
}
