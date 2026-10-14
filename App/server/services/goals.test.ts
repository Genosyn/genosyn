import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Chart } from "../db/entities/Chart.js";
import { Goal } from "../db/entities/Goal.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification, type NotificationKind } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  GoalAccessError,
  GoalError,
  type GoalReporter,
  composeGoalsContext,
  confirmGoalProgress,
  createGoal,
  deleteGoal,
  goalBriefBlock,
  goalProgress,
  goalsReadingChart,
  isAwaitingConfirmation,
  isGoalMet,
  refreshGoalValue,
  releaseGoalsFromChart,
  releaseGoalsOwnedBy,
  reportGoalProgress,
  resolveGoal,
  sweepGoals,
  updateGoal,
} from "./goals.js";

/**
 * Goals are the intent layer everything else grades against, so the
 * invariants here are the ones a wrong answer would quietly corrupt: progress
 * arithmetic, the tree rules, company scoping, that `achieved` / `missed`
 * settle exactly once however many passes race, and that the AI Employee a
 * Goal grades can never settle it with its own report.
 */

const MEMBER: GoalReporter = { kind: "member" };

let companyId: string;
let employeeId: string;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  employeeId = employee.id;
});

function goalShape(over: Partial<Goal> = {}): Goal {
  return {
    startValue: null,
    targetValue: 100,
    currentValue: null,
    direction: "increase_to",
    ...over,
  } as Goal;
}

describe("goal progress arithmetic", () => {
  test("increase without a baseline measures from zero", () => {
    assert.equal(goalProgress(goalShape({ currentValue: 25 })), 0.25);
  });

  test("increase with a baseline measures from the baseline", () => {
    assert.equal(goalProgress(goalShape({ startValue: 50, currentValue: 75 })), 0.5);
  });

  test("a met goal reads 1 even when the arithmetic would overshoot", () => {
    assert.equal(goalProgress(goalShape({ currentValue: 250 })), 1);
  });

  test("decrease without a baseline has no honest percent", () => {
    assert.equal(
      goalProgress(goalShape({ direction: "decrease_to", targetValue: 10, currentValue: 40 })),
      null,
    );
  });

  test("decrease with a baseline measures the distance travelled down", () => {
    assert.equal(
      goalProgress(
        goalShape({ direction: "decrease_to", startValue: 50, targetValue: 10, currentValue: 30 }),
      ),
      0.5,
    );
  });

  test("no current value means no progress and never met", () => {
    assert.equal(goalProgress(goalShape()), null);
    assert.equal(isGoalMet(goalShape()), false);
  });

  test("met respects direction on both sides", () => {
    assert.equal(isGoalMet(goalShape({ currentValue: 100 })), true);
    assert.equal(
      isGoalMet(goalShape({ direction: "decrease_to", targetValue: 10, currentValue: 10 })),
      true,
    );
    assert.equal(
      isGoalMet(goalShape({ direction: "decrease_to", targetValue: 10, currentValue: 11 })),
      false,
    );
  });
});

