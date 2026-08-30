import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { EmployeeAgentResult } from "./agent/runEmployee.js";
import type { RestrictedEmployeeAgentParams } from "./agent/runEmployee.js";
import {
  gradeAndPersistRunOutcome,
  latestCheckResultsForRun,
  sweepUngradedRuns,
} from "./runGrading.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "./runtimeSettings.js";

/**
 * M58's grading half: the one path both the runner and the re-grade sweep go
 * through, and the sweep that exists because the runner's path can die with
 * its process.
 *
 * The invariant every test here circles is that `outcomeCheckedAt` means
 * "somebody looked", not "somebody succeeded". A grader that leaves it null on
 * a failed provider call hands the sweep a row it will pick up again on the
 * next heartbeat, forever, spending a model turn each time — so the stamp has
 * to survive `unverified` exactly as it survives `achieved`.
 */

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  resetRuntimeSettingsCacheForTests();
});
afterEach(() => {
  resetRuntimeSettingsCacheForTests();
});
after(closeTestDb);

const NOW = new Date("2026-08-30T12:00:00.000Z");

async function fixture(routineValues: Partial<Routine> = {}) {
  const company = await insert(Company, {
    name: "Grading Co",
    slug: "grading-co",
    ownerId: "owner-grading",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Gale Grader",
    slug: "gale-grader",
    role: "Analyst",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Chase overdue invoices",
    slug: "chase-overdue-invoices",
    cronExpr: "0 9 * * *",
    acceptanceCriteria: "Every invoice over 30 days has been chased.",
    ...routineValues,
  });
  return { company, employee, routine };
}

async function completedRun(routineId: string, values: Partial<Run> = {}): Promise<Run> {
  return insert(Run, {
    routineId,
    startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    finishedAt: new Date(NOW.getTime() - 59 * 60 * 1000),
    status: "completed",
    exitCode: 0,
    logContent: "did the work\n",
    triggerKind: "schedule",
    attempt: 1,
    missedSlots: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...values,
  });
}

/** A model row is never dereferenced on the injected path; it is passed through. */
function stubModel(): AIModel {
  return {
    id: "model-stub",
    employeeId: "employee-stub",
    provider: "anthropic",
    model: "claude-stub",
    authMode: "apikey",
    isActive: true,
    configJson: "{}",
    connectedAt: null,
    contextWindow: null,
    contextWindowSource: null,
    createdAt: NOW,
  } as unknown as AIModel;
}

/**
 * A scripted verdict turn. Calls the submit tool the grader handed it, exactly
 * as a cooperating model would, and reports a fixed token charge so the test
 * can count how many turns were actually billed to the Run.
 */
function submitting(
  verdict: "achieved" | "unclear" | "off_goal",
  note: string,
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 100, outputTokens: 7 },
): (params: RestrictedEmployeeAgentParams) => Promise<EmployeeAgentResult> {
  return async (params) => {
    const tool = params.tools.find((t) => t.name === "submit_run_verdict");
    assert.ok(tool, "the grader must offer submit_run_verdict");
    params.callbacks?.onUsage?.(usage);
    await tool.run({ verdict, note });
    return { status: "ok", finalText: "done", steps: 1, stopReason: "end_turn" };
  };
}

/** A provider that is simply down — the case `unverified` exists for. */
const brokenProvider = async (): Promise<EmployeeAgentResult> => ({
  status: "error",
  error: "the provider returned 503",
});

