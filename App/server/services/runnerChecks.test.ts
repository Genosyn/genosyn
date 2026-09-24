import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AutonomyWaiver } from "../db/entities/AutonomyWaiver.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineCheck } from "../db/entities/RoutineCheck.js";
import { Standdown } from "../db/entities/Standdown.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { SandboxCommandResult } from "./agent/sandboxCommandRun.js";
import { agentRuntime } from "./agent/runtime.js";
import { createCheck, runChecksForRun } from "./routineChecks.js";
import { startRoutineRun } from "./runner.js";
import { waitForRoutineQueueIdle } from "./routineQueue.js";
import { interruptCoveredRuns, stopStanddowns } from "./standdowns.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { runWorkSummary } from "./runWorkSummary.js";
import { readRunDiagnostics } from "./runDiagnostics.js";

/**
 * The check phase, from both ends.
 *
 * `runCheckPhase` is private to `runner.ts`, so the first half of this file
 * tests `runChecksForRun` at exactly the boundary the runner calls it across —
 * the attempt number it passes, the absolute deadline it hands down, the
 * `not_run` it reads as "there was no bar here". The second half drives whole
 * Runs against a local OpenAI-compatible endpoint, because the parts of the
 * phase that only exist in `runner.ts` — the bounded remediation loop, the
 * verdict landing on the Run row, the deadline that stops a fix round from
 * quietly extending `Routine.timeoutSec` — cannot be reached any other way.
 *
 * The invariant running through all of it is the one the module note in
 * `routineChecks.ts` calls design call 2: a check that could not be run is a
 * failure, never a skip. "We could not verify" must never become "verified".
 */

let upstream: Server;
let upstreamBaseUrl = "";
let previousAllowlist: string[] = [];
/** Every model turn served, so remediation rounds can be counted. */
let upstreamTurns = 0;
let completionText = "I have done what was asked.";
let lastModelRequest = "";
let rejectRemediation = false;
let rejectAll = false;
let beforeCompletion: (() => Promise<void>) | null = null;

let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  upstream = createServer((request, response) => {
    void drain(request).then(async (body) => {
      lastModelRequest = body;
      upstreamTurns += 1;
      await beforeCompletion?.();
      if (rejectAll || (rejectRemediation && upstreamTurns > 1)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Remediation could not run", type: "invalid_request_error" },
          }),
        );
        return;
      }
      sendCompletion(response, completionText);
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});

