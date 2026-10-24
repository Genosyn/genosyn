import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { HIGH_PRIORITY_HEAD_START_MS } from "../../shared/routinePriority.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { activeModelOf, insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import { stopCron } from "./cron.js";
import {
  modelRunCapacity,
  modelRunSlotsInUse,
  resetModelRunSlotsForTests,
} from "./modelRunCapacity.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  stopRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import { holdRoutineQueue, releaseRoutineQueue } from "./routineQueueHold.js";
import { startRoutineRun } from "./runner.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";

/**
 * Routine priority in the real queue: the real dispatcher, runner and
 * database, with only the model mocked so a test can hold the one slot a
 * local model serves and read the order Routines reach it.
 *
 * The bar is the owner's: "mark some routine as priority so they run on the
 * top of the queue" — without breaking the rules that already hold. A Run
 * paused for a restart still resumes first, a continuation still finishes
 * work already begun, Standdowns, holds, approvals and claims behave as they
 * did, and no Normal Run waits forever.
 */

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

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const HOUR = 60 * 60_000;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function company(slug = "oneuptime") {
  return insert(Company, { name: slug, slug, ownerId: "owner" });
}

/** An AI Employee on a self-hosted model: one Run at a time unless the model says otherwise. */
async function employeeOn(
  co: Company,
  slug: string,
  model: { baseURL?: string; maxConcurrentRuns?: number | null } = {},
) {
  const employee = await insert(AIEmployee, {
    companyId: co.id,
    name: slug,
    slug,
    role: "Go to Market",
  });
  await insertEmployeeModel({
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

function routineFor(employee: AIEmployee, name: string, values: Partial<Routine> = {}) {
  return insert(Routine, {
    employeeId: employee.id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    cronExpr: "0 9 * * *",
    timeoutSec: 600,
    body: `${name}: do the day's work.`,
    ...values,
  });
}

/** A Run of `routine` that joined the queue `hoursAgo` hours ago and waits to start. */
function waitingRun(routine: Routine, hoursAgo: number, values: Partial<Run> = {}) {
  const createdAt = new Date(Date.now() - hoursAgo * HOUR);
  return insert(Run, {
    routineId: routine.id,
    employeeId: routine.employeeId,
    status: "queued",
    triggerKind: "schedule",
    queueOptionsJson: JSON.stringify({ triggerKind: "schedule" }),
    startedAt: createdAt,
    createdAt,
    ...values,
  });
}

/** The Routine a work turn was briefed for. */
function routineNamed(params: Parameters<typeof agentRuntime.run>[0]): string {
  const first = params.messages[0]?.content[0];
  return /^## Routine: (.+)$/m.exec(first && "text" in first ? first.text : "")?.[1] ?? "?";
}

/**
 * Mock the model. Every work turn is recorded in the order it reached the
 * model; the turns of the Routines named in `hold` wait until released, so a
 * test can keep a slot taken while it queues work behind it.
 */
function recordingModel(t: TestContext, hold: string[] = []) {
  const started: string[] = [];
  const holding = new Map(hold.map((name) => [name, { reached: barrier(), release: barrier() }]));
  t.after(() => {
    for (const gate of holding.values()) gate.release.resolve();
  });
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    // Outcome grading and reflection are bounded side turns; only the work counts.
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const name = routineNamed(params);
    started.push(name);
    const gate = holding.get(name);
    if (gate) {
      gate.reached.resolve();
      await gate.release.promise;
    }
    return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
  });
  return {
    started,
    reached: (name: string) => holding.get(name)!.reached.promise,
    release: (name: string) => holding.get(name)!.release.resolve(),
  };
}

/** Take the local model's only slot with a Run of its own, and keep it. */
async function occupyModel(employee: AIEmployee, model: ReturnType<typeof recordingModel>) {
  const busy = await startRoutineRun(await routineFor(employee, "Busy"), {
    triggerKind: "schedule",
  });
  await Promise.race([
    model.reached("Busy"),
    busy.completion.then((run) =>
      assert.fail(`The busy Run ended as ${run.status} before reaching the model: ${run.logContent}`),
    ),
  ]);
  return busy;
}

/** Free the busy Run's slot and let every waiting Run take its turn. */
async function drain(model: ReturnType<typeof recordingModel>, busy: { completion: Promise<Run> }) {
  model.release("Busy");
  assert.equal((await busy.completion).status, "completed");
  await waitForRoutineQueueIdle();
}

const runs = () => AppDataSource.getRepository(Run);

test("a High Routine's waiting Run starts before the Normal Runs queued ahead of it", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  await waitingRun(await routineFor(jamie, "Daily X DevOps Following"), 18);
  await waitingRun(await routineFor(jamie, "Daily Nostr Helpful Replies"), 17);
  const crm = await routineFor(jamie, "Daily CRM Sync", { priority: "high" });
  await waitingRun(crm, 0.1);
  await dispatchQueuedRoutineRuns();
  assert.equal(
    await runs().countBy({ status: "queued" }),
    3,
    "nothing jumps a model that is already serving its one Run",
  );

  await drain(model, busy);
  assert.deepEqual(model.started, [
    "Busy",
    "Daily CRM Sync",
    "Daily X DevOps Following",
    "Daily Nostr Helpful Replies",
  ]);
  assert.equal(await runs().countBy({ status: "completed" }), 4);
});