describe("gradeAndPersistRunOutcome", () => {
  test("stamps outcomeCheckedAt for an ordinary verdict and charges the turn to the Run", async () => {
    const { employee, routine } = await fixture();
    const run = await completedRun(routine.id, { tokensIn: 500, tokensOut: 20 });

    const result = await gradeAndPersistRunOutcome({
      run,
      routine,
      employee,
      model: stubModel(),
      runRestricted: submitting("achieved", "Eleven invoices were chased."),
    });

    assert.deepEqual(result, {
      graded: true,
      verdict: "achieved",
      note: "Eleven invoices were chased.",
    });
    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(stored.outcomeVerdict, "achieved");
    assert.ok(stored.outcomeCheckedAt instanceof Date);
    assert.equal(stored.tokensIn, 600);
    assert.equal(stored.tokensOut, 27);
  });

  test("stamps outcomeCheckedAt for `unverified` too, so the sweep cannot loop on a broken provider", async () => {
    const { employee, routine } = await fixture();
    const run = await completedRun(routine.id);

    const result = await gradeAndPersistRunOutcome({
      run,
      routine,
      employee,
      model: stubModel(),
      runRestricted: brokenProvider,
    });

    assert.equal(result.graded, true);
    assert.equal(result.graded && result.verdict, "unverified");
    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(stored.outcomeVerdict, "unverified");
    assert.notEqual(
      stored.outcomeCheckedAt,
      null,
      "an unstamped unverified Run is re-graded on every heartbeat forever",
    );

    // And the sweep proves it: the row it just stamped is no longer a candidate.
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 0, regradePerPass: 10 },
    });
    await AppDataSource.getRepository(Run).update(
      { id: run.id },
      { finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
    );
    await sweepUngradedRuns(NOW);
    const after = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(after.outcomeVerdict, "unverified");
    assert.equal(
      after.outcomeNote,
      "The outcome check could not run: the provider returned 503",
    );
  });

  test("two concurrent graders produce exactly one verdict and one token charge", async () => {
    const { employee, routine } = await fixture();
    const run = await completedRun(routine.id);
    // Two grader calls, each holding its own copy of the row — which is what
    // the runner and the sweep actually have.
    const runner = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    const sweep = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });

    const [first, second] = await Promise.all([
      gradeAndPersistRunOutcome({
        run: runner,
        routine,
        employee,
        model: stubModel(),
        runRestricted: submitting("achieved", "First grader.", {
          inputTokens: 10,
          outputTokens: 1,
        }),
      }),
      gradeAndPersistRunOutcome({
        run: sweep,
        routine,
        employee,
        model: stubModel(),
        runRestricted: submitting("off_goal", "Second grader.", {
          inputTokens: 10,
          outputTokens: 1,
        }),
      }),
    ]);

    const graded = [first, second].filter((r) => r.graded);
    const refused = [first, second].filter((r) => !r.graded);
    assert.equal(graded.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(
      refused[0].graded === false && refused[0].reason,
      "another grader reached this run first",
    );

    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    // One charge, not two: the loser's turn is spent but must not be added on
    // top of the winner's, or the Run's cost would double under a race.
    assert.equal(stored.tokensIn, 10);
    assert.equal(stored.tokensOut, 1);
    assert.equal(stored.outcomeNote, graded[0].graded === true ? graded[0].note : null);
  });

  test("a Routine with no acceptance criteria is not graded at all", async () => {
    const { employee, routine } = await fixture({ acceptanceCriteria: "   " });
    const run = await completedRun(routine.id);
    let called = 0;

    const result = await gradeAndPersistRunOutcome({
      run,
      routine,
      employee,
      model: stubModel(),
      runRestricted: async () => {
        called += 1;
        return { status: "ok", finalText: "", steps: 1 };
      },
    });

    assert.deepEqual(result, {
      graded: false,
      reason: "the routine declares no acceptance criteria",
    });
    assert.equal(called, 0, "an ungradable Run must not spend a model turn");
    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(stored.outcomeCheckedAt, null);
    assert.equal(stored.outcomeVerdict, null);
  });

  test("re-reads the Routine, so criteria edited mid-Run are the bar it is graded against", async () => {
    const { employee, routine } = await fixture();
    const run = await completedRun(routine.id);
    // The caller's stale copy still has criteria; the row no longer does.
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { acceptanceCriteria: "" },
    );

    const result = await gradeAndPersistRunOutcome({
      run,
      routine,
      employee,
      model: stubModel(),
      runRestricted: submitting("achieved", "should never be reached"),
    });

    assert.equal(result.graded, false);
  });
});

describe("latestCheckResultsForRun", () => {
  test("returns only the newest attempt's rows", async () => {
    const { company, routine } = await fixture();
    const run = await completedRun(routine.id);
    await insert(RunCheckResult, {
      companyId: company.id,
      runId: run.id,
      name: "invoices chased",
      kind: "effect",
      required: true,
      passed: false,
      detail: "expected at least 1, the ledger has 0.",
      attempt: 0,
    });
    await insert(RunCheckResult, {
      companyId: company.id,
      runId: run.id,
      name: "invoices chased",
      kind: "effect",
      required: true,
      passed: true,
      detail: "expected at least 1, the ledger has 3.",
      attempt: 1,
    });

    const rows = await latestCheckResultsForRun(run.id, company.id);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].passed, true);
    assert.match(rows[0].detail, /has 3/);
  });

  test("does not read another company's rows for the same Run id", async () => {
    const { company, routine } = await fixture();
    const run = await completedRun(routine.id);
    await insert(RunCheckResult, {
      companyId: "some-other-company",
      runId: run.id,
      name: "not ours",
      kind: "effect",
      required: true,
      passed: true,
      detail: "",
      attempt: 0,
    });

    assert.deepEqual(await latestCheckResultsForRun(run.id, company.id), []);
  });

  test("is empty rather than throwing when nothing ran", async () => {
    const { company, routine } = await fixture();
    const run = await completedRun(routine.id);
    assert.deepEqual(await latestCheckResultsForRun(run.id, company.id), []);
  });
});

