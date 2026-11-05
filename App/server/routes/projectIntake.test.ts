import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectIntake } from "../db/entities/ProjectIntake.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { projectsRouter } from "./projects.js";

/**
 * A Project's email intake moves the human gate ahead of time, so who can move it
 * is the point: an owner or admin, signed in themselves. A plain Member, an API key
 * and an AI Employee can't, however the request is dressed.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

let company: Company;
let owner: User;
let member: User;
let ada: AIEmployee;
let project: Project;
let account: MailAccount;

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
  app.use("/api/companies/:cid", projectsRouter);
  app.use("/api/companies/:cid/employees", employeesRouter);
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

async function addMember(email: string, role: Role) {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@intake.test",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await addMember("owner@intake.test", "owner");
  member = await addMember("member@intake.test", "member");
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Compliance",
    soulBody: "",
  });
  project = await insert(Project, {
    companyId: company.id,
    name: "Compliance",
    slug: "compliance",
    key: "COMP",
    todoCounter: 0,
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: "connection",
    provider: "gmail",
    address: "team@acme.test",
    status: "active",
  });
});

async function as<T = Record<string, unknown>>(
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  actingUserId = userId;
  const res = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

const turnedOn = {
  enabled: true,
  whatBelongs: "Store policies and agreements",
  instruction: "Sign in from the Vault.",
  accountIds: [] as string[],
  assigneeEmployeeId: null as string | null,
  reviewerEmployeeId: null,
  reviewerUserId: null,
  replyMode: "review",
  trustedSenders: "",
};

const intakes = () => AppDataSource.getRepository(ProjectIntake);

describe("seeing an intake", () => {
  test("anyone who can open the Project sees it's off until someone turns it on", async () => {
    const answer = await as<{ enabled: boolean; replyMode: string }>(
      member.id,
      "GET",
      "/projects/compliance/intake",
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.enabled, false);
    assert.equal(answer.body.replyMode, "review");
  });

  test("a Project they can't open stays closed", async () => {
    await AppDataSource.getRepository(Project).update({ id: project.id }, { accessMode: "restricted" });
    assert.equal((await as(member.id, "GET", "/projects/compliance/intake")).status, 403);
  });
});

describe("changing an intake", () => {
  test("an owner can, and the audit says what widened", async () => {
    const answer = await as<{ enabled: boolean; trustedSenders: string }>(
      owner.id,
      "PUT",
      "/projects/compliance/intake",
      { ...turnedOn, replyMode: "send", trustedSenders: "  NO-REPLY@Google.com \n\n@example.com" },
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.enabled, true);
    assert.equal(answer.body.trustedSenders, "no-reply@google.com\n@example.com");

    const [row] = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "project.intake.update",
    });
    const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
    assert.equal(metadata.changedReplyMode, true);
    assert.equal(metadata.changedTrustedSenders, true);
    assert.equal(row.actorUserId, owner.id);
  });

  test("a plain Member can't", async () => {
    const answer = await as(member.id, "PUT", "/projects/compliance/intake", turnedOn);
    assert.equal(answer.status, 403);
    assert.equal(await intakes().count(), 0);
  });

  test("an API key can't, even an owner's", async () => {
    const body = "B".repeat(43);
    await insert(ApiKey, {
      userId: owner.id,
      companyId: company.id,
      name: "automation",
      prefix: body.slice(0, 8),
      tokenHash: hashApiToken(body),
    });
    const key = { authorization: `Bearer gen_${body}` };
    const read = await as(null, "GET", "/projects/compliance/intake", undefined, key);
    assert.equal(read.status, 200, "the key itself is good");

    const answer = await as(null, "PUT", "/projects/compliance/intake", turnedOn, key);
    assert.equal(answer.status, 403);
    assert.equal(await intakes().count(), 0);
  });

  test("no AI Employee tool writes or reads one", () => {
    const named = STATIC_TOOLS.filter((tool) => /intake/i.test(tool.name));
    assert.deepEqual(named, []);
    for (const tool of STATIC_TOOLS) {
      assert.ok(
        !/\b(trustedSenders|replyMode)\b/.test(JSON.stringify(tool.inputSchema)),
        `${tool.name} takes an intake setting`,
      );
    }
  });

  test("refuses bad input with the reason", async () => {
    const noWords = await as<{ error: string }>(owner.id, "PUT", "/projects/compliance/intake", {
      ...turnedOn,
      whatBelongs: "",
    });
    assert.equal(noWords.status, 400);
    assert.match(noWords.body.error, /which email belongs/);

    const badSender = await as<{ error: string }>(owner.id, "PUT", "/projects/compliance/intake", {
      ...turnedOn,
      trustedSenders: "*.google.com",
    });
    assert.equal(badSender.status, 400);
    assert.match(badSender.body.error, /\*\.google\.com/);
  });

  test("goes when its Project goes", async () => {
    await as(owner.id, "PUT", "/projects/compliance/intake", turnedOn);
    assert.equal(await intakes().count(), 1);
    assert.equal((await as(owner.id, "DELETE", "/projects/compliance")).status, 200);
    assert.equal(await intakes().count(), 0);
  });
});

describe("listing the Projects taking email", () => {
  type Listing = { total: number; hasMore: boolean; projects: Array<{ projectSlug: string; replyMode: string; trustedSenderCount: number }> };

  test("for one mailbox: those naming it, and those taking from all of them", async () => {
    const elsewhere = await insert(MailAccount, {
      companyId: company.id,
      connectionId: "other",
      provider: "gmail",
      address: "other@acme.test",
      status: "active",
    });
    const named = await insert(Project, {
      companyId: company.id,
      name: "Named",
      slug: "named",
      key: "NAME",
      todoCounter: 0,
    });
    const notHere = await insert(Project, {
      companyId: company.id,
      name: "Not here",
      slug: "not-here",
      key: "NOT",
      todoCounter: 0,
    });
    const off = await insert(Project, {
      companyId: company.id,
      name: "Off",
      slug: "off",
      key: "OFF",
      todoCounter: 0,
    });
    const put = (slug: string, changes: Record<string, unknown>) =>
      as(owner.id, "PUT", `/projects/${slug}/intake`, { ...turnedOn, ...changes });
    await put(project.slug, { replyMode: "send", trustedSenders: "@google.com" });
    await put(named.slug, { accountIds: [account.id] });
    await put(notHere.slug, { accountIds: [elsewhere.id] });
    await put(off.slug, { enabled: false });

    const answer = await as<Listing>(member.id, "GET", `/project-intakes?accountId=${account.id}`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.projects.map((row) => row.projectSlug).sort(), [
      "compliance",
      "named",
    ]);
    assert.equal(answer.body.total, 2);
    const compliance = answer.body.projects.find((row) => row.projectSlug === "compliance")!;
    assert.equal(compliance.replyMode, "send");
    assert.equal(compliance.trustedSenderCount, 1);
  });

  test("a Project the Member can't open isn't mentioned", async () => {
    await as(owner.id, "PUT", "/projects/compliance/intake", turnedOn);
    await AppDataSource.getRepository(Project).update({ id: project.id }, { accessMode: "restricted" });
    const answer = await as<Listing>(member.id, "GET", `/project-intakes?accountId=${account.id}`);
    assert.deepEqual(answer.body.projects, []);
    assert.equal(answer.body.total, 0);
  });
});

describe("an AI Employee leaving", () => {
  test("the Project falls back to letting the AI choose who works it", async () => {
    await as(owner.id, "PUT", "/projects/compliance/intake", {
      ...turnedOn,
      assigneeEmployeeId: ada.id,
    });
    assert.equal((await intakes().find())[0].assigneeEmployeeId, ada.id);

    assert.equal((await as(owner.id, "DELETE", `/employees/${ada.id}`)).status, 200);
    const [row] = await intakes().find();
    assert.equal(row.assigneeEmployeeId, null);
    assert.equal(row.enabled, true, "email keeps being filed");
  });
});

describe("a Todo's own page", () => {
  const page = (userId: string, path: string) =>
    as<{
      project: { slug: string; myAccessLevel: string };
      todo: { id: string; title: string; ceilingJson?: unknown };
      related: Array<{ id: string; title: string }>;
    }>(userId, "GET", path);

  async function withFamily() {
    const parent = await insert(Todo, {
      projectId: project.id,
      number: 12,
      title: "The parent",
      status: "todo",
      priority: "none",
    });
    await insert(Todo, {
      projectId: project.id,
      number: 13,
      title: "A subtask",
      status: "todo",
      priority: "none",
      parentTodoId: parent.id,
    });
    await insert(Todo, {
      projectId: project.id,
      number: 14,
      title: "Unrelated",
      status: "todo",
      priority: "none",
    });
    return parent;
  }

  test("reads one Todo by its number, with its family and nothing else", async () => {
    const parent = await withFamily();
    const answer = await page(member.id, "/projects/compliance/todos/12");
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.todo.id, parent.id);
    assert.equal(answer.body.project.myAccessLevel, "write");
    assert.deepEqual(answer.body.related.map((row) => row.title), ["A subtask"]);
    assert.ok(!("ceilingJson" in answer.body.todo), "what a session may do isn't a Todo's field");

    const child = await page(member.id, "/projects/compliance/todos/13");
    assert.deepEqual(child.body.related.map((row) => row.title), ["The parent"]);
  });

  test("a number that isn't there is a 404, and one that isn't a number is refused", async () => {
    await withFamily();
    assert.equal((await page(member.id, "/projects/compliance/todos/99")).status, 404);
    assert.equal((await page(member.id, "/projects/compliance/todos/nope")).status, 400);
    assert.equal((await page(member.id, "/projects/compliance/todos/0")).status, 400);
    assert.equal((await page(member.id, "/projects/nowhere/todos/12")).status, 404);
  });

  test("a Project the Member can't open stays closed", async () => {
    await withFamily();
    await AppDataSource.getRepository(Project).update({ id: project.id }, { accessMode: "restricted" });
    assert.equal((await page(member.id, "/projects/compliance/todos/12")).status, 403);
    assert.equal((await page(owner.id, "/projects/compliance/todos/12")).status, 200);
  });
});
