import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineTrigger } from "../db/entities/RoutineTrigger.js";
import { Run } from "../db/entities/Run.js";
import { Workstream } from "../db/entities/Workstream.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import { stopCron, tickRoutine } from "./cron.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { dispatchTriggerEvent } from "./routineTriggers.js";
import { startManualRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";

/**
 * The customer report (genosyn#200) end to end: Follow through on open work
 * fired every 30 minutes and on every Workstream change, and each time ran a
 * full model turn plus an outcome check on an idle employee. With a run
 * condition, a scheduled time or Trigger fire with nothing due writes no Run,
 * asks no AI Model and no person, and the one that has a revisit to take up
 * runs exactly as before — with a brief that says what is due.
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
let company: Company;
let employee: AIEmployee;

async function setup() {
  company = await insert(Company, { name: "Idle Co", slug: "idle", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  await insertEmployeeModel({
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
}

function followThrough(values: Partial<Routine> = {}): Promise<Routine> {
  return insert(Routine, {
    employeeId: employee.id,
    name: "Follow through on open work",
    slug: "follow-through",
    cronExpr: "*/30 * * * *",
    timeoutSec: 600,
    body: "Resume your due Workstreams.",
    // Criteria mean every completed Run also gets an outcome check: a second
    // model turn an idle start must not spend either.
    acceptanceCriteria: "Advance due work; stay quiet otherwise.",
    runCondition: "workstream_due",
    nextRunAt: new Date(Date.now() + 86_400_000),
    ...values,
  });
}

function dueWorkstream(values: Partial<Workstream> = {}): Promise<Workstream> {
  return insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Check the invoice fix",
    stateDoc: "Work session queued; check whether it finished.",
    revisitAt: new Date(Date.now() - 60_000),
    ...values,
  });
}

/** Every model turn: work turns record their brief; restricted turns (grading) are counted. */
function mockModel(t: TestContext, work?: () => Promise<void>) {
  const calls = { work: [] as string[], restricted: 0 };
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) {
      calls.restricted += 1;
      return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    }
    const first = params.messages[0]?.content[0];
    calls.work.push(first && "text" in first ? first.text : "");
    await work?.();
    return { finalText: "Checked the due Workstream.", steps: 2, stopReason: "end_turn" };
  });
  return calls;
}

const runsOf = (routine: Routine) =>
  AppDataSource.getRepository(Run).find({
    where: { routineId: routine.id },
    order: { createdAt: "ASC" },
  });
const reload = (routine: Routine) =>
  AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });

test("an idle employee's scheduled times start no Run, ask no model and ask no person", async (t) => {
  await setup();
  const calls = mockModel(t);
  const plain = await followThrough();
  const gated = await followThrough({ slug: "gated", requiresApproval: true });
  // Open work with nothing planned, and work planned for later, are both idle.
  await dueWorkstream({ title: "Waiting on a person", revisitAt: null });
  await dueWorkstream({ title: "Later", revisitAt: new Date(Date.now() + 3_600_000) });

  for (let slot = 0; slot < 3; slot += 1) {
    await tickRoutine(plain.id, { missedSlots: 0 }, held);
    await tickRoutine(gated.id, { missedSlots: 0 }, held);
  }
  await waitForRoutineQueueIdle();

  assert.deepEqual(await runsOf(plain), []);
  assert.deepEqual(await runsOf(gated), []);
  assert.equal(await AppDataSource.getRepository(Approval).count(), 0, "no person is asked");
  assert.equal(calls.work.length, 0, "no work turn");
  assert.equal(calls.restricted, 0, "no outcome check");
  const saved = await reload(plain);
  assert.equal(saved.nothingDueCount, 3);
  assert.ok(saved.nothingDueAt, "the last look is recorded");
  assert.equal((await reload(gated)).nothingDueCount, 3);
});

