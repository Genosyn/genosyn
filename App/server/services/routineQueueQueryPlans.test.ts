import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Logger } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { initTestDb, resetTestDb } from "../test/dbHarness.js";
import { getEmployeeWorkQueue } from "./employeeWorkQueue.js";
import { getRoutineActivity } from "./routineActivity.js";
import { releaseOrphanedQueueSlots } from "./routineQueue.js";
import { claimedRuns, companyRunQueue, queuedRunsInStartOrder } from "./routineQueueOrder.js";
import { refreshStanddowns } from "./standdowns.js";

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

/** Run `work`, then explain every statement it sent against `runs`. */
async function plansOf(work: () => Promise<unknown>): Promise<Plan[]> {
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
  try {
    await work();
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
  return plans;
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

describe("Routine queue reads on a large Run history", () => {
  before(async () => {
    await initTestDb();
    await resetTestDb();
    // One company of 12 AI Employees and 120 Routines, plus two small ones;
    // 200 finished Runs per Routine (one in twenty a retry or continuation of
    // the one before), and a few waiting, running and claimed.
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
        ('f1', 'r2', 'e1', '2026-10-23 06:00:00.000', 'error', '2026-10-23 06:00:00.000', '', 'schedule', NULL, '2026-10-23 13:00:00.000')`);
    await AppDataSource.query("ANALYZE");
    const [index] = (await AppDataSource.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'
        AND sql LIKE '%("routineId", "startedAt")%'`,
    )) as { name: string }[];
    routineHistoryIndex = index.name;
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

  test("the dispatcher's read is bounded to waiting Runs", async () => {
    let read: Awaited<ReturnType<typeof queuedRunsInStartOrder>> = [];
    const plans = await plansOf(async () => {
      read = await queuedRunsInStartOrder();
    });
    assertBounded(plans, "queuedRunsInStartOrder");
    assert.equal(read.length, 30);
    assert.equal(read[0].id, "q7", "the paused Run is first in line");
  });

  test("a company's queue is read through each employee's waiting Runs", async () => {
    let line: Awaited<ReturnType<typeof companyRunQueue>> = [];
    const plans = await plansOf(async () => {
      line = await companyRunQueue("c1");
    });
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
    let queue: Awaited<ReturnType<typeof getEmployeeWorkQueue>> = null;
    const plans = await plansOf(async () => {
      queue = await getEmployeeWorkQueue("c1", "e1");
    });
    assertBounded(plans, "getEmployeeWorkQueue");
    assert.ok(queue);
    const read = queue as NonNullable<typeof queue>;
    assert.deepEqual(
      read.running.map((item) => item.runId),
      ["w1"],
    );
    assert.equal(read.pending.at(-1)?.id, "follow-up:f1", "the owed retry is listed after the queue");
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
});