describe("createGoal", () => {
  test("derives a unique company slug and defaults to an active manual goal", async () => {
    const first = await createGoal(companyId, { title: "Grow MRR", targetValue: 100 }, null);
    const second = await createGoal(companyId, { title: "Grow MRR", targetValue: 200 }, null);
    assert.equal(first.slug, "grow-mrr");
    assert.equal(second.slug, "grow-mrr-2");
    assert.equal(first.status, "active");
    assert.equal(first.metricKind, "manual");
  });

  test("refuses a parent from another company", async () => {
    const foreign = await insert(Goal, {
      companyId: testId("other-co"),
      title: "Theirs",
      slug: "theirs",
      targetValue: 1,
    });
    await assert.rejects(
      createGoal(companyId, { title: "Mine", targetValue: 1, parentGoalId: foreign.id }, null),
      GoalError,
    );
  });

  test("refuses nesting past the depth cap", async () => {
    let parent: string | null = null;
    for (let depth = 1; depth <= 4; depth++) {
      const goal: Goal = await createGoal(
        companyId,
        { title: `Level ${depth}`, targetValue: 1, parentGoalId: parent },
        null,
      );
      parent = goal.id;
    }
    await assert.rejects(
      createGoal(companyId, { title: "Level 5", targetValue: 1, parentGoalId: parent }, null),
      GoalError,
    );
  });

  test("a chart goal must name a chart of the same company; a manual goal must not", async () => {
    await assert.rejects(
      createGoal(companyId, { title: "Chartless", targetValue: 1, metricKind: "chart" }, null),
      GoalError,
    );
    const foreignChart = await insert(Chart, {
      companyId: testId("other-co"),
      title: "Their MRR",
      slug: "their-mrr",
      connectionId: testId("conn"),
      sql: "select 1",
    });
    await assert.rejects(
      createGoal(
        companyId,
        { title: "Bound wrong", targetValue: 1, metricKind: "chart", chartId: foreignChart.id },
        null,
      ),
      GoalError,
    );
    await assert.rejects(
      createGoal(
        companyId,
        { title: "Manual with chart", targetValue: 1, chartId: foreignChart.id },
        null,
      ),
      GoalError,
    );
  });

  test("refuses an owner employee from another company", async () => {
    const stranger = await insert(AIEmployee, {
      companyId: testId("other-co"),
      name: "Eve",
      slug: "eve",
      role: "Spy",
      soulBody: "",
    });
    await assert.rejects(
      createGoal(companyId, { title: "Owned wrong", targetValue: 1, ownerEmployeeId: stranger.id }, null),
      GoalError,
    );
  });
});

describe("updateGoal", () => {
  test("refuses re-parenting a goal into its own subtree", async () => {
    const top = await createGoal(companyId, { title: "Top", targetValue: 1 }, null);
    const child = await createGoal(
      companyId,
      { title: "Child", targetValue: 1, parentGoalId: top.id },
      null,
    );
    await assert.rejects(updateGoal(companyId, top.id, { parentGoalId: child.id }), GoalError);
    await assert.rejects(updateGoal(companyId, top.id, { parentGoalId: top.id }), GoalError);
  });

  test("counts the subtree's own height against the depth cap on re-parent", async () => {
    const a = await createGoal(companyId, { title: "A", targetValue: 1 }, null);
    const b = await createGoal(companyId, { title: "B", targetValue: 1, parentGoalId: a.id }, null);
    const c = await createGoal(companyId, { title: "C", targetValue: 1, parentGoalId: b.id }, null);
    await createGoal(companyId, { title: "D", targetValue: 1, parentGoalId: c.id }, null);
    const other = await createGoal(companyId, { title: "Other", targetValue: 1 }, null);
    // Moving A (height 4) under Other (depth 2 for A) would need 5 levels.
    await assert.rejects(updateGoal(companyId, a.id, { parentGoalId: other.id }), GoalError);
  });

  test("a rename keeps the slug so links stay stable", async () => {
    const goal = await createGoal(companyId, { title: "Grow MRR", targetValue: 1 }, null);
    const renamed = await updateGoal(companyId, goal.id, { title: "Grow ARR" });
    assert.equal(renamed.title, "Grow ARR");
    assert.equal(renamed.slug, "grow-mrr");
  });

  test("reactivating clears the settled stamp so the sweep may settle again", async () => {
    const goal = await createGoal(companyId, { title: "G", targetValue: 1 }, null);
    const archived = await updateGoal(companyId, goal.id, { status: "archived" });
    assert.ok(archived.settledAt);
    const reactivated = await updateGoal(companyId, goal.id, { status: "active" });
    assert.equal(reactivated.settledAt, null);
  });

  test("scopes by company", async () => {
    const goal = await createGoal(companyId, { title: "Mine", targetValue: 1 }, null);
    await assert.rejects(updateGoal(testId("other-co"), goal.id, { title: "Stolen" }), GoalError);
  });
});

