import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import { Workstream } from "../db/entities/Workstream.js";
import {
  CONDITIONED_STARTS,
  DEFAULT_ROUTINE_RUN_CONDITION,
  ROUTINE_RUN_CONDITIONS,
  WORKSTREAM_REVISIT_MAX_AHEAD_MS,
  isRoutineRunCondition,
  routineRunConditionOf,
  runConditionDecides,
  scheduleWithRunCondition,
  workstreamRevisitDue,
} from "../../shared/routineRunCondition.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  DUE_WORKSTREAMS_LISTED,
  LOOKED_RUN_STATUSES,
  admitConditionedStart,
  composeRunConditionBlock,
  evaluateRunCondition,
  recordNothingDue,
  revisitsDueForBrief,
  routineLookedAt,
  runConditionStatus,
} from "./routineRunConditions.js";

/**
 * Run conditions: a Routine that runs only when a Workstream is due starts
 * exactly when a revisit its employee planned has come and it has not looked
 * since — never on an idle schedule, never twice for one revisit, and never in
 * a way a person's own start, a webhook, an approval, a retry or a
 * continuation has to get past.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = new Date("2026-11-16T12:00:00.000Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

let companyId: string;
let employee: AIEmployee;
let followThrough: Routine;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Operations",
    soulBody: "",
  });
  followThrough = await routine({ slug: "follow-through", runCondition: "workstream_due" });
});

function routine(values: Partial<Routine> = {}): Promise<Routine> {
  return insert(Routine, {
    employeeId: employee.id,
    name: values.slug ?? "routine",
    slug: "routine",
    cronExpr: "*/30 * * * *",
    body: "Follow through.",
    enabled: true,
    ...values,
  });
}

function workstream(values: Partial<Workstream> = {}): Promise<Workstream> {
  return insert(Workstream, {
    companyId,
    employeeId: employee.id,
    title: "Collect overdue invoices",
    status: "active",
    routineId: null,
    revisitAt: null,
    ...values,
  });
}

function run(routineId: string, status: RunStatus, startedAt: Date): Promise<Run> {
  return insert(Run, {
    routineId,
    employeeId: employee.id,
    status,
    startedAt,
    finishedAt: status === "running" || status === "queued" ? null : startedAt,
    logContent: "",
  });
}

const fresh = (id: string) => AppDataSource.getRepository(Routine).findOneByOrFail({ id });

describe("the shared rule", () => {
  test("every condition is known, and anything unknown reads as always", () => {
    assert.deepEqual([...ROUTINE_RUN_CONDITIONS], ["always", "workstream_due"]);
    assert.equal(DEFAULT_ROUTINE_RUN_CONDITION, "always");
    assert.ok(isRoutineRunCondition("workstream_due"));
    for (const value of ["", "sometimes", null, undefined, 1, "ALWAYS"]) {
      assert.equal(isRoutineRunCondition(value), false, String(value));
      assert.equal(routineRunConditionOf(value), "always", String(value));
    }
  });

  test("only a scheduled time and a Trigger fire are decided by a condition", () => {
    assert.deepEqual([...CONDITIONED_STARTS], ["schedule", "event"]);
    assert.ok(runConditionDecides("schedule"));
    assert.ok(runConditionDecides("event"));
    for (const kind of ["manual", "webhook", "approval", "retry", "continuation", ""]) {
      assert.equal(runConditionDecides(kind), false, kind);
    }
  });

  test("a schedule reads with its condition", () => {
    assert.equal(
      scheduleWithRunCondition("Every 30 minutes", "workstream_due"),
      "Every 30 minutes, only when a Workstream is due",
    );
    assert.equal(scheduleWithRunCondition("Every 30 minutes", "always"), "Every 30 minutes");
    assert.equal(scheduleWithRunCondition("Daily at 09:00", undefined), "Daily at 09:00");
  });

  test("a revisit is due once it has come and the Routine has not looked since", () => {
    const active = (revisitAt: Date | null) => ({ status: "active", revisitAt });
    assert.equal(workstreamRevisitDue(active(null), null, now), false, "nothing planned");
    assert.equal(workstreamRevisitDue(active(at(MINUTE)), null, now), false, "still to come");
    assert.equal(workstreamRevisitDue(active(now), null, now), true, "comes exactly now");
    assert.equal(workstreamRevisitDue(active(at(-HOUR)), null, now), true, "never looked");
    assert.equal(
      workstreamRevisitDue(active(at(-HOUR)), at(-2 * HOUR), now),
      true,
      "came after the last look",
    );
    assert.equal(
      workstreamRevisitDue(active(at(-HOUR)), at(-HOUR), now),
      false,
      "the look that started as it came took it up",
    );
    assert.equal(
      workstreamRevisitDue(active(at(-2 * HOUR)), at(-HOUR), now),
      false,
      "already taken up",
    );
    assert.equal(
      workstreamRevisitDue({ status: "archived", revisitAt: at(-HOUR) }, null, now),
      false,
      "stopped work waits on nothing",
    );
    assert.equal(
      workstreamRevisitDue(active(at(-HOUR)), at(-2 * HOUR).toISOString(), now.getTime()),
      true,
      "accepts the wire's ISO strings and epoch numbers",
    );
    assert.equal(
      workstreamRevisitDue({ status: "active", revisitAt: "nonsense" }, null, now),
      false,
    );
  });

  test("a revisit may be planned up to two years ahead", () => {
    assert.ok(WORKSTREAM_REVISIT_MAX_AHEAD_MS >= 2 * 365 * 24 * HOUR);
    assert.ok(WORKSTREAM_REVISIT_MAX_AHEAD_MS < 3 * 365 * 24 * HOUR);
  });
});

