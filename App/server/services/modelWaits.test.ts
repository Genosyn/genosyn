import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModelWait } from "../db/entities/AIModelWait.js";
import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import {
  MAX_WAIT_ATTEMPTS,
  isWaitingForModel,
  resetModelWaitsForTests,
  runModelWaitsPass,
  setModelWaitHandlerForTests,
  settleModelWaitsForTests,
  startModelWaits,
  stopModelWaits,
  waitForModel,
  waitsByModel,
  waitsInGroup,
  type ModelWaitHandler,
  type ModelWaitResult,
} from "./modelWaits.js";

/**
 * The ledger of AI work that waits for an unavailable AI Model with no queue
 * of its own: each piece waits once, is carried on once its model answers,
 * never while it is down, and is given up — saying so — when it is too old or
 * keeps meeting the outage. The handlers are stand-ins; the ledger, the
 * breaker and the database are real.
 */

before(initTestDb);
beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
});
afterEach(() => {
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
});
after(closeTestDb);

async function fixture() {
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan",
    slug: "morgan",
    role: "Analyst",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
  });
  return { company, employee, model };
}

function down(model: AIModel): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

type Recorder = {
  resumed: string[];
  abandoned: Array<{ targetId: string; reason: string }>;
  handler: ModelWaitHandler;
};

function recorder(
  result: (targetId: string, call: number) => ModelWaitResult | Promise<ModelWaitResult>,
  extra: Partial<ModelWaitHandler> = {},
): Recorder {
  const resumed: string[] = [];
  const abandoned: Array<{ targetId: string; reason: string }> = [];
  return {
    resumed,
    abandoned,
    handler: {
      resume: async (wait) => {
        resumed.push(wait.targetId);
        return result(wait.targetId, resumed.length);
      },
      abandon: async (wait, reason) => {
        abandoned.push({ targetId: wait.targetId, reason });
      },
      ...extra,
    },
  };
}

async function rows(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find({ order: { createdAt: "ASC" } });
}

describe("waiting", () => {
  test("a piece of work waits once, however often it meets the outage", async () => {
    const { company, employee, model } = await fixture();
    down(model);
    const first = await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
      groupKey: "pipeline-1",
      payload: { step: 1 },
    });
    const second = await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
      groupKey: "pipeline-1",
      payload: { step: 2 },
    });
    assert.deepEqual(first, { created: true });
    assert.deepEqual(second, { created: false });
    const [only, ...rest] = await rows();
    assert.equal(rest.length, 0);
    assert.equal(only.status, "waiting");
    assert.equal(only.modelId, model.id);
    assert.deepEqual(JSON.parse(only.payloadJson), { step: 2 }, "the newest payload");
    assert.equal(await isWaitingForModel("pipeline_run", "run-1"), true);
    assert.equal((await waitsInGroup("pipeline_run", "pipeline-1")).length, 1);
    assert.deepEqual([...(await waitsByModel(company.id, [model.id])).entries()], [[model.id, 1]]);
  });

  test("nothing is carried on while its AI Model is unavailable, and it is once the model is back", async () => {
    const { company, employee, model } = await fixture();
    const work = recorder(() => ({ status: "done" }));
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    down(model);
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, [], "never while the model is down");
    assert.equal((await rows()).length, 1);

    await back(model);
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, ["run-1"], "once, when it is back");
    assert.equal((await rows()).length, 0, "the row is gone when the work ran");

    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, ["run-1"], "and never twice");
  });

  test("two passes at once carry a piece of work on only once", async () => {
    const { company, employee, model } = await fixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const work = recorder(async () => {
      await gate;
      return { status: "done" };
    });
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await AppDataSource.getRepository(AIModelWait).update({ targetId: "run-1" }, { resumeAt: new Date(0) });
    await Promise.all([runModelWaitsPass(), runModelWaitsPass(), runModelWaitsPass()]);
    assert.equal((await rows())[0].status, "resuming");
    release();
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, ["run-1"]);
  });

  test("meeting the outage again waits again, counts the attempt, and gives up after the cap", async () => {
    const { company, employee, model } = await fixture();
    const work = recorder(() => ({ status: "waiting" }));
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await settleModelWaitsForTests();
    assert.equal(work.resumed.length, 1);
    const [afterOne] = await rows();
    assert.equal(afterOne.status, "waiting");
    assert.equal(afterOne.attempts, 1);
    assert.ok(afterOne.resumeAt.getTime() > Date.now(), "looked at again later, not at once");

    for (let i = 1; i < MAX_WAIT_ATTEMPTS; i++) await settleModelWaitsForTests();
    assert.equal(work.resumed.length, MAX_WAIT_ATTEMPTS);
    assert.deepEqual(work.abandoned, [{ targetId: "run-1", reason: "attempts" }]);
    assert.equal((await rows()).length, 0);
  });

  test("not ready for another reason looks again later and counts nothing", async () => {
    const { company, employee, model } = await fixture();
    const later = new Date(Date.now() + 120_000);
    const work = recorder((_id, call) =>
      call === 1 ? { status: "later", at: later } : { status: "done" },
    );
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await settleModelWaitsForTests();
    const [waiting] = await rows();
    assert.equal(waiting.attempts, 0);
    assert.equal(waiting.resumeAt.getTime(), later.getTime());
    await runModelWaitsPass();
    assert.equal(work.resumed.length, 1, "not before its time");
    await settleModelWaitsForTests(() => new Date(later.getTime() + 1));
    assert.equal(work.resumed.length, 2);
  });

  test("work older than its handler allows is given up, and the feature says why", async () => {
    const { company, employee, model } = await fixture();
    const work = recorder(() => ({ status: "done" }), { maxAgeMs: () => 60_000 });
    setModelWaitHandlerForTests("customer_channel_reply", work.handler);
    await waitForModel({
      kind: "customer_channel_reply",
      targetId: "message-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await settleModelWaitsForTests(() => new Date(Date.now() + 61_000));
    assert.deepEqual(work.resumed, []);
    assert.deepEqual(work.abandoned, [{ targetId: "message-1", reason: "expired" }]);
    assert.equal((await rows()).length, 0);
  });

  test("a resume that throws is tried again later, never dropped on the floor", async () => {
    const { company, employee, model } = await fixture();
    const work = recorder((_id, call) => {
      if (call === 1) throw new Error("database hiccup");
      return { status: "done" };
    });
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await settleModelWaitsForTests();
    assert.equal((await rows())[0].attempts, 1);
    await settleModelWaitsForTests(() => new Date(Date.now() + 10 * 60_000));
    assert.equal(work.resumed.length, 2);
    assert.equal((await rows()).length, 0);
  });
});