describe("deleteGoal", () => {
  test("re-parents children to the deleted goal's own parent and unlinks routines", async () => {
    const top = await createGoal(companyId, { title: "Top", targetValue: 1 }, null);
    const mid = await createGoal(
      companyId,
      { title: "Mid", targetValue: 1, parentGoalId: top.id },
      null,
    );
    const leaf = await createGoal(
      companyId,
      { title: "Leaf", targetValue: 1, parentGoalId: mid.id },
      null,
    );
    const routine = await insert(Routine, {
      employeeId,
      name: "Weekly report",
      slug: "weekly-report",
      cronExpr: "0 9 * * 1",
      goalId: mid.id,
    });

    await deleteGoal(companyId, mid.id);

    const leafAfter = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: leaf.id });
    assert.equal(leafAfter.parentGoalId, top.id);
    const routineAfter = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: routine.id,
    });
    assert.equal(routineAfter.goalId, null);
  });
});

describe("progress reports and settling", () => {
  beforeEach(async () => {
    await insert(Membership, { companyId, userId: testId("owner"), role: "owner" });
  });

  test("a chart goal refuses a manual report", async () => {
    const chart = await insert(Chart, {
      companyId,
      title: "MRR",
      slug: "mrr",
      connectionId: testId("conn"),
      sql: "select 1",
    });
    const goal = await createGoal(
      companyId,
      { title: "MRR", targetValue: 1, metricKind: "chart", chartId: chart.id },
      null,
    );
    await assert.rejects(reportGoalProgress(companyId, goal.id, 5, MEMBER), GoalError);
  });

  test("an archived goal refuses reports", async () => {
    const goal = await createGoal(companyId, { title: "G", targetValue: 1 }, null);
    await updateGoal(companyId, goal.id, { status: "archived" });
    await assert.rejects(reportGoalProgress(companyId, goal.id, 5, MEMBER), GoalError);
  });

  test("a report that clears the target settles achieved exactly once and notifies", async () => {
    const goal = await createGoal(companyId, { title: "Signups", targetValue: 10 }, null);
    const reported = await reportGoalProgress(companyId, goal.id, 12, MEMBER);
    assert.equal(reported.status, "achieved");
    assert.ok(reported.settledAt);
    // The races the claim must win: a second report and a sweep pass.
    await sweepGoals();
    const notifications = await AppDataSource.getRepository(Notification).findBy({
      kind: "goal_achieved",
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /Signups/);
  });

  test("the sweep settles missed when the deadline passes unmet, once", async () => {
    const goal = await createGoal(
      companyId,
      { title: "Ship it", targetValue: 10, dueAt: new Date(Date.now() - 60_000) },
      null,
    );
    await sweepGoals();
    await sweepGoals();
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "missed");
    const notifications = await AppDataSource.getRepository(Notification).findBy({
      kind: "goal_missed",
    });
    assert.equal(notifications.length, 1);
  });

  test("an open-ended goal is never missed", async () => {
    const goal = await createGoal(companyId, { title: "Someday", targetValue: 10 }, null);
    await sweepGoals();
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "active");
  });
});

