import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { startRoutineRun } from "./runner.js";
import {
  dispatchQueuedRoutineRuns,
  releaseOrphanedQueueSlots,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import { stopCron } from "./cron.js";
import { reconcileOrphanedRuns } from "./runRecovery.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(name = "Jamie", company?: Company) {
  company ??= await insert(Company, { name: "Queue Co", slug: "queue-co", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name,
    slug: name.toLowerCase(),
    role: "Operations",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "queue-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "queue-test",
    }),
  });
  const routine = (name: string) =>
    insert(Routine, {
      employeeId: employee.id,
      name,
      slug: name.toLowerCase(),
      cronExpr: "0 9 * * *",
      timeoutSec: 60,
      body: `Perform ${name}.`,
    });
  return { company, employee, routine };
}

test("all origins queue in order for one employee and waiting consumes no Run allowance", async (t) => {
  const { employee, routine } = await fixture();
  const firstRoutine = await routine("First");
  const secondRoutine = await routine("Second");
  const thirdRoutine = await routine("Third");
  const started = barrier();
  const release = barrier();
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  t.mock.method(agentRuntime, "run", async () => {
    active++;
    maximum = Math.max(maximum, active);
    const run = await AppDataSource.getRepository(Run).findOneByOrFail({
      employeeId: employee.id,
      status: "running",
    });
    order.push(run.routineId);
    if (order.length === 1) {
      started.resolve();
      await release.promise;
    }
    active--;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const first = await startRoutineRun(firstRoutine);
  await started.promise;
  let dispatchChecks = 0;
  const second = await startRoutineRun(secondRoutine, {
    triggerKind: "webhook",
    beforeRunPersist: async () => {
      dispatchChecks++;
    },
  });
  const third = await startRoutineRun(thirdRoutine, { triggerKind: "approval" });
  assert.equal(second.run.status, "queued");
  assert.equal(third.run.status, "queued");
  assert.equal(dispatchChecks, 1, "expiring caller claims are checked at enqueue time");
  await AppDataSource.getRepository(Run).update(second.run.id, {
    startedAt: new Date(Date.now() - 120_000),
    continuationDeadlineAt: new Date(0),
  });
  release.resolve();
  const results = await Promise.all([first.completion, second.completion, third.completion]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, [firstRoutine.id, secondRoutine.id, thirdRoutine.id]);
  assert.ok(results.every((run) => run.status === "completed" || run.status === "reviewed"));
  assert.equal(dispatchChecks, 1);
  assert.ok(results[1].startedAt.getTime() >= second.run.createdAt.getTime());
  assert.equal(
    results[1].continuationDeadlineAt!.getTime() - results[1].startedAt.getTime(),
    60_000,
  );
  assert.ok(results.every((run) => run.queueActiveEmployeeId === null));
});

test("different employees can perform Routines concurrently", async (t) => {
  const one = await fixture();
  const two = await fixture("Casey", one.company);
  const bothStarted = barrier();
  const release = barrier();
  let active = 0;
  t.mock.method(agentRuntime, "run", async () => {
    active++;
    if (active === 2) bothStarted.resolve();
    await release.promise;
    active--;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const first = await startRoutineRun(await one.routine("One"));
  const second = await startRoutineRun(await two.routine("Two"));
  await bothStarted.promise;
  assert.equal(active, 2);
  release.resolve();
  await Promise.all([first.completion, second.completion]);
});

test("queued occurrences survive recovery and start after the abandoned employee slot is released", async (t) => {
  const { employee, routine } = await fixture();
  const first = await routine("Interrupted");
  const next = await routine("Waiting");
  const abandoned = await insert(Run, {
    routineId: first.id,
    employeeId: employee.id,
    queueActiveEmployeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    triggerKind: "manual",
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const waiting = await startRoutineRun(next);
  await waitForRoutineQueueIdle();
  assert.equal(calls, 0);
  await reconcileOrphanedRuns({ boot: true });
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: abandoned.id })).status,
    "error",
  );
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: waiting.run.id })).status,
    "queued",
  );
  await dispatchQueuedRoutineRuns();
  assert.equal((await waiting.completion).status, "completed");
  assert.equal(calls, 1);
});

test("a Standdown holds queued work while other ready Routines can proceed, then resumes it", async (t) => {
  const { company, routine } = await fixture();
  const firstRoutine = await routine("First");
  const heldRoutine = await routine("Held");
  const readyRoutine = await routine("Ready");
  const started = barrier();
  const release = barrier();
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
    }
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const first = await startRoutineRun(firstRoutine);
  await started.promise;
  const held = await startRoutineRun(heldRoutine);
  const ready = await startRoutineRun(readyRoutine);
  const standdown = await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: heldRoutine.id,
    reason: "Review the source data first.",
  });
  release.resolve();
  await Promise.all([first.completion, ready.completion]);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: held.run.id })).status,
    "queued",
  );
  assert.equal(calls, 2);
  await liftStanddown({ standdown });
  await dispatchQueuedRoutineRuns();
  assert.equal((await held.completion).status, "completed");
  assert.equal(calls, 3);
});

