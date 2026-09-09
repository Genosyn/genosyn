import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrDismissal } from "../db/entities/TldrDismissal.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { getHomeData } from "./home.js";
import { createDecision } from "./decisions.js";
import { listHomeRepositoryWork } from "./homeRepositoryWork.js";
import { repositoryCheckoutExists } from "./repositoryWorkspace.js";

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
      assert.ok(
        !data.approvals[0].title?.includes("sk-live-abc123"),
        data.approvals[0].title ?? "",
      );
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

describe("Home TLDR briefings", () => {
  test("returns up to three undismissed briefings and a per-Member unread count", async () => {
    const rows: Tldr[] = [];
    for (let index = 0; index < 4; index += 1) {
      const periodEnd = new Date(Date.UTC(2026, 7, 20, 8 + index));
      rows.push(
        await insert(Tldr, {
          companyId: company.id,
          employeeId: employee.id,
          employeeName: employee.name,
          employeeSlug: employee.slug,
          employeeRole: employee.role,
          employeeAvatarKey: null,
          status: "ready",
          triggerKind: "schedule",
          periodStart: new Date(periodEnd.getTime() - 60 * 60_000),
          periodEnd,
          title: `Brief ${index}`,
          summary: `Summary ${index}`,
          body: `Body ${index}`,
          sourceStatsJson: JSON.stringify({
            journalEntries: 1,
            routineRuns: 0,
            channelMessages: 0,
            channels: 0,
          }),
          errorMessage: "",
          finishedAt: periodEnd,
          createdAt: periodEnd,
        }),
      );
    }
    await insert(TldrDismissal, {
      companyId: company.id,
      tldrId: rows[3].id,
      userId: member.id,
    });

    const memberHome = await getHomeData({
      companyId: company.id,
      userId: member.id,
      role: "member",
    });
    assert.equal(memberHome.unreadTldrCount, 3);
    assert.deepEqual(
      memberHome.tldrs.map((tldr) => tldr.title),
      ["Brief 2", "Brief 1", "Brief 0"],
    );

    const ownerHome = await getHomeData({
      companyId: company.id,
      userId: owner.id,
      role: "owner",
    });
    assert.equal(ownerHome.unreadTldrCount, 4);
    assert.equal(ownerHome.tldrs.length, 3);
    assert.equal(ownerHome.tldrs[0].title, "Brief 3");
  });
});

async function repository(overrides: Partial<Repository> = {}): Promise<Repository> {
  return insert(Repository, {
    companyId: company.id,
    name: "Strategy",
    slug: "strategy",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    ...overrides,
  });
}

async function workSession(
  repo: Repository,
  overrides: Partial<RepositoryWorkSession> = {},
): Promise<RepositoryWorkSession> {
  return insert(RepositoryWorkSession, {
    companyId: repo.companyId,
    repositoryId: repo.id,
    employeeId: employee.id,
    requestedByUserId: owner.id,
    title: "Review the strategy",
    instruction: "Rewrite the company strategy",
    status: "ready",
    ...overrides,
  });
}

