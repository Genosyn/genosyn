import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Logger } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { initTestDb, resetTestDb } from "../test/dbHarness.js";
import { findInFlightRun } from "./cron.js";
import { getEmployeeWorkQueue } from "./employeeWorkQueue.js";
import { getRoutineActivity } from "./routineActivity.js";
import { findAcceptedManualRoutineRun } from "./routineManualStart.js";
import { releaseOrphanedQueueSlots } from "./routineQueue.js";
import { claimedRuns, companyRunQueue, queuedRunsInStartOrder } from "./routineQueueOrder.js";
import { assertManualResumeSource } from "./runManualResume.js";
import { claimRetryDispatch } from "./runRecovery.js";
import { refreshStanddowns } from "./standdowns.js";
import { getSystemHealthReport, getSystemHealthSummary } from "./systemHealth.js";

/**
 * The Routine queue's reads stay bounded on a large `runs` table.
 *
 * `runs` is the largest table in the App, every row carries its transcript
 * before most of its columns, and SQLite runs each statement on the event loop
 * (AGENTS.md §7) — the same loop that relays every Run's model replies and
 * tool calls. Here it holds 28,000 Runs of 140 Routines, almost all finished,
 * with real planner statistics. Each read must reach only live work through an
 * index: never a scan of `runs`, never a walk of a Routine's whole history.
 * Before, the heartbeat's claim sweep scanned the entire table every 30
 * seconds — over two seconds on a 1.5 GB install — and the control case shows
 * the planner still does that for the old shape.
 */

type Plan = { sql: string; steps: string[] };

let routineHistoryIndex = "";
let claimIndex = "";
let retryIndex = "";

/** Run `work`, then explain every statement it sent against `runs`. */
async function plansOf(work: () => Promise<unknown>): Promise<Plan[]> {
  return (await traced(work)).plans;
}

/** {@link plansOf}, keeping what `work` returned. */
async function traced<T>(work: () => Promise<T>): Promise<{ plans: Plan[]; result: T }> {
  const sent: { sql: string; params: unknown[] }[] = [];
  const capture: Logger = {
    logQuery: (sql, params) => void sent.push({ sql, params: params ?? [] }),
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };
  const original = AppDataSource.logger;
  Object.assign(AppDataSource, { logger: capture });
  let result: T;
  try {
    result = await work();
  } finally {
    Object.assign(AppDataSource, { logger: original });
  }
  const plans: Plan[] = [];
  for (const { sql, params } of sent) {
    if (!/^\s*SELECT/i.test(sql) || !/"runs"/.test(sql)) continue;
    const rows = (await AppDataSource.query(`EXPLAIN QUERY PLAN ${sql}`, params)) as {
      detail: string;
    }[];
    plans.push({ sql, steps: rows.map((row) => row.detail) });
  }
  return { plans, result };
}

/** Fails when a plan reads `runs` without an index bounding it to live work. */
function assertBounded(plans: Plan[], label: string) {
  assert.ok(plans.length > 0, `${label} read no Runs at all`);
  for (const plan of plans) {
    for (const step of plan.steps) {
      assert.doesNotMatch(step, /^SCAN (run|Run|runs)\b/, `${label} scans runs:\n${plan.sql}`);
      assert.ok(
        !step.includes(routineHistoryIndex),
        `${label} walks Routine history (${step}):\n${plan.sql}`,
      );
    }
  }
}

/** Fails unless every read of `runs` that tests a claim goes through the claim's own index. */
function assertClaimIndexed(plans: Plan[], label: string) {
  const claimReads = plans.filter((plan) =>
    /\bWHERE\b[\s\S]*"queueActiveEmployeeId"/.test(plan.sql),
  );
  assert.ok(claimReads.length > 0, `${label} tested no claim`);
  for (const plan of claimReads) {
    assert.ok(
      plan.steps.some((step) => step.includes(claimIndex)),
      `${label} tests a claim without its index (${plan.steps.join("; ")}):\n${plan.sql}`,
    );
  }
}

