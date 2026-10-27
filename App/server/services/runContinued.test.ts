import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test, type TestContext } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import { routineAutonomyEvidence } from "./autonomy.js";
import { dispatchDueRetries, stopCron } from "./cron.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { RUN_BATCH_TOKEN_TARGET } from "./runBatchBudget.js";
import {
  CONTINUATION_CANCELLED_REASON,
  continuationEligibility,
  revertUnstartedContinuation,
  saveRunCheckpoint,
  type RunCheckpoint,
} from "./runContinuation.js";
import {
  backfillContinuedRuns,
  CONTINUED_RUNS_BACKFILL_KEY,
  hasHandOffShape,
} from "./runContinuedBackfill.js";
import { readRunDiagnostics } from "./runDiagnostics.js";
import { finishedRunEvidence } from "./runEvidence.js";
import { markCurrentRunFailed } from "./runFailureReport.js";
import { findLiveRunFailures } from "./runFailures.js";
import { manualResumeEligibility } from "./runManualResume.js";
import { cancelPendingRetry } from "./runRecovery.js";
import { startRoutineRun } from "./runner.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

/**
 * A Run that hands its unfinished work to an automatic continuation is the
 * planned hand-off, not a failure. Production showed the cost of calling it
 * one: once the two-million-token batch hand-off shipped, most long Runs ended
 * `failed` with no reason, so the Routines page, Journal, Usage, earned
 * autonomy and the letter to the board all read ordinary progress as failing
 * work. These cases pin the whole lifecycle of the `continued` status.
 */

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

const HOUR = 60 * 60_000;

const batchOne: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed Deals 1 through 5 in the original daily window.",
  remaining: "Deals 6 through 12 in the same window.",
  resume: "Read Deal 6's full conversation; continue from cursor deal-5.",
  progressKey: "deal-5",
};

const batchTwo: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed Deals 1 through 10 in the original daily window.",
  remaining: "Deals 11 and 12 in the same window.",
  resume: "Read Deal 11's full conversation; continue from cursor deal-10.",
  progressKey: "deal-10",
};

const batchThree: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed Deals 1 through 11 in the original daily window.",
  remaining: "Deal 12 in the same window.",
  resume: "Read Deal 12's full conversation; continue from cursor deal-11.",
  progressKey: "deal-11",
};

const batchFour: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed Deal 12's first three conversations in the original daily window.",
  remaining: "Deal 12's last two conversations.",
  resume: "Read Deal 12's fourth conversation; continue from cursor deal-12-c3.",
  progressKey: "deal-12-c3",
};

const finished: RunCheckpoint = {
  state: "complete",
  completed: "Reviewed all twelve Deals in the original daily window.",
  remaining: "",
  resume: "",
  progressKey: "window-complete",
};

type AgentParams = Parameters<typeof agentRuntime.run>[0];
type AgentResult = Awaited<ReturnType<typeof agentRuntime.run>>;

/** Reflection and outcome turns are restricted; only work turns have no step ceiling. */
const RESTRICTED_REPLY: AgentResult = { finalText: "Noted.", steps: 1, stopReason: "end_turn" };

async function fixture(values: Partial<Routine> = {}) {
  const owner = await insert(User, {
    email: "owner@continued.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "OneUptime",
    slug: "continued",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie-mallers",
    role: "VP of Go to Market",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Enterprise Prospecting",
    slug: "enterprise-prospecting",
    cronExpr: "0 8 * * 2,4",
    body: "Review the daily Deal window.",
    timeoutSec: 6 * 3600,
    ...values,
  });
  await insertEmployeeModel({
    employeeId: employee.id,
    provider: "custom",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "deepseek-ai/DeepSeek-V4.1-Flash",
    }),
  });
  return { owner, company, employee, routine };
}

/** The running Run's own token, the way a tool call inside the Run would hold it. */
async function asRunningRun<T>(routine: Routine, act: (token: string) => Promise<T>): Promise<T> {
  const run = await runs().findOneByOrFail({ routineId: routine.id, status: "running" });
  const token = issueMcpToken(routine.employeeId, (await companyOf(routine)).id, {
    authority: "employee",
    routineId: routine.id,
    runId: run.id,
  });
  try {
    return await act(token);
  } finally {
    revokeMcpToken(token);
  }
}

