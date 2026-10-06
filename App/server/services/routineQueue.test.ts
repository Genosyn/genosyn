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
  ownsRoutineRunClaim,
  resumeRoutineQueue,
  stopRoutineQueue,
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

test(
  "simultaneous manual Runs of one Routine wait for the existing claim",
  { timeout: 20_000 },
  async (t) => {
    const { routine } = await fixture();
    const source = await routine("One occurrence at a time");
    const started = barrier();
    const release = barrier();
    const runs = AppDataSource.getRepository(Run);
    let calls = 0;
    t.mock.method(agentRuntime, "run", async () => {
      calls++;
      started.resolve();
      await release.promise;
      return { finalText: "Done", steps: 1, stopReason: "end_turn" };
    });
    const pending = await Promise.all([startRoutineRun(source), startRoutineRun(source)]);
    try {
      await started.promise;
      await Promise.all(Array.from({ length: 4 }, () => dispatchQueuedRoutineRuns()));
      const current = await runs.findBy({ routineId: source.id });
      assert.equal(current.filter((run) => run.status === "running").length, 1);
      assert.equal(current.filter((run) => run.status === "queued").length, 1);
      const owned = current.find((run) => run.status === "running")!;
      assert.equal(ownsRoutineRunClaim(owned.id, owned.queueActiveEmployeeId), true);
      assert.equal(ownsRoutineRunClaim(owned.id, "a different claim"), false);
      assert.equal(calls, 1);
    } finally {
      release.resolve();
      await waitForRoutineQueueIdle();
      await dispatchQueuedRoutineRuns();
      await Promise.all(pending.map((run) => run.completion));
    }
    assert.equal(calls, 2);
    for (const run of await runs.findBy({ routineId: source.id })) {
      assert.equal(run.queueActiveEmployeeId, null);
      assert.equal(ownsRoutineRunClaim(run.id, "any old claim"), false);
    }
  },
);

test("a rejected admission write does not poison later Routine dispatch", async (t) => {
  const { routine } = await fixture();
  const source = await routine("Retry admission");
  const runs = AppDataSource.getRepository(Run);
  const update = runs.update.bind(runs);
  let rejectOnce = true;
  t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
    if (rejectOnce && args[1].status === "running") {
      rejectOnce = false;
      throw new Error("Synthetic admission outage");
    }
    return update(...args);
  });
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Done",
    steps: 1,
    stopReason: "end_turn",
  }));
  const pending = await startRoutineRun(source);
  await waitForRoutineQueueIdle();
  assert.equal((await runs.findOneByOrFail({ id: pending.run.id })).status, "queued");
  await dispatchQueuedRoutineRuns();
  assert.equal((await pending.completion).status, "completed");
});

test("a failed claim cleanup does not leave stale local ownership", async (t) => {
  const { routine } = await fixture();
  const source = await routine("Cleanup failure");
  const runs = AppDataSource.getRepository(Run);
  const update = runs.update.bind(runs);
  let claimed: string | null = null;
  let failCleanup = true;
  t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
    if (args[1].status === "running" && typeof args[1].queueActiveEmployeeId === "string")
      claimed = args[1].queueActiveEmployeeId;
    if (failCleanup && args[1].status === undefined && args[1].queueActiveEmployeeId === null) {
      failCleanup = false;
      throw new Error("Synthetic cleanup outage");
    }
    return update(...args);
  });
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Done",
    steps: 1,
    stopReason: "end_turn",
  }));
  const pending = await startRoutineRun(source);
  await waitForRoutineQueueIdle();
  assert.ok(claimed);
  assert.equal(ownsRoutineRunClaim(pending.run.id, claimed), false);
  assert.equal((await runs.findOneByOrFail({ id: pending.run.id })).queueActiveEmployeeId, claimed);
  await releaseOrphanedQueueSlots(false, new Date(Date.now() + 6 * 60_000));
  await dispatchQueuedRoutineRuns();
  assert.equal((await pending.completion).queueActiveEmployeeId, null);
});

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
    // These tests are about queue ownership, not model capacity: let every
    // Routine reach the (mocked) model at once, as a hosted API would.
    maxConcurrentRuns: 0,
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

