import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { startRoutineRun } from "./runner.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { stopStanddowns } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

async function fixture() {
  const company = await insert(Company, { name: "Retries", slug: "retries", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "retry-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "retry-test",
    }),
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Weekday Active Lead Follow-Up",
    slug: "weekday-active-lead-follow-up",
    cronExpr: "0 9 * * 1-5",
    body: "Review every open Deal and draft follow-ups.",
  });
  return { employee, routine };
}

/** The scheduled attempt a server restart interrupted after it had used native coding. */
function interruptedAttempt(
  employee: AIEmployee,
  routine: Routine,
  values: Partial<Run> = {},
): Promise<Run> {
  return insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "error",
    errorKind: "interrupted",
    triggerKind: "schedule",
    attempt: 1,
    startedAt: new Date(Date.now() - 10 * 60_000),
    finishedAt: new Date(Date.now() - 5 * 60_000),
    requiredToolsJson: JSON.stringify({ tools: ["$native_coding"], grants: [] }),
    ...values,
  });
}

function recordWorkTurns(t: TestContext) {
  const turns: Array<{ nativeCoding?: boolean; system: string }> = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    turns.push({ nativeCoding: params.nativeCoding, system: params.system });
    return { finalText: "Repeated the scheduled review.", steps: 3, stopReason: "end_turn" };
  });
  return turns;
}

// 2026-09-29: three interrupted 09:00 Runs were retried at 10:05, each in the
// proactive-preparation scope, and two failed at once with "Retry preflight
// failed: Required tools are unavailable: $native_coding".
test("a recovery retry repeats scheduled work with that work's scope", async (t) => {
  const { employee, routine } = await fixture();
  const parent = await interruptedAttempt(employee, routine);
  const turns = recordWorkTurns(t);
  const retry = await (
    await startRoutineRun(routine, {
      triggerKind: "retry",
      attempt: 2,
      attemptLimit: 2,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(retry.status, "completed", retry.logContent);
  assert.equal(retry.continuationReviewOnly, false);
  assert.doesNotMatch(retry.logContent, /Retry preflight failed/);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].nativeCoding, true, "the retry keeps the native coding its attempt used");
  assert.doesNotMatch(turns[0].system, /proactive preparation/);
});

test("a retry of reviewed work stays a review", async (t) => {
  const { employee, routine } = await fixture();
  const parent = await interruptedAttempt(employee, routine, {
    continuationReviewOnly: true,
    requiredToolsJson: null,
  });
  const turns = recordWorkTurns(t);
  const retry = await (
    await startRoutineRun(routine, {
      triggerKind: "retry",
      attempt: 2,
      attemptLimit: 2,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(retry.continuationReviewOnly, true);
  assert.equal(retry.status, "reviewed", retry.logContent);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].nativeCoding, false);
  assert.match(turns[0].system, /proactive preparation/);
});
