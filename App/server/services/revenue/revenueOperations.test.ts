import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Membership } from "../../db/entities/Membership.js";
import { Notification } from "../../db/entities/Notification.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import {
  createRevenueAccount,
  listRevenueAccounts,
  normalizeAccountDomain,
} from "./accounts.js";
import {
  createRevenueClassification,
  listRevenueClassifications,
} from "./classifications.js";
import {
  createCustomField,
  getCustomValues,
  matchingResourceIds,
  setCustomValues,
} from "./customFields.js";
import {
  createRevenueDocument,
  deleteRevenueDocument,
  listRevenueDocuments,
} from "./documents.js";
import {
  createFollowUpTask,
  listFollowUps,
  updateFollowUpTask,
} from "./followUps.js";
import { dispatchDueFollowUpReminders } from "./followUpReminders.js";
import {
  commitRevenueImport,
  previewRevenueImport,
  rollbackRevenueImport,
} from "./imports.js";
import {
  addPartnershipContact,
  createPartnership,
  getPartnership,
} from "./partnerships.js";
import { createContact } from "./contacts.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_revenue_operations";

describe("revenue accounts", () => {
  test("normalizes domains, represents prospects, and rejects a duplicate domain", async () => {
    assert.equal(normalizeAccountDomain("HTTPS://www.Example.COM/about"), "example.com");
    const account = await createRevenueAccount(CO, {
      name: "Acme",
      domain: "https://www.acme.example/products",
      industry: "Infrastructure",
      employeeCount: 120,
    });
    assert.equal(account.accountStatus, "prospect");
    assert.equal(account.domain, "acme.example");
    assert.equal(account.industry, "Infrastructure");
    await assert.rejects(
      () => createRevenueAccount(CO, { name: "Acme duplicate", domain: "www.acme.example" }),
      /already exists/,
    );
    const listed = await listRevenueAccounts(CO, { status: "prospect" });
    assert.equal(listed.total, 1);
    assert.equal(listed.rows[0].contactCount, 0);
    assert.equal(listed.rows[0].openDealCount, 0);
  });
});

describe("typed custom fields", () => {
  test("validates values and supports exact normalized filtering", async () => {
    const account = await createRevenueAccount(CO, { name: "Typed Co" });
    await createCustomField(CO, {
      resourceType: "account",
      name: "Plan interest",
      fieldType: "select",
      options: ["Growth", "Enterprise"],
    });
    await createCustomField(CO, {
      resourceType: "account",
      name: "Infrastructure size",
      fieldType: "number",
    });
    const values = await setCustomValues(CO, "account", account.id, {
      plan_interest: "Enterprise",
      infrastructure_size: 250,
    });
    assert.equal(values.find((row) => row.field.key === "plan_interest")?.value, "Enterprise");
    assert.deepEqual(
      await matchingResourceIds(CO, "account", "plan_interest", "enterprise"),
      [account.id],
    );
    await assert.rejects(
      () => setCustomValues(CO, "account", account.id, { plan_interest: "Unknown" }),
      /unknown option/,
    );
    assert.equal((await getCustomValues(CO, "account", account.id)).length, 2);
  });
});

describe("follow-up queue", () => {
  test("orders due work, preserves assignment, and advances recurrence on completion", async () => {
    await AppDataSource.getRepository(AIEmployee).save({
      id: "employee_sales",
      companyId: CO,
      name: "Revenue AI",
      slug: "revenue-ai",
      role: "Account executive",
    });
    const dueAt = new Date("2026-07-20T10:00:00.000Z");
    const task = await createFollowUpTask(
      CO,
      {
        subject: "Send security answers",
        dueAt,
        priority: "high",
        assignedEmployeeId: "employee_sales",
        recurrenceRule: "FREQ=WEEKLY;INTERVAL=1",
      },
      { userId: "member_owner" },
    );
    const queue = await listFollowUps(CO, { state: "overdue" });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].priority, "high");
    assert.equal(queue[0].assignedEmployeeId, "employee_sales");

    await updateFollowUpTask(CO, task.id, { taskStatus: "completed" }, { userId: "member_owner" });
    const tasks = await AppDataSource.getRepository(Activity).find({
      where: { companyId: CO, kind: "task" },
      order: { dueAt: "ASC" },
    });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].taskStatus, "completed");
    assert.equal(tasks[1].dueAt?.toISOString(), "2026-07-27T10:00:00.000Z");
    assert.equal(tasks[1].assignedEmployeeId, "employee_sales");
  });

  test("dispatches each due human reminder exactly once", async () => {
    await AppDataSource.getRepository(Company).save({
      id: CO,
      name: "Revenue Co",
      slug: "revenue-co",
      ownerId: "member_owner",
    });
    await AppDataSource.getRepository(Membership).save({
      companyId: CO,
      userId: "member_owner",
      role: "owner",
    });
    await createFollowUpTask(
      CO,
      {
        subject: "Call the buying committee",
        dueAt: new Date("2026-07-25T10:00:00.000Z"),
        reminderAt: new Date("2026-07-25T09:00:00.000Z"),
        assignedUserId: "member_owner",
      },
      { userId: "member_owner" },
    );

    const now = new Date("2026-07-25T09:01:00.000Z");
    assert.equal(await dispatchDueFollowUpReminders(now), 1);
    assert.equal(await dispatchDueFollowUpReminders(now), 0);

    const notifications = await AppDataSource.getRepository(Notification).find({
      where: {
        companyId: CO,
        userId: "member_owner",
        kind: "revenue_follow_up",
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, "Call the buying committee");
    assert.equal(notifications[0].link, "/c/revenue-co/revenue/follow-ups");
  });
});

