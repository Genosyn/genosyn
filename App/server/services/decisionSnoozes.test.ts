import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../test/dbHarness.js";
import {
  cancelDecision,
  createDecision,
  decideDecision,
  listDecisions,
  listPendingDecisions,
} from "./decisions.js";
import {
  decisionSnoozedUntil,
  releaseDueDecisionSnoozes,
  snoozeDecision,
  type DecisionSnoozeDuration,
} from "./decisionSnoozes.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

async function scenario(): Promise<{
  companyId: string;
  employeeId: string;
  ownerId: string;
  memberId: string;
}> {
  const companyId = testCompanyId();
  const owner = await insert(User, {
    email: `owner-${companyId}@example.test`,
    passwordHash: "x",
    name: "Ada Owner",
  });
  const member = await insert(User, {
    email: `member-${companyId}@example.test`,
    passwordHash: "x",
    name: "Mo Member",
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
  await insert(Membership, { companyId, userId: member.id, role: "member" });
  return { companyId, employeeId: employee.id, ownerId: owner.id, memberId: member.id };
}

async function stack(companyId: string, employeeId: string): Promise<Decision> {
  const { decision } = await createDecision({
    companyId,
    employeeId,
    title: "Send the pricing reply?",
    body: "Draft goes here.",
    options: [{ label: "Send it" }, { label: "Hold" }],
  });
  return decision;
}

describe("Decision snooze presets", () => {
  test("uses exact elapsed-time durations, including an unambiguous 30-day month", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expected: Array<[DecisionSnoozeDuration, string]> = [
      ["one_hour", "2026-01-01T01:00:00.000Z"],
      ["one_day", "2026-01-02T00:00:00.000Z"],
      ["two_days", "2026-01-03T00:00:00.000Z"],
      ["one_week", "2026-01-08T00:00:00.000Z"],
      ["one_month", "2026-01-31T00:00:00.000Z"],
    ];

    for (const [duration, iso] of expected) {
      assert.equal(decisionSnoozedUntil(duration, now).toISOString(), iso);
    }
  });
});

describe("snoozing a Decision", () => {
  test("hides an active snooze from both Decision attention lists", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const decision = await stack(companyId, employeeId);
    const now = new Date();

    const result = await snoozeDecision({
      companyId,
      decisionId: decision.id,
      userId: memberId,
      role: "member",
      duration: "one_hour",
      now,
    });

    assert.equal(result.outcome, "snoozed");
    assert.equal(
      result.outcome === "snoozed" && result.decision.snoozedUntil?.toISOString(),
      new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    );
    assert.deepEqual(await listDecisions({ companyId }), []);
    const pending = await listPendingDecisions({ companyId, limit: 10 });
    assert.equal(pending.total, 0);
    assert.deepEqual(pending.decisions, []);

    const [initialNotification] = await AppDataSource.getRepository(Notification).find({
      where: { companyId, entityId: decision.id },
    });
    assert.ok(initialNotification.readAt, "snoozing clears the old unread bell");
  });

  test("wakes when due, re-notifies once, and repeated scheduler passes are idempotent", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const decision = await stack(companyId, employeeId);
    const now = new Date();
    const due = new Date(now.getTime() + 60 * 60 * 1_000);
    await snoozeDecision({
      companyId,
      decisionId: decision.id,
      userId: ownerId,
      role: "owner",
      duration: "one_hour",
      now,
    });

    await releaseDueDecisionSnoozes(new Date(due.getTime() - 1));
    assert.ok(
      (await AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id }))
        .snoozedUntil,
    );
    assert.equal(
      await AppDataSource.getRepository(Notification).countBy({ companyId, entityId: decision.id }),
      1,
    );

    await releaseDueDecisionSnoozes(due);
    const awakened = await AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id });
    assert.equal(awakened.snoozedUntil, null);
    assert.equal((await listPendingDecisions({ companyId, limit: 10 })).total, 1);
    const notifications = await AppDataSource.getRepository(Notification).find({
      where: { companyId, entityId: decision.id },
      order: { createdAt: "ASC" },
    });
    assert.equal(notifications.length, 2);
    assert.equal(notifications.filter((notification) => notification.readAt !== null).length, 1);
    assert.equal(notifications.filter((notification) => notification.readAt === null).length, 1);

    await releaseDueDecisionSnoozes(new Date(due.getTime() + 60_000));
    assert.equal(
      await AppDataSource.getRepository(Notification).countBy({ companyId, entityId: decision.id }),
      2,
    );
  });

  test("answering or dismissing a snoozed Decision clears its due timestamp", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const answer = await stack(companyId, employeeId);
    const dismiss = await stack(companyId, employeeId);
    for (const decision of [answer, dismiss]) {
      await snoozeDecision({
        companyId,
        decisionId: decision.id,
        userId: ownerId,
        role: "owner",
        duration: "one_week",
      });
    }

    assert.equal(
      (
        await decideDecision({
          companyId,
          decisionId: answer.id,
          userId: ownerId,
          role: "owner",
          optionId: "send-it",
        })
      ).outcome,
      "decided",
    );
    assert.equal(
      (
        await cancelDecision({
          companyId,
          decisionId: dismiss.id,
          userId: ownerId,
          role: "owner",
        })
      ).outcome,
      "cancelled",
    );

    assert.equal(
      (await AppDataSource.getRepository(Decision).findOneByOrFail({ id: answer.id })).snoozedUntil,
      null,
    );
    assert.equal(
      (await AppDataSource.getRepository(Decision).findOneByOrFail({ id: dismiss.id })).snoozedUntil,
      null,
    );
  });

  test("enforces the assignee and company boundary", async () => {
    const first = await scenario();
    const second = await scenario();
    const decision = await stack(first.companyId, first.employeeId);
    await AppDataSource.getRepository(Decision).update(decision.id, {
      assigneeUserId: first.ownerId,
    });

    const forbidden = await snoozeDecision({
      companyId: first.companyId,
      decisionId: decision.id,
      userId: first.memberId,
      role: "member",
      duration: "one_day",
    });
    assert.equal(forbidden.outcome, "forbidden");

    const hidden = await snoozeDecision({
      companyId: second.companyId,
      decisionId: decision.id,
      userId: second.ownerId,
      role: "owner",
      duration: "one_day",
    });
    assert.equal(hidden.outcome, "not_found");
  });
});
