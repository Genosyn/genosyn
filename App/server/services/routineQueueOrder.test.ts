import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Standdown } from "../db/entities/Standdown.js";
import {
  compareQueuedRuns,
  DEFAULT_ROUTINE_PRIORITY,
  HIGH_PRIORITY_HEAD_START_MS,
  isRoutinePriority,
  orderQueuedRuns,
  queueOrderTime,
  queueStage,
  ROUTINE_PRIORITIES,
  waitedIntoHighPriority,
  type QueuedRunOrderFields,
} from "../../shared/routinePriority.js";
import { initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { claimedRuns, companyRunQueue, queuedRunsInStartOrder } from "./routineQueueOrder.js";
import { refreshStanddowns } from "./standdowns.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR);

function entry(
  id: string,
  hoursAgo: number,
  values: Partial<QueuedRunOrderFields> = {},
): QueuedRunOrderFields {
  return {
    id,
    createdAt: at(hoursAgo),
    pauseCount: 0,
    continuationCount: 0,
    priority: "normal",
    ...values,
  };
}

const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe("the queue's order", () => {
  test("knows exactly two priorities, Normal by default", () => {
    assert.deepEqual([...ROUTINE_PRIORITIES], ["normal", "high"]);
    assert.equal(DEFAULT_ROUTINE_PRIORITY, "normal");
    assert.equal(isRoutinePriority("high"), true);
    assert.equal(isRoutinePriority("normal"), true);
    for (const value of ["urgent", "HIGH", "", null, undefined, 1]) {
      assert.equal(isRoutinePriority(value), false, String(value));
    }
  });

  test("puts High before Normal, and otherwise keeps the order Runs were queued in", () => {
    assert.deepEqual(
      ids(
        orderQueuedRuns([
          entry("normal-newer", 1),
          entry("high-newer", 0.5, { priority: "high" }),
          entry("normal-older", 6),
          entry("high-older", 3, { priority: "high" }),
        ]),
      ),
      ["high-older", "high-newer", "normal-older", "normal-newer"],
    );
  });

  test("resumes a Run paused for a restart first, then continuations, then new work", () => {
    const order = orderQueuedRuns([
      entry("new-high", 10, { priority: "high" }),
      entry("continuation-normal", 1, { continuationCount: 1 }),
      entry("paused-normal", 0.2, { pauseCount: 1 }),
      entry("continuation-high", 0.5, { continuationCount: 2, priority: "high" }),
      entry("paused-high", 0.1, { pauseCount: 2, priority: "high" }),
    ]);
    assert.deepEqual(ids(order), [
      "paused-high",
      "paused-normal",
      "continuation-high",
      "continuation-normal",
      "new-high",
    ]);
    assert.deepEqual(
      order.map(queueStage),
      ["resuming", "resuming", "continuing", "continuing", "new"],
      "a paused continuation counts as paused",
    );
  });

  test("lets a Normal Run that has waited a day count as High, behind the High work already waiting", () => {
    const day = HIGH_PRIORITY_HEAD_START_MS / HOUR;
    const order = orderQueuedRuns([
      entry("high-recent", 1, { priority: "high" }),
      entry("high-older-than-the-normal-turned", day + 3, { priority: "high" }),
      entry("normal-over-a-day", day + 2),
      entry("normal-under-a-day", day - 0.5),
    ]);
    assert.deepEqual(ids(order), [
      // Queued a day and three hours ago: ahead of the Normal Run, which only
      // counted as High from an hour after it.
      "high-older-than-the-normal-turned",
      "normal-over-a-day",
      "high-recent",
      "normal-under-a-day",
    ]);
  });

  test("never depends on the time it is asked, so two waiting Runs never swap places", () => {
    const runs = [
      entry("normal", 23, {}),
      entry("high", 0, { priority: "high" }),
      entry("old-normal", 30),
    ];
    const order = ids(orderQueuedRuns(runs));
    // Ordering is a function of the Runs alone; asking a week later changes nothing.
    assert.deepEqual(ids(orderQueuedRuns([...runs].reverse())), order);
    assert.equal(queueOrderTime(runs[1]), at(0).getTime() - HIGH_PRIORITY_HEAD_START_MS);
    assert.equal(queueOrderTime(runs[0]), at(23).getTime());
  });

  test("breaks a tie between Runs queued at the same moment by their id", () => {
    const order = orderQueuedRuns([entry("b", 2), entry("c", 2), entry("a", 2)]);
    assert.deepEqual(ids(order), ["a", "b", "c"]);
    assert.equal(compareQueuedRuns(entry("a", 2), entry("a", 2)), 0);
  });

  test("reads dates sent as text the same as stored dates, and puts an unreadable one last", () => {
    const order = orderQueuedRuns([
      { ...entry("broken", 0), createdAt: "not a date" },
      { ...entry("text", 2), createdAt: at(2).toISOString() },
      entry("date", 1),
    ]);
    assert.deepEqual(ids(order), ["text", "date", "broken"]);
  });

  test("does not change the list it was given", () => {
    const runs = [entry("second", 1), entry("first", 2)];
    orderQueuedRuns(runs);
    assert.deepEqual(ids(runs), ["second", "first"]);
  });

  test("says a Normal Run moved up once it has waited the head start, and never a High one", () => {
    const normal = { priority: "normal" as const, createdAt: at(24) };
    assert.equal(waitedIntoHighPriority(normal, NOW), true, "exactly a day");
    assert.equal(waitedIntoHighPriority(normal, NOW - 1), false);
    assert.equal(waitedIntoHighPriority({ ...normal, priority: "high" }, NOW + HOUR), false);
    assert.equal(waitedIntoHighPriority(normal, new Date(NOW)), true);
  });
});

describe("the queue as read from the database", () => {
  before(initTestDb);

  let company: Company;
  let jamie: AIEmployee;
  let sam: AIEmployee;

  beforeEach(async () => {
    await resetTestDb();
    await refreshStanddowns();
    company = await insert(Company, { name: "OneUptime", slug: "oneuptime", ownerId: "owner" });
    jamie = await insert(AIEmployee, {
      companyId: company.id,
      name: "Jamie Mallers",
      slug: "jamie",
      role: "VP of Go to Market",
    });
    sam = await insert(AIEmployee, {
      companyId: company.id,
      name: "Sam",
      slug: "sam",
      role: "Support",
    });
  });

  const routineFor = (employee: AIEmployee, name: string, values: Partial<Routine> = {}) =>
    insert(Routine, {
      employeeId: employee.id,
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      cronExpr: "0 9 * * *",
      body: "",
      ...values,
    });

  const waiting = (routine: Routine, hoursAgo: number, values: Partial<Run> = {}) =>
    insert(Run, {
      routineId: routine.id,
      employeeId: routine.employeeId,
      status: "queued",
      triggerKind: "schedule",
      startedAt: at(hoursAgo),
      createdAt: at(hoursAgo),
      ...values,
    });

  test("the dispatcher reads every waiting Run across companies, in order, with its Routine's priority now", async () => {
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: "owner" });
    const robin = await insert(AIEmployee, {
      companyId: other.id,
      name: "Robin",
      slug: "robin",
      role: "Ops",
    });
    const crm = await routineFor(jamie, "CRM sync");
    const elsewhere = await routineFor(robin, "Elsewhere", { priority: "high" });
    const older = await waiting(crm, 5);
    const high = await waiting(elsewhere, 1);
    await waiting(crm, 2, { status: "running" });
    await waiting(crm, 1, { status: "completed" });
    // Never offered: it has no employee to check its Routine's owner against.
    await waiting(crm, 9, { employeeId: null });

    assert.deepEqual(ids(await queuedRunsInStartOrder()), [high.id, older.id]);
    await AppDataSource.getRepository(Routine).update(elsewhere.id, { priority: "normal" });
    assert.deepEqual(
      ids(await queuedRunsInStartOrder()),
      [older.id, high.id],
      "a changed priority applies at the next read: no Run kept a copy",
    );
  });

  test("a waiting Run whose Routine is gone reads as Normal rather than failing the read", async () => {
    const crm = await routineFor(jamie, "CRM sync", { priority: "high" });
    const orphan = await waiting(crm, 1);
    await AppDataSource.getRepository(Routine).delete({ id: crm.id });
    const [only] = await queuedRunsInStartOrder();
    assert.equal(only.id, orphan.id);
    assert.equal(only.priority, "normal");
  });

  test("a company's queue numbers its Runs across employees, in the dispatcher's order", async () => {
    const jamieNormal = await waiting(await routineFor(jamie, "Jamie normal"), 8);
    const samHigh = await waiting(await routineFor(sam, "Sam high", { priority: "high" }), 1);
    const jamiePaused = await waiting(await routineFor(jamie, "Jamie paused"), 0.1, {
      pauseCount: 1,
    });
    const line = await companyRunQueue(company.id);
    assert.deepEqual(
      line.map((run) => [run.id, run.position, run.priority]),
      [
        [jamiePaused.id, 1, "normal"],
        [samHigh.id, 2, "high"],
        [jamieNormal.id, 3, "normal"],
      ],
    );
    assert.deepEqual(
      ids(line),
      ids((await queuedRunsInStartOrder()).filter((run) => line.some((item) => item.id === run.id))),
      "the company sees the same order its Runs are offered in",
    );
  });

  test("Runs the queue passes over keep their order but take no place in line", async () => {
    const stoodDown = await routineFor(jamie, "Stood down");
    const held = await waiting(stoodDown, 6);
    const first = await waiting(await routineFor(jamie, "First"), 5);
    // Its Routine moved to Sam: the dispatcher ends this Run instead of starting it.
    const moved = await routineFor(sam, "Moved");
    const leftBehind = await waiting(moved, 4, { employeeId: jamie.id });
    // Holding a claim it was never released from.
    const claimed = await waiting(await routineFor(jamie, "Claimed"), 3, {
      queueActiveEmployeeId: "run:stranded:claim",
    });
    // From before Runs recorded their employee: shown, never offered.
    const legacy = await waiting(await routineFor(jamie, "Legacy"), 2, { employeeId: null });
    const last = await waiting(await routineFor(jamie, "Last"), 1);
    await insert(Standdown, {
      companyId: company.id,
      scope: "routine",
      scopeId: stoodDown.id,
      reason: "Hold sends.",
      placedAt: new Date(),
    });
    await refreshStanddowns();

    const line = await companyRunQueue(company.id);
    assert.deepEqual(
      line.map((run) => [run.id, run.position]),
      [
        [held.id, null],
        [first.id, 1],
        [leftBehind.id, null],
        [claimed.id, null],
        [legacy.id, null],
        [last.id, 2],
      ],
    );
    assert.equal(line.find((run) => run.id === leftBehind.id)?.routineEmployeeId, sam.id);
  });

  test("a company's queue holds only its own Runs, and none that is not waiting", async () => {
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: "owner" });
    const robin = await insert(AIEmployee, {
      companyId: other.id,
      name: "Robin",
      slug: "robin",
      role: "Ops",
    });
    const mine = await waiting(await routineFor(jamie, "Mine"), 3);
    await waiting(await routineFor(robin, "Theirs", { priority: "high" }), 1);
    // An unnamed legacy Run of another company's Routine is theirs, not ours.
    await waiting(await routineFor(robin, "Theirs legacy"), 2, { employeeId: null });
    await waiting(await routineFor(jamie, "Running"), 2, { status: "running" });
    await waiting(await routineFor(jamie, "Done"), 2, { status: "completed" });

    assert.deepEqual(ids(await companyRunQueue(company.id)), [mine.id]);
    assert.deepEqual(await companyRunQueue(randomUUID()), []);
    const empty = await insert(Company, { name: "Empty", slug: "empty", ownerId: "owner" });
    assert.deepEqual(await companyRunQueue(empty.id), []);
  });

  test("claimed Runs are the ones holding a claim, read without their history", async () => {
    const crm = await routineFor(jamie, "CRM sync");
    const working = await waiting(crm, 1, { status: "running", queueActiveEmployeeId: "run:a:1" });
    const assessing = await waiting(crm, 2, {
      status: "completed",
      queueActiveEmployeeId: jamie.id,
    });
    await waiting(crm, 3);
    await waiting(crm, 4, { status: "completed" });
    assert.deepEqual(
      (await claimedRuns()).map((run) => run.id).sort(),
      [working.id, assessing.id].sort(),
    );
  });
});
