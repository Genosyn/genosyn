import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { Routine } from "../db/entities/Routine.js";
import type { Run } from "../db/entities/Run.js";
import { RunLesson } from "../db/entities/RunLesson.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import type { AgentTool } from "./agent/types.js";
import {
  composeLessonsBlock,
  dismissLesson,
  reflectOnRun,
  shouldReflect,
} from "./runLessons.js";

/**
 * The reflection half of the improvement loop: which Runs earn one, that the
 * rate limiter keeps a failing retry chain from writing five near-identical
 * lessons, and that what reaches the next brief is bounded and dismissible.
 */

let companyId: string;
let employee: AIEmployee;
let routine: Routine;

const model = { id: "model-1" } as AIModel;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "",
    acceptanceCriteria: "The digest was posted.",
  });
});

function fakeRun(over: Partial<Run> = {}): Run {
  return {
    id: testId("run"),
    routineId: routine.id,
    status: "failed",
    logContent: "[tool] post_message → error: channel not found",
    outcomeNote: "",
    ...over,
  } as Run;
}

/** Drive the restricted seam by answering with a fixed lesson. */
function submitting(cause: string, advice: string) {
  return (async (params: { tools: AgentTool[] }) => {
    await params.tools[0].run({ cause, advice });
    return { status: "ok", finalText: "", steps: 2, stopReason: "end_turn" };
  }) as never;
}

describe("shouldReflect", () => {
  test("failures and timeouts reflect; clean completions do not", () => {
    assert.equal(shouldReflect("failed", null), true);
    assert.equal(shouldReflect("timeout", null), true);
    assert.equal(shouldReflect("completed", null), false);
    assert.equal(shouldReflect("completed", "achieved"), false);
    assert.equal(shouldReflect("completed", "unclear"), false);
  });

  test("an off-goal completion reflects; interrupted stays with recovery", () => {
    assert.equal(shouldReflect("completed", "off_goal"), true);
    assert.equal(shouldReflect("interrupted", null), false);
    assert.equal(shouldReflect("skipped", null), false);
  });
});

describe("reflectOnRun", () => {
  test("stores the submitted lesson against the routine", async () => {
    const lesson = await reflectOnRun({
      run: fakeRun(),
      routine,
      employee,
      model,
      runRestricted: submitting("Wrong channel id", "Resolve the channel by name first"),
    });
    assert.ok(lesson);
    assert.equal(lesson.routineId, routine.id);
    assert.equal(lesson.companyId, companyId);
    assert.match(lesson.advice, /Resolve the channel/);
  });

  test("the rate limiter yields one lesson per routine per window, not one per attempt", async () => {
    const first = await reflectOnRun({
      run: fakeRun(),
      routine,
      employee,
      model,
      runRestricted: submitting("Cause A", "Advice A"),
    });
    assert.ok(first);
    const second = await reflectOnRun({
      run: fakeRun(),
      routine,
      employee,
      model,
      runRestricted: submitting("Cause B", "Advice B"),
    });
    assert.equal(second, null);
    assert.equal(await AppDataSource.getRepository(RunLesson).countBy({ routineId: routine.id }), 1);
  });

  test("a turn that submits nothing stores nothing", async () => {
    const lesson = await reflectOnRun({
      run: fakeRun(),
      routine,
      employee,
      model,
      runRestricted: (async () => ({
        status: "ok",
        finalText: "It went badly.",
        steps: 1,
      })) as never,
    });
    assert.equal(lesson, null);
    assert.equal(await AppDataSource.getRepository(RunLesson).countBy({ routineId: routine.id }), 0);
  });

  test("a reflection outage costs nothing but the lesson", async () => {
    const lesson = await reflectOnRun({
      run: fakeRun(),
      routine,
      employee,
      model,
      runRestricted: (async () => {
        throw new Error("provider unreachable");
      }) as never,
    });
    assert.equal(lesson, null);
  });
});

describe("composeLessonsBlock", () => {
  test("empty when there is nothing to say — no header with nothing under it", async () => {
    assert.equal(await composeLessonsBlock(routine.id), "");
  });

  test("folds the latest undismissed lessons, bounded to five", async () => {
    for (let n = 1; n <= 7; n++) {
      await insert(RunLesson, {
        companyId,
        employeeId: employee.id,
        routineId: routine.id,
        runId: testId(`run-${n}`),
        cause: `Cause ${n}`,
        advice: `Advice ${n}`,
      });
    }
    const block = await composeLessonsBlock(routine.id);
    assert.match(block, /## Lessons from earlier Runs/);
    assert.match(block, /Advice, not orders/);
    assert.equal((block.match(/^- /gm) ?? []).length, 5);
  });

  test("a dismissed lesson leaves future briefs immediately", async () => {
    const lesson = await insert(RunLesson, {
      companyId,
      employeeId: employee.id,
      routineId: routine.id,
      runId: testId("run"),
      cause: "Wrong channel",
      advice: "Resolve the channel by name",
    });
    assert.match(await composeLessonsBlock(routine.id), /Resolve the channel/);
    const dismissed = await dismissLesson(companyId, lesson.id);
    assert.ok(dismissed?.dismissedAt);
    assert.equal(await composeLessonsBlock(routine.id), "");
  });

  test("dismissal scopes by company", async () => {
    const lesson = await insert(RunLesson, {
      companyId,
      employeeId: employee.id,
      routineId: routine.id,
      runId: testId("run"),
      cause: "c",
      advice: "a",
    });
    assert.equal(await dismissLesson(testId("other-co"), lesson.id), null);
  });
});
