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
import { stopCron, tickRoutine } from "./cron.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { startRoutineRun } from "./runner.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import { stopStanddowns } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

const held = () => undefined;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One AI Employee on a local model, which serves one Run at a time by default. */
async function localEmployee() {
  const company = await insert(Company, { name: "Local", slug: "local", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:11434/v1"),
      modelId: "Qwen/Qwen3.8-27B",
    }),
  });
  return employee;
}

function routineFor(employee: AIEmployee, slug: string) {
  return insert(Routine, {
    employeeId: employee.id,
    name: slug,
    slug,
    cronExpr: "0 18 * * *",
    timeoutSec: 600,
    body: "Follow the day's DevOps conversations.",
    nextRunAt: new Date(Date.now() + 86_400_000),
  });
}

/** Mock the model: the first work turn waits on `release`; every brief is recorded. */
function busyModel(t: TestContext) {
  const firstStarted = barrier();
  const release = barrier();
  const briefs: string[] = [];
  t.after(release.resolve);
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const first = params.messages[0]?.content[0];
    briefs.push(first && "text" in first ? first.text : "");
    if (briefs.length === 1) {
      firstStarted.resolve();
      await release.promise;
    }
    return { finalText: "Followed the conversations.", steps: 2, stopReason: "end_turn" };
  });
  return { firstStarted, release, briefs };
}

function runsOf(routine: Routine): Promise<Run[]> {
  return AppDataSource.getRepository(Run).find({
    where: { routineId: routine.id },
    order: { createdAt: "ASC" },
  });
}

// 2026-10-01: with two Runs on one GPU, scheduled work waited hours in the
// queue; a daily slot that came due meanwhile would queue a second Run of the
// same Routine behind the first, and both would review the same window.
test("a slot that comes due while the Routine's scheduled Run waits folds into that Run", async (t) => {
  const employee = await localEmployee();
  const busy = await routineFor(employee, "stripe-qualification");
  const following = await routineFor(employee, "devops-following");
  const model = busyModel(t);

  const busyRun = await startRoutineRun(busy, { triggerKind: "schedule" });
  await model.firstStarted.promise;
  await startRoutineRun(following, { triggerKind: "schedule" });
  await dispatchQueuedRoutineRuns();
  const [waiting] = await runsOf(following);
  assert.equal(waiting.status, "queued", "the local model is busy with the other Routine");

  await tickRoutine(following.id, { missedSlots: 0 }, held);
  await tickRoutine(following.id, { missedSlots: 2 }, held);
  const afterSlots = await runsOf(following);
  assert.equal(afterSlots.length, 1, "no second Run queues behind the waiting one");
  assert.equal(afterSlots[0].id, waiting.id);
  assert.equal(afterSlots[0].status, "queued");
  assert.equal(afterSlots[0].missedSlots, 4, "one slot, then a slot that stood for three");

  model.release.resolve();
  await busyRun.completion;
  await waitForRoutineQueueIdle();
  const [finished] = await runsOf(following);
  assert.equal(finished.status, "completed", finished.logContent);
  assert.equal(finished.missedSlots, 4);
  assert.match(finished.logContent, /missed=4 more scheduled occurrence\(s\) covered by this run/);
  assert.equal(model.briefs.length, 2);
  assert.match(
    model.briefs[1],
    /it also stands in for 4 scheduled occurrence\(s\).*came due while this run waited to start/,
  );
  assert.doesNotMatch(model.briefs[0], /catching up/);
});

test("a slot never folds into a Run that has already started", async (t) => {
  const employee = await localEmployee();
  const following = await routineFor(employee, "devops-following");
  const model = busyModel(t);

  const running = await startRoutineRun(following, { triggerKind: "schedule" });
  await model.firstStarted.promise;
  await tickRoutine(following.id, { missedSlots: 0 }, held);
  const runs = await runsOf(following);
  assert.equal(runs.length, 2, "the next occurrence covers the time after the running Run");
  assert.equal(runs[0].status, "running");
  assert.equal(runs[0].missedSlots, 0);
  assert.equal(runs[1].status, "queued");
  assert.equal(runs[1].missedSlots, 0);

  model.release.resolve();
  await running.completion;
  await waitForRoutineQueueIdle();
  assert.deepEqual(
    (await runsOf(following)).map((run) => run.status),
    ["completed", "completed"],
  );
});

test("a slot keeps its own Run when the waiting Run was started by a person", async (t) => {
  const employee = await localEmployee();
  const busy = await routineFor(employee, "stripe-qualification");
  const following = await routineFor(employee, "devops-following");
  const model = busyModel(t);

  const busyRun = await startRoutineRun(busy, { triggerKind: "schedule" });
  await model.firstStarted.promise;
  await startRoutineRun(following, { triggerKind: "manual" });
  await tickRoutine(following.id, { missedSlots: 0 }, held);
  const runs = await runsOf(following);
  assert.deepEqual(
    runs.map((run) => [run.triggerKind, run.status, run.missedSlots]),
    [
      ["manual", "queued", 0],
      ["schedule", "queued", 0],
    ],
    "a manual Run is not retried, so it must not absorb a scheduled occurrence",
  );

  model.release.resolve();
  await busyRun.completion;
  await waitForRoutineQueueIdle();
});

test("a slot that folds while the queue is claiming the Run still reaches its brief", async (t) => {
  const employee = await localEmployee();
  const following = await routineFor(employee, "devops-following");
  const briefs: string[] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const first = params.messages[0]?.content[0];
    briefs.push(first && "text" in first ? first.text : "");
    return { finalText: "Followed the conversations.", steps: 2, stopReason: "end_turn" };
  });
  // Land the fold after the queue read the Run's options but before it claimed
  // the Run: the sibling check is the last step between the two.
  const repo = AppDataSource.getRepository(Run);
  const existsBy = repo.existsBy.bind(repo);
  let folded = false;
  t.mock.method(repo, "existsBy", async (...args: Parameters<typeof repo.existsBy>) => {
    if (!folded) {
      folded = true;
      await tickRoutine(following.id, { missedSlots: 0 }, held);
    }
    return existsBy(...args);
  });

  const started = await startRoutineRun(following, { triggerKind: "schedule" });
  const run = await started.completion;
  assert.ok(folded, "the fold ran inside the claim");
  assert.equal(run.status, "completed", run.logContent);
  assert.equal(run.missedSlots, 1);
  assert.equal((await runsOf(following)).length, 1);
  assert.equal(briefs.length, 1);
  assert.match(briefs[0], /it also stands in for 1 scheduled occurrence\(s\)/);
});
