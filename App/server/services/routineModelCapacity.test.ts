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
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { queueWaitLine, startRoutineRun } from "./runner.js";
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
  resetModelRunSlotsForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function employeeWithModel(
  company: Company,
  slug: string,
  model: { baseURL?: string; maxConcurrentRuns?: number | null } = {},
) {
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: slug,
    slug,
    role: "Operations",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    maxConcurrentRuns: model.maxConcurrentRuns ?? null,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(model.baseURL ?? LOCAL_ENDPOINT),
      modelId: "Qwen/Qwen3.8-27B",
    }),
  });
  return employee;
}

async function routineFor(employee: AIEmployee, slug: string) {
  return insert(Routine, {
    employeeId: employee.id,
    name: slug,
    slug,
    cronExpr: "0 9 * * *",
    timeoutSec: 600,
    body: "Review the records.",
  });
}

async function company() {
  return insert(Company, { name: "Local Models", slug: "local-models", ownerId: "owner" });
}

/** Mock the model: the first Routine turn waits on `release`, later ones finish at once. */
function blockFirstTurn(t: TestContext) {
  const firstStarted = barrier();
  const release = barrier();
  const started: string[] = [];
  t.after(release.resolve);
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    // Outcome grading and reflection are bounded turns; only the work counts.
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    started.push(params.system);
    if (started.length === 1) {
      firstStarted.resolve();
      await release.promise;
    }
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  return { firstStarted, release, started };
}

/** Fail instead of hanging when a Run ends before its model turn begins. */
async function reachesModel(started: Promise<void>, completion: Promise<Run>): Promise<void> {
  await Promise.race([
    started,
    completion.then((run) =>
      assert.fail(`The Run ended as ${run.status} before reaching the model: ${run.logContent}`),
    ),
  ]);
}

async function runOf(routine: Routine): Promise<Run> {
  return AppDataSource.getRepository(Run).findOneOrFail({
    where: { routineId: routine.id },
    order: { createdAt: "DESC" },
  });
}

test("a second Routine waits for a busy local model without spending its time limit", async (t) => {
  const co = await company();
  const employee = await employeeWithModel(co, "jamie");
  const busyRoutine = await routineFor(employee, "busy");
  const waitingRoutine = await routineFor(employee, "waiting");
  const model = blockFirstTurn(t);

  const busy = await startRoutineRun(busyRoutine, { triggerKind: "schedule" });
  await reachesModel(model.firstStarted.promise, busy.completion);
  const waiting = await startRoutineRun(waitingRoutine, { triggerKind: "schedule" });
  await dispatchQueuedRoutineRuns();
  await dispatchQueuedRoutineRuns();

  const queued = await runOf(waitingRoutine);
  assert.equal(queued.status, "queued", "the local model serves one Run at a time by default");
  assert.equal(model.started.length, 1);
  assert.match(
    queued.logContent,
    /\[queue\] Waiting for the AI Model Qwen\/Qwen3\.8-27B: 1 Run is already using it, and it serves 1 at a time\./,
  );

  model.release.resolve();
  const finished = await busy.completion;
  assert.equal(finished.status, "completed");
  const done = await waiting.completion;
  assert.equal(done.status, "completed", "a freed slot starts the waiting Run");
  assert.equal(model.started.length, 2);
  assert.ok(done.startedAt.getTime() >= finished.finishedAt!.getTime());
  assert.equal(
    done.continuationDeadlineAt?.getTime(),
    done.startedAt.getTime() + waitingRoutine.timeoutSec * 1000,
    "the time limit starts when the Run is claimed, not when it was queued",
  );
  assert.doesNotMatch(done.logContent, /Waiting for the AI Model/);
});

test("AI Employees pointed at one model server share its limit", async (t) => {
  const co = await company();
  const alex = await employeeWithModel(co, "alex");
  const sam = await employeeWithModel(co, "sam", { baseURL: `${LOCAL_ENDPOINT}/` });
  const model = blockFirstTurn(t);

  const first = await startRoutineRun(await routineFor(alex, "alex-review"));
  await reachesModel(model.firstStarted.promise, first.completion);
  const samRoutine = await routineFor(sam, "sam-review");
  const second = await startRoutineRun(samRoutine);
  await dispatchQueuedRoutineRuns();
  assert.equal((await runOf(samRoutine)).status, "queued");

  model.release.resolve();
  assert.equal((await first.completion).status, "completed");
  assert.equal((await second.completion).status, "completed");
});

