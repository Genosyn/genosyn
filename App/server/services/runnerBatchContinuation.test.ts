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
import { continuationEffects, runEffects } from "./runEffects.js";
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
      return await saveRunCheckpoint(token, value);
    } finally {
      revokeMcpToken(token);
    }
  };
  return { company, employee, routine, current, checkpoint };
}

function priorRun(routine: Routine, values: Partial<Run> = {}) {
  return insert(Run, {
    routineId: routine.id,
    status: "failed",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(Date.now() - 30_000),
    checkpointJson: JSON.stringify(unfinished),
    continuationDeadlineAt: new Date(Date.now() + 120_000),
    ...values,
  });
}

function reportCheckpoint(params: Parameters<typeof agentRuntime.run>[0], value: RunCheckpoint) {
  params.callbacks?.onToolResult?.("save_run_checkpoint", {
    content: JSON.stringify({ ok: true, state: value.state, checkpoint: value }),
  });
}

const complete: RunCheckpoint = {
  state: "complete",
  completed: "Reviewed all Deals and conversations in the original daily window.",
  remaining: "",
  resume: "",
  progressKey: "window-complete",
};

const advanced: RunCheckpoint = {
  ...unfinished,
  completed: "Reviewed Deals 1 through 6 in the original daily window.",
  remaining: "Deal 7's remaining conversations in the same window.",
  resume: "Read Deal 7's full conversation; continue from cursor deal-6.",
  progressKey: "deal-6",
};

for (const manualResume of [false, true]) {
  test(`${manualResume ? "a manually resumed" : "an automatic continuation"} Run keeps working at an unchanged source cursor and can complete`, async (t) => {
    const { company, routine, current, checkpoint } = await fixture();
    const parent = await priorRun(
      routine,
      manualResume
        ? {
            continuationDeadlineAt: new Date(0),
            continuationCount: 3,
          }
        : {},
    );
    let workTurns = 0;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      if (params.registry.resolve("submit_lesson"))
        return { finalText: "No lesson submitted.", steps: 1, stopReason: "end_turn" };
      workTurns++;
      const active = await current();
      for (const targetId of ["deal-6-followup", "deal-6-activity"]) {
        await recordAudit({
          companyId: company.id,
          runId: active.id,
          action: "deal.update",
          targetType: "deal",
          targetId,
          targetLabel: "Saved follow-up evidence",
        });
      }
      params.callbacks?.onUsage?.({
        inputTokens: RUN_BATCH_TOKEN_TARGET + 500_000,
        outputTokens: 0,
      });
      const currentItem = await checkpoint({
        ...unfinished,
        completed: "Recorded Deal 6 follow-up and Activity; its conversation is still being read.",
        resume: "Finish Deal 6's remaining attachment pages before advancing the stable cursor.",
      });
      reportCheckpoint(params, currentItem);
      assert.equal(
        params.signal?.aborted,
        false,
        "work within an unfinished source item must not be stranded",
      );
      params.callbacks?.onToolResult?.("get_email_attachment", {
        content: "The final attachment page.",
      });
      assert.equal(params.signal?.aborted, false);
      reportCheckpoint(params, await checkpoint(complete));
      assert.equal(params.signal?.aborted, false, "completion never needs a forced handoff");
      return {
        finalText: "Reviewed every conversation in the original window.",
        steps: 1,
        stopReason: "end_turn",
      };
    });
    const child = await (
      await startRoutineRun(
        routine,
        manualResume
          ? { resumeFromRunId: parent.id }
          : { triggerKind: "continuation", continuationFromRunId: parent.id },
      )
    ).completion;
    assert.equal(workTurns, 1);
    assert.equal(child.status, "completed");
    assert.equal(child.retryAt, null);
    assert.equal(child.continuationStopReason, null);
    assert.equal(child.continuationCount, manualResume ? 0 : 1);
    assert.doesNotMatch(child.logContent, /handing unfinished work/);
    assert.equal((await runEffects(child.id, { companyId: company.id })).length, 2);
    if (!manualResume)
      assert.equal(
        child.continuationDeadlineAt?.getTime(),
        parent.continuationDeadlineAt?.getTime(),
      );
  });
}

