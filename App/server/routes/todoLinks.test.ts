import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoLink } from "../db/entities/TodoLink.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { spawnNextRecurrence, nextOccurrence } from "../services/todos.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";
import { projectsRouter } from "./projects.js";

/**
 * A Todo says where it came from and a record says what work it started, and
 * neither hands anyone a way past the access rules of the other.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
const tokens: string[] = [];

let company: Company;
let owner: User;
let member: User;
let employee: AIEmployee;
let account: MailAccount;
let thread: MailThread;
let project: Project;

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
  app.use("/internal/mcp", mcpInternalRouter);
  app.use("/api/companies/:cid", projectsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const token of tokens) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function addMember(email: string, role: Role, financeAccess: "none" | "read" | "full") {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: company.id, userId: user.id, role, financeAccess });
  return user;
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
  owner = await addMember("owner@example.com", "owner", "full");
  member = await addMember("member@example.com", "member", "none");
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Compliance",
    slug: "compliance",
    role: "Compliance officer",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: "connection",
    provider: "gmail",
    address: "team@acme.test",
    status: "active",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "thread-1",
    subject: "Action required: accept the new agreement",
  });
  project = await insert(Project, {
    companyId: company.id,
    name: "Compliance",
    slug: "compliance",
    key: "COMP",
    todoCounter: 0,
  });
});

async function as<T = Record<string, unknown>>(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actingUserId = userId;
  const res = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function tool<T = Record<string, unknown>>(
  name: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: T }> {
  const bearer = token ?? issueMcpToken(employee.id, company.id, { authority: "employee" });
  if (!token) tokens.push(bearer);
  const res = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

type Linked = { todos: Array<{ id: string; key: string; isSource: boolean }>; total: number };
type TodoRow = { id: string; links: Array<{ kind: string; label: string | null; path: string | null }> };

describe("links, seen by Members", () => {
  test("a Todo created from an email shows on the thread, and links back", async () => {
    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
      assigneeUserId: null,
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.links[0].kind, "mail_thread");
    assert.equal(created.body.links[0].label, "Action required: accept the new agreement");
    assert.equal(created.body.links[0].path, `/mail/t/${thread.id}`);

    const back = await as<Linked>(
      owner.id,
      "GET",
      `/todo-links?kind=mail_thread&targetId=${thread.id}`,
    );
    assert.equal(back.body.total, 1);
    assert.equal(back.body.todos[0].key, "COMP-1");
    assert.equal(back.body.todos[0].isSource, true);
  });

  test("a Todo keeps its source's name after the record is gone", async () => {
    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    await AppDataSource.getRepository(MailThread).delete({ id: thread.id });
    const board = await as<{ todos: TodoRow[] }>(owner.id, "GET", "/projects/compliance/todos");
    const link = board.body.todos.find((todo) => todo.id === created.body.id)!.links[0];
    assert.equal(link.label, "Action required: accept the new agreement");
    assert.equal(link.path, null, "nowhere to go");
  });

  test("a Todo in a Project you can't open isn't listed on the record", async () => {
    project.accessMode = "restricted";
    await AppDataSource.getRepository(Project).save(project);
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "user",
      userId: owner.id,
      employeeId: null,
      accessLevel: "write",
    });
    await as(owner.id, "POST", "/projects/compliance/todos", {
      title: "Quiet work",
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    const seen = await as<Linked>(
      member.id,
      "GET",
      `/todo-links?kind=mail_thread&targetId=${thread.id}`,
    );
    assert.equal(seen.status, 200);
    assert.equal(seen.body.total, 0);
    assert.deepEqual(seen.body.todos, []);
  });

  test("a Member without Finance access can't read or link a Customer through a Todo", async () => {
    const customer = await insert(Customer, {
      companyId: company.id,
      name: "Globex",
      slug: "globex",
    });
    const refused = await as(member.id, "POST", "/projects/compliance/todos", {
      title: "Chase Globex",
      links: [{ kind: "customer", targetId: customer.id }],
    });
    assert.equal(refused.status, 403);

    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Chase Globex",
      links: [{ kind: "customer", targetId: customer.id }],
    });
    assert.equal(created.body.links[0].label, "Globex");
    const board = await as<{ todos: TodoRow[] }>(member.id, "GET", "/projects/compliance/todos");
    const link = board.body.todos[0].links[0];
    assert.equal(link.label, null, "the Customer's name stays behind its own bar");
    assert.equal(link.path, null);
  });

  test("a link to something outside this company is refused and the Todo stands", async () => {
    const created = await as<TodoRow & { linkError?: string }>(
      owner.id,
      "POST",
      "/projects/compliance/todos",
      {
        title: "Still worth doing",
        links: [
          {
            kind: "mail_thread",
            targetId: "00000000-0000-4000-8000-000000000000",
            isSource: true,
          },
        ],
      },
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.links.length, 0);
    assert.match(created.body.linkError ?? "", /not found/);
  });

  test("a Todo has at most one source, and removing a link removes only it", async () => {
    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    const other = await insert(MailThread, {
      companyId: company.id,
      accountId: account.id,
      gmailThreadId: "thread-2",
      subject: "A second email",
    });
    const added = await as<{ links: Array<{ targetId: string; isSource: boolean }> }>(
      owner.id,
      "POST",
      `/todos/${created.body.id}/links`,
      { kind: "mail_thread", targetId: other.id, isSource: true },
    );
    assert.equal(added.body.links.filter((link) => link.isSource).length, 1);

    const removed = await as(
      owner.id,
      "DELETE",
      `/todos/${created.body.id}/links/mail_thread/${other.id}`,
    );
    assert.equal(removed.status, 200);
    assert.equal(await AppDataSource.getRepository(TodoLink).countBy({ todoId: created.body.id }), 1);
  });

  test("deleting a Todo takes its links with it", async () => {
    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    await as(owner.id, "DELETE", `/todos/${created.body.id}`);
    assert.equal(await AppDataSource.getRepository(TodoLink).countBy({ companyId: company.id }), 0);
  });
});

describe("links, for AI Employees", () => {
  test("a Todo filed while working an email links that thread without being told", async () => {
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    const token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailThreadId: thread.id,
    });
    tokens.push(token);
    const created = await tool<{ todo: { id: string } }>(
      "create_todo",
      { projectSlug: "compliance", title: "Accept the agreement" },
      token,
    );
    assert.equal(created.status, 200);
    const links = await AppDataSource.getRepository(TodoLink).findBy({
      todoId: created.body.todo.id,
    });
    assert.equal(links.length, 1);
    assert.equal(links[0].kind, "mail_thread");
    assert.equal(links[0].targetId, thread.id);
    assert.equal(links[0].isSource, true);
    assert.equal(links[0].createdByEmployeeId, employee.id);
  });

  test("an employee can't link what its own Grants don't reach", async () => {
    const created = await tool<{ todo: { id: string } }>("create_todo", {
      projectSlug: "compliance",
      title: "Accept the agreement",
    });
    const refused = await tool("link_todo", {
      todoId: created.body.todo.id,
      kind: "mail_thread",
      id: thread.id,
    });
    assert.equal(refused.status, 403);
    assert.equal(await AppDataSource.getRepository(TodoLink).countBy({ companyId: company.id }), 0);
  });

  test("get_todo says a link exists but not what it is called without a Grant", async () => {
    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    type Read = {
      todo: { links: Array<{ kind: string; id: string; label: string | null; canRead: boolean }> };
    };
    const blind = await tool<Read>("get_todo", { todoId: created.body.id });
    assert.equal(blind.status, 200);
    assert.deepEqual(blind.body.todo.links[0], {
      kind: "mail_thread",
      id: thread.id,
      isSource: true,
      label: null,
      canRead: false,
    });

    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    const granted = await tool<Read>("get_todo", { todoId: created.body.id });
    assert.equal(granted.body.todo.links[0].canRead, true);
    assert.equal(granted.body.todo.links[0].label, "Action required: accept the new agreement");
  });

  test("get_mail_thread shows the work an email already started", async () => {
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    await as(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
      links: [{ kind: "mail_thread", targetId: thread.id, isSource: true }],
    });
    const read = await tool<{ linkedTodos: Array<{ key: string; projectSlug: string }> }>(
      "get_mail_thread",
      { threadId: thread.id },
    );
    assert.equal(read.status, 200);
    assert.deepEqual(
      read.body.linkedTodos.map((todo) => [todo.key, todo.projectSlug]),
      [["COMP-1", "compliance"]],
    );
  });

  test("link_todo and unlink_todo need write on the Project", async () => {
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    const created = await as<TodoRow>(owner.id, "POST", "/projects/compliance/todos", {
      title: "Accept the agreement",
    });
    const linked = await tool("link_todo", {
      todoId: created.body.id,
      kind: "mail_thread",
      id: thread.id,
      isSource: true,
    });
    assert.equal(linked.status, 200);

    project.accessMode = "restricted";
    await AppDataSource.getRepository(Project).save(project);
    const refused = await tool("unlink_todo", {
      todoId: created.body.id,
      kind: "mail_thread",
      id: thread.id,
    });
    assert.equal(refused.status, 403);
  });
});

describe("one way to create a Todo", () => {
  test("two Todos created at once take different numbers", async () => {
    const [left, right] = await Promise.all([
      as<{ number: number }>(owner.id, "POST", "/projects/compliance/todos", { title: "One" }),
      as<{ number: number }>(owner.id, "POST", "/projects/compliance/todos", { title: "Two" }),
    ]);
    assert.notEqual(left.body.number, right.body.number);
    const fresh = await AppDataSource.getRepository(Project).findOneByOrFail({ id: project.id });
    assert.equal(fresh.todoCounter, 2);
  });

  test("an AI Employee finishing a recurring Todo puts the next one on the list", async () => {
    const created = await tool<{ todo: { id: string } }>("create_todo", {
      projectSlug: "compliance",
      title: "File the monthly report",
      recurrence: "monthly",
      dueAt: "2026-03-01T00:00:00.000Z",
    });
    const finished = await tool("update_todo", { todoId: created.body.todo.id, status: "done" });
    assert.equal(finished.status, 200);
    const rows = await AppDataSource.getRepository(Todo).find({
      where: { projectId: project.id },
      order: { number: "ASC" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, "todo");
    assert.equal(rows[1].recurrenceParentId, rows[0].id);
    assert.ok((rows[1].dueAt?.getTime() ?? 0) > (rows[0].dueAt?.getTime() ?? 0));
  });

  test("a Todo can't be handed to an AI Employee who can't open a restricted Project", async () => {
    const colleague = await insert(AIEmployee, {
      companyId: company.id,
      name: "Sam",
      slug: "sam",
      role: "Support",
    });
    project.accessMode = "restricted";
    await AppDataSource.getRepository(Project).save(project);
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "ai",
      userId: null,
      employeeId: employee.id,
      accessLevel: "write",
    });

    const refused = await tool("create_todo", {
      projectSlug: "compliance",
      title: "Not for Sam",
      assigneeEmployeeSlug: colleague.slug,
    });
    assert.equal(refused.status, 400);

    const mine = await tool<{ todo: { id: string } }>("create_todo", {
      projectSlug: "compliance",
      title: "Mine",
    });
    const reassign = await tool("update_todo", {
      todoId: mine.body.todo.id,
      assigneeEmployeeSlug: colleague.slug,
    });
    assert.equal(reassign.status, 400);
    const review = await tool("update_todo", {
      todoId: mine.body.todo.id,
      reviewerEmployeeSlug: colleague.slug,
    });
    assert.equal(review.status, 400);
  });

  test("recurrence keeps its cadence", async () => {
    const monday = new Date("2026-03-06T12:00:00.000Z");
    assert.equal(nextOccurrence(monday, "none"), null);
    const friday = nextOccurrence(monday, "weekdays")!;
    assert.ok(![0, 6].includes(friday.getDay()));
    assert.equal(typeof spawnNextRecurrence, "function");
  });
});