describe("restarts and recovery", () => {
  test("work a stopped process was carrying on is taken back on boot and carried on once", async () => {
    const { company, employee, model } = await fixture();
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    // The process that claimed it died mid-resume.
    await AppDataSource.getRepository(AIModelWait).update(
      { targetId: "run-1" },
      { status: "resuming", claimedUntil: new Date(Date.now() + 60_000) },
    );
    const work = recorder(() => ({ status: "done" }));
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await startModelWaits();
    stopModelWaits();
    assert.equal((await rows())[0].status, "waiting", "boot takes it back on SQLite");
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, ["run-1"]);
  });

  test("a claim that lapsed is taken back by the next pass", async () => {
    const { company, employee, model } = await fixture();
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await AppDataSource.getRepository(AIModelWait).update(
      { targetId: "run-1" },
      { status: "resuming", claimedUntil: new Date(Date.now() - 1) },
    );
    const work = recorder(() => ({ status: "done" }));
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, ["run-1"]);
  });

  test("a restart during the outage keeps the work waiting, and it carries on when the model is back", async () => {
    const { company, employee, model } = await fixture();
    down(model);
    await flushModelAvailabilityWrites();
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    // A restart: this process forgets the breaker's memory; the outage and the
    // wait are rows, read back on boot.
    resetModelAvailabilityForTests();
    const { loadModelOutages } = await import("./modelAvailability.js");
    await loadModelOutages();
    const work = recorder(() => ({ status: "done" }));
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, [], "still down after the restart");
    await back(model);
    await settleModelWaitsForTests();
    assert.deepEqual(work.resumed, ["run-1"]);
  });

  test("the model answering again brings the work forward at once when the ledger is running", async () => {
    const { company, employee, model } = await fixture();
    const work = recorder(() => ({ status: "done" }));
    setModelWaitHandlerForTests("pipeline_run", work.handler);
    down(model);
    await waitForModel({
      kind: "pipeline_run",
      targetId: "run-1",
      companyId: company.id,
      employeeId: employee.id,
      model,
    });
    await AppDataSource.getRepository(AIModelWait).update(
      { targetId: "run-1" },
      { resumeAt: new Date(Date.now() + 10 * 60_000) },
    );
    await startModelWaits();
    try {
      await back(model);
      for (let i = 0; i < 100 && work.resumed.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(work.resumed, ["run-1"], "not at its next look, but at once");
    } finally {
      stopModelWaits();
      await settleModelWaitsForTests();
    }
  });
});
