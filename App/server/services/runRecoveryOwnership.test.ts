import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { config } from "../../config.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { dispatchDueRetries } from "./cron.js";
import { reconcileOrphanedRuns } from "./runRecovery.js";
import { assertManualResumeSource, manualResumeEligibility } from "./runManualResume.js";
import { startRoutineRun } from "./runner.js";
import { DurableRunLog } from "./runLog.js";
import {
  dispatchQueuedRoutineRuns,
  releaseOrphanedQueueSlots,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
  stopRoutineQueue,
} from "./routineQueue.js";
import { stopStanddowns } from "./standdowns.js";

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

async function observed(promise: Promise<unknown>) {
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Expected runtime boundary was not reached")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const checkpointJson = JSON.stringify({
  state: "continue",
  completed: "Read records 1 through 5.",
  remaining: "Read records 6 through 10.",
  resume: "Resume the captured inventory at record 6.",
  progressKey: "record-5",
});
const success = { finalText: "Done", steps: 1, stopReason: "end_turn" as const };

for (const boot of [false, true]) {
  test(`recovery preserves an owned captured deadline after a shorter Routine edit (boot=${boot})`, async (t) => {
    const { routine } = await fixture();
    const started = barrier();
    const release = barrier();
    let signal: AbortSignal | undefined;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      signal = params.signal;
      started.resolve();
      await release.promise;
      return success;
    });
    const pending = await startRoutineRun(routine);
    try {
      await observed(started.promise);
      const repo = AppDataSource.getRepository(Run);
      await repo.update(pending.run.id, { startedAt: new Date(Date.now() - 120_000) });
      await AppDataSource.getRepository(Routine).update(routine.id, { timeoutSec: 1 });
      const current = await repo.findOneByOrFail({ id: pending.run.id });
      await reconcileOrphanedRuns({ boot });
      assert.deepEqual(await repo.findOneByOrFail({ id: pending.run.id }), current);
      assert.equal(signal?.aborted, false);
    } finally {
      release.resolve();
      await pending.completion;
    }
  });
}

test("a deferred fresh Run publishes its new deadline before awaited preparation", async (t) => {
  const { routine } = await fixture();
  stopRoutineQueue();
  const pending = await startRoutineRun(routine);
  const runs = AppDataSource.getRepository(Run);
  await runs.update(pending.run.id, {
    startedAt: new Date(0),
    continuationDeadlineAt: new Date(0),
  });
  const preparing = barrier();
  const release = barrier();
  const companies = AppDataSource.getRepository(Company);
  const lookup = companies.findOneBy.bind(companies);
  t.mock.method(companies, "findOneBy", async (...args: Parameters<typeof companies.findOneBy>) => {
    preparing.resolve();
    await release.promise;
    return lookup(...args);
  });
  t.mock.method(agentRuntime, "run", async () => success);
  await resumeRoutineQueue();
  try {
    await observed(preparing.promise);
    const current = await runs.findOneByOrFail({ id: pending.run.id });
    assert.equal(current.status, "running");
    assert.equal(current.continuationDeadlineAt!.getTime() - current.startedAt.getTime(), 60_000);
    await reconcileOrphanedRuns();
    assert.equal((await runs.findOneByOrFail({ id: current.id })).status, "running");
  } finally {
    release.resolve();
    await pending.completion;
  }
});

for (const retryOnTimeout of [false, true]) {
  test(`local overdue recovery honors retryOnTimeout=${retryOnTimeout} and cleanup blocks its retry`, async (t) => {
    const { routine } = await fixture();
    routine.maxAttempts = 2;
    routine.retryOnTimeout = retryOnTimeout;
    await AppDataSource.getRepository(Routine).save(routine);
    const started = barrier();
    const release = barrier();
    t.mock.method(agentRuntime, "run", async () => {
      started.resolve();
      await release.promise;
      return success;
    });
    const pending = await startRoutineRun(routine, { triggerKind: "schedule" });
    try {
      await observed(started.promise);
      const runs = AppDataSource.getRepository(Run);
      const current = await runs.findOneByOrFail({ id: pending.run.id });
      const now = new Date(current.continuationDeadlineAt!.getTime() + 60_001);
      const result = await reconcileOrphanedRuns({ now });
      assert.equal(result.timedOut, 1);
      assert.equal(result.interrupted, 0);
      const recovered = await runs.findOneByOrFail({ id: current.id });
      assert.equal(!!recovered.retryAt, retryOnTimeout);
      if (recovered.retryAt) {
        await dispatchDueRetries(recovered.retryAt);
        assert.equal(await runs.countBy({ parentRunId: current.id }), 0);
      }
    } finally {
      release.resolve();
      await pending.completion;
    }
  });
}

