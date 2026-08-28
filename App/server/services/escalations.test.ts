import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { Handoff } from "../db/entities/Handoff.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification, type NotificationKind } from "../db/entities/Notification.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { sweepStalledWork } from "./escalations.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const DAY_MS = 24 * 60 * 60 * 1000;

async function scenario(): Promise<{
  companyId: string;
  employeeId: string;
  ownerId: string;
  outsiderId: string;
}> {
  const companyId = testCompanyId();
  const owner = await insert(User, {
    email: `owner-${companyId}@example.test`,
    passwordHash: "x",
    name: "Ada Owner",
  });
  const outsider = await insert(User, {
    email: `gone-${companyId}@example.test`,
    passwordHash: "x",
    name: "Sam Departed",
  });
  await insert(Company, {
    id: companyId,
    name: "Acme",
    slug: `acme-${companyId.slice(3, 11)}`,
    ownerId: owner.id,
  });
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Rey",
    slug: `rey-${companyId.slice(3, 11)}`,
    role: "Support",
    soulBody: "",
  });
  await insert(Membership, { companyId, userId: owner.id, role: "owner" });
  // `outsider` deliberately holds no Membership: they are the ex-colleague
  // whose account (and push devices) outlive their time at the company.
  return { companyId, employeeId: employee.id, ownerId: owner.id, outsiderId: outsider.id };
}

let routineSeq = 0;

async function staleApproval(companyId: string, employeeId: string): Promise<Approval> {
  routineSeq += 1;
  const routine = await insert(Routine, {
    employeeId,
    name: `Nightly digest ${routineSeq}`,
    slug: `nightly-${companyId.slice(3, 11)}-${routineSeq}`,
    cronExpr: "0 3 * * *",
    body: "",
    requiresApproval: true,
  });
  const approval = await insert(Approval, {
    companyId,
    employeeId,
    routineId: routine.id,
    status: "pending",
  });
  // `requestedAt` is a CreateDateColumn, so age it explicitly.
  await AppDataSource.getRepository(Approval).update(
    { id: approval.id },
    { requestedAt: new Date(Date.now() - 2 * DAY_MS) },
  );
  return approval;
}

function notifications(kind: NotificationKind): Promise<Notification[]> {
  return AppDataSource.getRepository(Notification).find({ where: { kind } });
}

