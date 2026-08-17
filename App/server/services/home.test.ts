import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { getHomeData } from "./home.js";
import { createDecision } from "./decisions.js";

/**
 * Home is an aggregation, not a named lookup, so it is the surface where a
 * visibility rule enforced on a dedicated route is easiest to forget. These
 * tests pin the two that matter: approval copy is redacted here exactly as the
 * approvals inbox redacts it, and Vault capture rows stay owner/admin-only.
 */

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

let company: Company;
let owner: User;
let member: User;
let employee: AIEmployee;

beforeEach(async () => {
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  member = await insert(User, { email: "member@example.test", name: "Member", passwordHash: "x" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "",
  });
});

async function approval(overrides: Partial<Approval> = {}): Promise<Approval> {
  return insert(Approval, {
    companyId: company.id,
    kind: "browser_action",
    routineId: "",
    employeeId: employee.id,
    title: "Submit the form",
    summary: "Send reviewed data",
    payloadJson: "{}",
    resultJson: null,
    errorMessage: null,
    status: "pending",
    decidedAt: null,
    decidedByUserId: null,
    ...overrides,
  });
}

describe("Home approval visibility", () => {
  test("redacts credential material out of approval copy for everyone", async () => {
    await approval({
      title: "Replay POST with Authorization: Bearer sk-live-abc123",
      summary: "token=hunter2 was in the query string",
    });
    for (const [user, role] of [
      [owner, "owner"],
      [member, "member"],
    ] as const) {
      const data = await getHomeData({ companyId: company.id, userId: user.id, role });
      assert.equal(data.approvals.length, 1);
      assert.ok(!data.approvals[0].title?.includes("sk-live-abc123"), data.approvals[0].title ?? "");
      assert.ok(!data.approvals[0].summary?.includes("hunter2"), data.approvals[0].summary ?? "");
    }
  });

  test("hides Vault capture rows from a Member, as GET /approvals does", async () => {
    await approval({
      title: "Save the login for shop.example.test",
      payloadJson: JSON.stringify({ action: "vault_capture" }),
    });
    await approval({ title: "Ordinary submit", payloadJson: JSON.stringify({ action: "submit" }) });

    const asMember = await getHomeData({
      companyId: company.id,
      userId: member.id,
      role: "member",
    });
    assert.deepEqual(
      asMember.approvals.map((a) => a.title),
      ["Ordinary submit"],
    );

    const asOwner = await getHomeData({ companyId: company.id, userId: owner.id, role: "owner" });
    assert.equal(asOwner.approvals.length, 2);
  });
});

describe("Home decision stack", () => {
  test("carries the pending stack, urgency first, with its true total", async () => {
    for (const [title, urgency] of [
      ["Normal", "normal"],
      ["Urgent", "high"],
      ["Whenever", "low"],
    ] as const) {
      await createDecision({
        companyId: company.id,
        employeeId: employee.id,
        title,
        options: [{ label: "Yes" }, { label: "No" }],
        urgency,
      });
    }

    const data = await getHomeData({ companyId: company.id, userId: member.id, role: "member" });
    assert.equal(data.pendingDecisionCount, 3);
    assert.deepEqual(
      data.decisions.map((d) => d.title),
      ["Urgent", "Normal", "Whenever"],
    );
    assert.equal(data.decisions[0].employee?.name, "Rey");
    assert.deepEqual(
      data.decisions[0].options.map((o) => o.label),
      ["Yes", "No"],
    );
  });

  test("is empty for a company whose employees are unblocked", async () => {
    const data = await getHomeData({ companyId: company.id, userId: member.id, role: "member" });
    assert.deepEqual(data.decisions, []);
    assert.equal(data.pendingDecisionCount, 0);
  });
});