async function companyOf(routine: Routine): Promise<Company> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
    id: routine.employeeId,
  });
  return AppDataSource.getRepository(Company).findOneByOrFail({ id: employee.companyId });
}

/** Save a checkpoint for the running Run and report it as its tool result. */
async function saveAndReport(params: AgentParams, routine: Routine, value: RunCheckpoint) {
  const saved = await asRunningRun(routine, (token) => saveRunCheckpoint(token, value));
  params.callbacks?.onToolResult?.("save_run_checkpoint", {
    content: JSON.stringify({ ok: true, state: saved.state, checkpoint: saved }),
  });
}

/**
 * A work turn that crosses the batch threshold and saves a continue
 * checkpoint: the runner ends the batch there and hands the rest on.
 */
async function yieldBatch(params: AgentParams, routine: Routine, value: RunCheckpoint) {
  params.callbacks?.onUsage?.({ inputTokens: RUN_BATCH_TOKEN_TARGET, outputTokens: 0 });
  await saveAndReport(params, routine, value);
  assert.equal(params.signal?.aborted, true, "the saved batch is handed to a fresh Run");
  throw new Error("The runtime observed the deliberate checkpoint handoff.");
}

function runs() {
  return AppDataSource.getRepository(Run);
}

async function journalTitles(runId: string): Promise<string[]> {
  const entries = await AppDataSource.getRepository(JournalEntry).findBy({ runId });
  return entries.map((entry) => entry.title);
}

async function failureAlerts(companyId: string): Promise<number> {
  return AppDataSource.getRepository(Notification).countBy({ companyId, kind: "run_failed" });
}

async function liveFailures(routine: Routine) {
  return findLiveRunFailures({
    routineIds: [routine.id],
    since: new Date(Date.now() - 48 * HOUR),
    take: 10,
  });
}

/** Make a queued continuation due now, the way time passing would. */
async function makeDue(run: Run) {
  await runs().update(run.id, { retryAt: new Date(Date.now() - 1_000) });
}

/** A hand-off as the runner now writes it, with time left in its window. */
function handOff(routine: Routine, values: Partial<Run> = {}) {
  return insert(Run, {
    routineId: routine.id,
    employeeId: routine.employeeId,
    status: "continued",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 10 * 60_000),
    finishedAt: new Date(Date.now() - 60_000),
    checkpointJson: JSON.stringify(batchOne),
    continuationDeadlineAt: new Date(Date.now() + 2 * HOUR),
    retryAt: new Date(Date.now() - 1_000),
    ...values,
  });
}

