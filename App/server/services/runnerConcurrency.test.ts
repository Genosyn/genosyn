import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { startRoutineRun } from "./runner.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
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

async function fixture() {
  const company = await insert(Company, {
    name: "Concurrent",
    slug: "concurrent",
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
    model: "concurrency-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    // These tests are about queue ownership, not model capacity: let every
    // Routine reach the (mocked) model at once, as a hosted API would.
    maxConcurrentRuns: 0,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "concurrency-test",
    }),
  });
  return insert(Routine, {
    employeeId: employee.id,
    name: "Review",
    slug: "review",
    cronExpr: "* * * * *",
    timeoutSec: 180,
    body: "Review the records.",
  });
}

test("accepted failed Runs of one Routine serialize and each increment its failure count", async (t) => {
  const routine = await fixture();
  const firstStarted = barrier();
  const release = barrier();
  t.after(release.resolve);
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null)
      return { finalText: "No lesson needed.", steps: 1, stopReason: "end_turn" };
    if (++calls === 1) firstStarted.resolve();
    await release.promise;
    throw new Error("The model rejected this request.");
  });
  const first = await startRoutineRun(routine);
  const second = await startRoutineRun(routine);
  await Promise.race([
    firstStarted.promise,
    first.completion.then(() => assert.fail("The first Run completed before reaching the model")),
  ]);
  await dispatchQueuedRoutineRuns();
  assert.equal(calls, 1);
  const pending = await AppDataSource.getRepository(Run).findBy({ routineId: routine.id });
  assert.equal(pending.filter((run) => run.status === "running").length, 1);
  assert.equal(pending.filter((run) => run.status === "queued").length, 1);
  release.resolve();
  await waitForRoutineQueueIdle();
  await dispatchQueuedRoutineRuns();
  const results = await Promise.all([first.completion, second.completion]);
  assert.equal(calls, 2);
  assert.ok(results.every((run) => run.status === "error"));
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }))
      .consecutiveFailures,
    2,
  );
});

test("a clean queued Run resets failures recorded after it started", async (t) => {
  const routine = await fixture();
  const secondStarted = barrier();
  const fail = barrier();
  const succeed = barrier();
  const firstStarted = barrier();
  t.after(() => {
    fail.resolve();
    succeed.resolve();
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null)
      return { finalText: "No lesson needed.", steps: 1, stopReason: "end_turn" };
    const attempt = ++calls;
    if (attempt === 1) {
      firstStarted.resolve();
      await fail.promise;
      throw new Error("The model rejected this request.");
    }
    secondStarted.resolve();
    await succeed.promise;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const first = await startRoutineRun(routine);
  await Promise.race([
    firstStarted.promise,
    first.completion.then(() => assert.fail("The first Run completed before reaching the model")),
  ]);
  const second = await startRoutineRun(routine);
  await dispatchQueuedRoutineRuns();
  assert.equal(calls, 1, "The second Run must wait for the first owner to finish");
  fail.resolve();
  assert.equal((await first.completion).status, "error");
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }))
      .consecutiveFailures,
    1,
  );
  await dispatchQueuedRoutineRuns();
  await Promise.race([
    secondStarted.promise,
    second.completion.then(() => assert.fail("The queued Run completed before reaching the model")),
  ]);
  // Another writer can change bookkeeping after this Run's snapshot even
  // though model execution for the same Routine is now serialized.
  await AppDataSource.getRepository(Routine).increment(
    { id: routine.id },
    "consecutiveFailures",
    1,
  );
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }))
      .consecutiveFailures,
    2,
  );
  succeed.resolve();
  assert.equal((await second.completion).status, "completed");
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }))
      .consecutiveFailures,
    0,
  );
});