test("Runs of the same priority keep the order they joined the queue in", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  // Inserted out of order: the queue orders by when each Run was queued.
  await waitingRun(await routineFor(jamie, "Normal newer"), 2);
  await waitingRun(await routineFor(jamie, "High newer", { priority: "high" }), 1);
  await waitingRun(await routineFor(jamie, "Normal older"), 5);
  await waitingRun(await routineFor(jamie, "High older", { priority: "high" }), 3);
  await dispatchQueuedRoutineRuns();

  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "High older", "High newer", "Normal older", "Normal newer"]);
});

test("a Run paused for a restart resumes before High priority work", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  await waitingRun(await routineFor(jamie, "Fresh high", { priority: "high" }), 5);
  // It was working when Genosyn restarted, and joined the queue later than the
  // High Run: work under way still finishes first (AGENTS.md §3).
  await waitingRun(await routineFor(jamie, "Paused normal"), 0.5, {
    logContent: "Earlier work.\n",
    pausedAt: new Date(Date.now() - 20 * 60_000),
    pauseCount: 1,
    pauseRemainingMs: 10 * 60_000,
  });
  await dispatchQueuedRoutineRuns();

  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "Paused normal", "Fresh high"]);
  const resumed = await runs().findOneByOrFail({ status: "completed", pauseCount: 1 });
  assert.match(resumed.logContent, /^Earlier work\./, "the same Run carried on with its transcript");
});

test("a continuation of work under way goes before High priority new work", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  await waitingRun(await routineFor(jamie, "Fresh high", { priority: "high" }), 3);
  const replies = await routineFor(jamie, "Nostr Helpful Replies");
  const parent = await insert(Run, {
    routineId: replies.id,
    employeeId: jamie.id,
    status: "failed",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 10 * 60_000),
    finishedAt: new Date(),
    checkpointJson: JSON.stringify({
      state: "continue",
      completed: "Read the profile's earlier replies.",
      remaining: "Reply to two of today's threads.",
      resume: "Open the home feed and pick two threads from today.",
      progressKey: "oriented",
    }),
    continuationDeadlineAt: new Date(Date.now() + 10 * 60_000),
  });
  await startRoutineRun(replies, { triggerKind: "continuation", continuationFromRunId: parent.id });
  await dispatchQueuedRoutineRuns();
  assert.equal(
    (await runs().findOneByOrFail({ routineId: replies.id, triggerKind: "continuation" })).status,
    "queued",
  );

  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "Nostr Helpful Replies", "Fresh high"]);
});

test("a Normal Run that has waited a day goes ahead of High work queued after that", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  const dayHours = HIGH_PRIORITY_HEAD_START_MS / HOUR;
  // High work joined the queue an hour ago. A Normal Run waiting longer than a
  // day before that counts as High from then on, and so goes first; one that
  // waited just under a day at the same point still waits behind it.
  await waitingRun(await routineFor(jamie, "High an hour ago", { priority: "high" }), 1);
  await waitingRun(await routineFor(jamie, "Normal just under a day"), dayHours);
  await waitingRun(await routineFor(jamie, "Normal over a day"), dayHours + 2);
  await dispatchQueuedRoutineRuns();

  await drain(model, busy);
  assert.deepEqual(model.started, [
    "Busy",
    "Normal over a day",
    "High an hour ago",
    "Normal just under a day",
  ]);
});

