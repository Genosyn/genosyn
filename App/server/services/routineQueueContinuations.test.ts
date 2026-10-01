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
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { saveRunCheckpoint, type RunCheckpoint } from "./runContinuation.js";
import { startRoutineRun } from "./runner.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";

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

const complete: RunCheckpoint = {
  state: "complete",
  completed: "Replied to two of today's threads.",
  remaining: "",
  resume: "",
  progressKey: "replied",
};

const unfinished: RunCheckpoint = {
  state: "continue",
  completed: "Read the profile's earlier replies.",
  remaining: "Reply to two of today's threads.",
  resume: "Open the Primal home feed and pick two threads from today.",
  progressKey: "oriented",
};

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
    role: "Community",
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

function routineFor(employee: AIEmployee, name: string) {
  return insert(Routine, {
    employeeId: employee.id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    cronExpr: "30 18 * * *",
    timeoutSec: 600,
    body: `${name}: help people with concrete answers.`,
  });
}

/** A Run that handed its unfinished work to a continuation. */
function handedOff(routine: Routine, deadline: Date) {
  return insert(Run, {
    routineId: routine.id,
    employeeId: routine.employeeId,
    status: "failed",
    triggerKind: "schedule",
    startedAt: new Date(deadline.getTime() - 600_000),
    finishedAt: new Date(),
    checkpointJson: JSON.stringify(unfinished),
    continuationDeadlineAt: deadline,
  });
}

/** Finish a continuation the way the model would: save a complete checkpoint. */
async function finishContinuation(params: Parameters<typeof agentRuntime.run>[0]) {
  const run = await AppDataSource.getRepository(Run).findOneBy({
    status: "running",
    triggerKind: "continuation",
  });
  if (!run) return;
  const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: run.routineId });
  const employee = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
    id: routine.employeeId,
  });
  const token = issueMcpToken(employee.id, employee.companyId, {
    authority: "employee",
    routineId: routine.id,
    runId: run.id,
  });
  try {
    const saved = await saveRunCheckpoint(token, complete);
    params.callbacks?.onToolResult?.("save_run_checkpoint", {
      content: JSON.stringify({ ok: true, state: saved.state, checkpoint: saved }),
    });
  } finally {
    revokeMcpToken(token);
  }
}

/** Mock the model: the first work turn waits on `release`; record the order Routines start. */
function busyModel(t: TestContext) {
  const firstStarted = barrier();
  const release = barrier();
  const started: string[] = [];
  t.after(release.resolve);
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const first = params.messages[0]?.content[0];
    const brief = first && "text" in first ? first.text : "";
    started.push(/^## Routine: (.+)$/m.exec(brief)?.[1] ?? "?");
    if (started.length === 1) {
      firstStarted.resolve();
      await release.promise;
    }
    await finishContinuation(params);
    return { finalText: "Replied to two threads.", steps: 2, stopReason: "end_turn" };
  });
  return { firstStarted, release, started };
}

function runOf(routine: Routine, triggerKind: Run["triggerKind"]): Promise<Run> {
  return AppDataSource.getRepository(Run).findOneByOrFail({ routineId: routine.id, triggerKind });
}

// 2026-10-01: Daily Nostr Helpful Replies handed off at 19:48 with 79 minutes
// of its 21:07 deadline left; its continuation queued behind three Runs of
// one to four hours each, so the deadline would pass before it could start.
test("a continuation that waited out its parent's deadline keeps the time its parent left", async (t) => {
  const employee = await localEmployee();
  const outreach = await routineFor(employee, "Stripe Qualification");
  const replies = await routineFor(employee, "Nostr Helpful Replies");
  const model = busyModel(t);

  const busy = await startRoutineRun(outreach, { triggerKind: "schedule" });
  await model.firstStarted.promise;
  const parent = await handedOff(replies, new Date(Date.now() + 10 * 60_000));
  await startRoutineRun(replies, { triggerKind: "continuation", continuationFromRunId: parent.id });
  const waiting = await runOf(replies, "continuation");
  assert.equal(waiting.status, "queued");

  // Two hours pass in the queue: the parent's deadline is now long gone.
  const runs = AppDataSource.getRepository(Run);
  const queuedAt = new Date(Date.now() - 2 * 60 * 60_000);
  const parentDeadline = new Date(queuedAt.getTime() + 10 * 60_000);
  await runs.update(parent.id, { continuationDeadlineAt: parentDeadline });
  await runs.update(waiting.id, {
    createdAt: queuedAt,
    startedAt: queuedAt,
    continuationDeadlineAt: parentDeadline,
  });

  model.release.resolve();
  await busy.completion;
  await waitForRoutineQueueIdle();
  const continued = await runs.findOneByOrFail({ id: waiting.id });
  assert.equal(continued.status, "completed", continued.logContent);
  assert.doesNotMatch(continued.logContent, /cannot start an automatic continuation/);
  assert.match(
    continued.logContent,
    /\[queue\] Waited 2h in the queue before starting; the shared deadline moved by the same time\./,
  );
  const left = continued.continuationDeadlineAt!.getTime() - continued.startedAt.getTime();
  assert.ok(
    left > 9 * 60_000 && left <= 10 * 60_000 + 5_000,
    `the continuation keeps the ten minutes its parent left, not ${left}ms`,
  );
  assert.deepEqual(model.started, ["Stripe Qualification", "Nostr Helpful Replies"]);
});

