import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import type { ToolRegistry } from "./agent/tools/toolRegistry.js";
import { stopCron, tickRoutine } from "./cron.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { ROUTINE_WRITE_TOOLS, setRoutineAccess } from "./routineAccess.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { startManualRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";

/**
 * Read + run takes away changing Routines, never running them.
 *
 * The scheduler, a Member's Run now, Triggers, webhooks, and retries all start
 * a Run without consulting Routines → AI access — none of them can be refused
 * by it. These tests drive the two most common doors end to end with the model
 * mocked, and check the one thing the level does change inside a Run: the
 * tools briefing and the working set the employee is handed.
 */

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

const held = () => undefined;

/** One AI Employee on a local model, with one Routine. */
async function employeeWithRoutine(slug: string) {
  const company = await insert(Company, {
    name: `Co ${slug}`,
    slug: `co-${slug}`,
    ownerId: "owner",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    slug,
    role: "Operations",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:11434/v1"),
      modelId: "Qwen/Qwen3.8-27B",
    }),
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Weekly report",
    slug: "weekly-report",
    cronExpr: "0 9 * * 1",
    timeoutSec: 600,
    body: "Write the weekly report.",
    nextRunAt: new Date(Date.now() + 86_400_000),
  });
  return { company, employee, routine };
}

type WorkTurn = { system: string; registry: ToolRegistry; brief: string };

/** Mock the model; record each work turn's system prompt, tools, and brief. */
function recordingModel(t: TestContext): WorkTurn[] {
  const turns: WorkTurn[] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    // Bounded helper turns (grading, summaries) are not the Routine's work.
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const first = params.messages[0]?.content[0];
    turns.push({
      system: params.system,
      registry: params.registry,
      brief: first && "text" in first ? first.text : "",
    });
    return { finalText: "Posted the weekly report.", steps: 2, stopReason: "end_turn" };
  });
  return turns;
}

async function runsOf(routine: Routine): Promise<Run[]> {
  return AppDataSource.getRepository(Run).find({
    where: { routineId: routine.id },
    order: { createdAt: "ASC" },
  });
}

function assertBriefedReadAndRun(turn: WorkTurn) {
  assert.match(turn.system, /\*\*read \+ run\*\* \(Routines → AI access\)/);
  assert.match(turn.system, /are refused for every Routine, yours or a teammate's/);
  assert.doesNotMatch(turn.system, /`create_routine` to schedule one/);
  for (const name of ROUTINE_WRITE_TOOLS) {
    assert.equal(turn.registry.visibility(name), "deferred", `${name} leaves the working set`);
    assert.ok(turn.registry.resolve(name), `${name} stays reachable, and the seam refuses it`);
  }
  assert.equal(turn.registry.visibility("list_routines"), "resident");
}

test("a read + run employee's scheduled Run starts, does its work, and completes", async (t) => {
  const { company, employee, routine } = await employeeWithRoutine("ada");
  await setRoutineAccess(company.id, employee.id, "run");
  const turns = recordingModel(t);

  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();

  const [run] = await runsOf(routine);
  assert.ok(run, "the heartbeat started a Run");
  assert.equal(run.triggerKind, "schedule");
  assert.equal(run.status, "completed", run.logContent);
  assert.equal(turns.length, 1);
  assert.match(turns[0].brief, /Write the weekly report\./);
  assertBriefedReadAndRun(turns[0]);
});

test("a Member's Run now starts a read + run employee's Routine like any other", async (t) => {
  const { company, employee, routine } = await employeeWithRoutine("bea");
  await setRoutineAccess(company.id, employee.id, "run");
  const turns = recordingModel(t);

  const accepted = await startManualRoutineRun(routine, company.id);
  assert.equal(accepted.status, "queued");
  await waitForRoutineQueueIdle();

  const [run] = await runsOf(routine);
  assert.equal(run.id, accepted.id);
  assert.equal(run.status, "completed", run.logContent);
  assert.equal(turns.length, 1);
  assertBriefedReadAndRun(turns[0]);
});

test("a read + write employee's Run is briefed and equipped exactly as before", async (t) => {
  const { routine } = await employeeWithRoutine("cy");
  const turns = recordingModel(t);

  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();

  const [run] = await runsOf(routine);
  assert.equal(run.status, "completed", run.logContent);
  assert.equal(turns.length, 1);
  assert.match(turns[0].system, /`create_routine` to schedule one/);
  assert.doesNotMatch(turns[0].system, /read \+ run/);
  for (const name of ROUTINE_WRITE_TOOLS) {
    assert.equal(turns[0].registry.visibility(name), "resident", name);
  }
});

test("changing the level between Runs changes the next Run's briefing, never whether it runs", async (t) => {
  const { company, employee, routine } = await employeeWithRoutine("dee");
  const turns = recordingModel(t);

  await setRoutineAccess(company.id, employee.id, "run");
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  await setRoutineAccess(company.id, employee.id, "write");
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();

  assert.deepEqual(
    (await runsOf(routine)).map((run) => run.status),
    ["completed", "completed"],
  );
  assert.equal(turns.length, 2);
  assertBriefedReadAndRun(turns[0]);
  assert.match(turns[1].system, /`create_routine` to schedule one/);
});