describe("a Run that hands its work to a continuation ends Continued", () => {
  test("a batch hand-off past the token threshold is Continued, quiet, and queues its continuation", async (t) => {
    const { company, routine } = await fixture({ consecutiveFailures: 2 });
    t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
      if (params.maxSteps !== null) return RESTRICTED_REPLY;
      return yieldBatch(params, routine, batchOne);
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(run.status, "continued", run.logContent);
    assert.equal(run.errorKind, null);
    assert.equal(run.exitCode, null);
    assert.equal(run.failureReason, null);
    assert.equal(run.continuationStopReason, null);
    assert.ok(run.retryAt, "the continuation is queued");
    assert.match(run.logContent, /handing unfinished work to a fresh Run/);
    assert.match(run.logContent, /continuation queued automatically/);

    const stored = await runs().findOneByOrFail({ id: run.id });
    assert.equal(stored.status, "continued", "the status is what every page reads");
    assert.equal(readRunDiagnostics(stored).failure, null, "no failure is invented for it");

    const titles = await journalTitles(run.id);
    assert.deepEqual(titles, [
      'Routine "Enterprise Prospecting" handed its unfinished work to a continuation',
    ]);
    const current = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(current.consecutiveFailures, 2, "a hand-off neither counts nor clears failures");
    assert.equal(await failureAlerts(company.id), 0, "nobody is paged about progress");
    assert.equal((await liveFailures(routine)).count, 0);
  });

  test("a Run that ends its turn with an actionable continue checkpoint is Continued", async (t) => {
    const { routine } = await fixture();
    t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
      if (params.maxSteps !== null) return RESTRICTED_REPLY;
      await saveAndReport(params, routine, batchOne);
      return { finalText: "Reviewed five Deals; seven remain.", steps: 1, stopReason: "end_turn" };
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(run.status, "continued", run.logContent);
    assert.ok(run.retryAt);
    assert.match(run.logContent, /\[unfinished\] Deals 6 through 12/);
    assert.equal(
      run.continuationDeadlineAt?.getTime(),
      run.startedAt.getTime() + routine.timeoutSec * 1000,
      "the continuation inherits the original window",
    );
  });

  test("a failure the employee reported stays Failed even while its work continues", async (t) => {
    const { company, routine } = await fixture();
    t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
      if (params.maxSteps !== null) return RESTRICTED_REPLY;
      await asRunningRun(routine, (token) =>
        markCurrentRunFailed(token, "The CRM refused writes for Deals 6 and 7."),
      );
      await saveAndReport(params, routine, batchOne);
      return { finalText: "Stopped at a CRM error.", steps: 1, stopReason: "end_turn" };
    });

    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;

    assert.equal(run.status, "failed", "a reported failure is never relabelled as progress");
    assert.equal(run.failureReason, "The CRM refused writes for Deals 6 and 7.");
    assert.ok(run.retryAt, "the saved work still continues automatically");
    assert.deepEqual(await journalTitles(run.id), ['Routine "Enterprise Prospecting" failed']);
    assert.equal(await failureAlerts(company.id), 0, "the alert waits for the chain's outcome");
  });

  test("unfinished work with no continuation left stays Failed and pages the owners", async (t) => {
    const { company, routine } = await fixture();
    // A real lineage: the initial Run and two continuations, each a hand-off.
    const root = await handOff(routine, { retryAt: null });
    const second = await handOff(routine, {
      triggerKind: "continuation",
      parentRunId: root.id,
      continuationCount: 1,
      checkpointJson: JSON.stringify(batchTwo),
      retryAt: null,
    });
    const parent = await handOff(routine, {
      triggerKind: "continuation",
      parentRunId: second.id,
      continuationCount: 2,
      checkpointJson: JSON.stringify(batchThree),
      retryAt: null,
    });
    t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
      if (params.maxSteps !== null) return RESTRICTED_REPLY;
      await saveAndReport(params, routine, batchFour);
      return { finalText: "Eleven Deals done; one remains.", steps: 1, stopReason: "end_turn" };
    });

    const last = await (
      await startRoutineRun(routine, {
        triggerKind: "continuation",
        continuationFromRunId: parent.id,
        parentRunId: parent.id,
      })
    ).completion;

    assert.equal(last.continuationCount, 3);
    assert.equal(last.status, "failed", last.logContent);
    assert.equal(last.retryAt, null);
    assert.equal(last.continuationStopReason, "The automatic continuation limit was reached.");
    assert.deepEqual(await journalTitles(last.id), ['Routine "Enterprise Prospecting" failed']);
    assert.equal(await failureAlerts(company.id), 1);
    const live = await liveFailures(routine);
    assert.deepEqual(
      live.rows.map((row) => row.id),
      [last.id],
      "the chain's own outcome is the one failure a Member sees",
    );
    for (const handedOff of [root, second, parent]) {
      assert.equal((await runs().findOneByOrFail({ id: handedOff.id })).status, "continued");
    }
    const current = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(current.consecutiveFailures, 1);
  });

  test("the continuation rules read a Continued parent exactly as the Failed hand-off it replaces", async () => {
    const { routine } = await fixture({ timeoutSec: 3600 });
    const now = new Date();
    const parent = (values: Partial<Run>) =>
      ({
        status: "continued",
        errorKind: null,
        triggerKind: "schedule",
        continuationCount: 0,
        continuationStopReason: null,
        checkpointJson: JSON.stringify(batchOne),
        startedAt: new Date(now.getTime() - 10 * 60_000),
        continuationDeadlineAt: new Date(now.getTime() + HOUR),
        ...values,
      }) as Run;
    const reason = (values: Partial<Run>) => continuationEligibility(parent(values), routine, now);

    assert.deepEqual(reason({}), { eligible: true, reason: null });
    assert.deepEqual(reason({ status: "failed" }), { eligible: true, reason: null });
    assert.equal(reason({ status: "completed" }).eligible, false);
    assert.equal(reason({ status: "error", errorKind: "runtime" }).eligible, false);
    assert.equal(reason({ errorKind: "timeout" }).eligible, false);
    assert.equal(
      reason({ continuationCount: 3 }).reason,
      "The automatic continuation limit was reached.",
    );
    assert.match(
      reason({ continuationDeadlineAt: new Date(now.getTime() + 60_000) }).reason ?? "",
      /time limit leaves too little time/,
    );
    assert.equal(reason({ checkpointJson: JSON.stringify(finished) }).eligible, false);
    assert.equal(
      continuationEligibility(parent({}), { ...routine, enabled: false } as Routine, now).reason,
      "The Routine is disabled.",
    );
  });
});

