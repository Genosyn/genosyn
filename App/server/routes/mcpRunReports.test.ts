import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineCheck } from "../db/entities/RoutineCheck.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { RESIDENT_GENOSYN_TOOLS } from "../services/agent/tools/index.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS } from "../services/agent/tools/toolIndex.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * M58's evidence tools.
 *
 * Before these there was no run-reading tool in the product at all: an AI
 * Employee could write a Routine, edit its brief and delete it, and could not
 * look at one thing any of its Runs had done. A manager briefed that one of its
 * Routines had been stood down could read the schedule that caused the
 * standdown and nothing about the failures behind it.
 *
 * So what these tests hold is narrow and load-bearing: the record is readable,
 * it is company-scoped through the Routine exactly as `get_routine` is, and it
 * stays out of the resident working set — the tools are for the turn that goes
 * looking, not a tax on every turn that does not.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let colleague: AIEmployee;
let routine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  effectClock = 0;
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `run-reports-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Collections",
    soulBody: "",
  });
  colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Robin",
    slug: "robin",
    role: "Support",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Chase overdue invoices",
    slug: "chase-overdue-invoices",
    cronExpr: "0 9 * * *",
    body: "Chase every invoice past due.",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Minutes-apart start times so "newest first" is unambiguous on any clock. */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function addRun(params: {
  routineId?: string;
  startedAgoMinutes: number;
  status?: Run["status"];
  checksVerdict?: Run["checksVerdict"];
  outcomeVerdict?: Run["outcomeVerdict"];
  outcomeNote?: string | null;
  attempt?: number;
  tokensIn?: number;
  tokensOut?: number;
  checkRemediations?: number;
}): Promise<Run> {
  const startedAt = minutesAgo(params.startedAgoMinutes);
  return insert(Run, {
    routineId: params.routineId ?? routine.id,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 30_000),
    status: params.status ?? "completed",
    logContent: "",
    exitCode: 0,
    checksVerdict: params.checksVerdict ?? null,
    outcomeVerdict: params.outcomeVerdict ?? null,
    outcomeNote: params.outcomeNote ?? null,
    attempt: params.attempt ?? 1,
    tokensIn: params.tokensIn ?? 0,
    tokensOut: params.tokensOut ?? 0,
    checkRemediations: params.checkRemediations ?? 0,
  });
}

async function addCheckResult(params: {
  runId: string;
  name: string;
  passed: boolean;
  attempt: number;
  detail?: string;
  required?: boolean;
}): Promise<RunCheckResult> {
  return insert(RunCheckResult, {
    companyId: company.id,
    runId: params.runId,
    checkId: null,
    name: params.name,
    kind: "effect",
    required: params.required ?? true,
    passed: params.passed,
    exitCode: null,
    detail: params.detail ?? "",
    durationMs: 5,
    attempt: params.attempt,
  });
}

/**
 * The stamp is explicit because the column's SQLite default is whole seconds:
 * fixtures that let the database fill it in all tie, and an ordering assertion
 * over ties passes or fails on uuid luck. Production writes go through
 * `recordAudit`, which stamps milliseconds for this reason — see
 * `services/runEffects.ts`.
 */
let effectClock = 0;
async function addEffect(params: {
  runId: string;
  action: string;
  targetLabel: string;
}): Promise<AuditEvent> {
  effectClock += 1;
  return insert(AuditEvent, {
    companyId: company.id,
    actorKind: "ai",
    actorEmployeeId: employee.id,
    runId: params.runId,
    action: params.action,
    targetType: "invoice",
    targetId: randomUUID(),
    targetLabel: params.targetLabel,
    metadataJson: "",
    createdAt: new Date(Date.UTC(2026, 0, 1) + effectClock * 1000),
  });
}

/** Set up a second company with its own employee, routine and Run. */
async function foreignRun(): Promise<{ routine: Routine; run: Run }> {
  const otherOwner = await insert(User, {
    email: "rival@example.test",
    name: "Rival",
    passwordHash: "x",
  });
  const otherCo = await insert(Company, {
    name: "Rival",
    slug: `rival-${randomUUID()}`,
    ownerId: otherOwner.id,
  });
  const outsider = await insert(AIEmployee, {
    companyId: otherCo.id,
    name: "Sam",
    slug: "sam",
    role: "Ops",
    soulBody: "",
  });
  const theirRoutine = await insert(Routine, {
    employeeId: outsider.id,
    name: "Their digest",
    slug: "their-digest",
    cronExpr: "0 8 * * *",
    body: "",
  });
  const theirRun = await addRun({ routineId: theirRoutine.id, startedAgoMinutes: 1 });
  await insert(RunCheckResult, {
    companyId: otherCo.id,
    runId: theirRun.id,
    checkId: null,
    name: "Their check",
    kind: "effect",
    required: true,
    passed: true,
    exitCode: null,
    detail: "secret",
    durationMs: 1,
    attempt: 0,
  });
  return { routine: theirRoutine, run: theirRun };
}

type RunRow = {
  id: string;
  routineId: string;
  routineName: string | null;
  status: string;
  checksVerdict: string | null;
  outcomeVerdict: string | null;
  outcomeNote: string | null;
  startedAt: string;
  finishedAt: string | null;
  attempt: number;
  tokensIn: number;
  tokensOut: number;
};

type RunReport = {
  run: RunRow & { checkRemediations: number };
  checks: {
    verdict: string | null;
    latest: Array<{ name: string; required: boolean; passed: boolean; detail: string }>;
    rounds: Array<{ name: string; passed: boolean; attempt: number }>;
  };
  effects: {
    rows: Array<{ action: string; targetLabel: string }>;
    total: number;
    truncated: boolean;
  };
};

describe("list_runs is the first way an employee can see what its schedule did", () => {
  test("one Routine's terminal Runs come back newest-first with the whole grading row", async () => {
    const older = await addRun({
      startedAgoMinutes: 60,
      checksVerdict: "failed",
      outcomeVerdict: "off_goal",
      outcomeNote: "Sent nothing.",
      attempt: 1,
      tokensIn: 900,
      tokensOut: 120,
    });
    const newer = await addRun({
      startedAgoMinutes: 5,
      checksVerdict: "passed",
      outcomeVerdict: "achieved",
      outcomeNote: "Eleven reminders went out.",
      attempt: 2,
      tokensIn: 1_100,
      tokensOut: 240,
    });
    // A Run still in flight has no verdicts written yet, so it is not evidence.
    await insert(Run, {
      routineId: routine.id,
      startedAt: minutesAgo(1),
      finishedAt: null,
      status: "running",
      logContent: "",
      exitCode: null,
    });

    const { status, body } = await tool<{ runs: RunRow[] }>("list_runs", {
      routine: routine.slug,
    });
    assert.equal(status, 200);
    assert.deepEqual(
      body.runs.map((r) => r.id),
      [newer.id, older.id],
      "terminal Runs must come back newest-first, and the running one must not appear",
    );

    const [first, second] = body.runs;
    assert.equal(first.routineName, routine.name);
    assert.equal(first.status, "completed");
    assert.equal(first.checksVerdict, "passed");
    assert.equal(first.outcomeVerdict, "achieved");
    assert.match(first.outcomeNote ?? "", /Eleven reminders/);
    assert.equal(first.attempt, 2);
    assert.equal(first.tokensIn, 1_100);
    assert.equal(first.tokensOut, 240);
    assert.ok(first.startedAt, "startedAt is what orders the history");
    assert.ok(first.finishedAt, "finishedAt is what says the Run stopped");
    assert.equal(second.checksVerdict, "failed");
    assert.equal(second.outcomeVerdict, "off_goal");
  });

  test("the limit is respected, and it takes the newest rows rather than the first", async () => {
    for (let i = 0; i < 6; i++) {
      await addRun({ startedAgoMinutes: (i + 1) * 10 });
    }
    const { body } = await tool<{ runs: RunRow[] }>("list_runs", {
      routine: routine.id,
      limit: 2,
    });
    assert.equal(body.runs.length, 2);
    const times = body.runs.map((r) => new Date(r.startedAt).getTime());
    assert.ok(times[0] > times[1], "the limited window must still be newest-first");
    const all = await tool<{ runs: RunRow[] }>("list_runs", { routine: routine.id });
    assert.equal(all.body.runs[0].id, body.runs[0].id, "the limit dropped the newest Run");
  });

  test("a limit outside the schema's range is refused rather than clamped silently", async () => {
    const { status } = await tool("list_runs", { routine: routine.id, limit: 500 });
    assert.equal(status, 400);
  });

  test("omitting the routine lists the caller's own Runs across its Routines", async () => {
    const second = await insert(Routine, {
      employeeId: employee.id,
      name: "Weekly report",
      slug: "weekly-report",
      cronExpr: "0 9 * * 1",
      body: "",
    });
    const theirs = await insert(Routine, {
      employeeId: colleague.id,
      name: "Support digest",
      slug: "support-digest",
      cronExpr: "0 9 * * *",
      body: "",
    });
    const mineA = await addRun({ startedAgoMinutes: 20 });
    const mineB = await addRun({ routineId: second.id, startedAgoMinutes: 10 });
    const notMine = await addRun({ routineId: theirs.id, startedAgoMinutes: 1 });

    const { status, body } = await tool<{ runs: RunRow[] }>("list_runs");
    assert.equal(status, 200);
    assert.deepEqual(
      body.runs.map((r) => r.id),
      [mineB.id, mineA.id],
      "the default listing is the caller's own Routines, newest first",
    );
    assert.equal(
      body.runs.some((r) => r.id === notMine.id),
      false,
      "a colleague's Run is not the caller's own history",
    );
    assert.deepEqual(
      body.runs.map((r) => r.routineName).sort(),
      ["Chase overdue invoices", "Weekly report"],
      "each row names the Routine it belongs to",
    );
  });

  test("an employee with no Routines is told so rather than shown an unexplained empty list", async () => {
    const emptyToken = issueMcpToken(colleague.id, company.id, { authority: "employee" });
    const previous = token;
    token = emptyToken;
    const { status, body } = await tool<{ runs: RunRow[]; note: string }>("list_runs");
    token = previous;
    revokeMcpToken(emptyToken);
    assert.equal(status, 200);
    assert.deepEqual(body.runs, []);
    assert.match(body.note, /no Routines/i);
  });
});

describe("get_run_report is the first time an employee can read what a Run did", () => {
  test("the check results and the effects come back for that Run", async () => {
    const run = await addRun({
      startedAgoMinutes: 10,
      checksVerdict: "passed",
      outcomeVerdict: "achieved",
      checkRemediations: 1,
    });
    // Round 0 failed, round 1 went green. Both rounds are kept: the record is
    // only honest if it says the Run needed a second try.
    await addCheckResult({
      runId: run.id,
      name: "A reminder was actually sent",
      passed: false,
      attempt: 0,
      detail: "expected at least 1 `mail.send`, the ledger has 0",
    });
    await addCheckResult({
      runId: run.id,
      name: "A reminder was actually sent",
      passed: true,
      attempt: 1,
      detail: "expected at least 1 `mail.send`, the ledger has 2",
    });
    await addEffect({ runId: run.id, action: "mail.send", targetLabel: "INV-1001" });
    await addEffect({ runId: run.id, action: "mail.send", targetLabel: "INV-1002" });

    const { status, body } = await tool<RunReport>("get_run_report", { runId: run.id });
    assert.equal(status, 200);
    assert.equal(body.run.id, run.id);
    assert.equal(body.run.routineName, routine.name);
    assert.equal(body.run.checkRemediations, 1);

    assert.equal(body.checks.verdict, "passed");
    assert.equal(body.checks.latest.length, 1, "the graded round is the newest one only");
    assert.equal(body.checks.latest[0].passed, true);
    assert.match(body.checks.latest[0].detail, /the ledger has 2/);
    assert.deepEqual(
      body.checks.rounds.map((r) => [r.attempt, r.passed]),
      [
        [0, false],
        [1, true],
      ],
      "the earlier remediation round must survive in the record",
    );

    assert.equal(body.effects.total, 2);
    assert.equal(body.effects.truncated, false);
    assert.deepEqual(
      body.effects.rows.map((e) => e.targetLabel),
      ["INV-1001", "INV-1002"],
      "effects are structured rows, oldest first — not rendered markdown",
    );
    assert.equal(body.effects.rows[0].action, "mail.send");
  });

  test("only that Run's evidence — a sibling Run's rows never bleed in", async () => {
    const first = await addRun({ startedAgoMinutes: 30 });
    const second = await addRun({ startedAgoMinutes: 5 });
    await addCheckResult({ runId: first.id, name: "First check", passed: true, attempt: 0 });
    await addCheckResult({ runId: second.id, name: "Second check", passed: false, attempt: 0 });
    await addEffect({ runId: first.id, action: "invoice.void", targetLabel: "INV-0001" });
    await addEffect({ runId: second.id, action: "mail.send", targetLabel: "INV-0002" });

    const { body } = await tool<RunReport>("get_run_report", { runId: second.id });
    assert.deepEqual(
      body.checks.rounds.map((r) => r.name),
      ["Second check"],
    );
    assert.deepEqual(
      body.effects.rows.map((e) => e.targetLabel),
      ["INV-0002"],
    );
    assert.equal(body.effects.total, 1);
  });

  test("a Run with no checks and no effects reports emptiness, not an error", async () => {
    const run = await addRun({ startedAgoMinutes: 3, checksVerdict: "not_run" });
    const { status, body } = await tool<RunReport>("get_run_report", { runId: run.id });
    assert.equal(status, 200);
    assert.equal(body.checks.verdict, "not_run");
    assert.deepEqual(body.checks.latest, []);
    assert.deepEqual(body.checks.rounds, []);
    assert.deepEqual(body.effects.rows, []);
    assert.equal(body.effects.total, 0);
  });

  test("an id that is not a Run at all is a plain 404", async () => {
    for (const handle of [randomUUID(), "not-a-uuid"]) {
      const { status } = await tool("get_run_report", { runId: handle });
      assert.equal(status, 404, `${handle} did not 404`);
    }
  });
});

describe("a read of the record is not a read of somebody else's record", () => {
  test("another company's Run and Routine are both unreachable", async () => {
    const foreign = await foreignRun();

    const report = await tool<{ error: string }>("get_run_report", { runId: foreign.run.id });
    assert.equal(report.status, 404, "a foreign Run leaked through get_run_report");
    assert.equal(
      JSON.stringify(report.body).includes("secret"),
      false,
      "the refusal must not carry the foreign Run's check detail",
    );

    for (const handle of [foreign.routine.id, foreign.routine.slug, foreign.routine.name]) {
      const listed = await tool("list_runs", { routine: handle });
      assert.equal(listed.status, 404, `${handle} leaked through list_runs`);
    }

    // And the caller's own default listing never widens to reach it either.
    const own = await tool<{ runs: RunRow[] }>("list_runs");
    assert.equal(
      own.body.runs.some((r) => r.id === foreign.run.id),
      false,
    );
  });
});

describe("a Routine tells its employee what bar it is graded against", () => {
  test("get_routine carries the Checks and the Goal it serves, and nothing writes them", async () => {
    const goalId = randomUUID();
    await AppDataSource.getRepository(Routine).update(routine.id, { goalId });
    await insert(RoutineCheck, {
      companyId: company.id,
      routineId: routine.id,
      name: "A reminder was actually sent",
      kind: "effect",
      spec: '{"action":"mail.send","atLeast":1}',
      required: true,
      enabled: true,
      timeoutSec: 120,
      position: 0,
      createdById: null,
    });

    const full = await tool<{
      routine: { goalId: string | null; checks: Array<Record<string, unknown>> };
    }>("get_routine", { routineId: routine.slug });
    assert.equal(full.status, 200);
    assert.equal(full.body.routine.goalId, goalId);
    assert.deepEqual(full.body.routine.checks, [
      { name: "A reminder was actually sent", kind: "effect", required: true },
    ]);
    assert.equal(
      "spec" in full.body.routine.checks[0],
      false,
      "the bar is named to the graded party, not handed to it",
    );

    const listed = await tool<{
      routines: Array<{ goalId: string | null; checks: Array<{ name: string }> }>;
    }>("list_routines");
    assert.equal(listed.body.routines[0].goalId, goalId);
    assert.deepEqual(
      listed.body.routines[0].checks.map((c) => c.name),
      ["A reminder was actually sent"],
    );

    // The load-bearing omission: no tool anywhere creates, edits, deletes or
    // reorders a Check. A bar the graded party can move is not a bar.
    const writers = STATIC_TOOLS.map((t) => t.name).filter((n) =>
      /^(create|update|delete|reorder|add)_(routine_)?check/.test(n),
    );
    assert.deepEqual(writers, [], "an AI Employee must never be able to move its own bar");
  });
});

describe("the evidence tools are published, deferred, and reachable", () => {
  test("both are in the manifest and neither is in the resident working set", () => {
    const byName = new Map(STATIC_TOOLS.map((t) => [t.name, t]));
    for (const name of ["list_runs", "get_run_report"]) {
      assert.ok(byName.has(name), `${name} is missing from the manifest`);
      assert.equal(
        (RESIDENT_GENOSYN_TOOLS as readonly string[]).includes(name),
        false,
        `${name} is resident — it would be paid for on every step of every Run`,
      );
    }
  });

  test("they sit in the runs domain with keywords for how they are actually asked for", () => {
    assert.deepEqual(TOOL_DOMAINS.runs.tools, ["list_runs", "get_run_report"]);
    assert.equal(TOOL_DOMAINS.runs.label, "runs");
    for (const phrase of ["run history", "did it work", "last run", "what happened"]) {
      assert.ok(TOOL_KEYWORDS.list_runs.includes(phrase), `list_runs lost "${phrase}"`);
    }
    for (const phrase of [
      "run evidence",
      "why did it fail",
      "check results",
      "what did it change",
    ]) {
      assert.ok(TOOL_KEYWORDS.get_run_report.includes(phrase), `get_run_report lost "${phrase}"`);
    }
  });
});
