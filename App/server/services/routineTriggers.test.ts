import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineTrigger } from "../db/entities/RoutineTrigger.js";
import { AppDataSource } from "../db/datasource.js";
import { LIVE_SYNC_KINDS } from "../db/subscribers/resourceChangeSubscriber.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  RoutineTriggerError,
  assertValidTriggerKind,
  dispatchTriggerEvent,
} from "./routineTriggers.js";

/**
 * Trigger guarantees: only registry kinds subscribe, scope narrows, the
 * interval claim fires once per window however many flushes race, and a
 * gated Routine's fire meets its Approval — never a bypass.
 */

let companyId: string;
let employee: AIEmployee;

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
});

async function gatedRoutine(): Promise<Routine> {
  return insert(Routine, {
    employeeId: employee.id,
    name: "Deal watcher",
    slug: "deal-watcher",
    cronExpr: "0 9 * * *",
    body: "",
    enabled: true,
    requiresApproval: true,
  });
}

async function addTrigger(routineId: string, over: Partial<RoutineTrigger> = {}) {
  return insert(RoutineTrigger, {
    companyId,
    routineId,
    kind: "deal",
    minIntervalSec: 900,
    enabled: true,
    ...over,
  });
}

describe("kind validation", () => {
  test("registry kinds pass; anything else is refused with the vocabulary", () => {
    assert.ok(LIVE_SYNC_KINDS.includes("routine"));
    assertValidTriggerKind("routine");
    assert.throws(() => assertValidTriggerKind("keystrokes"), RoutineTriggerError);
  });
});

describe("dispatchTriggerEvent", () => {
  test("a gated routine's fire enqueues the Approval a cron tick would", async () => {
    const routine = await gatedRoutine();
    await addTrigger(routine.id);
    await dispatchTriggerEvent(companyId, "deal", []);
    const approvals = await AppDataSource.getRepository(Approval).findBy({
      routineId: routine.id,
    });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "pending");
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "routine.run.event",
    });
    assert.equal(audits.length, 1);
  });

  test("the interval claim fires once however many flushes race", async () => {
    const routine = await gatedRoutine();
    await addTrigger(routine.id);
    await Promise.all([
      dispatchTriggerEvent(companyId, "deal", []),
      dispatchTriggerEvent(companyId, "deal", []),
    ]);
    await dispatchTriggerEvent(companyId, "deal", []);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findBy({ routineId: routine.id })).length,
      1,
    );
  });

  test("scope narrows: a scoped trigger ignores other scopes but matches an overflowed frame", async () => {
    const routine = await gatedRoutine();
    const scope = testId("scope");
    await addTrigger(routine.id, { scopeId: scope });
    await dispatchTriggerEvent(companyId, "deal", [testId("other-scope")]);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findBy({ routineId: routine.id })).length,
      0,
    );
    // An empty scope set means the specifics overflowed — treat company-wide.
    await dispatchTriggerEvent(companyId, "deal", []);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findBy({ routineId: routine.id })).length,
      1,
    );
  });

  test("disabled triggers, disabled routines, and other kinds fire nothing", async () => {
    const routine = await gatedRoutine();
    await addTrigger(routine.id, { enabled: false });
    await dispatchTriggerEvent(companyId, "deal", []);
    await AppDataSource.getRepository(RoutineTrigger).update(
      { routineId: routine.id },
      { enabled: true },
    );
    await AppDataSource.getRepository(Routine).update({ id: routine.id }, { enabled: false });
    await dispatchTriggerEvent(companyId, "deal", []);
    await dispatchTriggerEvent(companyId, "mail", []);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findBy({ routineId: routine.id })).length,
      0,
    );
  });
});