describe("a continuation chain is judged by the Run that ends it", () => {
  test("two hand-offs and a completion read Continued, Continued, Completed with nothing failing", async (t) => {
    const { company, routine } = await fixture();
    const stages = [batchOne, batchTwo];
    let workTurns = 0;
    t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
      if (params.maxSteps !== null) return RESTRICTED_REPLY;
      const stage = workTurns++;
      if (stage < stages.length) return yieldBatch(params, routine, stages[stage]);
      assert.match(JSON.stringify(params.messages), /deal-10/, "the last Run resumes saved work");
      await saveAndReport(params, routine, finished);
      return { finalText: "Reviewed all twelve Deals.", steps: 1, stopReason: "end_turn" };
    });

    const first = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
    assert.equal(first.status, "continued");

    await makeDue(first);
    const second = await dispatchDueRetries(new Date());
    assert.equal(second.started, 1);
    const middle = await second.completions[0];
    assert.equal(middle.status, "continued");
    assert.equal(middle.parentRunId, first.id);

    await makeDue(middle);
    const third = await dispatchDueRetries(new Date());
    const last = await third.completions[0];
    assert.equal(last.status, "completed", last.logContent);
    assert.equal(last.continuationCount, 2);

    const chain = await runs().find({
      where: { routineId: routine.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      chain.map((run) => run.status),
      ["continued", "continued", "completed"],
    );
    assert.deepEqual(
      chain.map((run) => run.retryAt),
      [null, null, null],
      "every queued continuation was spent",
    );
    assert.equal(await failureAlerts(company.id), 0);
    assert.equal((await liveFailures(routine)).count, 0);
    const current = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(current.consecutiveFailures, 0);

    // Earned autonomy weighs the chain once, by its outcome — not two failures and a success.
    const evidence = routineAutonomyEvidence({ runs: chain, hasCriteria: false, hasChecks: false });
    assert.equal(evidence.terminalRuns, 1);
    assert.doesNotMatch(evidence.reason, /did not complete/);
  });

  test("a hand-off finalized before the upgrade still dispatches its continuation", async (t) => {
    const { routine } = await fixture();
    const legacy = await handOff(routine, { status: "failed" });
    t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
      if (params.maxSteps !== null) return RESTRICTED_REPLY;
      await saveAndReport(params, routine, finished);
      return { finalText: "Reviewed all twelve Deals.", steps: 1, stopReason: "end_turn" };
    });

    const dispatched = await dispatchDueRetries(new Date());
    assert.equal(dispatched.started, 1);
    const child = await dispatched.completions[0];
    assert.equal(child.status, "completed");
    assert.equal(child.parentRunId, legacy.id);
    assert.equal((await liveFailures(routine)).count, 0);
  });
});