test("independent Routines of the same employee still execute concurrently", async (t) => {
  const firstRoutine = await fixture();
  const secondRoutine = await insert(Routine, {
    employeeId: firstRoutine.employeeId,
    name: "Independent review",
    slug: "independent-review",
    cronExpr: "* * * * *",
    timeoutSec: 180,
    body: "Review a separate source.",
  });
  const bothStarted = barrier();
  const release = barrier();
  t.after(release.resolve);
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null)
      return { finalText: "No lesson needed.", steps: 1, stopReason: "end_turn" };
    if (++calls === 2) bothStarted.resolve();
    await release.promise;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const [first, second] = await Promise.all([
    startRoutineRun(firstRoutine),
    startRoutineRun(secondRoutine),
  ]);
  await Promise.race([
    bothStarted.promise,
    Promise.race([first.completion, second.completion]).then(() =>
      assert.fail("An independent Run finished before both model calls started"),
    ),
  ]);
  assert.equal(calls, 2);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ status: "running" }), 2);
  release.resolve();
  assert.ok(
    (await Promise.all([first.completion, second.completion])).every(
      (run) => run.status === "completed",
    ),
  );
});

/** Delay one completion's bookkeeping after its snapshot, while other writers proceed. */
async function delayedCompletion(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T12:00:59.000Z") });
  const routine = await fixture();
  const repo = AppDataSource.getRepository(Routine);
  const update = repo.update.bind(repo);
  await update(routine.id, { nextRunAt: new Date("2026-09-28T12:01:00.000Z") });
  const entered = barrier();
  const release = barrier();
  t.after(release.resolve);
  let delayed = false;
  t.mock.method(repo, "update", async (...args: Parameters<typeof repo.update>) => {
    if (!delayed && args[1].lastRunAt instanceof Date) {
      delayed = true;
      entered.resolve();
      await release.promise;
    }
    return update(...args);
  });
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Done",
    steps: 1,
    stopReason: "end_turn",
  }));
  const first = await startRoutineRun(routine);
  await entered.promise;
  return { routine, repo, update, release, first };
}

test("an older completion cannot rewind a newer Run's completion or next schedule", async (t) => {
  const { routine, repo, update, release, first } = await delayedCompletion(t);
  t.mock.timers.setTime(Date.parse("2026-09-28T12:01:01.000Z"));
  // Publish another writer's newer completion directly. A second queued model
  // Run correctly cannot bypass the first Run's held bookkeeping/cleanup claim.
  const newer = await insert(Run, {
    routineId: routine.id,
    employeeId: routine.employeeId,
    status: "completed",
    startedAt: new Date("2026-09-28T12:01:00.000Z"),
    finishedAt: new Date("2026-09-28T12:01:01.000Z"),
  });
  await update(routine.id, {
    lastRunAt: newer.finishedAt,
    nextRunAt: new Date("2026-09-28T12:02:00.000Z"),
  });
  release.resolve();
  assert.equal((await first.completion).status, "completed");
  const current = await repo.findOneByOrFail({ id: routine.id });
  assert.equal(current.lastRunAt!.getTime(), newer.finishedAt!.getTime());
  assert.equal(current.nextRunAt!.toISOString(), "2026-09-28T12:02:00.000Z");
});

test("completion preserves a schedule advanced after its snapshot", async (t) => {
  const { routine, repo, update, release, first } = await delayedCompletion(t);
  await update(routine.id, { nextRunAt: new Date("2026-09-28T12:02:00.000Z") });
  release.resolve();
  const completed = await first.completion;
  assert.equal(completed.status, "completed");
  const current = await repo.findOneByOrFail({ id: routine.id });
  assert.equal(current.lastRunAt!.getTime(), completed.finishedAt!.getTime());
  assert.equal(current.nextRunAt!.toISOString(), "2026-09-28T12:02:00.000Z");
});

for (const disabled of [false, true]) {
  test(`completion respects a ${disabled ? "disabled" : "changed"} schedule after its snapshot`, async (t) => {
    const { routine, repo, update, release, first } = await delayedCompletion(t);
    const nextRunAt = disabled ? null : new Date("2026-09-28T12:05:00.000Z");
    await update(routine.id, { enabled: !disabled, cronExpr: "*/5 * * * *", nextRunAt });
    release.resolve();
    assert.equal((await first.completion).status, "completed");
    const current = await repo.findOneByOrFail({ id: routine.id });
    assert.equal(current.enabled, !disabled);
    assert.equal(current.cronExpr, "*/5 * * * *");
    assert.equal(current.nextRunAt?.getTime() ?? null, nextRunAt?.getTime() ?? null);
  });
}