for (const boundary of ["recording", "terminal CAS"] as const) {
  test(`a new unfinished checkpoint at the ${boundary} boundary prevents an ordinary recovery retry`, async (t) => {
    const { routine } = await fixture();
    const now = new Date();
    const runs = AppDataSource.getRepository(Run);
    const run = await insert(Run, {
      routineId: routine.id,
      status: "running",
      triggerKind: "schedule",
      startedAt: new Date(now.getTime() - 180_000),
    });
    const update = runs.update.bind(runs);
    let changed = false;
    if (boundary === "recording") {
      const sessions = AppDataSource.getRepository(BrowserSession);
      const find = sessions.find.bind(sessions);
      t.mock.method(sessions, "find", async (...args: Parameters<typeof sessions.find>) => {
        if (!changed) {
          changed = true;
          await update(run.id, { checkpointJson });
        }
        return find(...args);
      });
    } else {
      t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
        if (!changed && args[1].status === "error") {
          changed = true;
          await update(run.id, { checkpointJson });
        }
        return update(...args);
      });
    }
    await reconcileOrphanedRuns({ now });
    const saved = await runs.findOneByOrFail({ id: run.id });
    assert.equal(changed, true);
    assert.equal(saved.status, "running");
    assert.equal(saved.retryAt, null);
    assert.equal(saved.checkpointJson, checkpointJson);
    await reconcileOrphanedRuns({ now });
    const recovered = await runs.findOneByOrFail({ id: run.id });
    assert.equal(recovered.errorKind, "interrupted");
    assert.equal(recovered.retryAt, null);
    assert.equal(recovered.checkpointJson, checkpointJson);
    assert.match(recovered.logContent, /restart is not confirmed/);
    const journal = await AppDataSource.getRepository(JournalEntry).findOneByOrFail({
      runId: run.id,
    });
    assert.doesNotMatch(journal.title, /restart/);
    assert.match(journal.body, /does not confirm a server restart/);
  });
}

test("a replacement claim racing terminal recovery wins without losing ownership", async (t) => {
  const { routine } = await fixture();
  const now = new Date();
  const runs = AppDataSource.getRepository(Run);
  const run = await insert(Run, {
    routineId: routine.id,
    status: "running",
    triggerKind: "schedule",
    startedAt: new Date(now.getTime() - 180_000),
    queueActiveEmployeeId: "run:old-owner",
  });
  const update = runs.update.bind(runs);
  let replaced = false;
  t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
    if (!replaced && args[1].status === "error") {
      replaced = true;
      await update(run.id, { queueActiveEmployeeId: "run:replacement-owner" });
    }
    return update(...args);
  });
  await reconcileOrphanedRuns({ now });
  const latest = await runs.findOneByOrFail({ id: run.id });
  assert.equal(replaced, true);
  assert.equal(latest.status, "running");
  assert.equal(latest.queueActiveEmployeeId, "run:replacement-owner");
  assert.equal(latest.retryAt, null);
});

test("Postgres boot cannot reclassify an overdue Run with a live remote lease", async () => {
  const { routine } = await fixture();
  const now = new Date();
  const run = await insert(Run, {
    routineId: routine.id,
    status: "running",
    startedAt: new Date(now.getTime() - 180_000),
    queueActiveEmployeeId: "run:remote-owner",
  });
  await insert(SchedulerLease, {
    name: `routine-run:${run.id}`,
    holderId: "other-process",
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const driver = config.db.driver;
  try {
    Object.assign(config.db, { driver: "postgres" });
    await reconcileOrphanedRuns({ boot: true, now });
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).status,
      "running",
    );
  } finally {
    Object.assign(config.db, { driver });
  }
});

