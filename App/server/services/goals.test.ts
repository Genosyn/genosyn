import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Chart } from "../db/entities/Chart.js";
import { Goal } from "../db/entities/Goal.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  GoalError,
  composeGoalsContext,
  createGoal,
  deleteGoal,
  goalBriefBlock,
  goalProgress,
  isGoalMet,
  refreshGoalValue,
  reportGoalProgress,
  resolveGoal,
  sweepGoals,
  updateGoal,
} from "./goals.js";

/**
 * Goals are the intent layer everything else grades against, so the
 * invariants here are the ones a wrong answer would quietly corrupt: progress
 * arithmetic, the tree rules, company scoping, and — above all — that
 * `achieved` / `missed` settle exactly once however many passes race.
 */

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
    await assert.rejects(reportGoalProgress(companyId, goal.id, 5), GoalError);
  });

  test("an archived goal refuses reports", async () => {
    const goal = await createGoal(companyId, { title: "G", targetValue: 1 }, null);
    await updateGoal(companyId, goal.id, { status: "archived" });
    await assert.rejects(reportGoalProgress(companyId, goal.id, 5), GoalError);
  });

  test("a report that clears the target settles achieved exactly once and notifies", async () => {
    const goal = await createGoal(companyId, { title: "Signups", targetValue: 10 }, null);
    const reported = await reportGoalProgress(companyId, goal.id, 12);
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
