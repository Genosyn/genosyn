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
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { createCheck } from "./routineChecks.js";
import { startRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import {
  CONTINUATION_TOKEN_LIMIT,
  saveRunCheckpoint,
  type RunCheckpoint,
} from "./runContinuation.js";

before(initTestDb);
beforeEach(async () => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
});
after(async () => {
  stopStanddowns();
  await closeTestDb();
});

const unfinished: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed source events through event-71.",
  remaining: "Read event-72 completely and cover the remaining fixed window.",
  resume: "Fetch event-72, then resume after event-71 within the September 21 window.",
  progressKey: "event-71",
};
const complete: RunCheckpoint = {
  state: "complete",
  completed: "Reviewed every source event in the fixed window.",
  remaining: "",
  resume: "",
  progressKey: "window-complete",
};

async function fixture(values: Partial<Routine> = {}) {
  const company = await insert(Company, { name: "Safety Co", slug: "safety", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review source events",
    slug: "review-source-events",
    cronExpr: "0 9 * * *",
    body: "Review all source events and meet the required Checks.",
    ...values,
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "safety-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "safety-test",
    }),
  });
  const checkpoint = async (run: Run, value: RunCheckpoint) => {
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
  return { company, employee, routine, checkpoint };
}

async function pendingParent(routine: Routine, values: Partial<Run> = {}) {
  return insert(Run, {
    routineId: routine.id,
    triggerKind: "schedule",
    status: "failed",
    startedAt: new Date(),
    finishedAt: new Date(),
    checkpointJson: JSON.stringify(unfinished),
    continuationDeadlineAt: new Date(Date.now() + 30 * 60_000),
    ...values,
  });
}

test("a continuation cannot turn green by returning without a completion checkpoint", async (t) => {
  const { routine } = await fixture();
  const parent = await pendingParent(routine);
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "The work is complete.",
    steps: 1,
    stopReason: "end_turn",
  }));
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "failed");
  assert.equal(child.retryAt, null);
  assert.match(child.continuationStopReason ?? "", /without recording.*remaining work/i);
  assert.notEqual(child.outcomeVerdict, "on_goal");
});

test("an initial complete checkpoint does not disable configured retries after a required Check fails", async (t) => {
  const { company, routine, checkpoint } = await fixture({ maxAttempts: 2 });
  await createCheck({
    companyId: company.id,
    routineId: routine.id,
    name: "Required saved output",
    kind: "effect",
    spec: JSON.stringify({ action: "note.create", min: 1 }),
    createdById: null,
  });
  t.mock.method(agentRuntime, "run", async () => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (current) await checkpoint(current, complete);
    return { finalText: "Finished the review.", steps: 1, stopReason: "end_turn" };
  });
  const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
  assert.equal(run.status, "failed");
  assert.equal(run.checksVerdict, "failed");
  assert.ok(
    run.retryAt,
    "the independently failed Check still earns the configured second attempt",
  );
  assert.equal(run.continuationCount, 0);
  assert.equal(run.continuationStopReason, null);
});

for (const rejectsAfterAbort of [false, true]) {
  test(`the initial Run enforces its token ceiling without a checkpoint (${rejectsAfterAbort ? "rejected" : "returned"} abort)`, async (t) => {
    const { routine } = await fixture({ maxAttempts: 2 });
    let aborted = false;
    let workTurns = 0;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      workTurns++;
      params.callbacks?.onUsage?.({ inputTokens: CONTINUATION_TOKEN_LIMIT - 50, outputTokens: 75 });
      aborted = !!params.signal?.aborted;
      if (rejectsAfterAbort) throw new Error("The model request was aborted.");
      return { finalText: "Work remains unfinished.", steps: 1, stopReason: "aborted" };
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(workTurns, 1);
    assert.equal(aborted, true);
    assert.equal(run.continuationCount, 0);
    assert.equal(run.checkpointJson, null);
    assert.equal(run.status, "failed");
    assert.equal(run.errorKind, null, "a token ceiling is unfinished work, not a runtime outage");
    assert.equal(run.retryAt, null, "a configured retry must not silently reset the allowance");
    assert.match(run.continuationStopReason ?? "", /token limit/i);
    assert.equal(run.tokensIn + run.tokensOut, CONTINUATION_TOKEN_LIMIT + 25);
    assert.notEqual(run.outcomeVerdict, "on_goal");
  });
}

