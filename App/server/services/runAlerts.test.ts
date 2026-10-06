import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import { notifyRunFailure, notifyRunOffGoal } from "./runAlerts.js";

/**
 * Who hears that scheduled work broke: the company's owners and admins.
 *
 * The audience used to add the Member at the top of the employee's reporting
 * line, who might be neither. Reporting lines were removed, so these pin the
 * remaining rule — every owner and admin, once each, and no plain Member —
 * along with the parts that never depended on it.
 */

let companyId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let employee: AIEmployee;
let routine: Routine;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  ownerId = testId("owner");
  adminId = testId("admin");
  memberId = testId("member");
  await insert(Company, { id: companyId, name: "Acme", slug: "acme", ownerId });
  await insert(Membership, { companyId, userId: ownerId, role: "owner" });
  await insert(Membership, { companyId, userId: adminId, role: "admin" });
  await insert(Membership, { companyId, userId: memberId, role: "member" });
  // An owner of another company must never hear about this one.
  await insert(Membership, { companyId: testCompanyId(), userId: testId("other"), role: "owner" });
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Morning digest",
    slug: "morning-digest",
    cronExpr: "0 9 * * *",
    body: "Summarise the inbox.",
  });
});

function run(over: Partial<Run> = {}): Promise<Run> {
  return insert(Run, {
    routineId: routine.id,
    status: "failed",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(),
    logContent: "",
    attempt: 1,
    retryAt: null,
    ...over,
  });
}

const bells = (kind: Notification["kind"]) =>
  AppDataSource.getRepository(Notification).findBy({ kind });

describe("notifyRunFailure", () => {
  test("pages every owner and admin once, and no plain Member", async () => {
    const failed = await run();
    await notifyRunFailure(failed);
    const rows = await bells("run_failed");
    assert.deepEqual(rows.map((row) => row.userId).sort(), [adminId, ownerId].sort());
    for (const row of rows) {
      assert.equal(row.companyId, companyId);
      assert.equal(row.entityKind, "run");
      assert.equal(row.entityId, failed.id);
      assert.equal(row.actorId, employee.id);
      assert.equal(row.title, 'Routine "Morning digest" failed');
      assert.equal(row.link, `/c/acme/routines?routine=${routine.id}&run=${failed.id}`);
    }
  });

  test("says an Error is an Error, and counts the attempts it took", async () => {
    await notifyRunFailure(await run({ status: "error", attempt: 3 }));
    const [row] = await bells("run_failed");
    assert.equal(row.title, 'Routine "Morning digest" ended with an Error');
    assert.match(row.body, /after 3 attempts/);
  });

  test("stays quiet while a retry is still scheduled", async () => {
    await notifyRunFailure(await run({ retryAt: new Date(Date.now() + 60_000) }));
    assert.deepEqual(await bells("run_failed"), []);
  });

  test("a company with no owner or admin left pages nobody, and does not throw", async () => {
    await AppDataSource.getRepository(Membership).delete({ companyId, role: "owner" });
    await AppDataSource.getRepository(Membership).delete({ companyId, role: "admin" });
    await notifyRunFailure(await run());
    assert.deepEqual(await bells("run_failed"), []);
  });
});

describe("notifyRunOffGoal", () => {
  test("pages every owner and admin once with the checker's note, and no plain Member", async () => {
    const offGoal = await run({ status: "completed", outcomeVerdict: "off_goal" });
    await notifyRunOffGoal(offGoal, "The digest skipped two threads.");
    const rows = await bells("run_off_goal");
    assert.deepEqual(rows.map((row) => row.userId).sort(), [adminId, ownerId].sort());
    for (const row of rows) {
      assert.equal(row.title, 'Routine "Morning digest" finished off-goal');
      assert.equal(row.body, "The digest skipped two threads.");
      assert.equal(row.entityId, offGoal.id);
    }
  });

  test("falls back to plain words when the checker left no note", async () => {
    await notifyRunOffGoal(await run({ status: "completed" }), "");
    const [row] = await bells("run_off_goal");
    assert.match(row.body, /does not meet the Routine's acceptance criteria/);
  });
});