for (const [label, value] of [
  ["unchanged checkpoint", unfinished],
  ["changed key alone", { ...unfinished, progressKey: "deal-6" }],
  [
    "changed prose at the same source cursor",
    { ...unfinished, completed: "Recorded additional Deal 6 evidence." },
  ],
] as const) {
  test(`Effects do not authorize another continuation after voluntary completion with ${label}`, async (t) => {
    const { company, routine, current, checkpoint } = await fixture();
    const parent = await priorRun(routine);
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      if (params.registry.resolve("submit_lesson"))
        return { finalText: "No lesson submitted.", steps: 1, stopReason: "end_turn" };
      await recordAudit({
        companyId: company.id,
        runId: (await current()).id,
        action: "deal.update",
        targetType: "deal",
        targetId: "deal-6",
        targetLabel: "Saved next step",
      });
      params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
      reportCheckpoint(params, await checkpoint(value));
      assert.equal(
        params.signal?.aborted,
        false,
        "keep the current turn alive to make further progress",
      );
      return { finalText: "More work remains.", steps: 1, stopReason: "end_turn" };
    });
    const child = await (
      await startRoutineRun(routine, {
        triggerKind: "continuation",
        continuationFromRunId: parent.id,
      })
    ).completion;
    assert.equal(child.status, "failed");
    assert.equal(child.retryAt, null);
    assert.equal(
      child.continuationStopReason,
      "The saved checkpoint did not advance beyond the previous Run.",
    );
    assert.doesNotMatch(child.logContent, /handing unfinished work/);
    assert.equal((await runEffects(child.id, { companyId: company.id })).length, 1);
  });
}

test("an advanced continuation yields and its next Run retains the original deadline and completed work", async (t) => {
  const { routine, checkpoint } = await fixture();
  const parent = await priorRun(routine);
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    calls++;
    if (calls === 1) {
      params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
      reportCheckpoint(params, await checkpoint(advanced));
      assert.equal(params.signal?.aborted, true);
      throw new Error("The runtime observed the deliberate checkpoint handoff.");
    }
    assert.match(JSON.stringify(params.messages), /deal-6/);
    reportCheckpoint(params, await checkpoint(complete));
    return { finalText: "Completed the original window.", steps: 1, stopReason: "end_turn" };
  });
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "failed");
  assert.equal(child.errorKind, null);
  assert.equal(child.continuationStopReason, null);
  assert.ok(child.retryAt);
  const last = await (
    await startRoutineRun(routine, { triggerKind: "continuation", continuationFromRunId: child.id })
  ).completion;
  assert.equal(last.status, "completed");
  assert.equal(last.continuationCount, 2);
  assert.equal(last.continuationDeadlineAt?.getTime(), parent.continuationDeadlineAt?.getTime());
  assert.equal(last.parentRunId, child.id);
});

test("a clipped checkpoint result keeps its durable progress without aborting the model turn", async (t) => {
  const { routine, checkpoint } = await fixture();
  const parent = await priorRun(routine);
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
    const persisted = await checkpoint({
      ...advanced,
      completed: "\u0001".repeat(2_000),
      remaining: "\u0001".repeat(2_000),
      resume: "\u0001".repeat(3_000),
    });
    const content = JSON.stringify({ ok: true, state: "continue", checkpoint: persisted });
    assert.ok(content.length > 8_000);
    params.callbacks?.onToolResult?.("save_run_checkpoint", {
      content: content.slice(0, 8_000) + "\n… [truncated]",
    });
    assert.equal(params.signal?.aborted, false);
    reportCheckpoint(params, await checkpoint(complete));
    return { finalText: "Completed the original window.", steps: 1, stopReason: "end_turn" };
  });
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "completed");
  assert.equal(child.retryAt, null);
});

