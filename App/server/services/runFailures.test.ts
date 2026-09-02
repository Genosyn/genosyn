import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Routine } from "../db/entities/Routine.js";
import { Run, RunStatus } from "../db/entities/Run.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { findLiveRunFailures } from "./runFailures.js";

/**
 * The shared filter behind the Home "Failed routines" panel and the System
 * Health probe. What it leaves out is the whole point of it, so each exclusion
 * gets its own case.
 */

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const HOUR = 60 * 60 * 1000;
let routine: Routine;
let other: Routine;

beforeEach(async () => {
  const employeeId = testId("emp");
  routine = await insert(Routine, {
    employeeId,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "",
  });
  other = await insert(Routine, {
    employeeId,
    name: "Inbox sweep",
    slug: "inbox-sweep",
    cronExpr: "0 * * * *",
    body: "",
  });
});

function run(
  r: Routine,
  status: RunStatus,
  hoursAgo: number,
  overrides: Partial<Run> = {},
): Promise<Run> {
  return insert(Run, {
    routineId: r.id,
    status,
    logContent: "",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - hoursAgo * HOUR),
    ...overrides,
  });
}

async function live(take = 10) {
  return findLiveRunFailures({
    routineIds: [routine.id, other.id],
    since: new Date(Date.now() - 24 * HOUR),
    take,
  });
}

describe("findLiveRunFailures", () => {
  test("returns failures in the window, newest first, with the true total", async () => {
    await run(routine, "failed", 3);
    await run(routine, "timeout", 2);
    await run(other, "interrupted", 1);
    await run(other, "completed", 4);
    await run(routine, "failed", 30); // outside the 24h window

    const { rows, count } = await live();
    assert.equal(count, 3);
    assert.deepEqual(
      rows.map((r) => r.status),
      ["interrupted", "timeout", "failed"],
    );
  });

  test("drops a failure the routine's next run already fixed", async () => {
    const stale = await run(routine, "failed", 5);
    await run(routine, "completed", 2);
    const current = await run(other, "failed", 5);

    const { rows, count } = await live();
    assert.equal(count, 1);
    assert.deepEqual(
      rows.map((r) => r.id),
      [current.id],
    );
    assert.ok(!rows.some((r) => r.id === stale.id));
  });

  test("keeps a failure whose routine only succeeded before it", async () => {
    await run(routine, "completed", 6);
    const failure = await run(routine, "failed", 3);

    const { rows } = await live();
    assert.deepEqual(
      rows.map((r) => r.id),
      [failure.id],
    );
  });

  test("a later success on a different routine does not clear this one", async () => {
    const failure = await run(routine, "failed", 5);
    await run(other, "completed", 1);

    const { rows } = await live();
    assert.deepEqual(
      rows.map((r) => r.id),
      [failure.id],
    );
  });

  test("a later run that failed again does not clear the earlier one", async () => {
    await run(routine, "failed", 5);
    await run(routine, "failed", 1);

    const { count } = await live();
    assert.equal(count, 2);
  });

  test("skips dismissed rows and rows still owed a retry", async () => {
    await run(routine, "failed", 5, { dismissedAt: new Date() });
    await run(other, "failed", 5, { retryAt: new Date(Date.now() + HOUR) });

    const { rows, count } = await live();
    assert.equal(count, 0);
    assert.deepEqual(rows, []);
  });

  test("counts past the page it returns, and counts without fetching when asked", async () => {
    for (let n = 0; n < 4; n += 1) await run(routine, "failed", n + 1);

    const paged = await live(2);
    assert.equal(paged.rows.length, 2);
    assert.equal(paged.count, 4);

    const countOnly = await live(0);
    assert.deepEqual(countOnly.rows, []);
    assert.equal(countOnly.count, 4);
  });

  test("is empty when the company owns no routines", async () => {
    await run(routine, "failed", 1);
    const empty = await findLiveRunFailures({
      routineIds: [],
      since: new Date(Date.now() - 24 * HOUR),
      take: 10,
    });
    assert.deepEqual(empty, { rows: [], count: 0 });
  });
});