for (const longer of [false, true]) {
  test(`orphan cleanup honors the captured deadline after a ${longer ? "longer" : "shorter"} timeout edit`, async () => {
    const { routine } = await fixture();
    const now = new Date();
    await AppDataSource.getRepository(Routine).update(routine.id, {
      timeoutSec: longer ? 86_400 : 1,
    });
    const run = await insert(Run, {
      routineId: routine.id,
      status: "error",
      errorKind: "timeout",
      startedAt: new Date(now.getTime() - 600_000),
      finishedAt: new Date(now.getTime() - 360_000),
      continuationDeadlineAt: new Date(now.getTime() + (longer ? -360_000 : 60_000)),
      queueActiveEmployeeId: "run:abandoned:owner",
    });
    await releaseOrphanedQueueSlots(false, now);
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id }))
        .queueActiveEmployeeId,
      longer ? null : run.queueActiveEmployeeId,
    );
  });
}

async function fixture() {
  const company = await insert(Company, {
    name: "Ownership Co",
    slug: "ownership",
    ownerId: "owner",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "ownership-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "ownership-test",
    }),
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review inventory",
    slug: "review",
    cronExpr: "0 9 * * *",
    timeoutSec: 60,
    body: "Review the captured inventory.",
  });
  return { company, employee, routine };
}

test(
  "an overdue locally owned Run is a timeout and retains its claim through cleanup",
  { timeout: 30_000 },
  async (t) => {
    const { routine } = await fixture();
    const started = barrier();
    const release = barrier();
    let signal: AbortSignal | undefined;
    const stopCheckpointing = t.mock.method(DurableRunLog.prototype, "stopCheckpointing");
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      signal = params.signal;
      started.resolve();
      await release.promise;
      return success;
    });
    const pending = await startRoutineRun(routine, { triggerKind: "schedule" });
    try {
      await observed(started.promise);
      const repo = AppDataSource.getRepository(Run);
      const current = await repo.findOneByOrFail({ id: pending.run.id });
      assert.ok(current.queueActiveEmployeeId);
      await repo.update(current.id, { checkpointJson });
      const now = new Date(current.continuationDeadlineAt!.getTime() + 60_001);
      await reconcileOrphanedRuns({ now });
      const timedOut = await repo.findOneByOrFail({ id: current.id });
      assert.equal(timedOut.errorKind, "timeout");
      assert.equal(timedOut.status, "error");
      assert.equal(timedOut.queueActiveEmployeeId, current.queueActiveEmployeeId);
      assert.equal(signal?.aborted, true);
      assert.equal(timedOut.checkpointJson, checkpointJson);
      assert.equal(
        timedOut.continuationDeadlineAt?.getTime(),
        current.continuationDeadlineAt?.getTime(),
      );
      assert.equal(
        timedOut.retryAt,
        null,
        "a partial occurrence cannot escape the original deadline",
      );
      assert.match(timedOut.continuationStopReason!, /time limit/);
      assert.match(timedOut.logContent, /\[timeout\]/);
      assert.doesNotMatch(timedOut.logContent, /server stopped|restart/);
      const journal = await AppDataSource.getRepository(JournalEntry).findOneByOrFail({
        runId: current.id,
      });
      assert.match(journal.title, /time limit/);
      assert.doesNotMatch(journal.title + journal.body, /restart/);
      await releaseOrphanedQueueSlots(false, new Date(now.getTime() + 60 * 60_000));
      assert.equal(
        (await repo.findOneByOrFail({ id: current.id })).queueActiveEmployeeId,
        current.queueActiveEmployeeId,
      );
      await reconcileOrphanedRuns({ now });
      assert.equal(
        await AppDataSource.getRepository(JournalEntry).countBy({ runId: current.id }),
        1,
      );
    } finally {
      release.resolve();
      await pending.completion;
    }
    const finished = await AppDataSource.getRepository(Run).findOneByOrFail({ id: pending.run.id });
    assert.equal(
      finished.errorKind,
      "timeout",
      "late normal completion cannot replace the durable timeout",
    );
    assert.equal(finished.queueActiveEmployeeId, null);
    assert.ok(
      stopCheckpointing.mock.callCount() > 0,
      "recovery's early return must stop the log timer",
    );
  },
);

