import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { recordAudit } from "./audit.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { RUN_BATCH_TOKEN_TARGET } from "./runBatchBudget.js";
import { saveRunCheckpoint, type RunCheckpoint } from "./runContinuation.js";
import { continuationEffects } from "./runEffects.js";
import { startRoutineRun } from "./runner.js";
import { waitForRoutineQueueIdle } from "./routineQueue.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

const unfinished: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed Deals 1 through 5 in the original daily window.",
  remaining: "Deal 6 and remaining conversations in the same window.",
  resume: "Read Deal 6's full conversation; continue from cursor deal-5.",
  progressKey: "deal-5",
};

async function fixture(values: Partial<Routine> = {}) {
  const company = await insert(Company, { name: "Batch Co", slug: "batches", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Follow-ups",
    slug: "follow-ups",
    cronExpr: "0 9 * * *",
    body: "Review the daily Deal window.",
    ...values,
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
  const current = () =>
    AppDataSource.getRepository(Run).findOneByOrFail({ routineId: routine.id, status: "running" });
  const checkpoint = async (value: RunCheckpoint) => {
    const run = await current();
    const token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      routineId: routine.id,
      runId: run.id,
    });
    try {
      await saveRunCheckpoint(token, value);
    } finally {
      revokeMcpToken(token);
    }
  };
  return { company, employee, routine, current, checkpoint };
}

test("a long initial Run yields at a new durable checkpoint and its child receives saved progress", async (t) => {
  const { routine, checkpoint } = await fixture();
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    calls++;
    assert.match(JSON.stringify(params.messages), /Work in small batches/);
    if (calls === 1) {
      params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
      assert.equal(
        params.signal?.aborted,
        false,
        "the soft threshold alone must not interrupt work",
      );
      params.callbacks?.onToolResult?.("get_deal", { content: "Deal details" });
      assert.equal(params.signal?.aborted, false);
      params.callbacks?.onToolUse?.("update_deal", { id: "deal-5" }, "write-1");
      await checkpoint(unfinished);
      params.callbacks?.onToolResult?.("save_run_checkpoint", {
        content: JSON.stringify({ ok: true, state: "continue" }),
      });
      assert.equal(
        params.signal?.aborted,
        false,
        "a concurrent write must finish before a new checkpoint may hand off",
      );
      params.callbacks?.onToolResult?.("update_deal", { content: "Saved" }, "write-1");
      assert.equal(
        params.signal?.aborted,
        false,
        "an earlier checkpoint cannot cover the write that just finished",
      );
      await checkpoint(unfinished);
      params.callbacks?.onToolResult?.("save_run_checkpoint", {
        content: JSON.stringify({ ok: true, state: "continue" }),
      });
      assert.equal(params.signal?.aborted, true);
      throw new Error("The runtime observed the deliberate checkpoint handoff.");
    }
    assert.match(JSON.stringify(params.messages), /deal-5/);
    assert.match(JSON.stringify(params.messages), /There is no total model-token limit/);
    await checkpoint({
      ...unfinished,
      state: "complete",
      completed: "All Deals reviewed.",
      remaining: "",
      resume: "",
      progressKey: "window-complete",
    });
    return { finalText: "Reviewed the full window.", steps: 1, stopReason: "end_turn" };
  });
  const parent = await (await startRoutineRun(routine)).completion;
  assert.equal(parent.status, "failed");
  assert.equal(parent.errorKind, null);
  assert.ok(parent.retryAt);
  assert.equal(parent.continuationStopReason, null);
  assert.equal(parent.tokensIn, RUN_BATCH_TOKEN_TARGET);
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "completed");
  assert.equal(child.parentRunId, parent.id);
  assert.equal(child.continuationTokensUsed, RUN_BATCH_TOKEN_TARGET);
  assert.equal(child.continuationDeadlineAt?.getTime(), parent.continuationDeadlineAt?.getTime());
});

test("an admin resumption retains evidence and authority but must record whether work completed", async (t) => {
  const { company, routine } = await fixture();
  const source = await insert(Run, {
    routineId: routine.id,
    status: "failed",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(Date.now() - 30_000),
    triggerKind: "schedule",
    tokensIn: 17_700_000,
    checkpointJson: JSON.stringify(unfinished),
    continuationDeadlineAt: new Date(0),
    continuationCount: 3,
    continuationTokensUsed: 10_000_000,
    continuationOriginTriggerKind: "schedule",
    continuationReviewOnly: true,
    continuationStopReason: "The shared token limit for automatic continuation was reached.",
  });
  await recordAudit({
    companyId: company.id,
    runId: source.id,
    action: "deal.update",
    targetType: "deal",
    targetId: "deal-5",
    targetLabel: "Saved next step",
  });
  let workTurns = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.registry.resolve("submit_lesson"))
      return { finalText: "No lesson submitted.", steps: 1, stopReason: "end_turn" };
    workTurns++;
    assert.match(JSON.stringify(params.messages), /fresh time window/);
    assert.match(JSON.stringify(params.messages), /deal-5/);
    assert.match(JSON.stringify(params.messages), /Saved next step/);
    assert.match(params.system, /proactive preparation/);
    params.callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 20 });
    assert.equal(
      params.signal?.aborted,
      false,
      "old token use must not interrupt the resumed work",
    );
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  const child = await (await startRoutineRun(routine, { resumeFromRunId: source.id })).completion;
  assert.equal(workTurns, 1);
  assert.equal(child.status, "failed", "a fresh time window is not proof of completion");
  assert.equal(child.retryAt, null, "manual resume must not fall back to a blind retry");
  assert.match(child.continuationStopReason ?? "", /without recording/);
  assert.equal(child.parentRunId, source.id);
  assert.equal(child.triggerKind, "continuation");
  assert.equal(child.continuationCount, 0);
  assert.equal(child.continuationTokensUsed, 0);
  assert.equal(child.continuationReviewOnly, true);
  assert.equal(child.continuationOriginTriggerKind, "schedule");
  assert.ok(child.continuationDeadlineAt!.getTime() > Date.now());
  assert.equal((await continuationEffects(child, { companyId: company.id }))[0].targetId, "deal-5");
});

test("resumption refuses unavailable capabilities before spending a new model turn", async (t) => {
  const { routine } = await fixture();
  const source = await insert(Run, {
    routineId: routine.id,
    status: "failed",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(),
    triggerKind: "manual",
    checkpointJson: JSON.stringify(unfinished),
    requiredToolsJson: JSON.stringify({
      tools: ["unavailable_original_connection_tool"],
      grants: [],
    }),
  });
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    calls++;
    return { finalText: "Must not run", steps: 1, stopReason: "end_turn" };
  });
  const child = await (await startRoutineRun(routine, { resumeFromRunId: source.id })).completion;
  assert.equal(calls, 0);
  assert.equal(child.status, "error");
  assert.match(child.logContent, /preflight|unavailable/i);
  assert.equal(child.retryAt, null);
});
