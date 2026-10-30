import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { AppDataSource } from "../../db/datasource.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModelWait } from "../../db/entities/AIModelWait.js";
import { Company } from "../../db/entities/Company.js";
import { JournalEntry } from "../../db/entities/JournalEntry.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun } from "../../db/entities/PipelineRun.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { modelUnavailability } from "../agent/modelOutage.js";
import { openCodeError } from "../agent/opencodeEvents.js";
import { agentRuntime } from "../agent/runtime.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  loadModelOutages,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "../modelAvailability.js";
import {
  MAX_WAIT_ATTEMPTS,
  resetModelWaitsForTests,
  settleModelWaitsForTests,
} from "../modelWaits.js";
import { runPipeline } from "./executor.js";
import { fireManually, runPipelineHeartbeatPass, serializeGraph } from "./index.js";
import type { PipelineGraph } from "./types.js";

/**
 * A Pipeline whose AI step meets an unavailable AI Model: the run pauses at
 * that step — what ran before keeps its outputs and never runs again — and
 * carries on from the same step by itself once the model is back, on the graph
 * it started with. The model's error never reaches the next step as if it were
 * the answer. The runtime is a stand-in; the executor, the handlers, the wait
 * ledger and the breaker are real.
 */

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];

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

let company: Company;
let employee: AIEmployee;
let model: AIModel;

async function fixture(): Promise<void> {
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Quinn",
    slug: "quinn",
    role: "Bookkeeper",
  });
  model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: "{}",
  });
}

/** manual → journal "before" → ask Quinn → journal "after: <reply>". */
function graph(afterTitle = "after: {{ask.reply}}"): PipelineGraph {
  return {
    nodes: [
      { id: "start", type: "trigger.manual", x: 0, y: 0, config: {} },
      {
        id: "before",
        type: "action.journalNote",
        x: 0,
        y: 0,
        config: { employeeSlug: "quinn", title: "before", body: "" },
      },
      {
        id: "ask",
        type: "action.askEmployee",
        x: 0,
        y: 0,
        config: { employeeSlug: "quinn", message: "Is the ledger reconciled?" },
      },
      {
        id: "after",
        type: "action.journalNote",
        x: 0,
        y: 0,
        config: { employeeSlug: "quinn", title: afterTitle, body: "" },
      },
    ],
    edges: [
      { id: "e1", fromNodeId: "start", toNodeId: "before" },
      { id: "e2", fromNodeId: "before", toNodeId: "ask" },
      { id: "e3", fromNodeId: "ask", toNodeId: "after" },
    ],
  };
}

async function pipeline(over: Partial<Pipeline> = {}): Promise<Pipeline> {
  return insert(Pipeline, {
    companyId: company.id,
    name: "Ledger check",
    slug: "ledger-check",
    description: "",
    enabled: true,
    graphJson: serializeGraph(graph()),
    cronExpr: null,
    nextRunAt: null,
    ...over,
  });
}

function down(): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

function overloadedError(): Error {
  return openCodeError({
    name: "APIError",
    data: {
      message: "Overloaded",
      statusCode: 529,
      isRetryable: true,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    },
  } as never);
}

function runtime(
  t: TestContext,
  answer: (call: number) => string | Error = () => "Yes, reconciled.",
): RuntimeParams[] {
  const calls: RuntimeParams[] = [];
  t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
    calls.push(params);
    const outcome = answer(calls.length);
    if (outcome instanceof Error) throw outcome;
    params.callbacks?.onText?.(outcome);
    return { finalText: outcome, steps: 1, stopReason: "end_turn" };
  });
  return calls;
}

async function journalTitles(): Promise<string[]> {
  const rows = await AppDataSource.getRepository(JournalEntry).find({
    where: { employeeId: employee.id },
    order: { createdAt: "ASC" },
  });
  return rows.map((row) => row.title);
}

async function reload(id: string): Promise<PipelineRun> {
  return AppDataSource.getRepository(PipelineRun).findOneByOrFail({ id });
}

