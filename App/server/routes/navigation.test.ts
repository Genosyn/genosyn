import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { FinanceProposal } from "../db/entities/FinanceProposal.js";
import { Initiative } from "../db/entities/Initiative.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Project } from "../db/entities/Project.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import type { UsedSectionsResponse, WaitingElsewhere } from "../../shared/navigation.js";
import { navigationRouter } from "./navigation.js";

/**
 * The palette lists a section once the company has something in it, and the
 * Decision stack says what waits elsewhere. These pin both answers: what
 * counts as use, that another company's rows never leak in, and that each
 * waiting count follows who may act on its queue.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let ada: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", navigationRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function member(
  email: string,
  role: Role,
  companyId: string,
  financeAccess?: "none" | "read" | "full",
): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, {
    companyId,
    userId: user.id,
    role,
    ...(financeAccess ? { financeAccess } : {}),
  });
  return user;
}

async function get<T>(path: string, as: User): Promise<T> {
  actingUserId = as.id;
  const res = await fetch(`${baseUrl}/api/companies/${company.id}${path}`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as T;
}

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  await insert(Membership, { companyId: company.id, userId: founder.id, role: "owner" });
  owner = founder;
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
});

describe("GET /navigation/sections", () => {
  test("a new company uses nothing yet, and its default notebook does not count", async () => {
    await insert(Notebook, { companyId: company.id, title: "Company", slug: "company" });
    const body = await get<UsedSectionsResponse>("/navigation/sections", owner);
    assert.deepEqual(body.used, []);
  });

  test("a section is used once the company made, connected, or granted something there", async () => {
    await insert(Skill, { employeeId: ada.id, name: "Weekly brief", slug: "weekly-brief" });
    await insert(Routine, {
      employeeId: ada.id,
      name: "Morning digest",
      slug: "morning-digest",
      cronExpr: "0 9 * * 1-5",
    });
    await insert(Project, { companyId: company.id, name: "Launch", slug: "launch", key: "LAU" });
    await insert(EmployeeFinanceGrant, {
      companyId: company.id,
      employeeId: ada.id,
      accessLevel: "read",
    });
    const body = await get<UsedSectionsResponse>("/navigation/sections", owner);
    assert.deepEqual(body.used, ["tasks", "skills", "routines", "finance"]);
  });

  test("another company's rows never mark a section as used", async () => {
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
    const bo = await insert(AIEmployee, {
      companyId: other.id,
      name: "Bo",
      slug: "bo",
      role: "Writer",
      soulBody: "",
    });
    await insert(Skill, { employeeId: bo.id, name: "Drafting", slug: "drafting" });
    await insert(Project, { companyId: other.id, name: "Elsewhere", slug: "elsewhere", key: "ELS" });
    const body = await get<UsedSectionsResponse>("/navigation/sections", owner);
    assert.deepEqual(body.used, []);
  });

  test("an outsider gets no answer about the company", async () => {
    const outsider = await insert(User, {
      email: "outsider@example.com",
      name: "Outsider",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;
    const res = await fetch(`${baseUrl}/api/companies/${company.id}/navigation/sections`);
    assert.notEqual(res.status, 200);
  });
});

describe("GET /navigation/waiting", () => {
  beforeEach(async () => {
    // Email and work reviews are the stack's own rows; only the other kinds
    // count as waiting elsewhere.
    for (const kind of ["mail_send", "proactive_work", "browser_action", "ad_spend"] as const) {
      await insert(Approval, {
        companyId: company.id,
        routineId: "none",
        employeeId: ada.id,
        status: "pending",
        kind,
      });
    }
    await insert(Approval, {
      companyId: company.id,
      routineId: "none",
      employeeId: ada.id,
      status: "approved",
      kind: "browser_action",
    });
    await insert(RevisionProposal, {
      companyId: company.id,
      employeeId: ada.id,
      kind: "skill",
      status: "pending",
    });
    await insert(Initiative, {
      companyId: company.id,
      employeeId: ada.id,
      title: "Chase overdue invoices",
      status: "pending",
    });
    await insert(Initiative, {
      companyId: company.id,
      employeeId: ada.id,
      title: "Declined already",
      status: "declined",
    });
    await insert(FinanceProposal, {
      companyId: company.id,
      title: "Accrue October rent",
      payloadJson: "{}",
      status: "pending",
    });
  });

  test("an owner sees every queue they may act on", async () => {
    const body = await get<WaitingElsewhere>("/navigation/waiting", owner);
    assert.deepEqual(body, {
      approvals: 2,
      revisions: 1,
      initiatives: 1,
      todoReviews: 0,
      financeProposals: 1,
    });
  });

  test("a Member is not counted into queues an owner or admin decides", async () => {
    const reader = await member("reader@example.com", "member", company.id, "read");
    const body = await get<WaitingElsewhere>("/navigation/waiting", reader);
    assert.deepEqual(body, {
      approvals: null,
      revisions: null,
      initiatives: null,
      todoReviews: 0,
      financeProposals: null,
    });
  });

  test("a Member with full Finance access counts Finance proposals", async () => {
    const bookkeeper = await member("books@example.com", "member", company.id, "full");
    const body = await get<WaitingElsewhere>("/navigation/waiting", bookkeeper);
    assert.equal(body.financeProposals, 1);
    assert.equal(body.approvals, null);
  });

  test("a todo review counts only for the Member it names", async () => {
    const reviewer = await member("reviewer@example.com", "member", company.id);
    const project = await insert(Project, {
      companyId: company.id,
      name: "Launch",
      slug: "launch",
      key: "LAU",
    });
    await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Check the copy",
      status: "in_review",
      reviewerUserId: reviewer.id,
    });
    await insert(Todo, {
      projectId: project.id,
      number: 2,
      title: "Still being written",
      status: "in_progress",
      reviewerUserId: reviewer.id,
    });
    assert.equal((await get<WaitingElsewhere>("/navigation/waiting", reviewer)).todoReviews, 1);
    assert.equal((await get<WaitingElsewhere>("/navigation/waiting", owner)).todoReviews, 0);
  });
});