for (const rejectsAfterAbort of [false, true]) {
  test(`initial Run Check remediation shares the token ceiling without a checkpoint (${rejectsAfterAbort ? "rejected" : "returned"} abort)`, async (t) => {
    const { company, routine } = await fixture({ maxAttempts: 2 });
    await createCheck({
      companyId: company.id,
      routineId: routine.id,
      name: "Required saved output",
      kind: "effect",
      spec: JSON.stringify({ action: "note.create", min: 1 }),
      createdById: null,
    });
    let workTurns = 0;
    let remediationTurns = 0;
    let remediationAborted = false;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      const current = await AppDataSource.getRepository(Run).findOneBy({
        routineId: routine.id,
        status: "running",
      });
      if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
      if (JSON.stringify(params.messages).includes("Your work did not pass")) {
        remediationTurns++;
        params.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 100 });
        remediationAborted = !!params.signal?.aborted;
        if (rejectsAfterAbort) throw new Error("The remediation request was aborted.");
        return {
          finalText: "The required output is still missing.",
          steps: 1,
          stopReason: "aborted",
        };
      }
      workTurns++;
      params.callbacks?.onUsage?.({ inputTokens: CONTINUATION_TOKEN_LIMIT - 250, outputTokens: 0 });
      return { finalText: "Finished the review.", steps: 1, stopReason: "end_turn" };
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(workTurns, 1);
    assert.equal(
      remediationTurns,
      1,
      "no further remediation may run after consuming the allowance",
    );
    assert.equal(remediationAborted, true);
    assert.equal(run.continuationCount, 0);
    assert.equal(run.checkpointJson, null);
    assert.equal(run.checkRemediations, 1);
    assert.equal(run.checksVerdict, "failed");
    assert.equal(run.status, "failed");
    assert.equal(run.errorKind, null, "a token ceiling must not become a model/runtime Error");
    assert.equal(run.retryAt, null);
    assert.match(run.continuationStopReason ?? "", /token limit/i);
    assert.equal(run.tokensIn + run.tokensOut, CONTINUATION_TOKEN_LIMIT + 50);
    assert.notEqual(run.outcomeVerdict, "on_goal");
  });
}

test("a continuation stops Check remediation at its cumulative token ceiling", async (t) => {
  const { company, routine, checkpoint } = await fixture();
  await createCheck({
    companyId: company.id,
    routineId: routine.id,
    name: "Required saved output",
    kind: "effect",
    spec: JSON.stringify({ action: "note.create", min: 1 }),
    createdById: null,
  });
  const parent = await pendingParent(routine, {
    tokensIn: CONTINUATION_TOKEN_LIMIT - 250,
    tokensOut: 0,
  });
  let workTurns = 0;
  let remediationTurns = 0;
  let remediationAborted = false;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
    if (JSON.stringify(params.messages).includes("Your work did not pass")) {
      remediationTurns++;
      params.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 0 });
      remediationAborted = !!params.signal?.aborted;
      return { finalText: "Not finished.", steps: 1, stopReason: "aborted" };
    }
    workTurns++;
    await checkpoint(current, complete);
    params.callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 0 });
    return { finalText: "The review is complete.", steps: 1, stopReason: "end_turn" };
  });
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(workTurns, 1);
  assert.equal(
    remediationTurns,
    1,
    "there must not be a second remediation after the ceiling is reached",
  );
  assert.equal(remediationAborted, true);
  assert.equal(child.checkRemediations, 1);
  assert.equal(child.status, "failed");
  assert.equal(child.retryAt, null);
  assert.match(child.continuationStopReason ?? "", /token limit/i);
  assert.equal(
    child.continuationTokensUsed + child.tokensIn + child.tokensOut,
    CONTINUATION_TOKEN_LIMIT + 50,
  );
});

test("a scheduled continuation keeps its original review ceiling after the Routine marker is removed", async (t) => {
  const { routine, checkpoint } = await fixture({ mailDeliveryMode: "draft" });
  const scopes: boolean[] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
    scopes.push(
      !params.registry.resolve("create_routine") &&
        params.system.includes("This is proactive preparation"),
    );
    await checkpoint(current, current.continuationCount === 0 ? unfinished : complete);
    return { finalText: "Recorded the review progress.", steps: 1, stopReason: "end_turn" };
  });
  const parent = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
  assert.equal(parent.continuationReviewOnly, true);
  assert.ok(parent.retryAt);
  await AppDataSource.getRepository(Routine).update(routine.id, { mailDeliveryMode: null });
  const updatedRoutine = await AppDataSource.getRepository(Routine).findOneByOrFail({
    id: routine.id,
  });
  const child = await (
    await startRoutineRun(updatedRoutine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(child.continuationOriginTriggerKind, "schedule");
  assert.equal(child.continuationReviewOnly, true);
  assert.equal(child.status, "reviewed");
  assert.deepEqual(scopes, [true, true]);
});

test("a continuation keeps the deadline captured before preparation refreshes the Routine", async (t) => {
  const originalTimeoutSec = 300;
  const { routine, checkpoint } = await fixture({ timeoutSec: originalTimeoutSec });
  t.mock.method(agentRuntime, "run", async () => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (current) await checkpoint(current, unfinished);
    return { finalText: "Recorded unfinished source coverage.", steps: 1, stopReason: "end_turn" };
  });
  const parent = await (
    await startRoutineRun(routine, {
      triggerKind: "schedule",
      beforeRunPersist: async () => {
        // The scheduler refreshes this same object after slow preparation.
        routine.timeoutSec = 3600;
      },
    })
  ).completion;
  assert.ok(parent.retryAt);
  assert.equal(
    parent.continuationDeadlineAt?.getTime(),
    parent.startedAt.getTime() + originalTimeoutSec * 1000,
  );
});