describe("routineLookedAt", () => {
  test("is the start of the newest Run that got going; Errors and skips did not look", async () => {
    assert.equal(await routineLookedAt(followThrough.id), null, "a new Routine never looked");
    await run(followThrough.id, "completed", at(-3 * HOUR));
    await run(followThrough.id, "error", at(-2 * HOUR));
    await run(followThrough.id, "timeout", at(-90 * MINUTE));
    await run(followThrough.id, "interrupted", at(-80 * MINUTE));
    await run(followThrough.id, "skipped", at(-70 * MINUTE));
    assert.deepEqual(await routineLookedAt(followThrough.id), at(-3 * HOUR));
    for (const [index, status] of LOOKED_RUN_STATUSES.entries()) {
      const started = at(-60 * MINUTE + index * MINUTE);
      await run(followThrough.id, status, started);
      assert.deepEqual(await routineLookedAt(followThrough.id), started, status);
    }
  });

  test("reads only its own Routine's Runs", async () => {
    const other = await routine({ slug: "other" });
    await run(other.id, "completed", at(-MINUTE));
    assert.equal(await routineLookedAt(followThrough.id), null);
  });
});

describe("evaluateRunCondition", () => {
  test("a Routine that always runs is always due, whatever its Workstreams say", async () => {
    const always = await routine({ slug: "always" });
    assert.deepEqual(await evaluateRunCondition(always, now), { condition: "always", due: true });
  });

  test("an idle employee has nothing due", async () => {
    const verdict = await evaluateRunCondition(followThrough, now);
    assert.equal(verdict.condition, "workstream_due");
    assert.equal(verdict.due, false);
    assert.equal(verdict.condition === "workstream_due" && verdict.workstreams.length, 0);
  });

  test("open work with no revisit planned, or one still to come, starts nothing", async () => {
    await workstream({ title: "Unplanned" });
    await workstream({ title: "Later", revisitAt: at(HOUR) });
    assert.equal((await evaluateRunCondition(followThrough, now)).due, false);
  });

  test("a revisit that has come is due, soonest first, with its title and id", async () => {
    const later = await workstream({ title: "Second", revisitAt: at(-MINUTE) });
    const sooner = await workstream({ title: "First", revisitAt: at(-HOUR) });
    await workstream({ title: "Not yet", revisitAt: at(MINUTE) });
    const verdict = await evaluateRunCondition(followThrough, now);
    assert.ok(verdict.condition === "workstream_due" && verdict.due);
    assert.deepEqual(
      verdict.workstreams.map((w) => [w.id, w.title]),
      [
        [sooner.id, "First"],
        [later.id, "Second"],
      ],
    );
    assert.equal(verdict.lookedAt, null);
  });

  test("one Run takes a revisit up; a new revisit makes it due again", async () => {
    const work = await workstream({ revisitAt: at(-HOUR) });
    await run(followThrough.id, "completed", at(-30 * MINUTE));
    assert.equal((await evaluateRunCondition(followThrough, now)).due, false, "taken up");
    await AppDataSource.getRepository(Workstream).update(work.id, { revisitAt: at(-MINUTE) });
    assert.equal((await evaluateRunCondition(followThrough, now)).due, true, "planned again");
  });

  test("a Run that ended in an Error did not look, so the revisit stays due", async () => {
    await workstream({ revisitAt: at(-HOUR) });
    await run(followThrough.id, "error", at(-30 * MINUTE));
    await run(followThrough.id, "skipped", at(-20 * MINUTE));
    assert.equal((await evaluateRunCondition(followThrough, now)).due, true);
  });

  test("a Run already waiting or working has the revisit in hand", async () => {
    await workstream({ revisitAt: at(-HOUR) });
    await run(followThrough.id, "queued", at(-10 * MINUTE));
    assert.equal((await evaluateRunCondition(followThrough, now)).due, false);
  });

  test("only the employee's own active Workstreams it resumes count", async () => {
    const colleague = await insert(AIEmployee, {
      companyId,
      name: "Bo",
      slug: "bo",
      role: "Sales",
      soulBody: "",
    });
    const report = await routine({ slug: "weekly-report" });
    await insert(Workstream, {
      companyId,
      employeeId: colleague.id,
      title: "Someone else's",
      revisitAt: at(-HOUR),
    });
    for (const status of ["archived", "done", "abandoned"] as const) {
      await workstream({ title: status, status, revisitAt: at(-HOUR) });
    }
    await workstream({ title: "Bound elsewhere", routineId: report.id, revisitAt: at(-HOUR) });
    assert.equal((await evaluateRunCondition(followThrough, now)).due, false);

    const own = await workstream({
      title: "Bound to it",
      routineId: followThrough.id,
      revisitAt: at(-HOUR),
    });
    const verdict = await evaluateRunCondition(followThrough, now);
    assert.ok(verdict.condition === "workstream_due");
    assert.deepEqual(
      verdict.workstreams.map((w) => w.id),
      [own.id],
    );
  });

  test("a suggestion-only review resumes only its own tracking", async () => {
    const review = await routine({
      slug: "improve-own-work",
      selfReviewOnly: true,
      runCondition: "workstream_due",
    });
    await workstream({ title: "Business", revisitAt: at(-HOUR) });
    assert.equal((await evaluateRunCondition(review, now)).due, false);
    await workstream({ title: "Review", routineId: review.id, revisitAt: at(-HOUR) });
    assert.equal((await evaluateRunCondition(review, now)).due, true);
    // And business work never wakes for the review's tracking.
    await AppDataSource.getRepository(Workstream).update(
      { title: "Business" },
      { revisitAt: null },
    );
    assert.equal((await evaluateRunCondition(followThrough, now)).due, false);
  });

  test("names at most twenty due Workstreams", async () => {
    for (let index = 0; index < DUE_WORKSTREAMS_LISTED + 3; index += 1) {
      await workstream({ title: `Work ${index}`, revisitAt: at(-(index + 1) * MINUTE) });
    }
    const verdict = await evaluateRunCondition(followThrough, now);
    assert.ok(verdict.condition === "workstream_due");
    assert.equal(verdict.workstreams.length, DUE_WORKSTREAMS_LISTED);
    assert.equal(verdict.workstreams[0].title, `Work ${DUE_WORKSTREAMS_LISTED + 2}`);
  });
});

