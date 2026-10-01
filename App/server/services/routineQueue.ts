import { randomUUID } from "node:crypto";
import { IsNull, LessThanOrEqual, Like, Not, type Repository } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { executeQueuedRoutineRun, type StartRunOptions } from "./runner.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { StanddownError, workBlockedForRoutine } from "./standdowns.js";
import { browserRunCreationBlocked } from "./browserRecordings.js";
import { automaticRetryDelayMs, ORPHAN_GRACE_MS, shouldRetry } from "./cronMath.js";
import { resolveRoutineModel } from "./models.js";
import { creditedQueueWaitMs } from "./runContinuation.js";
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
const requested = new Set<string>();
let dispatchEnabled = true;
let dispatchGeneration = 0;

function canDispatch(): boolean {
  return dispatchEnabled && AppDataSource.isInitialized;
}

/** Stop new claims before restore closes the database; active Runs keep their existing lifecycle. */
export function stopRoutineQueue(): void {
  dispatchEnabled = false;
  dispatchGeneration++;
  requested.clear();
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
  requestRunDispatch(run.id);
  return completion;
}

function requestRunDispatch(runId: string): void {
  if (!canDispatch()) return;
  requested.add(runId);
  if (workers.has(runId)) return;
  const generation = dispatchGeneration;
  const canClaim = (): boolean => canDispatch() && generation === dispatchGeneration;
  const work = Promise.resolve()
    .then(async () => {
      do {
        if (!canClaim()) return;
        requested.delete(runId);
        await withSchedulerLease(`routine-run:${runId}`, 90_000, async (lease) => {
          if (!canClaim()) return;
          lease.assertHeld();
          // A saturated model admits no more Runs. This one stays queued, and
          // because its deadline starts at the claim, waiting costs it nothing.
          const target = await queuedRunModel(runId);
          if (!canClaim()) return;
          let started = false;
          const slot = await withModelRunSlot(target?.capacity ?? null, async () => {
            const next = await claimRun(runId, lease.assertHeld, canClaim);
            if (!next) return;
            started = true;
            // Each Run owns its lifecycle independently, including assessment and cleanup.
            const claim = next.run.queueActiveEmployeeId!;
            activeClaims.set(runId, claim);
            try {
              await processRun(next.run, next.routine);
            } finally {
              if (activeClaims.get(runId) === claim) activeClaims.delete(runId);
            }
          });
          if (!slot.admitted && target) await noteWaitingForModel(runId, target);
          // Offer the slot this Run used to the next waiting Run now, not at
          // the next heartbeat — and before this worker ends, so anyone
          // awaiting an idle queue sees the next Run. A Run whose claim was
          // refused for another reason (an earlier Run still cleaning up, a
          // Standdown) used nothing: re-dispatching would only offer it the
          // same slot again, forever. A failure here waits for the heartbeat.
          if (started && target?.capacity.limit != null)
            await dispatchQueuedRoutineRuns().catch(() => undefined);
        });
      } while (canClaim() && requested.has(runId));
    })
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
      if (canDispatch() && requested.has(runId)) requestRunDispatch(runId);
    });
  workers.set(runId, work);
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
    if (
      await claims.existsBy({
        routineId: routine.id,
        id: Not(run.id),
        queueActiveEmployeeId: Not(IsNull()),
      })
    )
      return null;
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
    const continuationDeadlineAt =
      run.continuationCount > 0
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
    {
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
        },
      );
    } else {
      const skipped = error instanceof QueuedRoutineIneligibleError;
      const retry =
        !skipped &&
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
          errorKind: skipped ? null : "runtime",
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
          logContent: `[queue] Unable to start this Run: ${error instanceof Error ? error.message : "Unexpected dispatch error"}\n`,
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

/** Called after crash reconciliation on every heartbeat, including the first after restart. */
export async function dispatchQueuedRoutineRuns(): Promise<void> {
  if (!canDispatch()) return;
  for (const runId of waiters.keys()) {
    if (!canDispatch()) return;
    await settleWaiter(runId);
  }
  if (!canDispatch()) return;
  // Oldest first, so a Run waiting for a busy AI Model is offered a freed slot
  // before Runs queued after it. Continuations go ahead of fresh work: they
  // finish an occurrence that has already started.
  const rows = await AppDataSource.getRepository(Run).find({
    where: { status: "queued", employeeId: Not(IsNull()) },
    select: { id: true, continuationCount: true },
    order: { createdAt: "ASC" },
  });
  const continuing = rows.filter((run) => run.continuationCount > 0);
  const fresh = rows.filter((run) => run.continuationCount <= 0);
  for (const run of [...continuing, ...fresh]) requestRunDispatch(run.id);
}

type QueuedRunModel = { capacity: ModelRunCapacity; label: string };

/** The model a queued Run will use, read the same way its start will read it. */
async function queuedRunModel(runId: string): Promise<QueuedRunModel | null> {
  const run = await AppDataSource.getRepository(Run).findOne({
    where: { id: runId, status: "queued" },
    select: { id: true, routineId: true },
  });
  if (!run) return null;
  const routine = await AppDataSource.getRepository(Routine).findOne({
    where: { id: run.routineId },
    select: { id: true, employeeId: true, modelId: true },
  });
  if (!routine) return null;
  const { model } = await resolveRoutineModel(routine);
  return model ? { capacity: modelRunCapacity(model), label: model.model } : null;
}

/** Say why a queued Run has not started, where a Member opening its log will look. */
async function noteWaitingForModel(runId: string, target: QueuedRunModel): Promise<void> {
  const limit = target.capacity.limit ?? 0;
  const inUse = Math.max(limit, await modelRunSlotsInUse(target.capacity));
  await AppDataSource.getRepository(Run).update(
    { id: runId, status: "queued" },
    {
      logContent:
        `[queue] Waiting for the AI Model ${target.label}: ${inUse} Run${inUse === 1 ? " is" : "s are"} already using it, ` +
        `and it serves ${limit} at a time. This Run starts as soon as one finishes; waiting does not count against its time limit.\n`,
    },
  );
}

/** Test/restore seam: await work already owned by this process, without creating new work. */
export async function waitForRoutineQueueIdle(): Promise<void> {
  while (workers.size) await Promise.all(workers.values());
}

/** Release a crashed worker's claim only after its bounded assessment work can finish. */
export async function releaseOrphanedQueueSlots(
  singleProcessBoot: boolean,
  now: Date,
): Promise<void> {
  const repo = AppDataSource.getRepository(Run);
  const rows = await repo.find({ where: { queueActiveEmployeeId: Not(IsNull()) } });
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
          run.startedAt.getTime() + Math.max(1, routine?.timeoutSec ?? 3600) * 1000,
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