test("a continuation is offered a freed slot before fresh Runs queued ahead of it", async (t) => {
  const employee = await localEmployee();
  const outreach = await routineFor(employee, "Stripe Qualification");
  const prospecting = await routineFor(employee, "Enterprise Prospecting");
  const replies = await routineFor(employee, "Nostr Helpful Replies");
  const model = busyModel(t);

  const busy = await startRoutineRun(outreach, { triggerKind: "schedule" });
  await model.firstStarted.promise;
  await startRoutineRun(prospecting, { triggerKind: "manual" });
  const parent = await handedOff(replies, new Date(Date.now() + 10 * 60_000));
  await startRoutineRun(replies, { triggerKind: "continuation", continuationFromRunId: parent.id });
  assert.equal((await runOf(prospecting, "manual")).status, "queued");
  assert.equal((await runOf(replies, "continuation")).status, "queued");

  model.release.resolve();
  await busy.completion;
  await waitForRoutineQueueIdle();
  assert.deepEqual(
    model.started,
    ["Stripe Qualification", "Nostr Helpful Replies", "Enterprise Prospecting"],
    "the continuation finishes started work before new work begins",
  );
  assert.equal((await runOf(replies, "continuation")).status, "completed");
  assert.equal((await runOf(prospecting, "manual")).status, "completed");
});

test("a continuation dispatched at once keeps its parent's exact deadline", async (t) => {
  const employee = await localEmployee();
  const replies = await routineFor(employee, "Nostr Helpful Replies");
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps === null) await finishContinuation(params);
    return { finalText: "Replied to two threads.", steps: 2, stopReason: "end_turn" };
  });
  const deadline = new Date(Date.now() + 10 * 60_000);
  const parent = await handedOff(replies, deadline);
  const continued = await (
    await startRoutineRun(replies, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
    })
  ).completion;
  assert.equal(continued.status, "completed", continued.logContent);
  assert.equal(continued.continuationDeadlineAt?.getTime(), deadline.getTime());
  assert.doesNotMatch(continued.logContent, /\[queue\] Waited/);
});

test("a continuation deferred by a Standdown at its claim is credited its wait once", async (t) => {
  const employee = await localEmployee();
  const outreach = await routineFor(employee, "Stripe Qualification");
  const replies = await routineFor(employee, "Nostr Helpful Replies");
  const model = busyModel(t);

  const busy = await startRoutineRun(outreach, { triggerKind: "schedule" });
  await model.firstStarted.promise;
  const parent = await handedOff(replies, new Date(Date.now() + 10 * 60_000));
  await startRoutineRun(replies, { triggerKind: "continuation", continuationFromRunId: parent.id });
  const waiting = await runOf(replies, "continuation");
  const runs = AppDataSource.getRepository(Run);
  const queuedAt = new Date(Date.now() - 2 * 60 * 60_000);
  const parentDeadline = new Date(queuedAt.getTime() + 10 * 60_000);
  await runs.update(parent.id, { continuationDeadlineAt: parentDeadline });
  await runs.update(waiting.id, {
    createdAt: queuedAt,
    startedAt: queuedAt,
    continuationDeadlineAt: parentDeadline,
  });

  // A Member stands the Routine down while its continuation is being claimed.
  const company = await AppDataSource.getRepository(Company).findOneByOrFail({});
  const update = runs.update.bind(runs);
  let standdown: Awaited<ReturnType<typeof placeStanddown>> | undefined;
  const deferred = barrier();
  t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
    const result = await update(...args);
    const where = args[0] as { id?: string };
    if (where.id === waiting.id && args[1].status === "running" && !standdown) {
      standdown = await placeStanddown({
        companyId: company.id,
        scope: "routine",
        scopeId: replies.id,
        reason: "Pause the replies for a moment.",
      });
    } else if (where.id === waiting.id && args[1].status === "queued") {
      deferred.resolve();
    }
    return result;
  });

  model.release.resolve();
  await busy.completion;
  await deferred.promise;
  await waitForRoutineQueueIdle();
  const held = await runs.findOneByOrFail({ id: waiting.id });
  assert.equal(held.status, "queued");
  assert.equal(
    held.continuationDeadlineAt?.getTime(),
    parentDeadline.getTime(),
    "the deferral gives back the wait its claim credited",
  );

  assert.ok(standdown);
  await liftStanddown({ standdown });
  await dispatchQueuedRoutineRuns();
  await waitForRoutineQueueIdle();
  const continued = await runs.findOneByOrFail({ id: waiting.id });
  assert.equal(continued.status, "completed", continued.logContent);
  const left = continued.continuationDeadlineAt!.getTime() - continued.startedAt.getTime();
  assert.ok(
    left > 9 * 60_000 && left <= 10 * 60_000 + 5_000,
    `the continuation keeps the ten minutes its parent left, not ${left}ms`,
  );
});
