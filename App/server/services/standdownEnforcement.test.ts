import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineTrigger } from "../db/entities/RoutineTrigger.js";
import { Run } from "../db/entities/Run.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { streamChatWithEmployee, type ChatResult } from "./chat.js";
import { bootCron, dispatchDueRetries, stopCron } from "./cron.js";
import { dispatchTriggerEvent } from "./routineTriggers.js";
import { startRoutineRun } from "./runner.js";
import { StanddownError, liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";
import { dispatchDueWakeups } from "./wakeups.js";

/**
 * Where the stop is actually enforced.
 *
 * `standdowns.test.ts` proves the predicate answers correctly. This file is
 * about the seams that ask it: a predicate nobody calls stops nothing, and
 * every one of these call sites compiles perfectly while doing the wrong
 * thing. The two behaviours worth the most here are the ones that are easy to
 * get backwards — a stop must **defer** owed work rather than cancel it, and it
 * must **not** hold the schedule still, because a month-old stop that keeps
 * every missed slot queued turns the lift into the incident.
 */

let company: Company;
let employee: AIEmployee;
let routine: Routine;
let otherEmployee: AIEmployee;
let otherRoutine: Routine;

before(initTestDb);
after(async () => {
  stopCron();
  stopStanddowns();
  await closeTestDb();
});

beforeEach(async () => {
  stopStanddowns();
  await resetTestDb();
  company = await insert(Company, {
    name: "Stop Co",
    slug: "stop-co",
    ownerId: "owner-stop",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sam Stopper",
    slug: "sam-stopper",
    role: "Operations",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly sweep",
    slug: "nightly-sweep",
    cronExpr: "0 3 * * *",
    body: "Sweep.",
  });
  otherEmployee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ola Other",
    slug: "ola-other",
    role: "Writer",
  });
  otherRoutine = await insert(Routine, {
    employeeId: otherEmployee.id,
    name: "Weekly digest",
    slug: "weekly-digest",
    cronExpr: "0 9 * * 1",
    body: "Digest.",
  });
});

afterEach(() => {
  stopCron();
  stopStanddowns();
});

async function runCount(routineId: string): Promise<number> {
  return AppDataSource.getRepository(Run).countBy({ routineId });
}

/**
 * The Trigger path starts its Run detached, so the control below has to wait
 * for a row rather than read one. Bounded, and it fails by timing out — a
 * control that quietly gave up would be worth less than no control at all.
 */
async function waitForRun(routineId: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await runCount(routineId);
    if (count > 0 || Date.now() > deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("startRoutineRun under a Standdown", () => {
  for (const scope of ["company", "employee", "routine"] as const) {
    test(`refuses at ${scope} scope and writes no Run row`, async () => {
      await placeStanddown({
        companyId: company.id,
        scope,
        scopeId:
          scope === "company" ? null : scope === "employee" ? employee.id : routine.id,
        reason: `stopped at ${scope} scope`,
      });

      await assert.rejects(
        () => startRoutineRun(routine, { triggerKind: "schedule" }),
        (error: unknown) => {
          assert.ok(error instanceof StanddownError, "must be a StanddownError, not a bare Error");
          assert.match(error.message, /stopped at/);
          return true;
        },
      );

      // No `skipped` row either: a stop is not this Routine failing, and a row
      // saying otherwise would make every consumer render the stop as the
      // incident.
      assert.equal(await runCount(routine.id), 0);
    });
  }

  test("proceeds when the standdown covers a different Routine", async () => {
    await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: otherRoutine.id,
      reason: "only the digest is stopped",
    });

    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    const finished = await started.completion;

    // No AI Model is connected, so the Run settles `skipped` — the point is
    // that a Run row exists at all, which is exactly what the stop prevents.
    assert.equal(finished.status, "skipped");
    assert.equal(await runCount(routine.id), 1);
  });

  test("proceeds when the standdown covers a different AI Employee", async () => {
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: otherEmployee.id,
      reason: "only Ola is stopped",
    });

    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    await started.completion;
    assert.equal(await runCount(routine.id), 1);
  });

  test("proceeds again once the standdown is lifted", async () => {
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "paused for an audit",
    });
    await assert.rejects(() => startRoutineRun(routine, { triggerKind: "schedule" }));

    await liftStanddown({ standdown, reason: "audit closed" });

    const started = await startRoutineRun(routine, { triggerKind: "schedule" });
    await started.completion;
    assert.equal(await runCount(routine.id), 1);
  });
});