describe("admitConditionedStart", () => {
  test("a start somebody asked for, or one already under way, is never held back", async () => {
    for (const kind of ["manual", "webhook", "approval", "retry", "continuation"]) {
      assert.equal(await admitConditionedStart(followThrough, kind, { now }), true, kind);
    }
    const saved = await fresh(followThrough.id);
    assert.equal(saved.nothingDueCount, 0, "nothing was declined");
    assert.equal(saved.nothingDueAt, null);
  });

  test("a scheduled time or Trigger fire with nothing due is declined and counted", async () => {
    assert.equal(await admitConditionedStart(followThrough, "schedule", { now }), false);
    assert.equal(
      await admitConditionedStart(followThrough, "event", { now: at(MINUTE), companyId }),
      false,
    );
    const saved = await fresh(followThrough.id);
    assert.equal(saved.nothingDueCount, 2);
    assert.deepEqual(saved.nothingDueAt, at(MINUTE));
  });

  test("a due revisit admits the start and records nothing", async () => {
    await workstream({ revisitAt: at(-MINUTE) });
    assert.equal(await admitConditionedStart(followThrough, "schedule", { now }), true);
    assert.equal((await fresh(followThrough.id)).nothingDueCount, 0);
  });

  test("a Routine that always runs is admitted without a look", async () => {
    const always = await routine({ slug: "always" });
    assert.equal(await admitConditionedStart(always, "schedule", { now }), true);
    assert.equal((await fresh(always.id)).nothingDueCount, 0);
  });
});