describe("partnerships and formal documents", () => {
  test("keeps controlled relationship context, primary/Reply-All contacts, and documents", async () => {
    const defaults = await listRevenueClassifications(CO);
    assert.ok(defaults.some((row) => row.kind === "partnership_type" && row.value === "technology"));
    const defaulted = await createPartnership(CO, { name: "New partner" });
    assert.equal(defaulted.type, "other");
    assert.equal(defaulted.status, "prospecting");
    await createRevenueClassification(CO, {
      kind: "partnership_status",
      label: "Contracting",
    });
    const partnership = await createPartnership(CO, {
      name: "Cloud Partner",
      type: "technology",
      status: "contracting",
      channelContext: "Copy the solutions lead",
      nextFollowUpAt: new Date("2026-08-01T09:00:00.000Z"),
    });
    const first = await createContact(CO, { name: "Partner lead", email: "lead@partner.example" });
    const second = await createContact(CO, { name: "Solutions", email: "se@partner.example" });
    await addPartnershipContact(CO, partnership.id, {
      contactId: first.id,
      isPrimary: true,
      replyAll: true,
    });
    await addPartnershipContact(CO, partnership.id, {
      contactId: second.id,
      isPrimary: true,
      replyAll: true,
    });
    const detail = await getPartnership(CO, partnership.id);
    assert.equal(detail?.contacts.filter((row) => row.isPrimary).length, 1);
    assert.equal(detail?.contacts.filter((row) => row.replyAll).length, 2);

    const document = await createRevenueDocument(
      CO,
      {
        kind: "contract",
        title: "Partner agreement",
        partnershipId: partnership.id,
        externalUrl: "https://docs.example/partner",
      },
      { employeeId: "employee_partnerships" },
    );
    assert.equal((await listRevenueDocuments(CO, { partnershipId: partnership.id })).length, 1);
    assert.equal(await deleteRevenueDocument(CO, document.id), true);
  });
});

describe("reversible Revenue imports", () => {
  test("previews duplicates, commits a durable row map, and safely rolls back new rows", async () => {
    await createContact(CO, { name: "Existing", email: "existing@example.com" });
    await createCustomField(CO, {
      resourceType: "contact",
      name: "Current stack",
      fieldType: "text",
    });
    const rows = [
      {
        sourceId: "base-1",
        values: { full_name: "Existing again", address: "existing@example.com" },
      },
      {
        sourceId: "base-2",
        values: {
          full_name: "New person",
          address: "new@example.com",
          stack: "Prometheus",
        },
      },
      {
        sourceId: "base-3",
        values: { full_name: "", address: "missing-name@example.com" },
      },
    ];
    const mapping = {
      name: "full_name",
      email: "address",
      "custom:current_stack": "stack",
    };
    const preview = await previewRevenueImport(CO, "contact", mapping, rows);
    assert.equal(preview.createCount, 1);
    assert.equal(preview.duplicateCount, 1);
    assert.equal(preview.skippedCount, 1);

    const batch = await commitRevenueImport(
      CO,
      {
        resourceType: "contact",
        sourceKind: "csv",
        sourceLabel: "contacts.csv",
        mapping,
        rows,
      },
      { userId: "member_owner" },
    );
    const rowMap = JSON.parse(batch.rowMapJson) as Array<{ sourceId: string; nativeId: string | null }>;
    const importedId = rowMap.find((row) => row.sourceId === "base-2")?.nativeId;
    assert.ok(importedId);
    assert.equal(
      (await getCustomValues(CO, "contact", importedId!)).find(
        (row) => row.field.key === "current_stack",
      )?.value,
      "Prometheus",
    );
    const rollback = await rollbackRevenueImport(CO, batch.id);
    assert.equal(rollback?.deleted, 1);
    assert.deepEqual(rollback?.blocked, []);
    assert.equal(rollback?.batch.status, "rolled_back");
  });
});