test(
  "independent Routines run concurrently for one employee across dispatch origins",
  { timeout: 20_000 },
  async (t) => {
    const { employee, routine } = await fixture();
    const origins = ["manual", "schedule", "retry", "event", "webhook", "approval"] as const;
    const allStarted = barrier();
    const release = barrier();
    t.after(release.resolve);
    let active = 0;
    let maximum = 0;
    let dispatchChecks = 0;
    t.mock.method(agentRuntime, "run", async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === origins.length) allStarted.resolve();
      await release.promise;
      active--;
      return { finalText: "Done", steps: 1, stopReason: "end_turn" };
    });
    const pending = await Promise.all(
      origins.map(async (triggerKind) => {
        const source = await routine(triggerKind);
        const parent =
          triggerKind === "retry"
            ? await insert(Run, {
                employeeId: employee.id,
                routineId: source.id,
                status: "error",
                errorKind: "runtime",
                triggerKind: "schedule",
                startedAt: new Date(),
                finishedAt: new Date(),
              })
            : null;
        return startRoutineRun(source, {
          triggerKind,
          ...(parent ? { parentRunId: parent.id, attempt: 2 } : {}),
          beforeRunPersist: async () => {
            dispatchChecks++;
          },
        });
      }),
    );
    await allStarted.promise;
    assert.equal(maximum, origins.length);
    assert.equal(dispatchChecks, origins.length, "caller claims are checked once at acceptance");
    const running = await AppDataSource.getRepository(Run).findBy({
      employeeId: employee.id,
      status: "running",
    });
    assert.equal(running.length, origins.length);
    assert.ok(running.every((run) => run.status === "running"));
    assert.equal(new Set(running.map((run) => run.queueActiveEmployeeId)).size, origins.length);
    // Repeated heartbeats must not start a second copy of an already-owned Run.
    await Promise.all(Array.from({ length: 5 }, () => dispatchQueuedRoutineRuns()));
    assert.equal(active, origins.length);
    release.resolve();
    const results = await Promise.all(pending.map((run) => run.completion));
    assert.ok(results.every((run) => run.status === "completed" || run.status === "reviewed"));
    assert.ok(results.every((run) => run.queueActiveEmployeeId === null));
  },
);

test("deferred dispatch consumes no Run allowance before work starts", async (t) => {
  const { routine } = await fixture();
  stopRoutineQueue();
  const pending = await startRoutineRun(await routine("Deferred"));
  await AppDataSource.getRepository(Run).update(pending.run.id, {
    startedAt: new Date(Date.now() - 120_000),
    continuationDeadlineAt: new Date(0),
  });
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Done",
    steps: 1,
    stopReason: "end_turn",
  }));
  await resumeRoutineQueue();
  const completed = await pending.completion;
  assert.equal(completed.status, "completed", completed.logContent);
  assert.ok(completed.startedAt.getTime() >= pending.run.createdAt.getTime());
  assert.equal(completed.continuationDeadlineAt!.getTime() - completed.startedAt.getTime(), 60_000);
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

test("an abandoned employee claim cannot block another Routine, and recovery still finalizes it", async (t) => {
  const { employee, routine } = await fixture();
  const first = await routine("Interrupted");
  const next = await routine("Ready");
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
  const ready = await startRoutineRun(next);
  assert.equal((await ready.completion).status, "completed");
  assert.equal(calls, 1);
  await reconcileOrphanedRuns({ boot: true });
  const recovered = await AppDataSource.getRepository(Run).findOneByOrFail({ id: abandoned.id });
  assert.equal(recovered.status, "error");
  assert.equal(recovered.queueActiveEmployeeId, null);
});

test("boot recovery releases a legacy claim stranded on a deferred Run", async (t) => {
  const { employee, routine } = await fixture();
  const source = await routine("DeferredBeforeUpgrade");
  const stranded = await insert(Run, {
    routineId: source.id,
    employeeId: employee.id,
    queueActiveEmployeeId: employee.id,
    queueOptionsJson: JSON.stringify({ triggerKind: "manual" }),
    status: "queued",
    startedAt: new Date(),
    triggerKind: "manual",
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  await reconcileOrphanedRuns({ boot: true });
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: stranded.id }))
      .queueActiveEmployeeId,
    null,
  );
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: stranded.id })).status,
    "completed",
  );
  assert.equal(calls, 1);
});