describe("stall sweep", () => {
  test("re-pages an approval left pending past the threshold, exactly once", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const approval = await staleApproval(companyId, employeeId);

    await sweepStalledWork(new Date());
    const first = await notifications("approval_stale");
    assert.equal(first.length, 1);
    assert.equal(first[0].userId, ownerId);
    assert.equal(first[0].entityId, approval.id);

    // The marker is on the row, so a second pass says nothing more.
    await sweepStalledWork(new Date());
    assert.equal((await notifications("approval_stale")).length, 1);

    const row = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.ok(row.stallRemindedAt);
  });

  test("a reminded row does not block newer stalled rows from being reminded", async () => {
    const { companyId, employeeId } = await scenario();
    const first = await staleApproval(companyId, employeeId);
    await sweepStalledWork(new Date());
    assert.equal((await notifications("approval_stale")).length, 1);

    // A durable marker keeps the reminded row out of the query entirely, so a
    // backlog can never wedge the sweep behind rows it has already handled.
    const second = await staleApproval(companyId, employeeId);
    await sweepStalledWork(new Date());
    const rows = await notifications("approval_stale");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.entityId).sort(),
      [first.id, second.id].sort(),
    );
  });

  test("deleting the reminder notification does not re-arm the nag", async () => {
    const { companyId, employeeId } = await scenario();
    await staleApproval(companyId, employeeId);
    await sweepStalledWork(new Date());
    assert.equal((await notifications("approval_stale")).length, 1);

    // "Clear all read" deletes feed rows; the marker must not live there.
    await AppDataSource.getRepository(Notification).delete({ kind: "approval_stale" });
    await sweepStalledWork(new Date());
    assert.equal((await notifications("approval_stale")).length, 0);
  });

  test("a blocked decision assigned to a departed member pages the owners instead", async () => {
    const { companyId, employeeId, ownerId, outsiderId } = await scenario();
    const decision = await insert(Decision, {
      companyId,
      employeeId,
      title: "Approve the refund?",
      body: "",
      optionsJson: JSON.stringify([{ id: "yes", label: "Yes" }]),
      status: "pending",
      assigneeUserId: outsiderId,
    });
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      { createdAt: new Date(Date.now() - 2 * DAY_MS) },
    );

    await sweepStalledWork(new Date());
    const rows = await notifications("decision_stale");
    assert.equal(rows.length, 1);
    // The ex-colleague keeps their account and their push devices; company
    // activity must not reach them, and the page must still reach someone.
    assert.equal(rows[0].userId, ownerId);
  });

  test("an overdue handoff escalates, and one still inside its deadline does not", async () => {
    const { companyId, employeeId } = await scenario();
    const other = await insert(AIEmployee, {
      companyId,
      name: "Kim",
      slug: `kim-${companyId.slice(3, 11)}`,
      role: "Ops",
      soulBody: "",
    });
    const overdue = await insert(Handoff, {
      companyId,
      fromEmployeeId: employeeId,
      toEmployeeId: other.id,
      title: "Reconcile the March statements",
      body: "",
      status: "pending",
      dueAt: new Date(Date.now() - DAY_MS),
    });
    await insert(Handoff, {
      companyId,
      fromEmployeeId: employeeId,
      toEmployeeId: other.id,
      title: "Draft the April plan",
      body: "",
      status: "pending",
      dueAt: new Date(Date.now() + DAY_MS),
    });
    // A handoff with no deadline at all is never overdue.
    await insert(Handoff, {
      companyId,
      fromEmployeeId: employeeId,
      toEmployeeId: other.id,
      title: "Someday: tidy the vendor list",
      body: "",
      status: "pending",
      dueAt: null,
    });

    await sweepStalledWork(new Date());
    const rows = await notifications("handoff_overdue");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entityId, overdue.id);
  });

  test("a revision proposal pending past the threshold re-pages exactly once", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const proposal = await insert(RevisionProposal, {
      companyId,
      employeeId,
      kind: "soul",
      targetLabel: "Soul",
      baseBody: "a",
      proposedBody: "b",
      rationale: "r",
      status: "pending",
    });
    await AppDataSource.getRepository(RevisionProposal).update(
      { id: proposal.id },
      { createdAt: new Date(Date.now() - 2 * DAY_MS) },
    );

    await sweepStalledWork(new Date());
    const rows = await notifications("revision_stale");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, ownerId);
    assert.equal(rows[0].entityId, proposal.id);

    await sweepStalledWork(new Date());
    assert.equal((await notifications("revision_stale")).length, 1);

    // A decided proposal never nags, however old.
    const decided = await insert(RevisionProposal, {
      companyId,
      employeeId,
      kind: "soul",
      targetLabel: "Soul",
      baseBody: "a",
      proposedBody: "c",
      rationale: "r",
      status: "rejected",
    });
    await AppDataSource.getRepository(RevisionProposal).update(
      { id: decided.id },
      { createdAt: new Date(Date.now() - 5 * DAY_MS) },
    );
    await sweepStalledWork(new Date());
    assert.equal((await notifications("revision_stale")).length, 1);
  });

  test("nothing is said about rows that are still fresh or already settled", async () => {
    const { companyId, employeeId } = await scenario();
    // Fresh: pending, but nowhere near the threshold.
    await insert(Approval, { companyId, employeeId, routineId: "", status: "pending" });
    // Settled: old, but a human already answered it.
    const decided = await insert(Approval, {
      companyId,
      employeeId,
      routineId: "",
      status: "approved",
    });
    await AppDataSource.getRepository(Approval).update(
      { id: decided.id },
      { requestedAt: new Date(Date.now() - 5 * DAY_MS) },
    );

    await sweepStalledWork(new Date());
    assert.equal((await notifications("approval_stale")).length, 0);
  });
});
