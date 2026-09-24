import { In, IsNull, Not } from "typeorm";
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

export class QueuedRoutineIneligibleError extends Error {}

/** Durable Runs are the queue; these promises are only local callers waiting for their result. */
const waiters = new Map<
  string,
  { resolve: (run: Run) => void; reject: (error: unknown) => void }
>();
const workers = new Map<string, Promise<void>>();
const requested = new Set<string>();

export function registerQueuedRun(run: Run): Promise<Run> {
  const completion = new Promise<Run>((resolve, reject) => {
    waiters.set(run.id, { resolve, reject });
  });
  // A caller may only need the accepted Run id. The durable result remains readable.
  void completion.catch(() => undefined);
  requestEmployeeDrain(run.employeeId!);
  return completion;
}

function requestEmployeeDrain(employeeId: string): void {
  requested.add(employeeId);
  if (workers.has(employeeId)) return;
  const work = Promise.resolve()
    .then(async () => {
      do {
        requested.delete(employeeId);
        await withSchedulerLease(`routine-queue:${employeeId}`, 90_000, async (lease) => {
          for (;;) {
            lease.assertHeld();
            const next = await claimNextRun(employeeId, lease.assertHeld);
            if (!next) return;
            // Keep the employee slot until assessment, reflection and cleanup also finish.
            await processRun(next.run, next.routine);
          }
        });
      } while (requested.has(employeeId));
    })
    .catch((error) => {
      // The next heartbeat resumes durable queued work after transient database failures.
      // eslint-disable-next-line no-console
      console.error(`[routine-queue] employee ${employeeId} dispatch failed:`, error);
    })
    .finally(() => {
      workers.delete(employeeId);
      if (requested.has(employeeId)) requestEmployeeDrain(employeeId);
    });
  workers.set(employeeId, work);
}

async function claimNextRun(
  employeeId: string,
  assertHeld: () => void,
): Promise<{ run: Run; routine: Routine } | null> {
  const repo = AppDataSource.getRepository(Run);
  if (await repo.existsBy({ queueActiveEmployeeId: employeeId })) return null;
  // A Run created before this feature was installed may lack its employee snapshot.
  if (
    await repo
      .createQueryBuilder("run")
      .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
      .where("routine.employeeId = :employeeId", { employeeId })
      .andWhere("run.status = :status", { status: "running" })
      .getExists()
  )
    return null;
  const pending = await repo
    .createQueryBuilder("run")
    .addSelect("run.queueOptionsJson")
    .where("run.employeeId = :employeeId AND run.status = :status", {
      employeeId,
      status: "queued",
    })
    .orderBy("run.createdAt", "ASC")
    .addOrderBy("run.id", "ASC")
    .getMany();
  for (const run of pending) {
    assertHeld();
    const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: run.routineId });
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
    if (!routine || !employee || routine.employeeId !== employeeId) {
      await skipQueuedRun(run, "The Routine or its AI Employee was removed or reassigned.");
      continue;
    }
    if (browserRunCreationBlocked({ employeeId, routineId: routine.id })) continue;
    if ((await workBlockedForRoutine(routine)).blocked) continue;
    const automatic = ["schedule", "retry", "event", "webhook", "continuation"].includes(
      run.triggerKind,
    );
    if (automatic && (!routine.enabled || routine.requiresApproval)) {
      await skipQueuedRun(
        run,
        routine.enabled
          ? "This Routine now requires human approval before starting."
          : "This Routine was disabled before its queued work started.",
      );
      continue;
    }
    assertHeld();
    try {
      const claimed = await repo.update(
        { id: run.id, status: "queued", queueActiveEmployeeId: IsNull() },
        {
          routineId: run.routineId,
          status: "running",
          queueActiveEmployeeId: employeeId,
          startedAt: new Date(),
        },
      );
      if (claimed.affected !== 1) continue;
    } catch (error) {
      // The unique slot also fences two replicas whose scheduler leases overlapped.
      const code = (error as { code?: string }).code;
      if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return null;
      throw error;
    }
    run.status = "running";
    run.queueActiveEmployeeId = employeeId;
    return { run, routine };
  }
  return null;
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
        { id: run.id, status: "running" },
        { routineId: run.routineId, status: "queued", startedAt: run.createdAt },
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
        { id: run.id, status: "running" },
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
      { id: run.id, queueActiveEmployeeId: run.employeeId! },
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
  for (const runId of waiters.keys()) await settleWaiter(runId);
  const rows = await AppDataSource.getRepository(Run).find({
    where: { status: "queued", employeeId: Not(IsNull()) },
    select: { employeeId: true },
  });
  for (const employeeId of new Set(rows.map((row) => row.employeeId!))) {
    requestEmployeeDrain(employeeId);
  }
}

/** Test/restore seam: await work already owned by this process, without creating new work. */
export async function waitForRoutineQueueIdle(): Promise<void> {
  await Promise.all(workers.values());
}

/** Release a crashed worker's post-Run slot only after its bounded assessment work can finish. */
export async function releaseOrphanedQueueSlots(
  singleProcessBoot: boolean,
  now: Date,
): Promise<void> {
  const repo = AppDataSource.getRepository(Run);
  const rows = await repo.find({ where: { queueActiveEmployeeId: Not(IsNull()) } });
  for (const run of rows) {
    if (run.status === "running") continue;
    if (workers.has(run.queueActiveEmployeeId!)) continue;
    const lease = await AppDataSource.getRepository(SchedulerLease).findOneBy({
      name: `routine-queue:${run.queueActiveEmployeeId}`,
    });
    // A terminal verdict precedes assessment and reflection. A live owner still
    // holds this slot, however old the Routine's original timeout has become.
    if (!singleProcessBoot && lease?.expiresAt && lease.expiresAt > now) continue;
    const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: run.routineId });
    // Grading and reflection each have a two-minute runtime ceiling. Even a
    // lost renewal must not release the slot while either turn can still run.
    const postRunDeadline = (run.finishedAt?.getTime() ?? 0) + 4 * 60_000;
    const cutoff =
      Math.max(
        run.startedAt.getTime() + Math.max(1, routine?.timeoutSec ?? 3600) * 1000,
        postRunDeadline,
      ) + ORPHAN_GRACE_MS;
    if (!singleProcessBoot && now.getTime() <= cutoff) continue;
    await repo.update(
      {
        id: run.id,
        status: Not(In(["running", "queued"])),
        queueActiveEmployeeId: run.queueActiveEmployeeId!,
      },
      { routineId: run.routineId, queueActiveEmployeeId: null },
    );
  }
}