test("changing a Routine's priority moves the Runs already waiting, up and down", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  const demoted = await routineFor(jamie, "Was high", { priority: "high" });
  const promoted = await routineFor(jamie, "Now high");
  await waitingRun(demoted, 1);
  await waitingRun(await routineFor(jamie, "Stays normal"), 6);
  await waitingRun(promoted, 0.1);
  await dispatchQueuedRoutineRuns();

  // No Run carries a copy: the queue reads each Routine's priority when it orders.
  await AppDataSource.getRepository(Routine).update(promoted.id, { priority: "high" });
  await AppDataSource.getRepository(Routine).update(demoted.id, { priority: "normal" });
  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "Now high", "Stays normal", "Was high"]);
});

test("AI Employees on one model server share one queue, in one order", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const sam = await employeeOn(co, "sam", { baseURL: `${LOCAL_ENDPOINT}/` });
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  await waitingRun(await routineFor(jamie, "Jamie normal"), 8);
  await waitingRun(await routineFor(sam, "Sam high", { priority: "high" }), 1);
  await waitingRun(await routineFor(sam, "Sam normal"), 4);
  await waitingRun(await routineFor(jamie, "Jamie high", { priority: "high" }), 2);
  await dispatchQueuedRoutineRuns();

  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "Jamie high", "Sam high", "Jamie normal", "Sam normal"]);
});

test("a model that serves two Runs at once starts the two placed highest", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie", { maxConcurrentRuns: 2 });
  const model = recordingModel(t, ["High one", "High two"]);
  stopRoutineQueue();
  await waitingRun(await routineFor(jamie, "Normal one"), 9);
  await waitingRun(await routineFor(jamie, "Normal two"), 8);
  await waitingRun(await routineFor(jamie, "High one", { priority: "high" }), 2);
  await waitingRun(await routineFor(jamie, "High two", { priority: "high" }), 1);
  await resumeRoutineQueue();
  await Promise.all([model.reached("High one"), model.reached("High two")]);
  assert.deepEqual([...model.started].sort(), ["High one", "High two"]);
  assert.equal(await runs().countBy({ status: "queued" }), 2, "the Normal Runs wait for a slot");

  model.release("High one");
  model.release("High two");
  await waitForRoutineQueueIdle();
  assert.deepEqual(model.started.slice(2), ["Normal one", "Normal two"]);
});

test("a High Run held by a Standdown does not hold Normal work back", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  const held = await routineFor(jamie, "Held high", { priority: "high" });
  await waitingRun(held, 1);
  await waitingRun(await routineFor(jamie, "Normal"), 5);
  const standdown = await placeStanddown({
    companyId: co.id,
    scope: "routine",
    scopeId: held.id,
    reason: "Review the outreach list first.",
  });
  await dispatchQueuedRoutineRuns();

  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "Normal"]);
  assert.equal((await runs().findOneByOrFail({ routineId: held.id })).status, "queued");

  await liftStanddown({ standdown });
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.deepEqual(model.started, ["Busy", "Normal", "Held high"]);
});

test("a High Run whose Routine is still finishing another Run lets the next Run start", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  const assessing = await routineFor(jamie, "Assessing high", { priority: "high" });
  // An earlier Run of the Routine still holds its claim while it is assessed:
  // one Run of a Routine at a time, whatever its priority.
  const earlier = await insert(Run, {
    routineId: assessing.id,
    employeeId: jamie.id,
    status: "completed",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 5 * 60_000),
    finishedAt: new Date(),
    queueActiveEmployeeId: "run:earlier:assessing",
  });
  await waitingRun(assessing, 1);
  await waitingRun(await routineFor(jamie, "Normal"), 5);
  await dispatchQueuedRoutineRuns();

  await drain(model, busy);
  assert.deepEqual(model.started, ["Busy", "Normal"]);
  await runs().update(earlier.id, { queueActiveEmployeeId: null });
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.deepEqual(model.started, ["Busy", "Normal", "Assessing high"]);
});