describe("a hand-off whose continuation never takes over returns to Failed", () => {
  test("dispatch that finds the Routine disabled stops the continuation and reopens the failure", async (t) => {
    const { company, routine } = await fixture();
    const parent = await handOff(routine);
    await AppDataSource.getRepository(Routine).update(routine.id, { enabled: false });
    t.mock.method(agentRuntime, "run", async () => {
      throw new Error("A disabled Routine's continuation must never reach the model.");
    });

    const dispatched = await dispatchDueRetries(new Date());

    assert.equal(dispatched.started, 0);
    const stopped = await runs().findOneByOrFail({ id: parent.id });
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.retryAt, null);
    assert.equal(stopped.continuationStopReason, "The Routine is disabled.");
    assert.equal(await failureAlerts(company.id), 1, "unfinished work nothing will continue pages");
    assert.deepEqual(
      (await liveFailures(routine)).rows.map((row) => row.id),
      [parent.id],
    );
    assert.match(readRunDiagnostics(stopped).failure?.message ?? "", /Routine is disabled/);
  });

  test("dispatch past the shared deadline reopens the failure with the time reason", async () => {
    const { routine } = await fixture({ timeoutSec: 3600 });
    const parent = await handOff(routine, {
      continuationDeadlineAt: new Date(Date.now() + 60_000),
    });

    await dispatchDueRetries(new Date());

    const stopped = await runs().findOneByOrFail({ id: parent.id });
    assert.equal(stopped.status, "failed");
    assert.match(stopped.continuationStopReason ?? "", /time limit leaves too little time/);
  });

  test("a Member cancelling the continuation returns the Run to Failed and makes it resumable", async () => {
    const { routine } = await fixture();
    const parent = await handOff(routine, { retryAt: new Date(Date.now() + 60_000) });

    assert.equal(await cancelPendingRetry(parent.id), "cancelled");

    const cancelled = await runs().findOneByOrFail({ id: parent.id });
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.retryAt, null);
    assert.equal(cancelled.continuationStopReason, CONTINUATION_CANCELLED_REASON);
    assert.deepEqual(manualResumeEligibility(cancelled, routine), {
      eligible: true,
      reason: null,
    });
    assert.equal(
      continuationEligibility(cancelled, routine).eligible,
      false,
      "a cancelled continuation is never queued again on its own",
    );
    assert.deepEqual(
      (await liveFailures(routine)).rows.map((row) => row.id),
      [parent.id],
    );
  });

  test("cancelling an ordinary retry leaves its Failed Run exactly as it was", async () => {
    const { routine } = await fixture({ maxAttempts: 3 });
    const failed = await insert(Run, {
      routineId: routine.id,
      employeeId: routine.employeeId,
      status: "failed",
      triggerKind: "schedule",
      startedAt: new Date(Date.now() - 10 * 60_000),
      finishedAt: new Date(Date.now() - 60_000),
      failureReason: "The CRM was down.",
      retryAt: new Date(Date.now() + 60_000),
    });

    assert.equal(await cancelPendingRetry(failed.id), "cancelled");

    const cancelled = await runs().findOneByOrFail({ id: failed.id });
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.retryAt, null);
    assert.equal(cancelled.continuationStopReason, null);
  });

  test("a queued continuation skipped before it starts reopens its parent's failure", async (t) => {
    const { routine } = await fixture();
    const other = await insert(Routine, {
      employeeId: routine.employeeId,
      name: "Weekly Revenue Snapshot",
      slug: "weekly-revenue-snapshot",
      cronExpr: "0 9 * * 1",
      body: "Snapshot revenue.",
      timeoutSec: 3600,
    });
    const busy = holdModel(t);
    const occupying = await startRoutineRun(other, { triggerKind: "manual" });
    await busy.started;
    const parent = await handOff(routine, { retryAt: null });
    const queued = await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    });
    assert.equal(
      (await runs().findOneByOrFail({ id: queued.run.id })).status,
      "queued",
      "one local model serves one Run at a time",
    );

    // A human switches the Routine off while its continuation waits.
    await AppDataSource.getRepository(Routine).update(routine.id, { enabled: false });
    busy.release();
    await occupying.completion;
    await waitForRoutineQueueIdle();

    const child = await runs().findOneByOrFail({ id: queued.run.id });
    assert.equal(child.status, "skipped");
    const reopened = await runs().findOneByOrFail({ id: parent.id });
    assert.equal(reopened.status, "failed");
    assert.match(reopened.continuationStopReason ?? "", /disabled|enabled state/);
    assert.deepEqual(
      (await liveFailures(routine)).rows.map((row) => row.id),
      [parent.id],
    );
  });

  test("reverting only ever moves a Continued Run, once", async () => {
    const { routine } = await fixture();
    const parent = await handOff(routine, { retryAt: null });
    const completed = await insert(Run, {
      routineId: routine.id,
      status: "completed",
      triggerKind: "schedule",
      startedAt: new Date(),
    });

    assert.equal(await revertUnstartedContinuation(parent.id, "Skipped."), true);
    assert.equal(await revertUnstartedContinuation(parent.id, "Skipped again."), false);
    assert.equal(await revertUnstartedContinuation(completed.id, "Skipped."), false);
    assert.equal(
      await revertUnstartedContinuation("00000000-0000-4000-8000-000000000000", "x"),
      false,
    );

    const reverted = await runs().findOneByOrFail({ id: parent.id });
    assert.equal(reverted.status, "failed");
    assert.equal(reverted.continuationStopReason, "Skipped.", "the first reason stands");
    assert.equal((await runs().findOneByOrFail({ id: completed.id })).status, "completed");
  });
});