test("a Standdown defers only covered work while other Routines start concurrently", async (t) => {
  const { company, routine } = await fixture();
  const heldRoutine = await routine("Held");
  const readyRoutine = await routine("Ready");
  const otherRoutine = await routine("Other");
  stopRoutineQueue();
  const held = await startRoutineRun(heldRoutine);
  const standdown = await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: heldRoutine.id,
    reason: "Review the source data first.",
  });
  const bothStarted = barrier();
  const release = barrier();
  t.after(release.resolve);
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    if (++calls === 2) bothStarted.resolve();
    await release.promise;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const ready = await startRoutineRun(readyRoutine);
  const other = await startRoutineRun(otherRoutine);
  await resumeRoutineQueue();
  await bothStarted.promise;
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: held.run.id })).status,
    "queued",
  );
  assert.equal(calls, 2);
  release.resolve();
  await Promise.all([ready.completion, other.completion]);
  await liftStanddown({ standdown });
  await dispatchQueuedRoutineRuns();
  assert.equal((await held.completion).status, "completed");
  assert.equal(calls, 3);
});

test("a Standdown during preparation durably releases the claim without clearing a replacement owner", async (t) => {
  const { company, routine } = await fixture();
  const source = await routine("DeferredDuringPreparation");
  const repo = AppDataSource.getRepository(Run);
  const update = repo.update.bind(repo);
  const deferred = barrier();
  const release = barrier();
  t.after(release.resolve);
  let standdown: Awaited<ReturnType<typeof placeStanddown>> | undefined;
  let originalClaim: string | undefined;
  t.mock.method(repo, "update", async (...args: Parameters<typeof repo.update>) => {
    const result = await update(...args);
    if (!standdown && args[1].status === "running" && args[1].queueActiveEmployeeId) {
      originalClaim = args[1].queueActiveEmployeeId as string;
      standdown = await placeStanddown({
        companyId: company.id,
        scope: "routine",
        scopeId: source.id,
        reason: "Stop before preparation finishes.",
      });
    } else if (args[1].status === "queued") {
      deferred.resolve();
      await release.promise;
    }
    return result;
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const pending = await startRoutineRun(source);
  await deferred.promise;
  const durable = await repo.findOneByOrFail({ id: pending.run.id });
  assert.equal(durable.status, "queued");
  assert.equal(
    durable.queueActiveEmployeeId,
    null,
    "a crash before cleanup must leave dispatchable work",
  );
  const replacementClaim = `run:${pending.run.id}:replacement`;
  assert.notEqual(originalClaim, replacementClaim);
  await update(pending.run.id, { status: "running", queueActiveEmployeeId: replacementClaim });
  release.resolve();
  await waitForRoutineQueueIdle();
  assert.equal(
    (await repo.findOneByOrFail({ id: pending.run.id })).queueActiveEmployeeId,
    replacementClaim,
    "late cleanup must never clear a different process's claim",
  );
  assert.equal(calls, 0);
  // Finish the simulated replacement owner and let the durable occurrence resume.
  await update(pending.run.id, { status: "queued", queueActiveEmployeeId: null });
  assert.ok(standdown);
  await liftStanddown({ standdown });
  await dispatchQueuedRoutineRuns();
  assert.equal((await pending.completion).status, "completed");
  assert.equal(calls, 1);
});

for (const scope of ["routine", "employee"] as const) {
  test(
    `a Standdown at ${scope} scope interrupts only the covered concurrent Runs`,
    { timeout: 20_000 },
    async (t) => {
      const { company, employee, routine } = await fixture();
      const stoppedRoutine = await routine("Stopped");
      const otherRoutine = await routine("Other");
      const bothStarted = barrier();
      const release = barrier();
      t.after(release.resolve);
      const signals: AbortSignal[] = [];
      t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
        assert.ok(params.signal);
        signals.push(params.signal);
        if (signals.length === 2) bothStarted.resolve();
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) =>
            params.signal!.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        return { finalText: "Done", steps: 1, stopReason: "end_turn" };
      });
      const first = await startRoutineRun(stoppedRoutine);
      const second = await startRoutineRun(otherRoutine);
      await bothStarted.promise;
      await placeStanddown({
        companyId: company.id,
        scope,
        scopeId: scope === "routine" ? stoppedRoutine.id : employee.id,
        reason: "Stop the covered work.",
      });
      assert.equal(signals.filter((signal) => signal.aborted).length, scope === "routine" ? 1 : 2);
      assert.equal((await first.completion).errorKind, "interrupted");
      if (scope === "routine") {
        assert.equal(
          (await AppDataSource.getRepository(Run).findOneByOrFail({ id: second.run.id })).status,
          "running",
        );
      }
      release.resolve();
      const other = await second.completion;
      assert.equal(other.status, scope === "routine" ? "completed" : "error");
      assert.ok(other.queueActiveEmployeeId === null);
    },
  );
}