async function waits(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find();
}

describe("an AI step whose AI Model is unavailable", () => {
  test("pauses the run there, keeping what ran, and it carries on from that step to the end once the model is back", async (t) => {
    await fixture();
    const calls = runtime(t);
    down();
    const p = await pipeline();
    const run = await fireManually(p);
    assert.equal(run.status, "paused");
    assert.equal(run.errorMessage, null, "not a failure");
    assert.equal(run.finishedAt, null);
    assert.match(run.logContent, /\[paused\] Quinn's AI Model is unavailable/);
    assert.deepEqual(await journalTitles(), ["before"]);
    assert.equal(calls.length, 0, "nothing is sent to a model that is down");
    assert.ok(JSON.parse(run.outputJson).before, "the outputs so far are kept");
    const [wait] = await waits();
    assert.equal(wait.kind, "pipeline_run");
    assert.equal(wait.targetId, run.id);
    assert.equal(wait.groupKey, p.id);

    await settleModelWaitsForTests();
    assert.equal((await reload(run.id)).status, "paused", "still down");

    await back();
    await settleModelWaitsForTests();
    const done = await reload(run.id);
    assert.equal(done.status, "completed", done.logContent);
    assert.ok(done.finishedAt);
    assert.match(done.logContent, /\[resumed\] The AI Model is answering again/);
    assert.deepEqual(
      await journalTitles(),
      ["before", "after: Yes, reconciled."],
      "the steps before the pause ran once, and the answer reached the step after",
    );
    assert.equal(calls.length, 1);
    assert.equal((await waits()).length, 0);
  });

  test("an outage in the middle of the step pauses too: the model's error never reaches the next step", async (t) => {
    await fixture();
    const calls = runtime(t, (call) => (call === 1 ? overloadedError() : "Yes, reconciled."));
    const p = await pipeline();
    const run = await fireManually(p);
    assert.equal(run.status, "paused");
    assert.deepEqual(await journalTitles(), ["before"], "no step was handed the error as a reply");
    assert.doesNotMatch(run.logContent, /reply \(error\)/);
    await back();
    await settleModelWaitsForTests();
    assert.equal((await reload(run.id)).status, "completed");
    assert.deepEqual(await journalTitles(), ["before", "after: Yes, reconciled."]);
    assert.equal(calls.length, 2);
  });

  test("meeting the outage again pauses again at the same step, and the run still completes", async (t) => {
    await fixture();
    runtime(t, (call) => (call <= 2 ? overloadedError() : "Yes, reconciled."));
    const run = await fireManually(await pipeline());
    await back();
    await settleModelWaitsForTests();
    const again = await reload(run.id);
    assert.equal(again.status, "paused");
    assert.equal((await waits())[0].attempts, 1);
    await back();
    await settleModelWaitsForTests();
    assert.equal((await reload(run.id)).status, "completed");
    assert.deepEqual(await journalTitles(), ["before", "after: Yes, reconciled."]);
  });

  test("an edit made while it waited does not change the run: it finishes on the graph it started with", async (t) => {
    await fixture();
    runtime(t);
    down();
    const p = await pipeline();
    const run = await fireManually(p);
    await AppDataSource.getRepository(Pipeline).update(
      { id: p.id },
      { graphJson: serializeGraph(graph("edited: {{ask.reply}}")) },
    );
    await back();
    await settleModelWaitsForTests();
    assert.equal((await reload(run.id)).status, "completed");
    assert.deepEqual(await journalTitles(), ["before", "after: Yes, reconciled."]);
  });

  test("a Pipeline turned off while it waited ends the run failed, saying so", async (t) => {
    await fixture();
    const calls = runtime(t);
    down();
    const p = await pipeline();
    const run = await fireManually(p);
    await AppDataSource.getRepository(Pipeline).update({ id: p.id }, { enabled: false });
    await back();
    await settleModelWaitsForTests();
    const ended = await reload(run.id);
    assert.equal(ended.status, "failed");
    assert.match(ended.errorMessage ?? "", /turned off while this run waited/);
    assert.equal(calls.length, 0);
  });

  test("a run an email started, whose mailbox was paused while it waited, ends failed rather than acting", async (t) => {
    await fixture();
    const calls = runtime(t);
    down();
    const account = await insert(MailAccount, {
      companyId: company.id,
      connectionId: "connection-1",
      address: "owner@example.com",
      status: "active",
    });
    const p = await pipeline();
    const run = await runPipeline({
      pipeline: p,
      triggerKind: "event",
      triggerNodeId: "start",
      payload: { event: "email.received", message: { id: "m1", accountId: account.id } },
    });
    assert.equal(run.status, "paused");
    await AppDataSource.getRepository(MailAccount).update({ id: account.id }, { status: "paused" });
    await back();
    await settleModelWaitsForTests();
    const ended = await reload(run.id);
    assert.equal(ended.status, "failed");
    assert.match(ended.errorMessage ?? "", /mailbox was paused/);
    assert.equal(calls.length, 0);
  });

  test("a schedule that comes due while a run waits folds into it instead of piling up", async (t) => {
    await fixture();
    runtime(t);
    down();
    const cron = "*/5 * * * *";
    const scheduled = graph();
    scheduled.nodes[0] = { id: "start", type: "trigger.schedule", x: 0, y: 0, config: { cronExpr: cron } };
    const p = await pipeline({
      graphJson: serializeGraph(scheduled),
      cronExpr: cron,
      nextRunAt: new Date(Date.now() - 1_000),
    });
    await runPipelineHeartbeatPass();
    for (let i = 0; i < 50; i++) {
      const rows = await AppDataSource.getRepository(PipelineRun).findBy({ pipelineId: p.id });
      if (rows.some((row) => row.status === "paused")) break;
      await delay(20);
    }
    assert.equal(await AppDataSource.getRepository(PipelineRun).countBy({ pipelineId: p.id }), 1);

    await AppDataSource.getRepository(Pipeline).update(
      { id: p.id },
      { nextRunAt: new Date(Date.now() - 1_000) },
    );
    await runPipelineHeartbeatPass();
    await delay(100);
    assert.equal(
      await AppDataSource.getRepository(PipelineRun).countBy({ pipelineId: p.id }),
      1,
      "the slot folded into the run already waiting",
    );
    await back();
    await settleModelWaitsForTests();
    assert.equal(
      await AppDataSource.getRepository(PipelineRun).countBy({ pipelineId: p.id, status: "completed" }),
      1,
    );
  });

  test("a restart during the outage: the run is still paused after boot and completes once the model is back", async (t) => {
    await fixture();
    const calls = runtime(t);
    down();
    await flushModelAvailabilityWrites();
    const run = await fireManually(await pipeline());
    resetModelAvailabilityForTests();
    resetModelWaitsForTests();
    await loadModelOutages();
    await runPipelineHeartbeatPass();
    assert.equal((await reload(run.id)).status, "paused", "the stale-run sweep leaves a paused run alone");
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    await back();
    await settleModelWaitsForTests();
    assert.equal((await reload(run.id)).status, "completed");
    assert.deepEqual(await journalTitles(), ["before", "after: Yes, reconciled."]);
  });

  test("a run that keeps meeting the outage is given up after the cap, failed with the reason", async (t) => {
    await fixture();
    runtime(t, () => overloadedError());
    const run = await fireManually(await pipeline());
    for (let i = 0; i < MAX_WAIT_ATTEMPTS; i++) {
      await back();
      await settleModelWaitsForTests();
    }
    const ended = await reload(run.id);
    assert.equal(ended.status, "failed");
    assert.match(ended.errorMessage ?? "", /kept becoming unavailable/);
    assert.deepEqual(await journalTitles(), ["before"], "the step after never ran on an error");
    assert.equal((await waits()).length, 0);
  });
});