/** Hold the model's only slot with one work turn until released. */
function holdModel(t: TestContext) {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let first = true;
  t.mock.method(agentRuntime, "run", async (params: AgentParams) => {
    if (params.maxSteps !== null) return RESTRICTED_REPLY;
    if (first) {
      first = false;
      markStarted();
      await released;
    }
    return { finalText: "Snapshot recorded.", steps: 1, stopReason: "end_turn" };
  });
  return { started, release };
}

describe("Run history readers count a hand-off as progress", () => {
  test("the live failure list ignores hand-offs, including legacy parents of a Continued child", async () => {
    const { routine } = await fixture();
    const legacyParent = await insert(Run, {
      routineId: routine.id,
      status: "failed",
      triggerKind: "schedule",
      startedAt: new Date(Date.now() - 3 * HOUR),
      finishedAt: new Date(Date.now() - 3 * HOUR + 60_000),
      checkpointJson: JSON.stringify(batchOne),
    });
    const continuedChild = await insert(Run, {
      routineId: routine.id,
      status: "continued",
      triggerKind: "continuation",
      parentRunId: legacyParent.id,
      continuationCount: 1,
      startedAt: new Date(Date.now() - 2 * HOUR),
      finishedAt: new Date(Date.now() - 2 * HOUR + 60_000),
      checkpointJson: JSON.stringify(batchTwo),
    });
    await insert(Run, {
      routineId: routine.id,
      status: "running",
      triggerKind: "continuation",
      parentRunId: continuedChild.id,
      continuationCount: 2,
      startedAt: new Date(Date.now() - HOUR),
    });
    assert.equal((await liveFailures(routine)).count, 0);
  });

  test("self-review and Revision evidence still include a hand-off's work", async () => {
    const { routine } = await fixture();
    const statuses: RunStatus[] = ["completed", "continued", "failed", "queued", "skipped"];
    for (const status of statuses) {
      await insert(Run, {
        routineId: routine.id,
        status,
        triggerKind: "schedule",
        startedAt: new Date(),
      });
    }
    const evidence = await runs()
      .createQueryBuilder("run")
      .where("run.routineId = :routineId", { routineId: routine.id })
      .andWhere(finishedRunEvidence())
      .getMany();
    assert.deepEqual(evidence.map((run) => run.status).sort(), [
      "completed",
      "continued",
      "failed",
    ]);
  });

  test("diagnostics never invent a failure for a Continued Run", () => {
    const diagnostics = readRunDiagnostics({
      status: "continued",
      errorKind: null,
      failureReason: null,
      continuationStopReason: null,
      checksVerdict: null,
      outcomeVerdict: null,
      outcomeNote: null,
      checkpointJson: JSON.stringify(batchOne),
      diagnosticsJson: null,
    } as Run);
    assert.equal(diagnostics.failure, null);
  });
});