test("deferred scheduled work rechecks a newly-added approval gate before any model call", async (t) => {
  const { routine } = await fixture();
  const protectedRoutine = await routine("Protected");
  stopRoutineQueue();
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Must not execute", steps: 1, stopReason: "end_turn" };
  });
  const pending = await startRoutineRun(protectedRoutine, { triggerKind: "schedule" });
  await AppDataSource.getRepository(Routine).update(protectedRoutine.id, {
    requiresApproval: true,
  });
  await resumeRoutineQueue();
  assert.equal((await pending.completion).status, "skipped");
  assert.equal(calls, 0);
});

for (const legacy of [false, true])
  test(`a live ${legacy ? "legacy employee" : "Run"} assessment claim survives its Routine work deadline`, async () => {
    const { employee, routine } = await fixture();
    const source = await routine("Assessed");
    const run = await insert(Run, {
      routineId: source.id,
      employeeId: employee.id,
      status: "completed",
      startedAt: new Date(Date.now() - 240_000),
      finishedAt: new Date(),
    });
    const claimId = legacy ? employee.id : `run:${run.id}`;
    const leaseName = legacy ? `routine-queue:${employee.id}` : `routine-run:${run.id}`;
    await AppDataSource.getRepository(Run).update(run.id, { queueActiveEmployeeId: claimId });
    await insert(SchedulerLease, {
      name: leaseName,
      holderId: "live-peer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await releaseOrphanedQueueSlots(false, new Date());
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id }))
        .queueActiveEmployeeId,
      claimId,
    );
    await AppDataSource.getRepository(SchedulerLease).update(
      { name: leaseName },
      { expiresAt: new Date(0) },
    );
    await releaseOrphanedQueueSlots(false, new Date());
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id }))
        .queueActiveEmployeeId,
      claimId,
      "a lost renewal still preserves the bounded assessment window",
    );
    await releaseOrphanedQueueSlots(false, new Date(Date.now() + 301_000));
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id }))
        .queueActiveEmployeeId,
      null,
    );
  });

test("orphan recovery removes expired dispatch leases and retains live or unrelated leases", async () => {
  const now = new Date();
  const leases = AppDataSource.getRepository(SchedulerLease);
  for (const [name, expiresAt] of [
    ["routine-run:abandoned", new Date(0)],
    ["routine-run:active", new Date(now.getTime() + 60_000)],
    ["other-scheduler", new Date(0)],
  ] as const)
    await insert(SchedulerLease, { name, holderId: "peer", expiresAt });
  await releaseOrphanedQueueSlots(false, now);
  assert.equal(await leases.existsBy({ name: "routine-run:abandoned" }), false);
  assert.equal(await leases.existsBy({ name: "routine-run:active" }), true);
  assert.equal(await leases.existsBy({ name: "other-scheduler" }), true);
});

test("deferred preparation retains its restricted scope when the Routine is edited", async (t) => {
  const { routine } = await fixture();
  const restricted = await routine("Restricted");
  await AppDataSource.getRepository(Routine).update(restricted.id, { mailDeliveryMode: "draft" });
  restricted.mailDeliveryMode = "draft";
  stopRoutineQueue();
  const pending = await startRoutineRun(restricted);
  await AppDataSource.getRepository(Routine).update(restricted.id, { mailDeliveryMode: null });
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    assert.match(params.system, /proactive preparation/);
    return { finalText: "Prepared", steps: 1, stopReason: "end_turn" };
  });
  await resumeRoutineQueue();
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
  stopCron();
  const second = await startRoutineRun(secondRoutine);
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
