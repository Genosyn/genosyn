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
import { createCheck } from "./routineChecks.js";
import { startRoutineRun } from "./runner.js";
import { placeStanddown, stopStanddowns } from "./standdowns.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { saveRunCheckpoint, type RunCheckpoint } from "./runContinuation.js";

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

for (const inherited of [false, true]) {
  test(`${inherited ? "an inherited continuation" : "an initial Run without a checkpoint"} can finish beyond ten million tokens and one hundred steps`, async (t) => {
    const { routine, checkpoint } = await fixture();
    const parent = inherited
      ? await pendingParent(routine, { continuationTokensUsed: 5_000_000, tokensIn: 10_000_000 })
      : null;
    let workTurns = 0;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      workTurns++;
      assert.equal(params.maxSteps, null, "Routine work explicitly has no step ceiling");
      params.callbacks?.onUsage?.({ inputTokens: 10_000_000, outputTokens: 75 });
      assert.equal(params.signal?.aborted, false, "total token use must not stop the Run");
      params.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 100 });
      assert.equal(params.signal?.aborted, false, "further work remains available");
      if (inherited) {
        const current = await AppDataSource.getRepository(Run).findOneByOrFail({
          routineId: routine.id,
          status: "running",
        });
        await checkpoint(current, complete);
      }
      return { finalText: "Finished the review.", steps: 125, stopReason: "end_turn" };
    });

    const run = await (
      await startRoutineRun(
        routine,
        parent
          ? { triggerKind: "continuation", continuationFromRunId: parent.id }
          : { triggerKind: "schedule" },
      )
    ).completion;

    assert.equal(workTurns, 1);
    assert.equal(run.status, "completed");
    assert.equal(run.errorKind, null);
    assert.equal(run.retryAt, null);
    assert.equal(run.continuationStopReason, null);
    assert.equal(run.tokensIn + run.tokensOut, 10_000_375);
    assert.equal(run.continuationTokensUsed, inherited ? 15_000_000 : 0);
    if (!inherited) assert.equal(run.checkpointJson, null);
  });
}

for (const savesRequiredOutput of [false, true]) {
  test(`Check remediation beyond ten million tokens and thirty steps ${savesRequiredOutput ? "can pass the required Check" : "retains the required Check and remediation bounds"}`, async (t) => {
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
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      const current = await AppDataSource.getRepository(Run).findOneBy({
        routineId: routine.id,
        status: "running",
      });
      if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
      if (JSON.stringify(params.messages).includes("Your work did not pass")) {
        remediationTurns++;
        assert.equal(params.maxSteps, null, "Check remediation explicitly has no step ceiling");
        params.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 100 });
        assert.equal(params.signal?.aborted, false, "remediation must not stop at a token total");
        if (savesRequiredOutput && remediationTurns === 2)
          await recordAudit({
            companyId: company.id,
            runId: current.id,
            action: "note.create",
            targetType: "note",
            targetId: "required-output",
            targetLabel: "Required review output",
          });
        return { finalText: "Reviewed the required output.", steps: 45, stopReason: "end_turn" };
      }
      workTurns++;
      params.callbacks?.onUsage?.({ inputTokens: 9_999_750, outputTokens: 0 });
      return { finalText: "Finished the review.", steps: 1, stopReason: "end_turn" };
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(workTurns, 1);
    assert.equal(remediationTurns, 2, "both configured remediation rounds remain available");
    assert.equal(run.checkRemediations, 2);
    assert.equal(run.checksVerdict, savesRequiredOutput ? "passed" : "failed");
    assert.equal(run.status, savesRequiredOutput ? "completed" : "failed");
    assert.equal(run.errorKind, null);
    assert.equal(run.continuationStopReason, null);
    assert.equal(run.tokensIn + run.tokensOut, 10_000_350);
    if (savesRequiredOutput) assert.equal(run.retryAt, null);
    else assert.ok(run.retryAt, "a failed Check still earns the configured retry");
  });
}