describe("Home Repository AI work", () => {
  test("lists every unarchived state needing a Member and excludes running or decided work", async () => {
    const repo = await repository();
    for (const status of [
      "ready", "empty", "proposed", "failed", "running", "published", "discarded",
    ] as const) {
      await workSession(repo, { status, title: status });
      await workSession(repo, { status, title: `Archived ${status}`, archivedAt: new Date() });
    }

    const data = await getHomeData({ companyId: company.id, userId: member.id, role: "member" });
    assert.equal(data.repositoryWorkCount, 4);
    assert.deepEqual(
      data.repositoryWork.map((session) => session.title).sort(),
      ["empty", "failed", "proposed", "ready"],
    );
    assert.equal(data.repositoryWork[0].employee?.name, "Rey");
  });

  test("combines repositories and employee-initiated work without depending on a reachable checkout", async () => {
    const local = await repository();
    const remote = await repository({
      name: "Product",
      slug: "product",
      origin: "remote",
      kind: "code",
      gitUrl: "https://genosyn.invalid/acme/product.git",
      encryptedToken: "not-for-home",
    });
    await workSession(local);
    const autonomous = await workSession(remote, {
      status: "proposed",
      requestedByUserId: null,
      filesChanged: 3,
      insertions: 20,
      deletions: 2,
      reply: "A long private transcript",
      error: "A long failure trace",
    });

    const result = await listHomeRepositoryWork({ companyId: company.id });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((row) => row.repository.slug).sort(), ["product", "strategy"]);
    const row = result.items.find((item) => item.id === autonomous.id)!;
    assert.deepEqual(row.repository, { id: remote.id, name: "Product", slug: "product", kind: "code" });
    assert.equal(row.filesChanged, 3);
    assert.equal(row.insertions, 20);
    assert.equal(row.deletions, 2);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("not-for-home"));
    assert.ok(!serialized.includes("A long private transcript"));
    assert.ok(!serialized.includes("A long failure trace"));
    assert.equal(repositoryCheckoutExists(remote), false);
  });

  test("scopes both sessions and their repositories to this company and never hydrates another company's employee", async () => {
    const local = await repository();
    const otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
    const foreign = await repository({ companyId: otherCompany.id, slug: "foreign" });
    const otherEmployee = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Private employee",
      slug: "private",
      role: "Engineer",
    });
    await workSession(foreign, { employeeId: otherEmployee.id });
    await workSession(foreign, { companyId: company.id });
    await workSession(local, { companyId: otherCompany.id });
    await workSession(local, { repositoryId: "deleted-repository" });
    const visible = await workSession(local, { employeeId: otherEmployee.id });

    const result = await listHomeRepositoryWork({ companyId: company.id });
    assert.equal(result.total, 1);
    assert.deepEqual(result.items.map((row) => row.id), [visible.id]);
    assert.equal(result.items[0].employee, null);
    assert.ok(!JSON.stringify(result).includes("Private employee"));
  });

  test("keeps the true backlog count and stable paging beyond the Home preview", async () => {
    const repo = await repository();
    const at = new Date("2026-09-09T09:00:00.000Z");
    const sessions: RepositoryWorkSession[] = [];
    for (let index = 9; index >= 0; index -= 1) {
      sessions.push(await workSession(repo, {
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        updatedAt: at,
      }));
    }
    const expected = sessions.map((session) => session.id).sort();
    const home = await getHomeData({ companyId: company.id, userId: member.id, role: "member" });
    assert.equal(home.repositoryWorkCount, 10);
    assert.deepEqual(home.repositoryWork.map((row) => row.id), expected.slice(0, 8));

    const next = await listHomeRepositoryWork({ companyId: company.id, offset: 8, limit: 8 });
    assert.equal(next.total, 10);
    assert.deepEqual(next.items.map((row) => row.id), expected.slice(8));
    assert.deepEqual(
      await listHomeRepositoryWork({ companyId: company.id, offset: 10, limit: 8 }),
      { items: [], total: 10 },
    );

    const newest = await workSession(repo, { updatedAt: new Date(at.getTime() + 1000) });
    const refreshed = await listHomeRepositoryWork({ companyId: company.id, limit: 1 });
    assert.deepEqual(refreshed.items.map((row) => row.id), [newest.id]);
  });

  test("uses a bounded readable instruction when an older session has no title", async () => {
    const repo = await repository();
    await workSession(repo, { title: "  ", instruction: `Review\n\n${"the strategy ".repeat(100)}` });
    const result = await listHomeRepositoryWork({ companyId: company.id });
    assert.equal(result.items[0].title.length, 200);
    assert.match(result.items[0].title, /^Review the strategy/);
    assert.ok(result.items[0].title.endsWith("…"));
    assert.ok(!("instruction" in result.items[0]));
  });

  test("returns an empty attention queue when no Repository AI work needs a Member", async () => {
    const data = await getHomeData({ companyId: company.id, userId: member.id, role: "member" });
    assert.deepEqual(data.repositoryWork, []);
    assert.equal(data.repositoryWorkCount, 0);
  });
});