/**
 * The reads of `runs` that look for a Run owed a follow-up, in either shape:
 * the `retryAt` range, or the `NOT (… IS NULL)` it replaced.
 */
function followUpReads(plans: Plan[]): Plan[] {
  return plans.filter((plan) => /"retryAt" >|NOT\s*\("\w+"\."retryAt" IS NULL\)/.test(plan.sql));
}

/** Fails unless every read of `runs` that looks for a follow-up goes through the `retryAt` index. */
function assertRetryIndexed(plans: Plan[], label: string) {
  const reads = followUpReads(plans);
  assert.ok(reads.length > 0, `${label} looked for no follow-up`);
  for (const plan of reads) {
    assert.ok(
      plan.steps.some((step) => step.includes(retryIndex)),
      `${label} looks for a follow-up without its index (${plan.steps.join("; ")}):\n${plan.sql}`,
    );
  }
}

describe("Routine queue reads on a large Run history", () => {
  before(async () => {
    await initTestDb();
    await resetTestDb();
    // One company of 12 AI Employees and 120 Routines, plus two small ones;
    // 200 finished Runs per Routine (one in twenty a retry or continuation of
    // the one before), a few waiting, running and claimed, and two owed a
    // retry: one due, one being dispatched.
    await AppDataSource.query(`
      INSERT INTO companies (id, name, slug, ownerId) VALUES
        ('c1', 'OneUptime', 'oneuptime', 'u1'), ('c2', 'Other', 'other', 'u1'),
        ('c3', 'Third', 'third', 'u1')`);
    await AppDataSource.query(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 14)
      INSERT INTO ai_employees (id, companyId, name, slug, role)
      SELECT 'e' || i, CASE WHEN i <= 12 THEN 'c1' WHEN i = 13 THEN 'c2' ELSE 'c3' END,
        'Emp ' || i, 'emp-' || i, 'Ops'
      FROM n`);
    await AppDataSource.query(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 140)
      INSERT INTO routines (id, employeeId, name, slug, cronExpr, body, priority)
      SELECT 'r' || i, 'e' || (((i - 1) / 10) + 1), 'Routine ' || i, 'routine-' || i, '0 9 * * *',
        'Brief', CASE WHEN i % 9 = 0 THEN 'high' ELSE 'normal' END
      FROM n`);
    await AppDataSource.query(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 28000)
      INSERT INTO runs (id, routineId, employeeId, startedAt, finishedAt, status, createdAt,
        logContent, triggerKind, parentRunId)
      SELECT 'run' || i, 'r' || (((i - 1) % 140) + 1), 'e' || ((((i - 1) % 140) / 10) + 1),
        datetime('2026-04-01', '+' || (i / 150) || ' days'),
        datetime('2026-04-01', '+' || (i / 150) || ' days', '+30 minutes'),
        CASE WHEN i % 11 = 0 THEN 'error' WHEN i % 13 = 0 THEN 'failed'
          WHEN i % 17 = 0 THEN 'skipped' WHEN i % 19 = 0 THEN 'reviewed' ELSE 'completed' END,
        datetime('2026-04-01', '+' || (i / 150) || ' days'),
        'A transcript.', 'schedule',
        CASE WHEN i % 20 = 0 THEN 'run' || (i - 140) END
      FROM n`);
    await AppDataSource.query(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
      INSERT INTO runs (id, routineId, employeeId, startedAt, status, createdAt, logContent,
        triggerKind, pauseCount)
      SELECT 'q' || i, 'r' || (i * 4), 'e' || ((((i * 4) - 1) / 10) + 1),
        datetime('2026-10-22', '+' || i || ' hours'), 'queued',
        datetime('2026-10-22', '+' || i || ' hours'), '', 'schedule', CASE WHEN i = 7 THEN 1 ELSE 0 END
      FROM n`);
    await AppDataSource.query(`
      INSERT INTO runs (id, routineId, employeeId, startedAt, status, createdAt, logContent,
        triggerKind, queueActiveEmployeeId, retryAt)
      VALUES
        ('w1', 'r1', 'e1', '2026-10-23 08:00:00.000', 'running', '2026-10-23 08:00:00.000', '', 'schedule', 'run:w1:a', NULL),
        ('w2', 'r11', 'e2', '2026-10-23 08:00:00.000', 'running', '2026-10-23 08:00:00.000', '', 'schedule', 'run:w2:a', NULL),
        ('w3', 'r21', 'e3', '2026-10-23 07:00:00.000', 'completed', '2026-10-23 07:00:00.000', '', 'schedule', 'run:w3:a', NULL),
        ('f1', 'r2', 'e1', '2026-10-23 06:00:00.000', 'error', '2026-10-23 06:00:00.000', '', 'schedule', NULL, '2026-10-23 13:00:00.000'),
        ('f2', 'r35', 'e4', '2026-10-23 06:00:00.000', 'error', '2026-10-23 06:00:00.000', '', 'schedule', NULL, '2026-10-23 13:00:00.000')`);
    // The scheduler swaps a retry's due time for its dispatch claim, a date
    // in the 1900s, while it starts the retry.
    assert.ok(
      await claimRetryDispatch(
        "f2",
        new Date("2026-10-23T13:00:00Z"),
        new Date("2026-10-23T13:00:05Z"),
      ),
    );
    await AppDataSource.query("ANALYZE");
    const [index] = (await AppDataSource.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'
        AND sql LIKE '%("routineId", "startedAt")%'`,
    )) as { name: string }[];
    routineHistoryIndex = index.name;
    const [claim] = (await AppDataSource.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'
        AND sql LIKE '%("queueActiveEmployeeId")%'`,
    )) as { name: string }[];
    claimIndex = claim.name;
    const [retry] = (await AppDataSource.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'
        AND sql LIKE '%("retryAt")%'`,
    )) as { name: string }[];
    retryIndex = retry.name;
    await refreshStanddowns();
  });

  test("the old claim reads scan the table or walk a Routine's history", async () => {
    // TypeORM writes `Not(IsNull())` as `NOT (… IS NULL)`, which no index
    // answers: the heartbeat's sweep read every Run, past its transcript, to
    // find the few holding a claim, and a claim's sibling check read every Run
    // the Routine ever had.
    const sweep = (await AppDataSource.query(
      `EXPLAIN QUERY PLAN SELECT id FROM runs WHERE NOT ("queueActiveEmployeeId" IS NULL)`,
    )) as { detail: string }[];
    assert.ok(
      sweep.some((step) => /^SCAN runs\b/.test(step.detail)),
      `the old sweep no longer scans: ${JSON.stringify(sweep)}`,
    );
    const sibling = (await AppDataSource.query(
      `EXPLAIN QUERY PLAN SELECT 1 FROM runs WHERE "routineId" = 'r5' AND "id" <> 'q1'
         AND NOT ("queueActiveEmployeeId" IS NULL) LIMIT 1`,
    )) as { detail: string }[];
    assert.ok(
      sibling.some((step) => step.detail.includes(routineHistoryIndex)),
      `the old sibling check no longer walks history: ${JSON.stringify(sibling)}`,
    );
  });

  test("the old follow-up reads scan the table or walk a Routine's history", async () => {
    // `retryAt` had the same `NOT (… IS NULL)`: a manual resume read every Run
    // its Routine ever had, and System Health read every Run in the table,
    // past its transcript, to count the few owed a retry.
    const resume = (await AppDataSource.query(
      `EXPLAIN QUERY PLAN SELECT 1 FROM runs WHERE "routineId" = 'r2'
         AND NOT ("retryAt" IS NULL) LIMIT 1`,
    )) as { detail: string }[];
    assert.ok(
      resume.some((step) => step.detail.includes(routineHistoryIndex)),
      `the old resume check no longer walks history: ${JSON.stringify(resume)}`,
    );
    const routineIds = Array.from({ length: 120 }, (_, i) => `r${i + 1}`);
    const health = (await AppDataSource.query(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM runs
         WHERE "routineId" IN (${routineIds.map(() => "?").join(", ")})
         AND NOT ("retryAt" IS NULL)`,
      routineIds,
    )) as { detail: string }[];
    assert.ok(
      health.some((step) => /^SCAN runs\b/.test(step.detail)),
      `the old System Health count no longer scans: ${JSON.stringify(health)}`,
    );
  });

  test("the dispatcher's read is bounded to waiting Runs", async () => {
    const { plans, result: read } = await traced(() => queuedRunsInStartOrder());
    assertBounded(plans, "queuedRunsInStartOrder");
    assert.equal(read.length, 30);
    assert.equal(read[0].id, "q7", "the paused Run is first in line");
  });

  test("a company's queue is read through each employee's waiting Runs", async () => {
    const { plans, result: line } = await traced(() => companyRunQueue("c1"));
    assertBounded(plans, "companyRunQueue");
    assert.equal(line.length, 30, "every waiting Run of c1's employees");
  });

  test("the claim reads go through the claim index", async () => {
    assertBounded(await plansOf(() => claimedRuns()), "claimedRuns");
    assertBounded(
      await plansOf(() => releaseOrphanedQueueSlots(false, new Date("2026-10-23T09:00:00Z"))),
      "releaseOrphanedQueueSlots",
    );
  });

  test("an AI Employee's day reads only its live and waiting work", async () => {
    const { plans, result: queue } = await traced(() => getEmployeeWorkQueue("c1", "e1"));
    assertBounded(plans, "getEmployeeWorkQueue");
    assert.ok(queue);
    assert.deepEqual(
      queue.running.map((item) => item.runId),
      ["w1"],
    );
    assert.equal(
      queue.pending.at(-1)?.id,
      "follow-up:f1",
      "the owed retry is listed after the queue",
    );
  });

  test("the Running page's running and queued sections are bounded", async () => {
    const plans = await plansOf(() =>
      getRoutineActivity({
        companyId: "c1",
        from: new Date("2026-10-23T00:00:00Z"),
        to: new Date("2026-10-24T00:00:00Z"),
      }),
    );
    // "Ran today" counts a calendar day of history per Routine and the
    // follow-up lookup reads by parent; both are outside the queue.
    const queueReads = plans.filter(
      (plan) => !/COUNT\(\*\)/.test(plan.sql) && !/followUp/i.test(plan.sql),
    );
    assertBounded(queueReads, "getRoutineActivity running and queued");
  });

  // Each Routine-scoped claim check below wrote `Not(IsNull())`, the shape the
  // control case above shows walking the Routine's history.

  test("a retry's in-flight check reads the Routine's live Runs, not its history", async () => {
    const now = new Date("2026-10-23T09:00:00Z");
    const expected = [
      ["r1", "w1"],
      ["r21", "w3"],
      ["r5", undefined],
    ] as const;
    for (const [routineId, runId] of expected) {
      const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routineId });
      const { plans, result } = await traced(() => findInFlightRun(routine, now));
      const label = `findInFlightRun(${routineId})`;
      assertClaimIndexed(plans, label);
      // Its other half asks for a Run started since the Routine's timeout
      // began, which the history index bounds as well as the status one.
      for (const plan of plans) {
        for (const step of plan.steps) {
          assert.doesNotMatch(step, /^SCAN (run|Run|runs)\b/, `${label} scans runs:\n${plan.sql}`);
          if (step.includes(routineHistoryIndex)) {
            assert.match(step, /\(routineId=\? AND startedAt>\?\)/, `${label} walks history`);
          }
        }
      }
      assert.equal(result?.id, runId, routineId);
    }
  });

  test("a manual start finds the work it already accepted without walking history", async () => {
    const expected = [
      ["r21", "w3"],
      ["r4", "q1"],
      ["r5", undefined],
    ] as const;
    for (const [routineId, runId] of expected) {
      const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routineId });
      const { plans, result } = await traced(() => findAcceptedManualRoutineRun(routine, "c1"));
      assertBounded(plans, `findAcceptedManualRoutineRun(${routineId})`);
      assertClaimIndexed(plans, `findAcceptedManualRoutineRun(${routineId})`);
      assert.equal(result?.id, runId, routineId);
    }
  });

  test("a manual resume waits for a claimed Run without walking history", async () => {
    // r21's failed Run left unfinished work, but w3 still holds its claim.
    await AppDataSource.query(`
      INSERT INTO runs (id, routineId, employeeId, startedAt, finishedAt, status, createdAt,
        logContent, triggerKind, checkpointJson)
      VALUES ('resume1', 'r21', 'e3', '2026-10-23 05:00:00.000', '2026-10-23 05:30:00.000',
        'failed', '2026-10-23 05:00:00.000', '', 'schedule',
        '{"state":"continue","completed":"Half the list.","remaining":"The other half.","resume":"Start at the second half.","progressKey":"list"}')`);
    const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: "r21" });
    const run = await AppDataSource.getRepository(Run).findOneByOrFail({ id: "resume1" });
    const { plans, result } = await traced(() =>
      assertManualResumeSource(run, routine).then(
        () => "resumable",
        (error: Error) => error.message,
      ),
    );
    assert.equal(result, "Wait for this Routine's earlier Run cleanup to finish.");
    assertBounded(plans, "assertManualResumeSource");
    assertClaimIndexed(plans, "assertManualResumeSource");
  });

  // The follow-up checks below wrote `Not(IsNull())` on `retryAt`, the shape
  // the control case above shows walking history. `anyRetryAt()` starts in
  // 1900, so it also finds f2, whose `retryAt` holds a dispatch claim.

  test("a manual resume waits for an owed follow-up without walking history", async () => {
    // r2's f1 is due a retry and r35's f2 is being dispatched; unfinished work
    // on either Routine waits for it.
    for (const [routineId, employeeId] of [
      ["r2", "e1"],
      ["r35", "e4"],
    ] as const) {
      const id = `resume-${routineId}`;
      await AppDataSource.query(
        `INSERT INTO runs (id, routineId, employeeId, startedAt, finishedAt, status, createdAt,
          logContent, triggerKind, checkpointJson)
        VALUES (?, ?, ?, '2026-10-23 05:00:00.000', '2026-10-23 05:30:00.000', 'failed',
          '2026-10-23 05:00:00.000', '', 'schedule',
          '{"state":"continue","completed":"Half the list.","remaining":"The other half.","resume":"Start at the second half.","progressKey":"list"}')`,
        [id, routineId, employeeId],
      );
      const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routineId });
      const run = await AppDataSource.getRepository(Run).findOneByOrFail({ id });
      const { plans, result } = await traced(() =>
        assertManualResumeSource(run, routine).then(
          () => "resumable",
          (error: Error) => error.message,
        ),
      );
      const label = `assertManualResumeSource(${routineId})`;
      assert.equal(result, "This Routine already has a follow-up queued or starting.", label);
      assertBounded(plans, label);
      assertRetryIndexed(plans, label);
    }
  });

  test("System Health counts the Runs owed a follow-up without walking history", async () => {
    // Its other reads are windowed by `startedAt`; only the retry reads are
    // held to the `retryAt` index.
    const { plans, result: report } = await traced(() => getSystemHealthReport("c1"));
    assertBounded(followUpReads(plans), "getSystemHealthReport");
    assertRetryIndexed(plans, "getSystemHealthReport");
    const retries = report.checks.find((check) => check.id === "pending_retries");
    assert.ok(retries);
    assert.equal(retries.count, 2);
    assert.deepEqual(
      retries.items.map((item) => item.label),
      ["Routine 35", "Routine 2"],
      "the retry being dispatched sorts first, by its claim",
    );

    // The Home card asks for the count alone.
    const { plans: countPlans, result: summary } = await traced(() => getSystemHealthSummary("c1"));
    assertBounded(followUpReads(countPlans), "getSystemHealthSummary");
    assertRetryIndexed(countPlans, "getSystemHealthSummary");
    assert.equal(summary.checks.find((check) => check.id === "pending_retries")?.count, 2);
  });
});