test("a Standdown still interrupts Check remediation without a step ceiling", async (t) => {
  const { company, routine } = await fixture();
  await createCheck({
    companyId: company.id,
    routineId: routine.id,
    name: "Required saved output",
    kind: "effect",
    spec: JSON.stringify({ action: "note.create", min: 1 }),
    createdById: null,
  });
  let remediationTurns = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
    assert.equal(params.maxSteps, null);
    if (!JSON.stringify(params.messages).includes("Your work did not pass"))
      return { finalText: "Review needs its required output.", steps: 125, stopReason: "end_turn" };
    remediationTurns++;
    await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      source: "human",
      reason: "Stop this Routine's work.",
      placedByUserId: null,
    });
    assert.equal(params.signal?.aborted, true, "Standdown still interrupts an unlimited turn");
    return { finalText: "Stopped.", steps: 45, stopReason: "aborted" };
  });

  const run = await (await startRoutineRun(routine)).completion;

  assert.equal(remediationTurns, 1);
  assert.equal(run.checkRemediations, 1);
  assert.equal(run.status, "error");
  assert.equal(run.errorKind, "interrupted");
  assert.equal(run.retryAt, null);
  assert.notEqual(run.outcomeVerdict, "on_goal");
});

for (const rejects of [false, true]) {
  test(`Check remediation beyond ten million tokens retains ${rejects ? "runtime errors" : "interruption errors"}`, async (t) => {
    const { company, routine } = await fixture();
    await createCheck({
      companyId: company.id,
      routineId: routine.id,
      name: "Required saved output",
      kind: "effect",
      spec: JSON.stringify({ action: "note.create", min: 1 }),
      createdById: null,
    });
    let remediationTurns = 0;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      const current = await AppDataSource.getRepository(Run).findOneBy({
        routineId: routine.id,
        status: "running",
      });
      if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
      if (JSON.stringify(params.messages).includes("Your work did not pass")) {
        remediationTurns++;
        params.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 100 });
        assert.equal(params.signal?.aborted, false, "token use did not interrupt remediation");
        if (rejects) throw new Error("The model request failed during remediation.");
        return { finalText: "Interrupted.", steps: 1, stopReason: "aborted" };
      }
      params.callbacks?.onUsage?.({ inputTokens: 9_999_750, outputTokens: 0 });
      return { finalText: "Finished the review.", steps: 1, stopReason: "end_turn" };
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(remediationTurns, 1, "a real error still stops remediation");
    assert.equal(run.checkRemediations, 1);
    assert.equal(run.checksVerdict, "failed");
    assert.equal(run.status, "error");
    assert.equal(run.errorKind, rejects ? "runtime" : "interrupted");
    assert.equal(run.continuationStopReason, null);
    assert.equal(run.tokensIn + run.tokensOut, 10_000_050);
    assert.notEqual(run.outcomeVerdict, "on_goal");
  });
}

test("a continuation can remediate Checks after its inherited token total exceeds ten million", async (t) => {
  const { company, routine, checkpoint } = await fixture();
  await createCheck({
    companyId: company.id,
    routineId: routine.id,
    name: "Required saved output",
    kind: "effect",
    spec: JSON.stringify({ action: "note.create", min: 1 }),
    createdById: null,
  });
  const parent = await pendingParent(routine, { tokensIn: 15_000_000 });
  let remediationTurns = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
    if (JSON.stringify(params.messages).includes("Your work did not pass")) {
      remediationTurns++;
      params.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 0 });
      assert.equal(params.signal?.aborted, false);
      await recordAudit({
        companyId: company.id,
        runId: current.id,
        action: "note.create",
        targetType: "note",
        targetId: "continued-output",
        targetLabel: "Completed review output",
      });
      return { finalText: "Saved the required output.", steps: 1, stopReason: "end_turn" };
    }
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
  assert.equal(remediationTurns, 1);
  assert.equal(child.checkRemediations, 1);
  assert.equal(child.checksVerdict, "passed");
  assert.equal(child.status, "completed");
  assert.equal(child.retryAt, null);
  assert.equal(child.continuationStopReason, null);
  assert.equal(child.continuationTokensUsed + child.tokensIn + child.tokensOut, 15_000_300);
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