test(
  "a terminal cleanup claim defers a fresh manual Run and an automatic retry",
  { timeout: 30_000 },
  async (t) => {
    const { employee, routine } = await fixture();
    const now = new Date();
    const terminal = await insert(Run, {
      routineId: routine.id,
      employeeId: employee.id,
      status: "error",
      errorKind: "timeout",
      triggerKind: "schedule",
      startedAt: new Date(now.getTime() - 180_000),
      finishedAt: now,
      retryAt: now,
      queueActiveEmployeeId: "run:still-cleaning:owner",
    });
    await AppDataSource.getRepository(Routine).update(routine.id, {
      maxAttempts: 2,
      retryOnTimeout: true,
    });
    let calls = 0;
    t.mock.method(agentRuntime, "run", async () => {
      calls++;
      return success;
    });
    const pending = await startRoutineRun(routine);
    await waitForRoutineQueueIdle();
    assert.equal(calls, 0, "manual acceptance must not bypass the cleanup owner");
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: pending.run.id })).status,
      "queued",
    );
    await dispatchDueRetries(now, () => undefined);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: terminal.id }), 0);
    assert.ok(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: terminal.id })).retryAt! > now,
    );
    await AppDataSource.getRepository(Run).update(terminal.id, { queueActiveEmployeeId: null });
    await dispatchQueuedRoutineRuns();
    assert.equal((await pending.completion).status, "completed");
    assert.equal(calls, 1);
  },
);

for (const legacy of [false, true]) {
  test(`an unexpired ${legacy ? "legacy" : "per-Run"} remote lease prevents age recovery`, async () => {
    const { employee, routine } = await fixture();
    const now = new Date();
    const run = await insert(Run, {
      employeeId: employee.id,
      routineId: routine.id,
      status: "running",
      startedAt: new Date(now.getTime() - 10 * 60_000),
      continuationDeadlineAt: new Date(now.getTime() - 5 * 60_000),
      queueActiveEmployeeId: legacy ? employee.id : "run:remote:owner",
      checkpointJson,
    });
    await insert(SchedulerLease, {
      name: legacy ? `routine-queue:${employee.id}` : `routine-run:${run.id}`,
      holderId: "other-process",
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const before = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    await reconcileOrphanedRuns({ now });
    assert.deepEqual(
      await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id }),
      before,
    );
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
  });
}

test("a failed Run cannot resume while its own or an earlier Run's cleanup claim remains", async () => {
  const { employee, routine } = await fixture();
  const now = new Date();
  const source = await insert(Run, {
    employeeId: employee.id,
    routineId: routine.id,
    status: "failed",
    startedAt: now,
    finishedAt: now,
    checkpointJson,
    queueActiveEmployeeId: "run:source:owner",
  });
  assert.equal(manualResumeEligibility(source, routine).eligible, false);
  await assert.rejects(assertManualResumeSource(source, routine), /cleanup|finish/i);
  source.queueActiveEmployeeId = null;
  await AppDataSource.getRepository(Run).update(source.id, { queueActiveEmployeeId: null });
  const earlier = await insert(Run, {
    employeeId: employee.id,
    routineId: routine.id,
    status: "error",
    errorKind: "timeout",
    startedAt: new Date(now.getTime() - 180_000),
    finishedAt: now,
    queueActiveEmployeeId: "run:earlier:owner",
  });
  await assert.rejects(assertManualResumeSource(source, routine), /cleanup|progress/i);
  await AppDataSource.getRepository(Run).update(earlier.id, { queueActiveEmployeeId: null });
  await assertManualResumeSource(source, routine);
});