test("a slot that frees while a pass is under way goes to the Run ahead, not the one the pass reached", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Busy"]);
  const busy = await occupyModel(jamie, model);
  const high = await waitingRun(await routineFor(jamie, "Ahead", { priority: "high" }), 1);
  await waitingRun(await routineFor(jamie, "Behind"), 2);
  const capacity = modelRunCapacity(
    await activeModelOf(jamie.id),
  );
  // The pass finds the model full for the High Run and notes why it waits;
  // right then the busy Run finishes and frees the slot, before the pass
  // offers the Normal Run behind it.
  const repo = runs();
  const update = repo.update.bind(repo);
  let freed = false;
  t.mock.method(repo, "update", async (...args: Parameters<typeof repo.update>) => {
    const result = await update(...args);
    const criteria = args[0] as { id?: string };
    const values = args[1] as { logContent?: string };
    if (!freed && criteria.id === high.id && values.logContent?.includes("Waiting for the AI Model")) {
      freed = true;
      model.release("Busy");
      await busy.completion;
      while ((await modelRunSlotsInUse(capacity)) > 0) await nextTurn();
    }
    return result;
  });
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.ok(freed, "the slot freed in the middle of a pass");
  assert.deepEqual(model.started, ["Busy", "Ahead", "Behind"]);
});

test("a new Run never takes a free slot from a Run ahead of it in the queue", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t, ["Waiting high"]);
  // Waiting since before the slot came free, and not yet offered it.
  await waitingRun(await routineFor(jamie, "Waiting high", { priority: "high" }), 1);
  // A Run queued now is offered its start in queue order, behind that one.
  const fresh = await startRoutineRun(await routineFor(jamie, "Fresh normal"), {
    triggerKind: "manual",
  });
  await model.reached("Waiting high");
  assert.deepEqual(model.started, ["Waiting high"]);
  assert.equal((await runs().findOneByOrFail({ id: fresh.run.id })).status, "queued");

  model.release("Waiting high");
  assert.equal((await fresh.completion).status, "completed");
  assert.deepEqual(model.started, ["Waiting high", "Fresh normal"]);
});

test("a model with no limit starts every waiting Run at once, whatever its priority", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie", { maxConcurrentRuns: 0 });
  const model = recordingModel(t, ["Normal", "High"]);
  stopRoutineQueue();
  await waitingRun(await routineFor(jamie, "Normal"), 3);
  await waitingRun(await routineFor(jamie, "High", { priority: "high" }), 1);
  await resumeRoutineQueue();
  await Promise.all([model.reached("Normal"), model.reached("High")]);
  assert.equal(await runs().countBy({ status: "running" }), 2);
  model.release("Normal");
  model.release("High");
  await waitForRoutineQueueIdle();
  assert.equal(await runs().countBy({ status: "completed" }), 2);
});

test("an upgrade hold keeps High work waiting too, and the order survives it", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t);
  await holdRoutineQueue(new Date(Date.now() + 10 * 60_000));
  await waitingRun(await routineFor(jamie, "Normal"), 4);
  const high = await waitingRun(await routineFor(jamie, "High", { priority: "high" }), 1);
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.deepEqual(model.started, [], "nothing starts while an upgrade holds the queue");
  assert.match(
    (await runs().findOneByOrFail({ id: high.id })).logContent,
    /Waiting for Genosyn to restart for an upgrade/,
  );

  await releaseRoutineQueue();
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.deepEqual(model.started, ["High", "Normal"]);
});

test("a High Routine that now needs approval still skips its scheduled Run", async (t) => {
  const co = await company();
  const jamie = await employeeOn(co, "jamie");
  const model = recordingModel(t);
  const gated = await routineFor(jamie, "Gated high", { priority: "high", requiresApproval: true });
  const pending = await waitingRun(gated, 1);
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  assert.deepEqual(model.started, []);
  assert.equal((await runs().findOneByOrFail({ id: pending.id })).status, "skipped");
});