describe("recordNothingDue", () => {
  test("counts each declined start and keeps the latest time, without touching the rest", async () => {
    const before = await fresh(followThrough.id);
    await recordNothingDue(followThrough, at(-MINUTE));
    await recordNothingDue(followThrough, now, companyId);
    const saved = await fresh(followThrough.id);
    assert.equal(saved.nothingDueCount, 2);
    assert.deepEqual(saved.nothingDueAt, now);
    assert.equal(saved.cronExpr, before.cronExpr);
    assert.deepEqual(saved.nextRunAt, before.nextRunAt);
    assert.deepEqual(saved.lastRunAt, before.lastRunAt);
    assert.equal(saved.enabled, true);
  });
});

describe("the brief", () => {
  test("a Routine that always runs adds nothing", async () => {
    const always = await routine({ slug: "always" });
    assert.equal(await revisitsDueForBrief(always, now), null);
    assert.equal(composeRunConditionBlock(null, "schedule"), "");
  });

  test("names every revisit that has come, even one an earlier Run left unplanned", async () => {
    const work = await workstream({ title: "  Fix  the\nimport ", revisitAt: at(-HOUR) });
    await run(followThrough.id, "completed", at(-30 * MINUTE));
    const due = await revisitsDueForBrief(followThrough, now);
    assert.deepEqual(
      due?.map((w) => w.id),
      [work.id],
    );
    const block = composeRunConditionBlock(due, "schedule");
    assert.match(block, /^## Due now/);
    assert.match(block, /Genosyn started this Run because a revisit you planned has come/);
    assert.ok(block.includes(`- "Fix the import" (workstreamId ${work.id})`), block);
    assert.ok(block.includes(`revisit due since ${at(-HOUR).toISOString()}`));
    assert.match(block, /revisitAt/);
    assert.match(block, /`revisitAt: null` when it waits on nothing time-based/);
    assert.match(block, /A revisit is taken up by one Run/);
  });

  test("says why the Run started, for every way it can start", () => {
    const due = [{ id: "w1", title: "Work", revisitAt: now, routineId: null }];
    for (const kind of ["schedule", "event", "retry"]) {
      assert.match(composeRunConditionBlock(due, kind), /Genosyn started this Run/, kind);
    }
    for (const kind of ["manual", "webhook", "approval"]) {
      assert.match(composeRunConditionBlock(due, kind), /This Run was asked for/, kind);
    }
    assert.match(
      composeRunConditionBlock([], "manual"),
      /None of your Workstreams has reached its revisit time\. This Run was asked for/,
    );
    assert.match(
      composeRunConditionBlock([], "schedule"),
      /None of your Workstreams has a revisit due any more/,
    );
  });

  test("points at list_workstreams when the list is cut short", () => {
    const due = Array.from({ length: DUE_WORKSTREAMS_LISTED }, (_, index) => ({
      id: `w${index}`,
      title: `Work ${index}`,
      revisitAt: now,
      routineId: null,
    }));
    assert.match(composeRunConditionBlock(due, "schedule"), /list_workstreams shows the rest/);
    assert.doesNotMatch(
      composeRunConditionBlock(due.slice(1), "schedule"),
      /list_workstreams shows the rest/,
    );
  });
});

describe("runConditionStatus", () => {
  test("a Routine that always runs is simply due", async () => {
    const always = await routine({ slug: "always" });
    assert.deepEqual(await runConditionStatus(always, now), {
      condition: "always",
      due: true,
      nothingDueAt: null,
      nothingDueCount: 0,
      dueWorkstreams: [],
      nextRevisit: null,
      unplanned: 0,
      lookedAt: null,
    });
  });

  test("says what is due, what comes next, what will never start it, and what it saved", async () => {
    const due = await workstream({ title: "Due", revisitAt: at(-MINUTE) });
    const next = await workstream({ title: "Next", revisitAt: at(HOUR) });
    await workstream({ title: "Later", revisitAt: at(2 * HOUR) });
    await workstream({ title: "Unplanned A" });
    await workstream({ title: "Unplanned B" });
    await workstream({ title: "Closed", status: "done" });
    await run(followThrough.id, "completed", at(-2 * HOUR));
    await recordNothingDue(followThrough, at(-HOUR));
    const status = await runConditionStatus(await fresh(followThrough.id), now);
    assert.deepEqual(status, {
      condition: "workstream_due",
      due: true,
      nothingDueAt: at(-HOUR).toISOString(),
      nothingDueCount: 1,
      dueWorkstreams: [{ id: due.id, title: "Due", revisitAt: at(-MINUTE).toISOString() }],
      nextRevisit: { id: next.id, title: "Next", revisitAt: at(HOUR).toISOString() },
      unplanned: 2,
      lookedAt: at(-2 * HOUR).toISOString(),
    });
  });
});
