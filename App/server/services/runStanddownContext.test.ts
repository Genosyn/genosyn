import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Standdown } from "../db/entities/Standdown.js";
import { Workstream } from "../db/entities/Workstream.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { saveRunCheckpoint } from "./runContinuation.js";
import { startRoutineRun } from "./runner.js";
import { waitForRoutineQueueIdle } from "./routineQueue.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { liftStanddown, placeStanddown, stopStanddowns, workBlocked } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

const staleReason = "employee standdown requires a human lift and none was supplied";

async function fixture() {
  const company = await insert(Company, { name: "Resume Co", slug: "resume-co", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily CRM Sync",
    slug: "daily-crm-sync",
    cronExpr: "0 9 * * *",
    body: "Review the daily Deal window.",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "test",
    }),
  });
  const standdown = await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: routine.id,
    reason: "Review this Routine's work.",
    placedByUserId: "owner",
  });
  await liftStanddown({ standdown, userId: "owner", reason: "Ready to resume." });
  // Keep the exact misleading historical text shipped before scope-aware entries.
  // A model can also retrieve it by ID even when the lift is outside its preview.
  await insert(JournalEntry, {
    employeeId: employee.id,
    kind: "system",
    title: "Your work was stood down",
    body: "Nothing you are scheduled for will run. Work resumes when a human lifts the standdown.",
  });
  return { company, employee, routine };
}

test("a resumed Routine gets live scope authority despite stale Journal and blocked Workstream text", async (t) => {
  const { company, employee, routine } = await fixture();
  await insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    routineId: routine.id,
    title: "Daily review",
    stateDoc: `Blocked: ${staleReason}.`,
  });
  const other = await insert(Routine, {
    employeeId: employee.id,
    name: "Other Routine",
    slug: "other",
    cronExpr: "0 10 * * *",
    body: "Other work.",
  });
  await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: other.id,
    reason: "Only this other Routine is stopped.",
    placedByUserId: "owner",
  });
  let workTurns = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.registry.resolve("submit_lesson"))
      return { finalText: "No lesson submitted.", steps: 1, stopReason: "end_turn" };
    workTurns++;
    assert.match(params.system, /Your work was stood down/);
    assert.match(
      params.system,
      /No active company, AI Employee, or Routine Standdown covers this Run\./,
    );
    assert.ok(params.system.includes(routine.id), "the status must name this Run's Routine");
    assert.ok(
      params.system.indexOf("## Current Standdown status") >
        params.system.indexOf("## Recent activity"),
    );
    assert.match(JSON.stringify(params.messages), new RegExp(staleReason));
    return { finalText: "Reviewed the current Deal window.", steps: 1, stopReason: "end_turn" };
  });
  const result = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
  assert.equal(workTurns, 1);
  assert.equal(result.status, "completed", result.logContent ?? "");
  assert.equal(workBlocked(company.id, { employeeId: employee.id }).blocked, false);
  assert.equal(
    workBlocked(company.id, { employeeId: employee.id, routineId: other.id }).blocked,
    true,
  );
  assert.equal(
    await AppDataSource.getRepository(Standdown).count(),
    2,
    "a Run cannot place its own Standdown",
  );
});

test("manual continuation receives current authority alongside its older checkpoint", async (t) => {
  const { company, employee, routine } = await fixture();
  const source = await insert(Run, {
    routineId: routine.id,
    status: "failed",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(Date.now() - 30_000),
    checkpointJson: JSON.stringify({
      state: "continue",
      completed: "Reviewed Deal 1.",
      remaining: "Review Deal 2.",
      resume: `Earlier blocker: ${staleReason}. Continue with Deal 2 once lifted.`,
      progressKey: "deal-1",
    }),
  });
  let workTurns = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.registry.resolve("submit_lesson"))
      return { finalText: "No lesson submitted.", steps: 1, stopReason: "end_turn" };
    workTurns++;
    assert.match(
      params.system,
      /No active company, AI Employee, or Routine Standdown covers this Run\./,
    );
    assert.match(JSON.stringify(params.messages), new RegExp(staleReason));
    const run = await AppDataSource.getRepository(Run).findOneByOrFail({
      routineId: routine.id,
      status: "running",
    });
    const token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      routineId: routine.id,
      runId: run.id,
    });
    try {
      await saveRunCheckpoint(token, {
        state: "complete",
        completed: "Reviewed both Deals.",
        remaining: "",
        resume: "",
        progressKey: "deal-2",
      });
    } finally {
      revokeMcpToken(token);
    }
    return { finalText: "Reviewed both Deals.", steps: 1, stopReason: "end_turn" };
  });
  const result = await (await startRoutineRun(routine, { resumeFromRunId: source.id })).completion;
  assert.equal(workTurns, 1);
  assert.equal(result.status, "completed", result.logContent ?? "");
  assert.equal(result.parentRunId, source.id);
});
