import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AutonomyWaiver } from "../db/entities/AutonomyWaiver.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineCheck } from "../db/entities/RoutineCheck.js";
import { Run } from "../db/entities/Run.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  computeAutonomyPromotions,
  contractAutonomyOnBadRun,
  executeAutonomyPromotion,
  revokeWaiver,
  routineAutonomyEvidence,
} from "./autonomy.js";

/**
 * Earned autonomy's two invariants, tested from both ends: promotion is
 * drafted only for a clean, evidenced record and always lands as a pending
 * Approval (never applies anything itself); demotion revokes exactly once,
 * re-arms the gate it waived, and pages the humans.
 *
 * M58 adds the third: "clean" must mean verified, not merely uneventful. A Run
 * nobody graded, a checker outage, and a required Check that did not pass all
 * used to count as evidence of good work, which meant the surest way to earn
 * unattended work was to be measured by nothing at all.
 */

let companyId: string;
let employee: AIEmployee;
let ownerId: string;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  ownerId = testId("owner");
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
    browserApprovalRequired: true,
  });
  await insert(Membership, { companyId, userId: ownerId, role: "owner" });
});

async function seedCleanRecord(args: { runs?: number; browserApprovals?: number } = {}) {
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "",
  });
  for (let n = 0; n < (args.runs ?? 12); n++) {
    await insert(Run, {
      routineId: routine.id,
      status: "completed",
      logContent: "",
      triggerKind: "schedule",
      startedAt: new Date(),
    });
  }
  for (let n = 0; n < (args.browserApprovals ?? 6); n++) {
    await insert(Approval, {
      companyId,
      employeeId: employee.id,
      routineId: "",
      kind: "browser_action",
      status: "approved",
    });
  }
  return routine;
}

function promotions(): Promise<Approval[]> {
  return AppDataSource.getRepository(Approval).findBy({ kind: "autonomy_promotion" });
}

