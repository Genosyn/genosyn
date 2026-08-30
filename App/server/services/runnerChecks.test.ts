import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineCheck } from "../db/entities/RoutineCheck.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { SandboxCommandResult } from "./agent/sandboxCommandRun.js";
import { createCheck, runChecksForRun } from "./routineChecks.js";
import { startRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";

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

let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  upstream = createServer((request, response) => {
    void drain(request).then(() => {
      upstreamTurns += 1;
      sendCompletion(response, "I have done what was asked.");
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
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
  stopStanddowns();
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Consume the body; its content is not what these tests are about.
  }
}

function sendCompletion(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(
    `data: ${JSON.stringify({
      id: "check-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: "checks-test",
      choices: [
        { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

beforeEach(async () => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  upstreamTurns = 0;
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
    timeoutSec: 60,
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
    await effectCheck(routine.id, "switched off", { action: "invoice.send", min: 1 }, {
      enabled: false,
    });
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
    await effectCheck(routine.id, "advisory only", { action: "invoice.send", min: 1 }, {
      required: false,
    });
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
    const runCommand = async (options: {
      timeoutMs?: number;
    }): Promise<SandboxCommandResult> => {
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

    assert.equal(run.status, "completed");
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
  });

  test("a Run out of budget stops remediating instead of extending its own timeout", async () => {
    await connectModel();
    // Four seconds of wall clock, and the setup seam eats the first 1.5 — the
    // work turn still has room, but the first check round lands with far less
    // than the ten seconds `runCheckPhase` requires to brief a fix into.
    const routine = await makeRoutine({ timeoutSec: 4, retryOnTimeout: false });
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });

    const startedAt = Date.now();
    const started = await startRoutineRun(routine, {
      triggerKind: "schedule",
      beforeRunPersist: () => new Promise((resolve) => setTimeout(resolve, 1_500)),
    });
    const run = await started.completion;
    const elapsed = Date.now() - startedAt;

    assert.equal(run.status, "completed", "the Run itself must not have timed out");
    assert.equal(run.checksVerdict, "failed");
    assert.match(run.logContent, /no time left in this Run's budget for another attempt/);
    assert.doesNotMatch(
      run.logContent,
      /asking for a fix/,
      "a round with no time to work in must not start a turn certain to be aborted",
    );
    assert.ok(
      elapsed < 10_000,
      `remediation must not outlive the Run's own budget — took ${elapsed}ms`,
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
  test("checkRemediations counts only rounds that actually ran", async () => {
    await connectModel();
    const routine = await makeRoutine({ timeoutSec: 4, retryOnTimeout: false });
    await effectCheck(routine.id, "an invoice was sent", { action: "invoice.send", min: 1 });

    const started = await startRoutineRun(routine, {
      triggerKind: "schedule",
      beforeRunPersist: () => new Promise((resolve) => setTimeout(resolve, 1_500)),
    });
    const run = await started.completion;

    // Guards against passing for the wrong reason: a Run that timed out before
    // the check phase would also report zero remediations.
    assert.equal(run.status, "completed");
    assert.equal(run.checksVerdict, "failed");
    assert.doesNotMatch(run.logContent, /asking for a fix/);
    assert.equal(run.checkRemediations, 0, "no fix round was ever briefed");
  });
});
