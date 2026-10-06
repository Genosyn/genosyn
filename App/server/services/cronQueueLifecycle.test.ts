import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { bootCron, stopCron, tickCron } from "./cron.js";
import { startRoutineRun } from "./runner.js";
import { waitForRoutineQueueIdle } from "./routineQueue.js";
import { stopStanddowns } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await resetTestDb();
});
after(async () => {
  stopCron();
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

async function queuedRoutine() {
  const company = await insert(Company, { name: "Lifecycle", slug: "lifecycle", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "test",
    }),
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review",
    slug: "review",
    body: "Review the records.",
    cronExpr: "0 9 * * *",
    timeoutSec: 60,
    nextRunAt: new Date(Date.now() + 86_400_000),
  });
  return startRoutineRun(routine);
}

test("a reboot waits for the older heartbeat and performs its own recovery before draining", async (t) => {
  const pending = await queuedRoutine();
  const entered = barrier();
  const release = barrier();
  const repo = AppDataSource.getRepository(Run);
  const find = repo.find.bind(repo);
  let recoveries = 0;
  t.mock.method(repo, "find", async (options: Parameters<typeof repo.find>[0]) => {
    if (options?.where && !Array.isArray(options.where) && options.where.status === "running") {
      if (++recoveries === 1) {
        entered.resolve();
        await release.promise;
      }
    }
    return find(options);
  });
  let turns = 0;
  t.mock.method(agentRuntime, "run", async () => {
    assert.equal(recoveries, 2, "the replacement boot must reconcile before starting work");
    turns++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const oldBoot = bootCron();
  await entered.promise;
  stopCron();
  const newBoot = bootCron();
  release.resolve();
  await Promise.all([oldBoot, newBoot]);
  assert.equal((await pending.completion).status, "completed");
  assert.equal(turns, 1);
});

test("a failed boot recovery holds the queue until a later heartbeat succeeds", async (t) => {
  const pending = await queuedRoutine();
  const repo = AppDataSource.getRepository(Run);
  const find = repo.find.bind(repo);
  let failures = 1;
  t.mock.method(repo, "find", async (options: Parameters<typeof repo.find>[0]) => {
    if (
      options?.where &&
      !Array.isArray(options.where) &&
      options.where.status === "running" &&
      failures-- > 0
    )
      throw new Error("Simulated recovery outage");
    return find(options);
  });
  let turns = 0;
  t.mock.method(agentRuntime, "run", async () => {
    turns++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  await bootCron();
  await waitForRoutineQueueIdle();
  assert.equal(turns, 0);
  assert.equal((await repo.findOneByOrFail({ id: pending.run.id })).status, "queued");
  await tickCron();
  assert.equal((await pending.completion).status, "completed");
  assert.equal(turns, 1);
});

test("a stopped boot heartbeat cannot resume the queue after its delayed recovery returns", async (t) => {
  const pending = await queuedRoutine();
  const entered = barrier();
  const release = barrier();
  const repo = AppDataSource.getRepository(Run);
  const find = repo.find.bind(repo);
  let held = false;
  t.mock.method(repo, "find", async (options: Parameters<typeof repo.find>[0]) => {
    if (
      !held &&
      options?.where &&
      !Array.isArray(options.where) &&
      options.where.status === "running"
    ) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return find(options);
  });
  let turns = 0;
  t.mock.method(agentRuntime, "run", async () => {
    turns++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const boot = bootCron();
  await entered.promise;
  stopCron();
  release.resolve();
  await boot;
  await waitForRoutineQueueIdle();
  assert.equal(turns, 0);
  assert.equal((await repo.findOneByOrFail({ id: pending.run.id })).status, "queued");
  await bootCron();
  assert.equal((await pending.completion).status, "completed");
});

test("a missed scheduler lease keeps queued work stopped until boot recovery can run", async (t) => {
  const pending = await queuedRoutine();
  let turns = 0;
  t.mock.method(agentRuntime, "run", async () => {
    turns++;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const originalDriver = config.db.driver;
  const transaction = t.mock.method(AppDataSource, "transaction", async () => false);
  try {
    // Exercise the lease-miss branch without needing another database process.
    // Its acquire transaction returns false before Postgres-only locking runs.
    Object.assign(config.db, { driver: "postgres" });
    await bootCron();
  } finally {
    Object.assign(config.db, { driver: originalDriver });
    transaction.mock.restore();
  }
  await waitForRoutineQueueIdle();
  assert.equal(turns, 0);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: pending.run.id })).status,
    "queued",
  );
  await tickCron();
  assert.equal((await pending.completion).status, "completed");
  assert.equal(turns, 1);
});
