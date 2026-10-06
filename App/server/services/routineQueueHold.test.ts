import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
import { stopCron } from "./cron.js";
import { startRoutineRun } from "./runner.js";
import { reconcileOrphanedRuns } from "./runRecovery.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import {
  drainRoutineRuns,
  HOLD_MARGIN_MS,
  holdRoutineQueue,
  releaseRoutineQueue,
  routineQueueHeldUntil,
} from "./routineQueueHold.js";
import { stopStanddowns } from "./standdowns.js";

// The nightly automatic upgrade restarted one install at 02:17 on five of
// eleven nights, each time cutting off the Routine its local model was
// working on. An upgrade now lets running Runs finish first.

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
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

async function routine() {
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
  return insert(Routine, {
    employeeId: employee.id,
    name: "Historical Email Lead Backfill",
    slug: "historical-email-lead-backfill",
    cronExpr: "0 2 * * *",
    body: "Backfill leads from historical email.",
  });
}

function running(backfill: Routine) {
  return insert(Run, {
    routineId: backfill.id,
    employeeId: backfill.employeeId,
    status: "running",
    triggerKind: "schedule",
    startedAt: new Date(),
  });
}

test("a hold lasts until it is released or expires", async () => {
  assert.equal(await routineQueueHeldUntil(), null);
  const until = new Date(Date.now() + 60_000);
  await holdRoutineQueue(until);
  assert.equal((await routineQueueHeldUntil())?.getTime(), until.getTime());
  assert.equal(await routineQueueHeldUntil(new Date(until.getTime() + 1)), null, "expired");
  await holdRoutineQueue(new Date(until.getTime() + 60_000));
  assert.equal((await routineQueueHeldUntil())?.getTime(), until.getTime() + 60_000, "extended");
  await releaseRoutineQueue();
  assert.equal(await routineQueueHeldUntil(), null);
});

test("draining with nothing running holds the queue and returns at once", async () => {
  const before = Date.now();
  assert.equal(await drainRoutineRuns({ minutes: 60, pollMs: 10 }), 0);
  const until = await routineQueueHeldUntil();
  assert.ok(until, "new Runs wait for the restart");
  assert.ok(until.getTime() >= before + 60 * 60_000 + HOLD_MARGIN_MS);
});

test("draining waits for the running Run to finish", async () => {
  const backfill = await routine();
  const run = await running(backfill);
  const waits: number[] = [];
  const draining = drainRoutineRuns({
    minutes: 1,
    pollMs: 10,
    onWaiting: (count) => waits.push(count),
  });
  await delay(80);
  await AppDataSource.getRepository(Run).update(
    { id: run.id },
    { status: "completed", finishedAt: new Date() },
  );
  assert.equal(await draining, 0);
  assert.ok(waits.length > 0 && waits.every((count) => count === 1));
});

test("draining gives up when its time runs out and reports what is still running", async () => {
  const backfill = await routine();
  await running(backfill);
  const started = Date.now();
  assert.equal(await drainRoutineRuns({ minutes: 0.002, pollMs: 10 }), 1);
  assert.ok(Date.now() - started >= 100);
});

test("a Run queued during a hold waits, says why, and starts once the hold is released", async (t) => {
  const backfill = await routine();
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Backfilled 3 leads.",
    steps: 4,
    stopReason: "end_turn",
  }));
  await holdRoutineQueue(new Date(Date.now() + 60_000));
  const { completion } = await startRoutineRun(backfill, { triggerKind: "manual" });
  await waitForRoutineQueueIdle();
  const held = await AppDataSource.getRepository(Run).findOneByOrFail({ routineId: backfill.id });
  assert.equal(held.status, "queued");
  assert.match(held.logContent, /Waiting for Genosyn to restart for an upgrade/);

  await releaseRoutineQueue();
  await dispatchQueuedRoutineRuns();
  const run = await completion;
  assert.equal(run.status, "completed");
});

test("the restarted process releases the hold before it starts queued Runs", async () => {
  await holdRoutineQueue(new Date(Date.now() + 60_000));
  await reconcileOrphanedRuns({ now: new Date() });
  assert.ok(await routineQueueHeldUntil(), "an ordinary heartbeat keeps the hold");
  await reconcileOrphanedRuns({ boot: true, now: new Date() });
  assert.equal(await routineQueueHeldUntil(), null);
});