describe("promotion eligibility", () => {
  test("a clean, evidenced record drafts a pending browser promotion — and applies nothing", async () => {
    await seedCleanRecord();
    const drafted = await computeAutonomyPromotions();
    assert.equal(drafted, 1);
    const rows = await promotions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.match(rows[0].title ?? "", /submit browser forms without approval/);
    const fresh = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(fresh.browserApprovalRequired, true);
  });

  test("a pending promotion is not drafted twice", async () => {
    await seedCleanRecord();
    await computeAutonomyPromotions();
    await computeAutonomyPromotions();
    assert.equal((await promotions()).length, 1);
  });

  test("a rejected promotion holds a cooldown", async () => {
    await seedCleanRecord();
    await computeAutonomyPromotions();
    const [proposal] = await promotions();
    await AppDataSource.getRepository(Approval).update(
      { id: proposal.id },
      { status: "rejected", decidedAt: new Date() },
    );
    await computeAutonomyPromotions();
    assert.equal((await promotions()).length, 1);
  });

  test("one rejected browser submit disqualifies the record", async () => {
    await seedCleanRecord();
    await insert(Approval, {
      companyId,
      employeeId: employee.id,
      routineId: "",
      kind: "browser_action",
      status: "rejected",
    });
    assert.equal(await computeAutonomyPromotions(), 0);
  });

  test("a failed run in the window disqualifies everything", async () => {
    const routine = await seedCleanRecord();
    await insert(Run, {
      routineId: routine.id,
      status: "failed",
      logContent: "",
      triggerKind: "schedule",
      startedAt: new Date(),
    });
    assert.equal(await computeAutonomyPromotions(), 0);
  });

  test("a consistently-verified gated routine earns its own promotion", async () => {
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Weekly invoice sweep",
      slug: "weekly-invoice-sweep",
      cronExpr: "0 9 * * 1",
      body: "",
      acceptanceCriteria: "Every overdue invoice was chased.",
      requiresApproval: true,
      enabled: true,
    });
    for (let n = 0; n < 12; n++) {
      await insert(Run, {
        routineId: routine.id,
        status: "completed",
        logContent: "",
        triggerKind: "schedule",
        startedAt: new Date(),
        outcomeVerdict: "achieved",
        checksVerdict: "passed",
      });
    }
    for (let n = 0; n < 6; n++) {
      await insert(Approval, {
        companyId,
        employeeId: employee.id,
        routineId: routine.id,
        kind: "routine",
        status: "approved",
      });
    }
    // The employee-wide record must also be clean; the runs above provide it.
    // browserApprovalRequired stays gated but has no browser evidence, so only
    // the routine promotion drafts.
    const drafted = await computeAutonomyPromotions();
    assert.equal(drafted, 1);
    const [proposal] = await promotions();
    assert.match(proposal.title ?? "", /run without approval/);
    // The evidence says what was verified, not that nothing complained. Ten is
    // the lookback, not the twelve seeded above.
    assert.match(proposal.summary ?? "", /All 10 of the last Runs were verified/);
    assert.match(proposal.summary ?? "", /10 of them also passed its required Checks/);
  });

  test("ten spotless Runs against no criteria and no Checks earn nothing", async () => {
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Inbox tidy",
      slug: "inbox-tidy",
      cronExpr: "0 9 * * 1",
      body: "",
      requiresApproval: true,
      enabled: true,
    });
    for (let n = 0; n < 10; n++) {
      await insert(Run, {
        routineId: routine.id,
        status: "completed",
        logContent: "",
        triggerKind: "schedule",
        startedAt: new Date(),
      });
    }
    for (let n = 0; n < 6; n++) {
      await insert(Approval, {
        companyId,
        employeeId: employee.id,
        routineId: routine.id,
        kind: "routine",
        status: "approved",
      });
    }
    assert.equal(await computeAutonomyPromotions(), 0);
  });

  test("an unverified Run in the window blocks every promotion", async () => {
    const routine = await seedCleanRecord();
    await insert(Run, {
      routineId: routine.id,
      status: "completed",
      logContent: "",
      triggerKind: "schedule",
      startedAt: new Date(),
      outcomeVerdict: "unverified",
    });
    assert.equal(await computeAutonomyPromotions(), 0);
  });

  test("a completed Run nobody ever graded blocks promotion when the Routine has criteria", async () => {
    const routine = await seedCleanRecord();
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { acceptanceCriteria: "The digest was posted." },
    );
    // Every seeded Run now sits on a criteria-bearing Routine with a null
    // verdict: ungraded, which is not the same as fine.
    assert.equal(await computeAutonomyPromotions(), 0);
  });

  test("a failed required Check in the window blocks every promotion", async () => {
    const routine = await seedCleanRecord();
    await insert(Run, {
      routineId: routine.id,
      status: "completed",
      logContent: "",
      triggerKind: "schedule",
      startedAt: new Date(),
      checksVerdict: "failed",
    });
    assert.equal(await computeAutonomyPromotions(), 0);
  });

  test("a Routine with Checks but no verdicts is still not promotable", async () => {
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Ledger sync",
      slug: "ledger-sync",
      cronExpr: "0 9 * * 1",
      body: "",
      requiresApproval: true,
      enabled: true,
    });
    await insert(RoutineCheck, {
      companyId,
      routineId: routine.id,
      name: "A row was written",
      kind: "effect",
      spec: "{}",
    });
    for (let n = 0; n < 12; n++) {
      await insert(Run, {
        routineId: routine.id,
        status: "completed",
        logContent: "",
        triggerKind: "schedule",
        startedAt: new Date(),
        checksVerdict: "passed",
      });
    }
    for (let n = 0; n < 6; n++) {
      await insert(Approval, {
        companyId,
        employeeId: employee.id,
        routineId: routine.id,
        kind: "routine",
        status: "approved",
      });
    }
    assert.equal(await computeAutonomyPromotions(), 0);
  });
});

describe("routineAutonomyEvidence", () => {
  const run = (over: Partial<Run>): Pick<Run, "status" | "outcomeVerdict" | "checksVerdict"> =>
    ({ status: "completed", outcomeVerdict: "achieved", checksVerdict: "passed", ...over }) as Run;

  test("a Routine measured by nothing says so in plain English", () => {
    const evidence = routineAutonomyEvidence({
      runs: Array.from({ length: 10 }, () => run({ outcomeVerdict: null, checksVerdict: null })),
      hasCriteria: false,
      hasChecks: false,
    });
    assert.equal(evidence.promotable, false);
    assert.equal(evidence.verified, 0);
    assert.match(evidence.reason, /no acceptance criteria and no Checks/);
    assert.match(evidence.reason, /nobody established that they worked/i);
  });

  test("every Run verified is promotable; one failed Check is not", () => {
    const green = Array.from({ length: 5 }, () => run({}));
    assert.equal(
      routineAutonomyEvidence({ runs: green, hasCriteria: true, hasChecks: true }).promotable,
      true,
    );
    const withFailure = [...green, run({ checksVerdict: "failed" })];
    const evidence = routineAutonomyEvidence({
      runs: withFailure,
      hasCriteria: true,
      hasChecks: true,
    });
    assert.equal(evidence.promotable, false);
    assert.equal(evidence.verified, 5);
    assert.match(evidence.reason, /Only 5 of the last 6 Runs were verified/);
    assert.match(evidence.reason, /1 failed a required Check/);
  });

  test("an unverified Run is named as a Run with no verdict to rely on", () => {
    const evidence = routineAutonomyEvidence({
      runs: [run({}), run({ outcomeVerdict: "unverified" })],
      hasCriteria: true,
      hasChecks: false,
    });
    assert.equal(evidence.promotable, false);
    assert.match(evidence.reason, /finished without a verdict anyone can rely on/);
  });

  test("no finished Runs is not promotable either", () => {
    const evidence = routineAutonomyEvidence({ runs: [], hasCriteria: true, hasChecks: true });
    assert.equal(evidence.promotable, false);
    assert.match(evidence.reason, /no finished Runs/);
  });
});

