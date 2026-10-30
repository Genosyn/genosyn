import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { AutonomyWaiver } from "../db/entities/AutonomyWaiver.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineCheck } from "../db/entities/RoutineCheck.js";
import { Run } from "../db/entities/Run.js";
import { addMember } from "../test/accessFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import { recordAudit } from "./audit.js";
import { stopCron } from "./cron.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  isModelAvailable,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import { saveRunCheckpoint } from "./runContinuation.js";
import {
  MAX_OUTAGE_PAUSES,
  MAX_RUN_PAUSES,
  pauseLocalRuns,
  resetRunPausesForTests,
  restartPauseCount,
} from "./runPause.js";
import { startRoutineRun } from "./runner.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";

/**
 * A Routine Run that meets an unavailable AI Model pauses — it does not fail.
 *
 * The bar, from AGENTS.md §3: nobody decided the work should stop, so the Run
 * goes back to the queue as the same Run with its transcript, tokens, saved
 * progress and Effects; it records no verdict, journal entry, alert, autonomy
 * change, failure count or retry; the queue starts nothing on the model while
 * it is unavailable and, once it is back, resumes the paused Runs first with
 * the time they had left, one at a time. It is never a Standdown, and the two
 * compose in both directions.
 */

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  resetRunPausesForTests();
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 0 } });
  await resetTestDb();
  await resumeRoutineQueue();
});
afterEach(async () => {
  await waitForRoutineQueueIdle();
  resetRunPausesForTests();
  resetModelAvailabilityForTests();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  overrideRuntimeSettingsForTests(null);
  await closeTestDb();
});

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];
type RuntimeResult = Awaited<ReturnType<typeof agentRuntime.run>>;

/** What OpenCode throws once its retries are spent on an overloaded service. */
function overloadedError(): Error {
  return Object.assign(new Error("The AI Model request failed (HTTP 529)."), {
    status: 529,
    statusCode: 529,
    providerDetail: "HTTP 529 · overloaded_error\nOverloaded",
  });
}

async function fixture(routineValues: Partial<Routine> = {}) {
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Avery",
    slug: "avery",
    role: "Operations",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: "{}",
  });
  const routine = (name: string, values: Partial<Routine> = {}) =>
    insert(Routine, {
      employeeId: employee.id,
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      cronExpr: "0 9 * * *",
      timeoutSec: 3600,
      body: `${name}: do the work.`,
      ...routineValues,
      ...values,
    });
  return { company, employee, model, routine };
}

function routineName(params: RuntimeParams): string {
  const first = params.messages[0]?.content[0];
  return /^## Routine: (.+)$/m.exec(first && "text" in first ? first.text : "")?.[1] ?? "?";
}

/** Grading and lessons go through the runtime too; answer them at once. */
function sideTurn(params: RuntimeParams): RuntimeResult | null {
  if (params.registry.resolve("submit_lesson"))
    return { finalText: "No lesson.", steps: 1, stopReason: "end_turn" };
  if (params.registry.resolve("submit_run_verdict"))
    return { finalText: "No verdict.", steps: 1, stopReason: "end_turn" };
  return null;
}

async function row(runId: string): Promise<Run> {
  return AppDataSource.getRepository(Run).findOneByOrFail({ id: runId });
}

async function waitFor(runId: string, done: (run: Run) => boolean, label: string): Promise<Run> {
  for (let i = 0; i < 800; i++) {
    await waitForRoutineQueueIdle();
    const current = await row(runId);
    if (done(current)) return current;
    await delay(10);
  }
  throw new Error(`Run ${runId} never ${label}.`);
}

const pausedNow = (run: Run) => run.status === "queued" && run.pauseCount > 0;

/** Bring the model back: its next check answers, and the work carries on. */
async function modelIsBack(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
  await dispatchQueuedRoutineRuns();
}