describe("AI Employee reports", () => {
  const employee = (): GoalReporter => ({ kind: "employee", employeeId });

  beforeEach(async () => {
    await insert(Membership, { companyId, userId: testId("owner"), role: "owner" });
  });

  async function ownedGoal(over: { dueAt?: Date } = {}): Promise<Goal> {
    return createGoal(
      companyId,
      { title: "Signups", targetValue: 10, ownerEmployeeId: employeeId, ...over },
      null,
    );
  }

  async function bells(kind: NotificationKind): Promise<Notification[]> {
    return AppDataSource.getRepository(Notification).findBy({ kind });
  }

  test("a met number waits for a person: neither the report nor the sweep settles it", async () => {
    const goal = await ownedGoal();
    const reported = await reportGoalProgress(companyId, goal.id, 12, employee());
    assert.equal(reported.status, "active");
    assert.equal(reported.currentValueSource, "employee");
    assert.equal(isAwaitingConfirmation(reported), true);

    await sweepGoals();
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "active");
    assert.equal(after.settledAt, null);
    assert.equal((await bells("goal_achieved")).length, 0);
    // Still in front of every employee, marked as unconfirmed.
    assert.match(
      await composeGoalsContext(companyId, employeeId),
      /Signups.*reported met, awaiting a person's confirmation/,
    );
    assert.match(
      (await goalBriefBlock(companyId, goal.id)) ?? "",
      /currently 12, reported met and awaiting a person's confirmation/,
    );
  });

  test("owners and admins are told once per claim, naming the employee", async () => {
    const goal = await ownedGoal();
    await reportGoalProgress(companyId, goal.id, 12, employee());
    await reportGoalProgress(companyId, goal.id, 14, employee());
    let pending = await bells("goal_confirmation_pending");
    assert.equal(pending.length, 1);
    assert.match(pending[0].title, /Signups/);
    assert.match(pending[0].body, /^Ada reported 12 against a target of 10/);

    // Falling short ends the claim; meeting the target again is a new one.
    await reportGoalProgress(companyId, goal.id, 4, employee());
    await reportGoalProgress(companyId, goal.id, 11, employee());
    pending = await bells("goal_confirmation_pending");
    assert.equal(pending.length, 2);
  });

  test("a goal reported met is not missed when its deadline passes", async () => {
    const goal = await ownedGoal({ dueAt: new Date(Date.now() - 60_000) });
    await reportGoalProgress(companyId, goal.id, 12, employee());
    await sweepGoals();
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "active");
  });

  test("an unmet number past the deadline is missed by the sweep, never by the report", async () => {
    const goal = await ownedGoal({ dueAt: new Date(Date.now() - 60_000) });
    const reported = await reportGoalProgress(companyId, goal.id, 3, employee());
    assert.equal(reported.status, "active");
    await sweepGoals();
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "missed");
  });

  test("reports only on a goal the employee owns or one of its routines serves", async () => {
    const northStar = await createGoal(
      companyId,
      { title: "Company north star", targetValue: 100 },
      null,
    );
    await assert.rejects(
      reportGoalProgress(companyId, northStar.id, 1, employee()),
      GoalAccessError,
    );

    const colleague = await insert(AIEmployee, {
      companyId,
      name: "Bo",
      slug: "bo",
      role: "Ops",
      soulBody: "",
    });
    const theirs = await createGoal(
      companyId,
      { title: "Bo's goal", targetValue: 5, ownerEmployeeId: colleague.id },
      null,
    );
    await assert.rejects(reportGoalProgress(companyId, theirs.id, 1, employee()), GoalAccessError);

    await insert(Routine, {
      employeeId,
      name: "Weekly report",
      slug: "weekly-report",
      cronExpr: "0 9 * * 1",
      goalId: northStar.id,
    });
    const served = await reportGoalProgress(companyId, northStar.id, 7, employee());
    assert.equal(served.currentValue, 7);
    const untouched = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: theirs.id });
    assert.equal(untouched.currentValue, null);
  });
});