describe("historical hand-offs are reclassified once at boot", () => {
  type Shape = Partial<Run> & { child?: RunStatus };

  async function seed(routine: Routine, shape: Shape): Promise<Run> {
    const { child, ...values } = shape;
    const run = await insert(Run, {
      routineId: routine.id,
      status: "failed",
      triggerKind: "schedule",
      startedAt: new Date(Date.now() - 5 * HOUR),
      finishedAt: new Date(Date.now() - 5 * HOUR + 60_000),
      checkpointJson: JSON.stringify(batchOne),
      ...values,
    });
    if (child) {
      await insert(Run, {
        routineId: routine.id,
        status: child,
        triggerKind: "continuation",
        parentRunId: run.id,
        continuationCount: 1,
        startedAt: new Date(Date.now() - 4 * HOUR),
      });
    }
    return run;
  }

  test("only the exact hand-off shape moves, and real failures keep Failed", async () => {
    const { routine } = await fixture();
    const tookOver = await seed(routine, { child: "completed" });
    const childFailed = await seed(routine, { child: "failed" });
    const stillQueued = await seed(routine, { retryAt: new Date(Date.now() + 60_000) });
    const keep = {
      reported: await seed(routine, {
        child: "completed",
        failureReason: "The CRM refused writes.",
      }),
      stopped: await seed(routine, {
        child: "completed",
        continuationStopReason: "The automatic continuation limit was reached.",
      }),
      checkFailed: await seed(routine, { child: "completed", checksVerdict: "failed" }),
      offGoal: await seed(routine, { child: "completed", outcomeVerdict: "off_goal" }),
      skippedChild: await seed(routine, { child: "skipped" }),
      cancelled: await seed(routine, {}),
      blocked: await seed(routine, {
        child: "completed",
        checkpointJson: JSON.stringify({ ...batchOne, state: "blocked" }),
      }),
      complete: await seed(routine, {
        child: "completed",
        checkpointJson: JSON.stringify(finished),
      }),
      noCheckpoint: await seed(routine, { checkpointJson: null, retryAt: new Date() }),
      retryChild: await seed(routine, { checkpointJson: null }),
    };
    await insert(Run, {
      routineId: routine.id,
      status: "completed",
      triggerKind: "retry",
      parentRunId: keep.retryChild.id,
      startedAt: new Date(),
    });
    const errored = await seed(routine, {
      status: "error",
      errorKind: "runtime",
      child: "completed",
    });

    assert.equal(await backfillContinuedRuns(), 3);

    for (const run of [tookOver, childFailed, stillQueued]) {
      assert.equal((await runs().findOneByOrFail({ id: run.id })).status, "continued");
    }
    for (const [name, run] of Object.entries(keep)) {
      assert.equal((await runs().findOneByOrFail({ id: run.id })).status, "failed", name);
    }
    assert.equal((await runs().findOneByOrFail({ id: errored.id })).status, "error");
    assert.equal(
      (await liveFailures(routine)).rows.some((row) => row.id === tookOver.id),
      false,
    );

    const marker = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
      key: CONTINUED_RUNS_BACKFILL_KEY,
    });
    assert.equal(JSON.parse(marker.value).runs, 3);
  });

  test("it runs once: later boots never rescan the Run history", async () => {
    const { routine } = await fixture();
    await seed(routine, { child: "completed" });
    assert.equal(await backfillContinuedRuns(), 1);

    const arrivedLater = await seed(routine, { child: "completed" });
    assert.equal(await backfillContinuedRuns(), 0);
    assert.equal((await runs().findOneByOrFail({ id: arrivedLater.id })).status, "failed");
  });

  test("an install with no history records that the work is done", async () => {
    assert.equal(await backfillContinuedRuns(), 0);
    assert.ok(
      await AppDataSource.getRepository(AppSetting).existsBy({ key: CONTINUED_RUNS_BACKFILL_KEY }),
    );
  });

  test("the shape check rejects every reason a Failed Run really failed", () => {
    const base = {
      failureReason: null,
      continuationStopReason: null,
      checksVerdict: null,
      outcomeVerdict: null,
      checkpointJson: JSON.stringify(batchOne),
      retryAt: null,
    } as Run;
    assert.equal(hasHandOffShape(base), true);
    assert.equal(hasHandOffShape({ ...base, failureReason: "Blocked." }), false);
    assert.equal(hasHandOffShape({ ...base, failureReason: "   " }), true, "blank is no report");
    assert.equal(hasHandOffShape({ ...base, continuationStopReason: "Limit." }), false);
    assert.equal(hasHandOffShape({ ...base, checksVerdict: "failed" }), false);
    assert.equal(hasHandOffShape({ ...base, outcomeVerdict: "off_goal" }), false);
    assert.equal(hasHandOffShape({ ...base, checkpointJson: null }), false);
    assert.equal(hasHandOffShape({ ...base, checkpointJson: "{not json" }), false);
    assert.equal(hasHandOffShape({ ...base, checkpointJson: JSON.stringify(finished) }), false);
  });
});