describe("pausing on an outage", () => {
  test("keeps the transcript, tokens, saved progress and Effects, and records nothing final", async (t) => {
    const { company, employee, model, routine } = await fixture();
    await addMember(company.id, "owner");
    const sweep = await routine("Nightly Ledger Sweep", { maxAttempts: 3 });
    await insert(AutonomyWaiver, {
      companyId: company.id,
      employeeId: employee.id,
      kind: "routine_approval",
      routineId: sweep.id,
      grantedByUserId: null,
      evidence: "Earned.",
    });
    let turn = 0;
    let resumedBrief = "";
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) {
        const run = await AppDataSource.getRepository(Run).findOneByOrFail({
          routineId: sweep.id,
          status: "running",
        });
        params.callbacks?.onText?.("Reconciled March. Posted 4 entries.\n");
        await recordAudit({
          companyId: company.id,
          runId: run.id,
          action: "ledger_entry.create",
          targetType: "ledger_entry",
          targetId: "le-1",
          targetLabel: "March accrual",
        });
        const token = issueMcpToken(employee.id, company.id, {
          authority: "employee",
          routineId: sweep.id,
          runId: run.id,
        });
        try {
          await saveRunCheckpoint(token, {
            state: "continue",
            completed: "March is reconciled.",
            remaining: "April.",
            resume: "Open April's statements.",
            progressKey: "2026-03",
          });
        } finally {
          revokeMcpToken(token);
        }
        params.callbacks?.onUsage?.({ inputTokens: 2_000, outputTokens: 200 });
        throw overloadedError();
      }
      resumedBrief = JSON.stringify(params.messages);
      const run = await AppDataSource.getRepository(Run).findOneByOrFail({
        routineId: sweep.id,
        status: "running",
      });
      const token = issueMcpToken(employee.id, company.id, {
        authority: "employee",
        routineId: sweep.id,
        runId: run.id,
      });
      try {
        await saveRunCheckpoint(token, {
          state: "complete",
          completed: "March and April are reconciled.",
          remaining: "",
          resume: "",
          progressKey: "2026-04",
        });
      } finally {
        revokeMcpToken(token);
      }
      params.callbacks?.onUsage?.({ inputTokens: 300, outputTokens: 30 });
      params.callbacks?.onText?.("Reconciled April too. Done.");
      return { finalText: "Reconciled March and April.", steps: 2, stopReason: "end_turn" };
    });

    const { run: accepted, completion } = await startRoutineRun(sweep, { triggerKind: "schedule" });
    const paused = await waitFor(accepted.id, pausedNow, "paused");
    assert.equal(paused.status, "queued");
    assert.equal(paused.pauseReason, "outage");
    assert.equal(paused.pauseCount, 1);
    assert.equal(paused.outagePauses, 1);
    assert.ok(paused.pausedAt);
    assert.equal(paused.errorKind, null, "not an Error");
    assert.equal(paused.finishedAt, null);
    assert.equal(paused.retryAt, null, "an outage spends no retry");
    assert.equal(paused.outcomeVerdict, null, "no verdict");
    assert.equal(paused.outcomeCheckedAt, null);
    assert.equal(paused.queueActiveEmployeeId, null);
    assert.equal(paused.tokensIn, 2_000);
    assert.equal(paused.tokensOut, 200);
    assert.match(paused.logContent, /Reconciled March\. Posted 4 entries\./);
    assert.match(paused.logContent, /\[paused\] The AI Model is overloaded \(HTTP 529, overloaded_error\)\./);
    assert.match(paused.checkpointJson ?? "", /"progressKey":"2026-03"/);
    const remaining = paused.pauseRemainingMs ?? 0;
    assert.ok(remaining > 59 * 60_000 && remaining <= 60 * 60_000, String(remaining));
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ runId: accepted.id }),
      1,
      "its Effects are its own, untouched",
    );
    assert.equal(await AppDataSource.getRepository(JournalEntry).countBy({ runId: accepted.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(Notification).countBy({ kind: "run_failed" }),
      0,
      "no failure alert",
    );
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: sweep.id }))
        .consecutiveFailures ?? 0,
      0,
    );
    const waiver = await AppDataSource.getRepository(AutonomyWaiver).findOneByOrFail({
      routineId: sweep.id,
    });
    assert.equal(waiver.revokedAt, null, "earned autonomy is untouched");
    assert.equal(isModelAvailable(model), false);

    // While unavailable the queue does not start it, however often it is asked.
    await dispatchQueuedRoutineRuns();
    await dispatchQueuedRoutineRuns();
    assert.equal(turn, 1);
    assert.equal((await row(accepted.id)).status, "queued");

    await modelIsBack(model);
    const finished = await completion;
    assert.equal(finished.id, accepted.id, "the same Run carried on");
    assert.equal(finished.status, "completed", finished.logContent);
    assert.equal(finished.tokensIn, 2_300);
    assert.equal(finished.tokensOut, 230);
    assert.equal(finished.pauseCount, 1);
    assert.match(resumedBrief, /Resume this Run now that your AI Model is back/);
    assert.match(resumedBrief, /March is reconciled\./, "its saved progress");
    assert.match(resumedBrief, /ledger_entry\.create/, "its Effects");
    assert.match(resumedBrief, /Reconciled March\. Posted 4 entries\./, "its transcript");
    const log = finished.logContent;
    assert.ok(
      log.indexOf("Posted 4 entries") < log.indexOf("[paused]") &&
        log.indexOf("[paused]") < log.indexOf("[resumed] The AI Model is answering again") &&
        log.indexOf("[resumed]") < log.indexOf("Reconciled April too"),
      "one transcript, in order",
    );
    assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: sweep.id }), 1);
  });

  test("a check-remediation round that meets the outage pauses the Run too", async (t) => {
    const { company, model, routine } = await fixture();
    const report = await routine("Weekly Report");
    // A Check this Run cannot pass, so it gets a remediation round.
    await insert(RoutineCheck, {
      companyId: company.id,
      routineId: report.id,
      name: "Report saved",
      kind: "effect",
      spec: JSON.stringify({ action: "report.save" }),
      required: true,
      enabled: true,
    });
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) return { finalText: "Wrote the report.", steps: 1, stopReason: "end_turn" };
      throw overloadedError();
    });
    const { run: accepted } = await startRoutineRun(report, { triggerKind: "manual" });
    const paused = await waitFor(accepted.id, pausedNow, "paused");
    assert.equal(paused.pauseReason, "outage");
    assert.equal(paused.errorKind, null);
    assert.match(paused.logContent, /remediation turn stopped: The AI Model is overloaded/);
    assert.equal(isModelAvailable(model), false);
  });

  test("a model that keeps failing a Run after its checks pass ends it, as an Error", async (t) => {
    const { routine } = await fixture();
    const flaky = await routine("Flaky Import");
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      throw overloadedError();
    });
    const { run: accepted, completion } = await startRoutineRun(flaky, { triggerKind: "manual" });
    await waitFor(accepted.id, pausedNow, "paused");
    // As if it had already paused for the model as often as it may.
    await AppDataSource.getRepository(Run).update(
      { id: accepted.id },
      { outagePauses: MAX_OUTAGE_PAUSES, pauseCount: MAX_OUTAGE_PAUSES },
    );
    await modelIsBack(await activeModelOf(accepted.employeeId!));
    const ended = await completion;
    assert.equal(ended.status, "error");
    assert.equal(ended.errorKind, "runtime");
    assert.match(ended.logContent, /became unavailable \d+ times during this Run/);
  });

  test("outage pauses never use up the restart allowance", () => {
    assert.equal(restartPauseCount({ pauseCount: MAX_RUN_PAUSES, outagePauses: MAX_RUN_PAUSES }), 0);
    assert.equal(restartPauseCount({ pauseCount: 7, outagePauses: 4 }), 3);
  });

  test("a restart while a Run is paused for an outage keeps it a pause, and the restart pause says so", async (t) => {
    const { routine } = await fixture();
    const longJob = await routine("Long Job");
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) throw overloadedError();
      // Back from the outage; work until a restart pauses it.
      if (!params.signal?.aborted)
        await new Promise<void>((resolve) =>
          params.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      return { finalText: "", steps: 1, stopReason: "aborted" };
    });
    const { run: accepted } = await startRoutineRun(longJob, { triggerKind: "manual" });
    await waitFor(accepted.id, pausedNow, "paused for the outage");
    await modelIsBack(await activeModelOf(accepted.employeeId!));
    // Not `waitFor`: the queue is busy with this very Run until it pauses.
    for (let i = 0; i < 800 && turn < 2; i++) await delay(5);
    assert.equal(turn, 2, "the Run resumed once the model was back");
    const outcome = await pauseLocalRuns({ graceMs: 0, reason: "restart" }, { timeoutMs: 10_000 });
    assert.equal(outcome.stillRunning, 0);
    const paused = await row(accepted.id);
    assert.equal(paused.status, "queued");
    assert.equal(paused.pauseReason, "restart");
    assert.equal(paused.pauseCount, 2);
    assert.equal(paused.outagePauses, 1);
    resetRunPausesForTests();
  });
});