test("queued scheduled work rechecks a newly-added approval gate before any model call", async (t) => {
  const { employee, routine } = await fixture();
  const source = await routine("Source");
  const protectedRoutine = await routine("Protected");
  const occupied = await insert(Run, {
    routineId: source.id,
    employeeId: employee.id,
    queueActiveEmployeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    triggerKind: "manual",
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Must not execute", steps: 1, stopReason: "end_turn" };
  });
  const pending = await startRoutineRun(protectedRoutine, { triggerKind: "schedule" });
  await waitForRoutineQueueIdle();
  await AppDataSource.getRepository(Routine).update(protectedRoutine.id, {
    requiresApproval: true,
  });
  await AppDataSource.getRepository(Run).update(occupied.id, {
    status: "completed",
    queueActiveEmployeeId: null,
  });
  await dispatchQueuedRoutineRuns();
  assert.equal((await pending.completion).status, "skipped");
  assert.equal(calls, 0);
});

test("a live assessment lease retains its employee slot beyond the Routine work deadline", async () => {
  const { employee, routine } = await fixture();
  const source = await routine("Assessed");
  const run = await insert(Run, {
    routineId: source.id,
    employeeId: employee.id,
    queueActiveEmployeeId: employee.id,
    status: "completed",
    startedAt: new Date(Date.now() - 240_000),
    finishedAt: new Date(),
  });
  await insert(SchedulerLease, {
    name: `routine-queue:${employee.id}`,
    holderId: "live-peer",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await releaseOrphanedQueueSlots(false, new Date());
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).queueActiveEmployeeId,
    employee.id,
  );
  await AppDataSource.getRepository(SchedulerLease).update(
    { name: `routine-queue:${employee.id}` },
    { expiresAt: new Date(0) },
  );
  await releaseOrphanedQueueSlots(false, new Date());
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).queueActiveEmployeeId,
    employee.id,
    "a lost renewal still preserves the bounded assessment window",
  );
  await releaseOrphanedQueueSlots(false, new Date(Date.now() + 301_000));
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).queueActiveEmployeeId,
    null,
  );
});

test("queued preparation retains its restricted scope when the Routine is edited", async (t) => {
  const { employee, routine } = await fixture();
  const source = await routine("Source");
  const restricted = await routine("Restricted");
  await AppDataSource.getRepository(Routine).update(restricted.id, { mailDeliveryMode: "draft" });
  restricted.mailDeliveryMode = "draft";
  const occupied = await insert(Run, {
    routineId: source.id,
    employeeId: employee.id,
    queueActiveEmployeeId: employee.id,
    status: "running",
    startedAt: new Date(),
  });
  const pending = await startRoutineRun(restricted);
  await waitForRoutineQueueIdle();
  await AppDataSource.getRepository(Routine).update(restricted.id, { mailDeliveryMode: null });
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    assert.match(params.system, /proactive preparation/);
    return { finalText: "Prepared", steps: 1, stopReason: "end_turn" };
  });
  await AppDataSource.getRepository(Run).update(occupied.id, {
    status: "completed",
    queueActiveEmployeeId: null,
  });
  await dispatchQueuedRoutineRuns();
  const completed = await pending.completion;
  assert.equal(completed.status, "reviewed", completed.logContent);
  assert.equal(completed.continuationReviewOnly, true);
});

test("stopping cron lets the active Run finish but holds queued work until resume", async (t) => {
  const { routine } = await fixture();
  const firstRoutine = await routine("First");
  const secondRoutine = await routine("Second");
  const thirdRoutine = await routine("Third");
  const started = barrier();
  const release = barrier();
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
    }
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const first = await startRoutineRun(firstRoutine);
  await started.promise;
  const second = await startRoutineRun(secondRoutine);
  stopCron();
  const third = await startRoutineRun(thirdRoutine);
  release.resolve();
  assert.equal((await first.completion).status, "completed");
  await waitForRoutineQueueIdle();
  await dispatchQueuedRoutineRuns();
  assert.equal(calls, 1);
  for (const pending of [second, third]) {
    const row = await AppDataSource.getRepository(Run).findOneByOrFail({ id: pending.run.id });
    assert.equal(row.status, "queued");
    assert.equal(row.queueActiveEmployeeId, null);
  }
  await resumeRoutineQueue();
  await Promise.all([second.completion, third.completion]);
  assert.equal(calls, 3);
});

test("a stop during claim persistence returns the occurrence to the durable queue", async (t) => {
  const { routine } = await fixture();
  const source = await routine("Claiming");
  const repo = AppDataSource.getRepository(Run);
  const update = repo.update.bind(repo);
  let stopped = false;
  t.mock.method(repo, "update", async (...args: Parameters<typeof repo.update>) => {
    const result = await update(...args);
    if (!stopped && args[1].status === "running" && args[1].queueActiveEmployeeId) {
      stopped = true;
      stopCron();
    }
    return result;
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const pending = await startRoutineRun(source);
  await waitForRoutineQueueIdle();
  const restored = await repo.findOneByOrFail({ id: pending.run.id });
  assert.equal(stopped, true);
  assert.equal(restored.status, "queued");
  assert.equal(restored.queueActiveEmployeeId, null);
  assert.equal(calls, 0);
  await resumeRoutineQueue();
  assert.equal((await pending.completion).status, "completed");
  assert.equal(calls, 1);
});

test("resume before database initialization cannot restart queued work", async (t) => {
  stopCron();
  await closeTestDb();
  await resumeRoutineQueue();
  await dispatchQueuedRoutineRuns();
  await initTestDb();
  const { routine } = await fixture();
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const pending = await startRoutineRun(await routine("AfterRestore"));
  await waitForRoutineQueueIdle();
  assert.equal(calls, 0);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: pending.run.id })).status,
    "queued",
  );
  await resumeRoutineQueue();
  assert.equal((await pending.completion).status, "completed");
  assert.equal(calls, 1);
});