describe("confirming a reported number", () => {
  beforeEach(async () => {
    await insert(Membership, { companyId, userId: testId("owner"), role: "owner" });
  });

  async function reportedMet(): Promise<Goal> {
    const goal = await createGoal(
      companyId,
      { title: "Signups", targetValue: 10, ownerEmployeeId: employeeId },
      null,
    );
    return reportGoalProgress(companyId, goal.id, 12, { kind: "employee", employeeId });
  }

  test("a person's confirmation settles achieved once and notifies", async () => {
    const goal = await reportedMet();
    const confirmed = await confirmGoalProgress(companyId, goal.id, 12);
    assert.equal(confirmed.status, "achieved");
    assert.equal(confirmed.currentValueSource, "member");
    await sweepGoals();
    const achieved = await AppDataSource.getRepository(Notification).findBy({
      kind: "goal_achieved",
    });
    assert.equal(achieved.length, 1);
  });

  test("refuses a number that moved since it was read, and a goal with nothing to confirm", async () => {
    const goal = await reportedMet();
    await assert.rejects(confirmGoalProgress(companyId, goal.id, 11), /changed/);
    const plain = await createGoal(
      companyId,
      { title: "Plain", targetValue: 10, currentValue: 3 },
      null,
    );
    await assert.rejects(confirmGoalProgress(companyId, plain.id, 3), GoalError);
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "active");
  });

  test("an unrelated edit does not turn a reported number into a person's", async () => {
    const goal = await reportedMet();
    // The edit dialog re-sends a manual goal's current value with every save.
    await updateGoal(companyId, goal.id, {
      description: "Count trial signups only",
      currentValue: 12,
    });
    await sweepGoals();
    let after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.status, "active");
    assert.equal(after.currentValueSource, "employee");

    // A different number a person types is theirs, and settles.
    await updateGoal(companyId, goal.id, { currentValue: 13 });
    await sweepGoals();
    after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.currentValueSource, "member");
    assert.equal(after.status, "achieved");
  });
});

describe("when a chart or an employee goes", () => {
  async function chart(slug: string): Promise<Chart> {
    return insert(Chart, {
      companyId,
      title: slug,
      slug,
      connectionId: testId("conn"),
      sql: "select 1",
    });
  }

  test("goalsReadingChart lists every goal bound to the chart, archived ones included", async () => {
    const mrr = await chart("mrr");
    const other = await chart("other");
    const live = await createGoal(
      companyId,
      { title: "Live", targetValue: 1, metricKind: "chart", chartId: mrr.id },
      null,
    );
    const shelved = await createGoal(
      companyId,
      { title: "Shelved", targetValue: 1, metricKind: "chart", chartId: mrr.id },
      null,
    );
    await updateGoal(companyId, shelved.id, { status: "archived" });
    await createGoal(
      companyId,
      { title: "Elsewhere", targetValue: 1, metricKind: "chart", chartId: other.id },
      null,
    );
    assert.deepEqual(
      (await goalsReadingChart(companyId, mrr.id)).map((g) => g.id).sort(),
      [live.id, shelved.id].sort(),
    );
    assert.deepEqual(await goalsReadingChart(testId("other-co"), mrr.id), []);
  });

  test("releaseGoalsFromChart demotes bound goals to manual, keeping their last reading", async () => {
    const mrr = await chart("mrr");
    const bound = await insert(Goal, {
      companyId,
      title: "MRR",
      slug: "mrr",
      targetValue: 100,
      metricKind: "chart",
      chartId: mrr.id,
      currentValue: 42,
      currentValueSource: "chart",
    });
    assert.equal(await releaseGoalsFromChart(companyId, mrr.id), 1);
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: bound.id });
    assert.equal(after.metricKind, "manual");
    assert.equal(after.chartId, null);
    assert.equal(after.currentValue, 42);
    // Reportable by hand again, where a dangling binding refused every report.
    const reported = await reportGoalProgress(companyId, bound.id, 50, MEMBER);
    assert.equal(reported.currentValue, 50);
  });

  test("releaseGoalsOwnedBy clears that employee's ownership and nobody else's", async () => {
    const colleague = await insert(AIEmployee, {
      companyId,
      name: "Bo",
      slug: "bo",
      role: "Ops",
      soulBody: "",
    });
    const mine = await createGoal(
      companyId,
      { title: "Mine", targetValue: 1, ownerEmployeeId: employeeId },
      null,
    );
    const theirs = await createGoal(
      companyId,
      { title: "Theirs", targetValue: 1, ownerEmployeeId: colleague.id },
      null,
    );
    await releaseGoalsOwnedBy(companyId, employeeId);
    const repo = AppDataSource.getRepository(Goal);
    assert.equal((await repo.findOneByOrFail({ id: mine.id })).ownerEmployeeId, null);
    assert.equal((await repo.findOneByOrFail({ id: theirs.id })).ownerEmployeeId, colleague.id);
  });
});