after(async () => {
  await waitForRoutineQueueIdle();
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
  stopStanddowns();
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function drain(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

function sendCompletion(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(
    `data: ${JSON.stringify({
      id: "check-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: "checks-test",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  upstreamTurns = 0;
  completionText = "I have done what was asked.";
  lastModelRequest = "";
  rejectRemediation = false;
  rejectAll = false;
  beforeCompletion = null;
  await resetTestDb();
  company = await insert(Company, {
    name: "Checks Co",
    slug: "checks-co",
    ownerId: "owner-checks",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Cass Checker",
    slug: "cass-checker",
    role: "Operations",
  });
});

afterEach(() => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
});

let routineSeq = 0;

async function makeRoutine(values: Partial<Routine> = {}): Promise<Routine> {
  routineSeq += 1;
  return insert(Routine, {
    employeeId: employee.id,
    name: `Checked routine ${routineSeq}`,
    slug: `checked-routine-${routineSeq}`,
    cronExpr: "0 3 * * *",
    body: "Do the work.",
    acceptanceCriteria: "",
    // Work, two remediation turns, and reflection each start an external runtime.
    timeoutSec: 480,
    maxAttempts: 1,
    ...values,
  });
}

async function makeRun(routineId: string): Promise<Run> {
  return insert(Run, {
    routineId,
    startedAt: new Date(),
    finishedAt: null,
    status: "running",
    logContent: "",
    triggerKind: "schedule",
    attempt: 1,
    missedSlots: 0,
  });
}

async function effectCheck(
  routineId: string,
  name: string,
  spec: Record<string, unknown>,
  values: { required?: boolean; enabled?: boolean } = {},
) {
  return createCheck({
    companyId: company.id,
    routineId,
    name,
    kind: "effect",
    spec: JSON.stringify(spec),
    createdById: null,
    ...values,
  });
}

async function connectModel(): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "checks-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(upstreamBaseUrl),
      modelId: "checks-test",
    }),
  });
}

/** Deadline tests control the model boundary so process startup cannot consume their budget. */
function completedModelForDeadlineTest(
  t: TestContext,
  beforeReturn: (call: number) => Promise<void>,
): () => number {
  let calls = 0;
  t.mock.method(agentRuntime, "run", async () => {
    await beforeReturn(++calls);
    return { finalText: completionText, steps: 1, stopReason: "end_turn" };
  });
  return () => calls;
}

async function setRemainingRunBudget(t: TestContext, routine: Routine, remainingMs: number) {
  const run = await AppDataSource.getRepository(Run).findOneByOrFail({
    routineId: routine.id,
    status: "running",
  });
  const now = run.startedAt.getTime() + routine.timeoutSec * 1000 - remainingMs;
  t.mock.method(Date, "now", () => now);
}

async function resultsFor(runId: string): Promise<RunCheckResult[]> {
  return AppDataSource.getRepository(RunCheckResult).find({
    where: { runId },
    order: { attempt: "ASC", createdAt: "ASC" },
  });
}

/** The base the runner passes on every round, minus the attempt number. */
function checkParams(run: Run, routine: Routine, deadlineAtMs = Date.now() + 60_000) {
  return {
    run,
    routine,
    employee,
    companyId: company.id,
    cwd: "/tmp/genosyn-checks-test",
    deadlineAtMs,
  };
}

describe("runChecksForRun — the boundary the runner calls across", () => {
  test("`not_run` when the Routine declares no Checks at all", async () => {
    const routine = await makeRoutine();
    const run = await makeRun(routine.id);

    const phase = await runChecksForRun({ ...checkParams(run, routine), attempt: 0 });

    assert.deepEqual(phase, { verdict: "not_run", results: [] });
    assert.deepEqual(await resultsFor(run.id), []);
  });

  test("`not_run` when every Check the Routine has is disabled", async () => {
    const routine = await makeRoutine();
    await effectCheck(
      routine.id,
      "switched off",
      { action: "invoice.send", min: 1 },
      {
        enabled: false,
      },
    );
    const run = await makeRun(routine.id);

    const phase = await runChecksForRun({ ...checkParams(run, routine), attempt: 0 });

    assert.equal(phase.verdict, "not_run");
    assert.deepEqual(await resultsFor(run.id), []);
  });

  test("the attempt number separates the rounds rather than overwriting them", async () => {
    const routine = await makeRoutine();
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });
    const run = await makeRun(routine.id);

    const first = await runChecksForRun({ ...checkParams(run, routine), attempt: 0 });
    const second = await runChecksForRun({ ...checkParams(run, routine), attempt: 1 });

    assert.equal(first.verdict, "failed");
    assert.equal(second.verdict, "failed");
    const rows = await resultsFor(run.id);
    assert.deepEqual(
      rows.map((r) => r.attempt),
      [0, 1],
      "an overwritten round would erase the history the strip shows a human",
    );
    assert.equal(rows[0].name, "an invoice was sent");
  });

  test("an unsatisfied required Check fails the round; an advisory one does not", async () => {
    const routine = await makeRoutine();
    await effectCheck(
      routine.id,
      "advisory only",
      { action: "invoice.send", min: 1 },
      {
        required: false,
      },
    );
    const run = await makeRun(routine.id);

    const phase = await runChecksForRun({ ...checkParams(run, routine), attempt: 0 });

    assert.equal(phase.verdict, "passed");
    assert.equal(phase.results.length, 1);
    assert.equal(phase.results[0].passed, false);
    assert.equal(phase.results[0].required, false);
  });

  test("a satisfiable Check passes and records what the ledger held", async () => {
    const routine = await makeRoutine();
    await effectCheck(routine.id, "nothing was required", { action: "invoice.send", min: 0 });
    const run = await makeRun(routine.id);

    const phase = await runChecksForRun({ ...checkParams(run, routine), attempt: 0 });

    assert.equal(phase.verdict, "passed");
    assert.equal(phase.results[0].passed, true);
    assert.match(phase.results[0].detail, /the ledger has 0/);
  });

  test("a spec nobody can read is a recorded failure, never a skip", async () => {
    const routine = await makeRoutine();
    const check = await effectCheck(routine.id, "readable for now", {
      action: "invoice.send",
      min: 1,
    });
    // Corrupt it behind `createCheck`'s validation, the way a hand-edited row or
    // a future schema change would.
    await AppDataSource.getRepository(RoutineCheck).update({ id: check.id }, { spec: "{not json" });
    const run = await makeRun(routine.id);

    const phase = await runChecksForRun({ ...checkParams(run, routine), attempt: 0 });

    assert.equal(phase.verdict, "failed");
    assert.equal(phase.results.length, 1, "the failure has to be written down, not swallowed");
    assert.equal(phase.results[0].passed, false);
    assert.match(phase.results[0].detail, /could not be read/);
  });

  test("a command Check is clamped to whatever is left of the Run's deadline", async () => {
    const routine = await makeRoutine();
    await createCheck({
      companyId: company.id,
      routineId: routine.id,
      name: "the report exists",
      kind: "command",
      spec: "test -f report.csv",
      timeoutSec: 900,
      createdById: null,
    });
    const run = await makeRun(routine.id);
    const timeouts: number[] = [];
    const runCommand = async (options: { timeoutMs?: number }): Promise<SandboxCommandResult> => {
      timeouts.push(options.timeoutMs ?? -1);
      return { output: "", exitCode: 0, timedOut: false, aborted: false, truncated: false };
    };

    const phase = await runChecksForRun({
      // Five seconds left of the Run, against a Check that asked for 900.
      ...checkParams(run, routine, Date.now() + 5_000),
      attempt: 0,
      runCommand: runCommand as never,
    });

    assert.equal(phase.verdict, "passed");
    assert.equal(timeouts.length, 1);
    assert.ok(
      timeouts[0] <= 5_000,
      `checks must not extend Routine.timeoutSec — got ${timeouts[0]}ms`,
    );
    assert.ok(timeouts[0] > 0);
  });

  test("a command Check reached after the deadline fails with the reason, and never runs", async () => {
    const routine = await makeRoutine();
    await createCheck({
      companyId: company.id,
      routineId: routine.id,
      name: "the report exists",
      kind: "command",
      spec: "test -f report.csv",
      createdById: null,
    });
    const run = await makeRun(routine.id);
    let spawned = 0;
    const runCommand = async (): Promise<SandboxCommandResult> => {
      spawned += 1;
      return { output: "", exitCode: 0, timedOut: false, aborted: false, truncated: false };
    };

    const phase = await runChecksForRun({
      ...checkParams(run, routine, Date.now() - 1),
      attempt: 0,
      runCommand: runCommand as never,
    });

    assert.equal(spawned, 0);
    assert.equal(phase.verdict, "failed");
    assert.match(phase.results[0].detail, /whole time budget/);
  });

  test("a Check belonging to another company's Routine is not run for this Run", async () => {
    const routine = await makeRoutine();
    await effectCheck(routine.id, "ours", { action: "invoice.send", min: 1 });
    const run = await makeRun(routine.id);

    const phase = await runChecksForRun({
      ...checkParams(run, routine),
      companyId: "a-different-company",
      attempt: 0,
    });

    // `listChecks` scopes by company, so the bar simply is not there — and a
    // Routine with no readable Checks is `not_run`, not a silent pass.
    assert.equal(phase.verdict, "not_run");
  });
});

describe("the check phase inside a Run", () => {
  test("failed remediation clears the initial work claim", async () => {
    await connectModel();
    completionText = "All invoice totals are correct.";
    rejectRemediation = true;
    const routine = await makeRoutine();
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });
    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const run = await started.completion;
    assert.equal(run.status, "error");
    assert.equal(run.errorKind, "runtime");
    assert.equal(run.checksVerdict, "failed");
    assert.match(run.logContent, /remediation turn failed/);
    assert.equal(readRunDiagnostics(run).failure?.phase, "checks");
    assert.ok(readRunDiagnostics(run).failure?.message);
    assert.equal(runWorkSummary(run), null);
  });
  test("a complete model response persists a concise work outcome without another model call", async () => {
    await connectModel();
    completionText =
      "## Outcome\nAdded 6 qualified Contacts. Drafted 4 outreach messages.\n\n## Details\nCalled list_issues 8 times.";
    const routine = await makeRoutine();
    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const run = await started.completion;
    const persisted = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(run.status, "completed");
    assert.equal(upstreamTurns, 1);
    assert.equal(
      runWorkSummary(persisted),
      "Added 6 qualified Contacts. Drafted 4 outreach messages.",
    );
    assert.match(persisted.logContent, /\[work-summary\]/);
    assert.match(
      persisted.logContent,
      /Called list_issues 8 times/,
      "the full report stays available in the Run log",
    );
    assert.match(lastModelRequest, /Begin your final report with one or two short sentences/);
    assert.match(lastModelRequest, /Do not claim work you did not complete/);
  });

  test("the runner stores a redacted summary while leaving verdicts independent", async () => {
    await connectModel();
    completionText =
      "Saved the report with **api_key**: hidden-example-value. One invoice needs review.";
    const routine = await makeRoutine();
    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const run = await started.completion;
    assert.doesNotMatch(runWorkSummary(run)!, /hidden-example-value/);
    const marker = run.logContent.split("\n").find((line) => line.startsWith("[work-summary]"))!;
    assert.doesNotMatch(marker, /hidden-example-value/);
    assert.equal(run.outcomeVerdict, null);
    assert.equal(run.checksVerdict, "not_run");
  });
  test("a Routine with no Checks finalizes `not_run` with no remediation", async () => {
    await connectModel();
    const routine = await makeRoutine();

    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const run = await started.completion;

    assert.equal(run.status, "completed");
    assert.equal(run.checksVerdict, "not_run");
    assert.equal(run.checkRemediations, 0);
    assert.equal(upstreamTurns, 1, "no Checks means no remediation rounds");
  });

  test("a passing Check finalizes `passed` and buys no extra model turn", async () => {
    await connectModel();
    const routine = await makeRoutine();
    await effectCheck(routine.id, "nothing was required", { action: "invoice.send", min: 0 });

    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const run = await started.completion;

    assert.equal(run.checksVerdict, "passed");
    assert.equal(run.checkRemediations, 0);
    assert.equal(upstreamTurns, 1);
    const rows = await resultsFor(run.id);
    assert.deepEqual(
      rows.map((r) => r.attempt),
      [0],
    );
  });

  test("a failing Check earns exactly two briefed rounds, then finalizes `failed`", async () => {
    await connectModel();
    const routine = await makeRoutine();
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });

    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const run = await started.completion;

    assert.equal(run.status, "failed");
    assert.equal(run.checksVerdict, "failed");
    assert.equal(
      run.checkRemediations,
      2,
      "the bound is what stops remediation becoming a second, unbudgeted Run",
    );
    // One work turn, two remediation turns, and the single reflection turn a
    // check-failing Run earns from the improvement loop (M52).
    assert.equal(upstreamTurns, 4);
    const rows = await resultsFor(run.id);
    assert.deepEqual(
      rows.map((r) => r.attempt),
      [0, 1, 2],
      "every round is written down, so a human can see what was tried",
    );
    assert.ok(rows.every((r) => !r.passed));
    assert.match(run.logContent, /\[checks\] 0\/1 passed/);
    assert.match(run.logContent, /remediation 1 of 2/);
    assert.equal(
      run.logContent.split("[work-summary]").length - 1,
      5,
      "both remediation rounds invalidate the old summary before recording a new one",
    );
    assert.equal(
      runWorkSummary(run),
      null,
      "a failed Check must not present a successful work claim",
    );
  });

  test("a Run out of budget stops remediating instead of extending its own timeout", async (t) => {
    await connectModel();
    // Complete the model with four seconds left: the first Check round has
    // less than the ten seconds runCheckPhase requires to brief a fix into.
    const routine = await makeRoutine({ retryOnTimeout: false });
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });
    const modelCalls = completedModelForDeadlineTest(t, async (call) => {
      if (call === 1) await setRemainingRunBudget(t, routine, 4_000);
    });

    const started = await startRoutineRun(routine, {
      triggerKind: "schedule",
    });
    const run = await started.completion;

    assert.ok(modelCalls() >= 1, "the model must finish before the Check budget is tested");
    assert.equal(run.status, "failed", "unfinished work must not be reported as a timeout");
    assert.equal(run.errorKind, null);
    assert.equal(run.checksVerdict, "failed");
    assert.match(run.logContent, /no time left in this Run's budget for another attempt/);
    assert.doesNotMatch(
      run.logContent,
      /asking for a fix/,
      "a round with no time to work in must not start a turn certain to be aborted",
    );
    assert.deepEqual(
      (await resultsFor(run.id)).map((result) => result.attempt),
      [0],
      "the completed work must be checked without starting a remediation round",
    );
  });

  /**
   * KNOWN FAILING — reported, not fixed.
   *
   * `runCheckPhase` increments `remediations` at the top of the loop body
   * (services/runner.ts:996) and only then discovers there is no time left,
   * breaking at services/runner.ts:1002. The abandoned round is still counted,
   * so `Run.checkRemediations` claims a briefed fix attempt that never
   * happened — and the assertion right above this test proves it never did.
   * The count is what a human reads to judge how much trouble a Run was in,
   * and it is off by one in the direction that overstates.
   */
  test("checkRemediations counts only rounds that actually ran", async (t) => {
    await connectModel();
    const routine = await makeRoutine({ retryOnTimeout: false });
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });
    const modelCalls = completedModelForDeadlineTest(t, async (call) => {
      if (call === 1) await setRemainingRunBudget(t, routine, 4_000);
    });

    const started = await startRoutineRun(routine, {
      triggerKind: "schedule",
    });
    const run = await started.completion;

    // Guards against passing for the wrong reason: a Run that timed out before
    // the check phase would also report zero remediations.
    assert.equal(run.status, "failed");
    assert.equal(run.checksVerdict, "failed");
    assert.ok(modelCalls() >= 1, "the model must finish before the Check budget is tested");
    assert.doesNotMatch(run.logContent, /asking for a fix/);
    assert.equal(run.checkRemediations, 0, "no fix round was ever briefed");
  });
});

describe("Run completion states", () => {
  test("server-observed failure details survive finalization independently of the transcript", async (t) => {
    await connectModel();
    for (const failure of ["authorization", "timeout"] as const) {
      const routine = await makeRoutine({ timeoutSec: 180 });
      t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
        params.callbacks?.onToolUse?.(
          "browser_open",
          { url: "https://example.test" },
          "observed-step",
        );
        if (failure === "authorization") {
          params.callbacks?.onToolResult?.(
            "browser_open",
            { isError: true, content: "Browser RPC 401: Invalid token" },
            "observed-step",
          );
          throw new Error("Browser RPC 401: Invalid token");
        }
        await setRemainingRunBudget(t, routine, -100);
        return { finalText: "", steps: 1, stopReason: "end_turn" };
      });
      const run = await (await startRoutineRun(routine)).completion;
      const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
      assert.equal(stored.status, "error");
      const diagnostic = readRunDiagnostics(stored);
      assert.equal(diagnostic.failure?.category, failure);
      assert.equal(diagnostic.failure?.phase, "work");
      assert.ok(diagnostic.failure?.message);
      if (failure === "authorization")
        assert.equal(diagnostic.toolErrors[0]?.step?.tool, "browser_open");
      else assert.equal(diagnostic.failure?.step?.tool, "browser_open");
      const withoutTranscript = { ...stored, logContent: "" };
      assert.equal(readRunDiagnostics(withoutTranscript).failure?.category, failure);
      t.mock.restoreAll();
    }
  });

  test("a model request error is Error, with no invented failure reason or outcome", async () => {
    await connectModel();
    rejectAll = true;
    const routine = await makeRoutine();
    const run = await (await startRoutineRun(routine)).completion;
    assert.equal(run.status, "error");
    assert.equal(run.errorKind, "runtime");
    assert.equal(run.failureReason, null);
    assert.equal(run.outcomeVerdict, null);
    assert.equal(run.checksVerdict, null);
    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.ok(stored.diagnosticsJson);
    assert.equal(readRunDiagnostics(stored).failure?.category, "model");
    assert.ok(readRunDiagnostics(stored).failure?.message);
  });

  test("an employee's durable failure report finalizes Failed and retains its reason", async () => {
    await connectModel();
    const routine = await makeRoutine({ maxAttempts: 2 });
    beforeCompletion = async () => {
      await AppDataSource.getRepository(Run).update(
        { routineId: routine.id, status: "running" },
        { failureReason: "The source report does not include the required totals." },
      );
    };
    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(run.status, "failed");
    assert.equal(stored.status, "failed");
    assert.equal(stored.failureReason, "The source report does not include the required totals.");
    assert.equal(stored.errorKind, null);
    assert.equal(stored.outcomeVerdict, null);
    assert.equal(stored.checksVerdict, null);
    assert.ok(stored.retryAt);
  });

  test("a failure report racing the terminal write cannot leave a Completed Run", async (t) => {
    await connectModel();
    const routine = await makeRoutine({ maxAttempts: 2 });
    const repo = AppDataSource.getRepository(Run);
    const update = repo.update.bind(repo);
    let raced = false;
    t.mock.method(repo, "update", async (...args: Parameters<typeof repo.update>) => {
      if (!raced && args[1].status === "completed") {
        raced = true;
        await update(
          { routineId: routine.id, status: "running" },
          { failureReason: "Delivery remained incomplete." },
        );
      }
      return update(...args);
    });
    const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
    assert.equal(raced, true);
    assert.equal(run.status, "failed");
    assert.equal(run.failureReason, "Delivery remained incomplete.");
    assert.ok(run.retryAt);
    assert.equal((await repo.findOneByOrFail({ id: run.id })).status, "failed");
  });

  test("recovery that wins while the model works retains its terminal Error and transcript", async () => {
    await connectModel();
    const routine = await makeRoutine();
    beforeCompletion = async () => {
      await AppDataSource.getRepository(Run).update(
        { routineId: routine.id, status: "running" },
        {
          status: "error",
          errorKind: "interrupted",
          finishedAt: new Date(),
          logContent: "Recovered after a server restart.",
        },
      );
    };
    const run = await (await startRoutineRun(routine)).completion;
    assert.equal(run.status, "error");
    assert.equal(run.errorKind, "interrupted");
    assert.equal(run.logContent, "Recovered after a server restart.");
  });

  test("a failure report during remediation survives a later passing Check", async () => {
    await connectModel();
    const routine = await makeRoutine();
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });
    beforeCompletion = async () => {
      if (upstreamTurns !== 2) return;
      await AppDataSource.getRepository(Run).update(
        { routineId: routine.id, status: "running" },
        { failureReason: "The invoice was sent but its delivery could not be confirmed." },
      );
      await AppDataSource.getRepository(RoutineCheck).update(
        { routineId: routine.id },
        { spec: JSON.stringify({ action: "invoice.send", min: 0 }) },
      );
    };
    const run = await (await startRoutineRun(routine)).completion;
    assert.equal(run.status, "failed");
    assert.equal(run.checksVerdict, "passed");
    assert.equal(
      run.failureReason,
      "The invoice was sent but its delivery could not be confirmed.",
    );
    assert.equal(run.checkRemediations, 1);
  });
});

test("a Standdown interruption is Error during work or remediation", async () => {
  await connectModel();
  for (const duringRemediation of [false, true]) {
    upstreamTurns = 0;
    const routine = await makeRoutine();
    if (duringRemediation)
      await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });
    let interrupted = false;
    beforeCompletion = async () => {
      if (upstreamTurns !== (duringRemediation ? 2 : 1)) return;
      const ids = interruptCoveredRuns(
        Object.assign(new Standdown(), {
          companyId: company.id,
          scope: "routine",
          scopeId: routine.id,
        }),
      );
      interrupted = ids.length === 1;
    };
    const run = await (await startRoutineRun(routine)).completion;
    assert.equal(interrupted, true);
    assert.equal(run.status, "error");
    assert.equal(run.errorKind, "interrupted");
    assert.equal(run.failureReason, null);
    assert.equal(run.checkRemediations, duringRemediation ? 1 : 0);
  }
});

test("a post-model exception after the deadline remains a timeout Error", async (t) => {
  await connectModel();
  const routine = await makeRoutine({ maxAttempts: 3, retryOnTimeout: false });
  let failed = false;
  const modelCalls = completedModelForDeadlineTest(t, async () => {
    const runs = AppDataSource.getRepository(Run);
    const running = await runs.findOneByOrFail({ routineId: routine.id, status: "running" });
    const afterDeadline = running.startedAt.getTime() + routine.timeoutSec * 1000 + 100;
    const findOneBy = runs.findOneBy.bind(runs);
    t.mock.method(runs, "findOneBy", async (...args: Parameters<typeof runs.findOneBy>) => {
      if (!failed) {
        failed = true;
        t.mock.method(Date, "now", () => afterDeadline);
        throw new Error("The Run query did not finish before the deadline.");
      }
      return findOneBy(...args);
    });
  });
  const run = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
  assert.equal(modelCalls(), 1, "the model must return before the storage query fails");
  assert.equal(failed, true, "the post-model storage query must actually fail");
  assert.equal(run.status, "error");
  assert.equal(run.errorKind, "timeout");
  assert.equal(
    run.retryAt,
    null,
    "the timeout retry setting must still apply after the model returns",
  );
  assert.match(run.logContent, /\[timeout\]/);
});

test("runtime and timeout Errors revoke earned Waivers and leave a journal", async (t) => {
  await connectModel();
  for (const timedOut of [false, true]) {
    const routine = await makeRoutine({ timeoutSec: timedOut ? 1 : 180 });
    const waiver = await insert(AutonomyWaiver, {
      companyId: company.id,
      employeeId: employee.id,
      kind: "routine_approval",
      routineId: routine.id,
    });
    if (!timedOut) {
      beforeCompletion = async () => {
        const runs = AppDataSource.getRepository(Run);
        const findOneBy = runs.findOneBy.bind(runs);
        let failed = false;
        t.mock.method(runs, "findOneBy", async (...args: Parameters<typeof runs.findOneBy>) => {
          if (!failed) {
            failed = true;
            throw new Error("The Run storage is temporarily unavailable.");
          }
          return findOneBy(...args);
        });
      };
    }
    if (timedOut) {
      const runs = AppDataSource.getRepository(Run);
      const update = runs.update.bind(runs);
      t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
        if (args[1].status === "running" && args[1].queueOptionsJson)
          await new Promise((resolve) => setTimeout(resolve, 1_100));
        return update(...args);
      });
    }
    const run = await (await startRoutineRun(routine)).completion;
    assert.equal(run.status, "error");
    assert.equal(run.errorKind, timedOut ? "timeout" : "runtime");
    assert.equal(readRunDiagnostics(run).failure?.category, timedOut ? "timeout" : "application");
    if (timedOut) assert.match(readRunDiagnostics(run).failure?.message ?? "", /time budget/);
    assert.equal(await AppDataSource.getRepository(JournalEntry).countBy({ runId: run.id }), 1);
    assert.ok(
      (await AppDataSource.getRepository(AutonomyWaiver).findOneByOrFail({ id: waiver.id }))
        .revokedAt,
    );
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }))
        .requiresApproval,
      true,
    );
  }
});