test("a revisit that has come starts one Run that names it; the next time starts none", async (t) => {
  await setup();
  const calls = mockModel(t);
  const routine = await followThrough();
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  assert.equal((await reload(routine)).nothingDueCount, 1, "idle before the revisit came");

  const work = await dueWorkstream();
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  const [finished] = await runsOf(routine);
  assert.equal(finished.status, "completed", finished.logContent);
  assert.equal(finished.triggerKind, "schedule");
  assert.equal(calls.work.length, 1);
  assert.match(calls.work[0], /## Due now/);
  assert.match(calls.work[0], /Genosyn started this Run because a revisit you planned has come/);
  assert.ok(calls.work[0].includes(`"Check the invoice fix" (workstreamId ${work.id})`));
  assert.match(calls.work[0], /revisitAt/);
  assert.equal(calls.restricted, 1, "the Run that did work is graded as before");
  assert.equal(
    (await reload(routine)).nothingDueCount,
    0,
    "a finished Run starts the count afresh",
  );

  // The employee planned no new revisit: the one it took up is not due again.
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  assert.equal((await runsOf(routine)).length, 1);
  assert.equal(calls.work.length, 1);
  assert.equal((await reload(routine)).nothingDueCount, 2);

  // A new revisit that comes later starts the next one.
  await AppDataSource.getRepository(Workstream).update(work.id, {
    revisitAt: new Date(Date.now() + 5),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  assert.equal((await runsOf(routine)).length, 2);
  assert.equal(calls.work.length, 2);
});

test("a Run that ended in an Error leaves the revisit due for the next scheduled time", async (t) => {
  await setup();
  let fail = true;
  const calls = mockModel(t, async () => {
    if (fail) throw new Error("The runtime crashed before it reached the Workstream.");
  });
  const routine = await followThrough();
  await dueWorkstream();

  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  const [errored] = await runsOf(routine);
  assert.equal(errored.status, "error", errored.logContent);

  fail = false;
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  const runs = await runsOf(routine);
  assert.equal(runs.length, 2, "the revisit was still due");
  assert.equal(runs[1].status, "completed", runs[1].logContent);
  assert.equal(calls.work.length, 2);
  assert.equal((await reload(routine)).nothingDueCount, 0);
});

test("Run now runs with nothing due, and says it was asked for", async (t) => {
  await setup();
  const calls = mockModel(t);
  const routine = await followThrough();
  const started = await startManualRoutineRun(routine, company.id);
  await waitForRoutineQueueIdle();
  const finished = await AppDataSource.getRepository(Run).findOneByOrFail({ id: started.id });
  assert.equal(finished.status, "completed", finished.logContent);
  assert.equal(finished.triggerKind, "manual");
  assert.equal(calls.work.length, 1);
  assert.match(
    calls.work[0],
    /None of your Workstreams has reached its revisit time\. This Run was asked for/,
  );
});

test("a Trigger fire with nothing due starts nothing, records nothing, and spends its interval", async (t) => {
  await setup();
  const calls = mockModel(t);
  const routine = await followThrough();
  const trigger = await insert(RoutineTrigger, {
    companyId: company.id,
    routineId: routine.id,
    kind: "workstream",
    minIntervalSec: 3600,
    enabled: true,
  });

  await dispatchTriggerEvent(company.id, "workstream", []);
  await waitForRoutineQueueIdle();
  assert.deepEqual(await runsOf(routine), []);
  assert.equal(calls.work.length, 0);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({ action: "routine.run.event" }),
    0,
    "no audit row claims the Routine was started",
  );
  assert.equal(
    await AppDataSource.getRepository(JournalEntry).countBy({ routineId: routine.id }),
    0,
    "no journal entry either",
  );
  assert.equal((await reload(routine)).nothingDueCount, 1);
  const claimed = await AppDataSource.getRepository(RoutineTrigger).findOneByOrFail({
    id: trigger.id,
  });
  assert.ok(claimed.lastFiredAt, "the fire used its interval, so it cannot loop on itself");

  // Once a revisit has come and the interval has passed, the next change starts it.
  await dueWorkstream();
  await AppDataSource.getRepository(RoutineTrigger).update(trigger.id, { lastFiredAt: null });
  await dispatchTriggerEvent(company.id, "workstream", []);
  await waitForRoutineQueueIdle();
  const [fired] = await runsOf(routine);
  assert.equal(fired?.triggerKind, "event");
  // Event-started work ends Reviewed, exactly as before conditions existed.
  assert.equal(fired.status, "reviewed", fired.logContent);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({ action: "routine.run.event" }),
    1,
  );
});

test("a Routine that always runs keeps running every scheduled time", async (t) => {
  await setup();
  const calls = mockModel(t);
  const routine = await followThrough({ slug: "always", runCondition: "always" });
  await tickRoutine(routine.id, { missedSlots: 0 }, held);
  await waitForRoutineQueueIdle();
  const [finished] = await runsOf(routine);
  assert.equal(finished.status, "completed", finished.logContent);
  assert.equal(calls.work.length, 1);
  assert.doesNotMatch(calls.work[0], /## Due now/);
  assert.equal((await reload(routine)).nothingDueCount, 0);
});