test("a model with no limit, or a separate server, runs Routines side by side", async (t) => {
  const co = await company();
  const unlimited = await employeeWithModel(co, "unlimited", { maxConcurrentRuns: 0 });
  const elsewhere = await employeeWithModel(co, "elsewhere", {
    baseURL: "http://192.168.1.50:8000/v1",
  });
  const bothStarted = barrier();
  const release = barrier();
  t.after(release.resolve);
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    if (++calls === 3) bothStarted.resolve();
    await release.promise;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const runs = await Promise.all([
    startRoutineRun(await routineFor(unlimited, "a")),
    startRoutineRun(await routineFor(unlimited, "b")),
    startRoutineRun(await routineFor(elsewhere, "c")),
  ]);
  await Promise.race([
    bothStarted.promise,
    Promise.race(runs.map((run) => run.completion)).then(() =>
      assert.fail("A Run finished before all three reached the model"),
    ),
  ]);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ status: "running" }), 3);
  release.resolve();
  const results = await Promise.all(runs.map((run) => run.completion));
  assert.ok(results.every((run) => run.status === "completed"));
});

test("raising a model's limit admits a waiting Run without another heartbeat", async (t) => {
  const co = await company();
  const employee = await employeeWithModel(co, "jamie");
  const model = blockFirstTurn(t);
  const busy = await startRoutineRun(await routineFor(employee, "busy"));
  await reachesModel(model.firstStarted.promise, busy.completion);
  const waitingRoutine = await routineFor(employee, "waiting");
  const waiting = await startRoutineRun(waitingRoutine);
  await dispatchQueuedRoutineRuns();
  assert.equal((await runOf(waitingRoutine)).status, "queued");

  await AppDataSource.getRepository(AIModel).update(
    { employeeId: employee.id },
    { maxConcurrentRuns: 2 },
  );
  await dispatchQueuedRoutineRuns();
  assert.equal((await waiting.completion).status, "completed");
  assert.equal(model.started.length, 2, "the second Run ran while the first still held the model");
  model.release.resolve();
  assert.equal((await busy.completion).status, "completed");
});

test("a Run refused for another reason frees the slot without retrying in a loop", async (t) => {
  const co = await company();
  const employee = await employeeWithModel(co, "jamie");
  const routine = await routineFor(employee, "cleaning-up");
  // An earlier Run of this Routine still owns its cleanup, so a new Run of it
  // cannot start yet — whatever the model's capacity.
  const cleaning = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "error",
    errorKind: "timeout",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 180_000),
    finishedAt: new Date(),
    queueActiveEmployeeId: "run:earlier:cleanup",
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const pending = await startRoutineRun(routine);
  let idle = false;
  await Promise.race([
    waitForRoutineQueueIdle().then(() => {
      idle = true;
    }),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  assert.equal(idle, true, "a refused claim must not keep re-offering itself the slot");
  assert.equal((await runOf(routine)).status, "queued");
  assert.equal(calls, 0);

  await AppDataSource.getRepository(Run).update(cleaning.id, { queueActiveEmployeeId: null });
  await dispatchQueuedRoutineRuns();
  assert.equal((await pending.completion).status, "completed");
  assert.equal(calls, 1);
});

test("a started Run's log says how long it waited in the queue", () => {
  const createdAt = new Date("2026-10-01T09:00:00.000Z");
  assert.deepEqual(
    queueWaitLine({ createdAt, startedAt: new Date("2026-10-01T09:00:40.000Z"), continuationCount: 0 }),
    [],
    "a short dispatch delay is not worth a line",
  );
  assert.deepEqual(
    queueWaitLine({ createdAt, startedAt: new Date("2026-10-01T09:12:00.000Z"), continuationCount: 0 }),
    ["[queue] Waited 12m in the queue before starting; the time limit started when this Run did."],
  );
  assert.deepEqual(
    queueWaitLine({ createdAt, startedAt: new Date("2026-10-01T10:30:00.000Z"), continuationCount: 2 }),
    ["[queue] Waited 1h 30m in the queue before starting; the shared deadline moved by the same time."],
  );
});