describe("chat under a Standdown", () => {
  async function chat(): Promise<ChatResult> {
    return streamChatWithEmployee(company.id, employee.id, "status please", [], () => {}, {
      toolAuthority: "employee",
    });
  }

  test("refuses under a company standdown, naming the reason", async () => {
    await placeStanddown({
      companyId: company.id,
      scope: "company",
      reason: "incident 4471",
    });

    const result = await chat();

    assert.equal(result.status, "error");
    assert.match(result.reply, /stood down and cannot work right now/);
    assert.match(result.reply, /incident 4471/);
  });

  test("refuses under an employee standdown", async () => {
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: employee.id,
      reason: "Sam is stopped",
    });

    const result = await chat();

    assert.equal(result.status, "error");
    assert.match(result.reply, /Sam is stopped/);
  });

  test("a Routine standdown deliberately does not stop chat", async () => {
    await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "only the sweep is stopped",
    });

    const result = await chat();

    // The employee has no model, so the turn cannot succeed — but it must fail
    // for that reason and not because a Routine-scoped stop leaked into chat.
    assert.doesNotMatch(result.reply, /stood down/);
    assert.doesNotMatch(result.reply, /only the sweep is stopped/);
  });
});

describe("dispatchDueWakeups under a Standdown", () => {
  async function dueWakeup(): Promise<EmployeeWakeup> {
    // A wakeup with no AI Model behind it lands in the journal instead of a
    // session, which would make "did it fire?" unobservable at the seam this
    // test is about.
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "custom",
      model: "wakeup-stub",
      authMode: "customEndpoint",
      isActive: true,
      connectedAt: new Date(),
      configJson: "{}",
    });
    return insert(EmployeeWakeup, {
      companyId: company.id,
      employeeId: employee.id,
      at: new Date(Date.now() - 60 * 1000),
      brief: "check the invoice",
      status: "pending",
    });
  }

  test("defers rather than firing or cancelling, then fires after the lift", async () => {
    const wakeup = await dueWakeup();
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: employee.id,
      reason: "Sam is stopped",
    });
    const briefs: string[] = [];
    const fakeChat = (async (_companyId: string, _employeeId: string, message: string) => {
      briefs.push(message);
      return { status: "ok", reply: "on it", attachmentIds: [], sidecars: {} };
    }) as unknown as Parameters<typeof dispatchDueWakeups>[1];

    await dispatchDueWakeups(new Date(), fakeChat);

    const deferred = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(deferred.status, "pending", "a deferred wakeup must not be consumed");
    assert.equal(deferred.firedAt, null);
    assert.equal(briefs.length, 0);

    await liftStanddown({ standdown, reason: "resumed" });
    await dispatchDueWakeups(new Date(), fakeChat);

    const fired = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fired.status, "fired");
    assert.equal(briefs.length, 1);
  });

  test("a standdown on another AI Employee does not defer this one", async () => {
    const wakeup = await dueWakeup();
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: otherEmployee.id,
      reason: "Ola is stopped",
    });
    const fakeChat = (async () => ({
      status: "ok",
      reply: "on it",
      attachmentIds: [],
      sidecars: {},
    })) as unknown as Parameters<typeof dispatchDueWakeups>[1];

    await dispatchDueWakeups(new Date(), fakeChat);

    const fired = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fired.status, "fired");
  });
});