describe("promotion execution", () => {
  test("approving applies the gate change and writes the waiver row", async () => {
    await seedCleanRecord();
    await computeAutonomyPromotions();
    const [proposal] = await promotions();
    proposal.decidedByUserId = ownerId;
    await executeAutonomyPromotion(proposal);
    const fresh = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(fresh.browserApprovalRequired, false);
    const waivers = await AppDataSource.getRepository(AutonomyWaiver).findBy({
      employeeId: employee.id,
    });
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].kind, "browser_approval");
    assert.equal(waivers[0].grantedByUserId, ownerId);
    assert.equal(waivers[0].revokedAt, null);
  });

  test("a promotion whose employee is gone fails the execution, loudly", async () => {
    await seedCleanRecord();
    await computeAutonomyPromotions();
    const [proposal] = await promotions();
    await AppDataSource.getRepository(AIEmployee).delete({ id: employee.id });
    await assert.rejects(executeAutonomyPromotion(proposal), /no longer exists/);
  });
});

describe("demotion", () => {
  async function grantBrowserWaiver(): Promise<AutonomyWaiver> {
    employee.browserApprovalRequired = false;
    await AppDataSource.getRepository(AIEmployee).save(employee);
    return insert(AutonomyWaiver, {
      companyId,
      employeeId: employee.id,
      kind: "browser_approval",
      routineId: null,
    });
  }

  test("a bad run revokes every active waiver, re-arms the gates, and pages once", async () => {
    await grantBrowserWaiver();
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Gated",
      slug: "gated",
      cronExpr: "0 3 * * *",
      body: "",
      requiresApproval: false,
    });
    await insert(AutonomyWaiver, {
      companyId,
      employeeId: employee.id,
      kind: "routine_approval",
      routineId: routine.id,
    });
    const badRun = { id: testId("run"), status: "failed", outcomeVerdict: null } as Run;

    await contractAutonomyOnBadRun({ run: badRun, employee });
    // The race the claim must win: the same bad run reported twice.
    await contractAutonomyOnBadRun({ run: badRun, employee });

    const freshEmployee = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(freshEmployee.browserApprovalRequired, true);
    const freshRoutine = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: routine.id,
    });
    assert.equal(freshRoutine.requiresApproval, true);
    const waivers = await AppDataSource.getRepository(AutonomyWaiver).findBy({
      employeeId: employee.id,
    });
    assert.ok(waivers.every((w) => w.revokedAt !== null));
    const bells = await AppDataSource.getRepository(Notification).findBy({
      kind: "autonomy_revoked",
    });
    assert.equal(bells.length, 2); // one per waiver, once each
  });

  test("a Run that failed a required Check revokes waivers, and the reason says which", async () => {
    await grantBrowserWaiver();
    const badRun = {
      id: testId("run"),
      status: "completed",
      outcomeVerdict: "achieved",
      checksVerdict: "failed",
    } as Run;

    await contractAutonomyOnBadRun({ run: badRun, employee });

    const fresh = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(fresh.browserApprovalRequired, true);
    const [waiver] = await AppDataSource.getRepository(AutonomyWaiver).findBy({
      employeeId: employee.id,
    });
    assert.ok(waiver.revokedAt);
    // A green verdict on the same Run does not soften it: the Check is the
    // stronger evidence of the two, and the reason names it.
    assert.match(waiver.revokedReason ?? "", /failed a required Check/);
  });

  test("a human revoke re-arms the gate without the system-page", async () => {
    const waiver = await grantBrowserWaiver();
    const revoked = await revokeWaiver(waiver, "Revoked by a human", ownerId);
    assert.equal(revoked, true);
    const fresh = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(fresh.browserApprovalRequired, true);
    assert.equal(
      (await AppDataSource.getRepository(Notification).findBy({ kind: "autonomy_revoked" }))
        .length,
      0,
    );
  });
});