for (const scenario of [
  "approval",
  "approval-required",
  "review-only",
  "last-continuation",
  "deadline",
] as const) {
  test(`${scenario} work cannot be forced into an unavailable automatic handoff`, async (t) => {
    const { routine, checkpoint } = await fixture({
      requiresApproval: scenario === "approval-required",
      selfReviewOnly: scenario === "review-only",
    });
    const parent = ["last-continuation", "deadline"].includes(scenario)
      ? await priorRun(routine, { continuationCount: scenario === "last-continuation" ? 2 : 0 })
      : null;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      if (scenario === "review-only")
        assert.match(JSON.stringify(params.messages), /suggestion-only review/);
      if (scenario === "last-continuation") {
        const brief = JSON.stringify(params.messages);
        assert.match(brief, /This is continuation 3 of 3 in the current time window/);
        assert.match(brief, /No automatic continuations remain after this Run/);
        assert.match(brief, /it does not require ending this active Run/);
        assert.ok(
          brief.includes(
            `Shared absolute deadline: ${parent!.continuationDeadlineAt!.toISOString()} (UTC)`,
          ),
        );
      }
      params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
      const persisted = await checkpoint(advanced);
      const clock =
        scenario === "deadline"
          ? t.mock.method(Date, "now", () => parent!.continuationDeadlineAt!.getTime() - 4_000)
          : null;
      try {
        reportCheckpoint(params, persisted);
        assert.equal(params.signal?.aborted, false);
      } finally {
        clock?.mock.restore();
      }
      if (scenario === "last-continuation") {
        params.callbacks?.onUsage?.({ inputTokens: 15_000_000, outputTokens: 0 });
        reportCheckpoint(
          params,
          await checkpoint({
            ...advanced,
            progressKey: "deal-7",
            completed: "Reviewed Deals 1 through 7 in the original daily window.",
          }),
        );
        assert.equal(
          params.signal?.aborted,
          false,
          "the final Run keeps working across saved batches",
        );
      }
      reportCheckpoint(params, await checkpoint(complete));
      return { finalText: "Completed the original window.", steps: 1, stopReason: "end_turn" };
    });
    const result = await (
      await startRoutineRun(
        routine,
        parent
          ? { triggerKind: "continuation", continuationFromRunId: parent.id }
          : { triggerKind: scenario === "review-only" ? "manual" : "approval" },
      )
    ).completion;
    assert.equal(result.status, "completed");
    assert.equal(result.retryAt, null);
    assert.doesNotMatch(result.logContent, /handing unfinished work/);
    if (scenario === "last-continuation") {
      assert.equal(result.continuationCount, 3);
      assert.equal(
        result.continuationDeadlineAt!.getTime(),
        parent!.continuationDeadlineAt!.getTime(),
      );
    }
  });
}

for (const continuing of [false, true]) {
  test(`${continuing ? "a continuation" : "an initial Run"} waits for background workers before handing off a saved batch`, async (t) => {
    const { routine, checkpoint } = await fixture();
    const parent = continuing ? await priorRun(routine) : null;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
      const persisted = await checkpoint(advanced);
      for (const pending of [2, 1]) {
        params.callbacks?.onBackgroundWork?.(pending);
        reportCheckpoint(params, persisted);
        assert.equal(
          params.signal?.aborted,
          false,
          "a pending response cannot make unfinished workers safe to interrupt",
        );
      }
      params.callbacks?.onBackgroundWork?.(0);
      assert.equal(
        params.signal?.aborted,
        false,
        "worker completion alone is not a durable handoff boundary",
      );
      reportCheckpoint(params, await checkpoint(advanced));
      assert.equal(params.signal?.aborted, true);
      return { finalText: "", steps: 1, stopReason: "aborted" };
    });
    const result = await (
      await startRoutineRun(
        routine,
        parent
          ? { triggerKind: "continuation", continuationFromRunId: parent.id }
          : { triggerKind: "manual" },
      )
    ).completion;
    assert.equal(result.status, "failed");
    assert.equal(result.errorKind, null);
    assert.ok(result.retryAt);
    assert.match(result.logContent, /Batch progress saved; handing unfinished work/);
    if (parent)
      assert.equal(
        result.continuationDeadlineAt?.getTime(),
        parent.continuationDeadlineAt?.getTime(),
      );
  });
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
      let persisted = await checkpoint(unfinished);
      params.callbacks?.onToolResult?.("save_run_checkpoint", {
        content: JSON.stringify({ ok: true, state: "continue", checkpoint: persisted }),
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
      persisted = await checkpoint(unfinished);
      params.callbacks?.onToolResult?.("save_run_checkpoint", {
        content: JSON.stringify({ ok: true, state: "continue", checkpoint: persisted }),
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