describe("dispatchTriggerEvent under a Standdown", () => {
  async function trigger(): Promise<RoutineTrigger> {
    return insert(RoutineTrigger, {
      companyId: company.id,
      routineId: routine.id,
      kind: "deal",
      scopeId: null,
      enabled: true,
      minIntervalSec: 0,
      lastFiredAt: null,
    });
  }

  test("a company standdown fires nothing and does not even consume the interval", async () => {
    const row = await trigger();
    await placeStanddown({
      companyId: company.id,
      scope: "company",
      reason: "everything is stopped",
    });

    await dispatchTriggerEvent(company.id, "deal", ["deal-1"]);

    assert.equal(await runCount(routine.id), 0);
    const after = await AppDataSource.getRepository(RoutineTrigger).findOneByOrFail({
      id: row.id,
    });
    assert.equal(after.lastFiredAt, null);
  });

  test("control: the same event does start a Run when nothing is stood down", async () => {
    await trigger();

    await dispatchTriggerEvent(company.id, "deal", ["deal-1"]);

    assert.equal(
      await waitForRun(routine.id),
      1,
      "if this fails the standdown assertions above prove nothing",
    );
  });

  test("a Routine standdown consumes the interval but starts no Run", async () => {
    const row = await trigger();
    await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "only the sweep is stopped",
    });

    await dispatchTriggerEvent(company.id, "deal", ["deal-1"]);

    assert.equal(await runCount(routine.id), 0);
    // Deliberate: the slot is spent so lifting does not release a burst of
    // triggers that all became due while work was stopped.
    const after = await AppDataSource.getRepository(RoutineTrigger).findOneByOrFail({
      id: row.id,
    });
    assert.notEqual(after.lastFiredAt, null);
  });
});

describe("the retry queue under a Standdown", () => {
  async function owedRetry(now: Date): Promise<Run> {
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { maxAttempts: 3, retryBackoffSec: 60 },
    );
    return insert(Run, {
      routineId: routine.id,
      startedAt: new Date(now.getTime() - 10 * 60 * 1000),
      finishedAt: new Date(now.getTime() - 9 * 60 * 1000),
      status: "failed",
      exitCode: null,
      logContent: "failed\n",
      triggerKind: "schedule",
      attempt: 1,
      parentRunId: null,
      retryAt: new Date(now.getTime() - 60 * 1000),
      missedSlots: 0,
    });
  }

  test("defers the owed attempt instead of cancelling it", async () => {
    const now = new Date();
    const parent = await owedRetry(now);
    await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "paused mid-incident",
    });

    const result = await dispatchDueRetries(now);

    assert.equal(result.started, 0);
    const after = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
    assert.notEqual(
      after.retryAt,
      null,
      "cancelling an owed retry converts a pause into a decision nobody made",
    );
    assert.ok((after.retryAt as Date).getTime() > now.getTime());
    // The attempt itself was not started: no child Run exists.
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 0);
  });

  test("starts the owed attempt once the standdown is lifted", async () => {
    const now = new Date();
    const parent = await owedRetry(now);
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: routine.id,
      reason: "paused mid-incident",
    });
    await dispatchDueRetries(now);
    await liftStanddown({ standdown, reason: "resumed" });

    // The deferral pushed `retryAt` forward; the lift makes it eligible again
    // at that later moment rather than dropping the attempt.
    const deferred = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
    const later = new Date((deferred.retryAt as Date).getTime() + 1000);
    const result = await dispatchDueRetries(later);
    await Promise.all(result.completions);

    assert.equal(result.started, 1);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 1);
  });
});

describe("the schedule under a Standdown", () => {
  test("a due Routine still has nextRunAt advanced, so a lift is not a catch-up storm", async () => {
    const overdue = new Date(Date.now() - 6 * 60 * 60 * 1000);
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { cronExpr: "*/5 * * * *", nextRunAt: overdue },
    );
    await placeStanddown({
      companyId: company.id,
      scope: "company",
      reason: "everything is stopped",
    });

    // Phase 2 lives inside the heartbeat's unexported `tick()`; `bootCron`
    // awaits exactly one pass of it, which is the only reachable way in.
    await bootCron();
    stopCron();

    const after = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.ok(after.nextRunAt, "the schedule must not be left frozen in the past");
    assert.ok(
      (after.nextRunAt as Date).getTime() > Date.now(),
      "a stop that holds nextRunAt still queues every missed slot for the lift",
    );
    assert.equal(await runCount(routine.id), 0);
  });

  test("control: the same pass does start the Routine when nothing is stood down", async () => {
    const overdue = new Date(Date.now() - 6 * 60 * 60 * 1000);
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { cronExpr: "*/5 * * * *", nextRunAt: overdue },
    );

    await bootCron();
    stopCron();
    // The Run row is durable before `tickRoutine` returns; the agent half of it
    // settles `skipped` on its own because no AI Model is connected.
    assert.equal(
      await runCount(routine.id),
      1,
      "if this fails the standdown assertion above proves nothing",
    );
  });
});