describe("refreshGoalValue", () => {
  test("only chart goals refresh, and a dangling chart is a legible error", async () => {
    const manual = await createGoal(companyId, { title: "Manual", targetValue: 1 }, null);
    await assert.rejects(refreshGoalValue(manual), GoalError);

    const chart = await insert(Chart, {
      companyId,
      title: "MRR",
      slug: "mrr",
      connectionId: testId("conn"),
      sql: "select 1",
    });
    const bound = await createGoal(
      companyId,
      { title: "Bound", targetValue: 1, metricKind: "chart", chartId: chart.id },
      null,
    );
    await AppDataSource.getRepository(Chart).delete({ id: chart.id });
    await assert.rejects(refreshGoalValue(bound), /chart no longer exists/);
  });
});

describe("prompt and brief folding", () => {
  test("composeGoalsContext lists owned goals first, then company goals, and stays empty otherwise", async () => {
    assert.equal(await composeGoalsContext(companyId, employeeId), "");

    await createGoal(companyId, { title: "Company north star", targetValue: 100 }, null);
    const owned = await createGoal(
      companyId,
      {
        title: "Reply fast",
        targetValue: 4,
        direction: "decrease_to",
        unit: "hours",
        ownerEmployeeId: employeeId,
        currentValue: 9,
      },
      null,
    );
    const context = await composeGoalsContext(companyId, employeeId);
    assert.match(context, /## Goals/);
    assert.match(context, /Goals you own/);
    assert.match(context, /Reply fast/);
    assert.match(context, /Company goals for shared direction/);
    assert.match(context, /Company north star/);
    assert.ok(
      context.indexOf(owned.title) < context.indexOf("Company north star"),
      "owned goals come first",
    );
  });

  test("an owned top-level goal is not repeated in the company section", async () => {
    await createGoal(
      companyId,
      { title: "Only once", targetValue: 1, ownerEmployeeId: employeeId },
      null,
    );
    const context = await composeGoalsContext(companyId, employeeId);
    assert.equal(context.split("Only once").length, 2);
  });

  test("goalBriefBlock folds only an active goal and survives a dangling link", async () => {
    assert.equal(await goalBriefBlock(companyId, null), null);
    assert.equal(await goalBriefBlock(companyId, testId("gone")), null);

    const goal = await createGoal(
      companyId,
      { title: "Grow MRR", targetValue: 500, unit: "$", currentValue: 350 },
      null,
    );
    const block = await goalBriefBlock(companyId, goal.id);
    assert.ok(block);
    assert.match(block, /Grow MRR/);
    assert.match(block, /reach 500 \$/);
    assert.match(block, /currently 350 \$/);

    await updateGoal(companyId, goal.id, { status: "archived" });
    assert.equal(await goalBriefBlock(companyId, goal.id), null);
  });
});

describe("resolveGoal", () => {
  test("resolves by id and by slug, scoped to the company", async () => {
    const goal = await createGoal(companyId, { title: "Grow MRR", targetValue: 1 }, null);
    assert.equal((await resolveGoal(companyId, goal.id))?.id, goal.id);
    assert.equal((await resolveGoal(companyId, "grow-mrr"))?.id, goal.id);
    assert.equal((await resolveGoal(companyId, "Grow MRR"))?.id, goal.id);
    assert.equal(await resolveGoal(testId("other-co"), goal.id), null);
    assert.equal(await resolveGoal(companyId, "nope"), null);
  });
});