async function activeModelOf(employeeId: string): Promise<AIModel> {
  const { getActiveModel } = await import("./models.js");
  const model = await getActiveModel(employeeId);
  assert.ok(model);
  return model;
}

describe("the queue while a model is unavailable", () => {
  test("starts nothing on it, and once it is back resumes paused Runs first, one at a time", async (t) => {
    overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 1 } });
    const { model, routine } = await fixture();
    const earlier = await routine("Earlier Work");
    const waiting = await routine("Waiting Work");
    const later = await routine("Later Work");
    const starts: Array<{ name: string; at: number }> = [];
    let failFirst = true;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      starts.push({ name: routineName(params), at: Date.now() });
      if (failFirst) {
        failFirst = false;
        throw overloadedError();
      }
      return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
    });

    const first = await startRoutineRun(earlier, { triggerKind: "manual" });
    await waitFor(first.run.id, pausedNow, "paused");
    const second = await startRoutineRun(waiting, { triggerKind: "manual" });
    const third = await startRoutineRun(later, { triggerKind: "schedule" });
    await waitForRoutineQueueIdle();
    assert.deepEqual(
      starts.map((s) => s.name),
      ["Earlier Work"],
      "nothing starts while the model is unavailable",
    );
    for (const id of [second.run.id, third.run.id]) {
      const queued = await row(id);
      assert.equal(queued.status, "queued");
      assert.match(queued.logContent, /it is unavailable/);
    }

    await modelIsBack(model);
    const done = await Promise.all([first.completion, second.completion, third.completion]);
    assert.deepEqual(
      done.map((run) => run.status),
      ["completed", "completed", "completed"],
    );
    assert.deepEqual(
      starts.map((s) => s.name),
      ["Earlier Work", "Earlier Work", "Waiting Work", "Later Work"],
      "the paused Run first, then the rest in the order they queued",
    );
    // Each Run's claim is when the queue admitted it: one a second once back.
    const claimed = done.map((run) => run.startedAt.getTime());
    assert.ok(
      claimed[1] - claimed[0] >= 950 && claimed[2] - claimed[1] >= 950,
      `starts are spread a second apart: ${claimed[1] - claimed[0]}ms, ${claimed[2] - claimed[1]}ms`,
    );
  });

  test("a Standdown placed during an outage still defers the work after recovery; lifting it starts it", async (t) => {
    const { company, model, routine } = await fixture();
    const job = await routine("Standdown Job");
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) throw overloadedError();
      return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
    });
    const { run: accepted, completion } = await startRoutineRun(job, { triggerKind: "manual" });
    await waitFor(accepted.id, pausedNow, "paused");
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "company",
      reason: "Quarter close: hold all AI work.",
    });
    await modelIsBack(model);
    await waitForRoutineQueueIdle();
    assert.equal(turn, 1, "recovery never bypasses a Standdown");
    assert.equal((await row(accepted.id)).status, "queued");
    await liftStanddown({ standdown, userId: null });
    await dispatchQueuedRoutineRuns();
    const done = await completion;
    assert.equal(done.status, "completed");
    assert.equal(turn, 2);
  });

  test("lifting a Standdown while the model is still unavailable starts nothing", async (t) => {
    const { company, model, routine } = await fixture();
    const job = await routine("Lift Job");
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
    });
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "company",
      reason: "Investigating an incident.",
    });
    recordModelFailure(
      model,
      modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
    );
    // Accepted before the stop? It is refused; place it after lifting would race.
    await liftStanddown({ standdown, userId: null });
    const { run: accepted, completion } = await startRoutineRun(job, { triggerKind: "manual" });
    await dispatchQueuedRoutineRuns();
    await waitForRoutineQueueIdle();
    assert.equal(turn, 0, "lifting a Standdown never bypasses an unavailable model");
    assert.equal((await row(accepted.id)).status, "queued");
    await modelIsBack(model);
    assert.equal((await completion).status, "completed");
  });

  test("a Standdown that lands while the turn meets the outage wins: the Run ends interrupted", async (t) => {
    const { company, routine } = await fixture();
    const job = await routine("Interrupted Job");
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      await placeStanddown({ companyId: company.id, scope: "company", reason: "Stop now." });
      for (let i = 0; i < 200 && !params.signal?.aborted; i++) await delay(5);
      throw overloadedError();
    });
    const { completion } = await startRoutineRun(job, { triggerKind: "manual" });
    const ended = await completion;
    assert.equal(ended.status, "error");
    assert.equal(ended.errorKind, "interrupted");
    assert.equal(ended.pauseCount, 0, "not paused: a person stopped it");
  });
});