describe("sweepUngradedRuns", () => {
  /**
   * The sweep exposes no model seam, so every case below drives it through the
   * one branch it can reach without a provider: an employee with no AI Model,
   * which the sweep stamps `unverified` rather than re-scanning forever. That
   * stamp is the observable signal for "this Run was selected".
   */
  const NEVER_GRADED_NOTE =
    "Never graded: the employee has no AI model connected, so no outcome check could run.";

  async function selectedRunIds(): Promise<string[]> {
    const rows = await AppDataSource.getRepository(Run).find({
      where: { outcomeNote: NEVER_GRADED_NOTE },
    });
    return rows.map((r) => r.id).sort();
  }

  test("picks up a stale criteria-bearing Run and leaves a young one alone", async () => {
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 10, regradePerPass: 10 },
    });
    const { routine } = await fixture();
    const stale = await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 11 * 60 * 1000),
    });
    const young = await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 9 * 60 * 1000),
    });

    await sweepUngradedRuns(NOW);

    assert.deepEqual(await selectedRunIds(), [stale.id]);
    const untouched = await AppDataSource.getRepository(Run).findOneByOrFail({ id: young.id });
    assert.equal(untouched.outcomeCheckedAt, null);
    assert.equal(untouched.outcomeVerdict, null);
  });

  test("stamps the no-model case so it is never re-scanned", async () => {
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 10, regradePerPass: 10 },
    });
    const { routine } = await fixture();
    const run = await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    await sweepUngradedRuns(NOW);
    const stamped = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(stamped.outcomeVerdict, "unverified");
    assert.ok(stamped.outcomeCheckedAt instanceof Date);
    const firstStamp = stamped.outcomeCheckedAt.getTime();

    // A second pass must find nothing left to do.
    await sweepUngradedRuns(new Date(NOW.getTime() + 60 * 1000));
    const again = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(again.outcomeCheckedAt?.getTime(), firstStamp);
  });

  test("skips Runs whose Routine declares no criteria", async () => {
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 10, regradePerPass: 10 },
    });
    const { employee, routine } = await fixture();
    const graded = await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    const bare = await insert(Routine, {
      employeeId: employee.id,
      name: "No bar",
      slug: "no-bar",
      cronExpr: "0 9 * * *",
      acceptanceCriteria: "",
    });
    const ungraded = await completedRun(bare.id, {
      finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    await sweepUngradedRuns(NOW);

    assert.deepEqual(await selectedRunIds(), [graded.id]);
    const skipped = await AppDataSource.getRepository(Run).findOneByOrFail({ id: ungraded.id });
    assert.equal(skipped.outcomeCheckedAt, null);
  });

  test("only Runs that finished `completed` are candidates", async () => {
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 10, regradePerPass: 10 },
    });
    const { routine } = await fixture();
    const failed = await completedRun(routine.id, {
      status: "failed",
      exitCode: null,
      finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    await sweepUngradedRuns(NOW);

    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: failed.id });
    assert.equal(stored.outcomeCheckedAt, null);
    assert.equal(stored.outcomeVerdict, null);
  });

  test("respects regradePerPass, and picks the oldest first", async () => {
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 10, regradePerPass: 2 },
    });
    const { routine } = await fixture();
    const oldest = await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
    });
    const middle = await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
    });
    await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });

    await sweepUngradedRuns(NOW);

    assert.deepEqual(await selectedRunIds(), [oldest.id, middle.id].sort());
  });

  test("does nothing at all when regradePerPass is 0", async () => {
    overrideRuntimeSettingsForTests({
      containment: { regradeAfterMinutes: 10, regradePerPass: 0 },
    });
    const { routine } = await fixture();
    await completedRun(routine.id, {
      finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    await sweepUngradedRuns(NOW);

    assert.deepEqual(await selectedRunIds(), []);
  });
});
