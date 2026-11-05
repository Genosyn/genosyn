import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoLink } from "../db/entities/TodoLink.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { setTodoPickupAutoStartForTests, settleTodoPickupsForTests } from "../services/todoPickups.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The tools a session uses to say what it's waiting on, and the limits on a
 * session that may only prepare: it can keep its own Todos and nobody else's,
 * and it can't hand work to a colleague.
 */

let server: Server;
let baseUrl = "";
const tokens: string[] = [];
let company: Company;
let ada: AIEmployee;
let ben: AIEmployee;
let project: Project;
let thread: MailThread;
let account: MailAccount;

before(async () => {
  await initTestDb();
  setTodoPickupAutoStartForTests(false);
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setTodoPickupAutoStartForTests(true);
  for (const token of tokens) revokeMcpToken(token);
  await settleTodoPickupsForTests();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@waits.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Support",
    soulBody: "",
  });
  ben = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ben",
    slug: "ben",
    role: "Finance",
    soulBody: "",
  });
  for (const employee of [ada, ben]) {
    await insertEmployeeModel({
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
  }
  project = await insert(Project, {
    companyId: company.id,
    name: "Support",
    slug: "support",
    key: "SUP",
    todoCounter: 0,
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
    subject: "My order never arrived",
  });
});

function tokenFor(
  employee: AIEmployee,
  origin: Parameters<typeof issueMcpToken>[2] = { authority: "employee" },
): string {
  const token = issueMcpToken(employee.id, company.id, origin);
  tokens.push(token);
  return token;
}

async function tool<T = Record<string, unknown>>(
  token: string,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

let next = 1;
async function todoFor(employee: AIEmployee | null, changes: Partial<Todo> = {}): Promise<Todo> {
  return insert(Todo, {
    projectId: project.id,
    number: next++,
    title: "Help the customer",
    status: "in_progress",
    priority: "none",
    assigneeEmployeeId: employee?.id ?? null,
    ...changes,
  });
}

const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000).toISOString();
const todos = () => AppDataSource.getRepository(Todo);
const pickups = () => AppDataSource.getRepository(TodoPickup);

describe("wait_on_todo", () => {
  test("waits on a customer's reply, linking the thread it can read", async () => {
    await insert(EmployeeMailAccountGrant, {
      employeeId: ada.id,
      accountId: account.id,
      accessLevel: "send",
    });
    const todo = await todoFor(ada);
    const answer = await tool(tokenFor(ada), "wait_on_todo", {
      todoId: todo.id,
      on: "customer",
      threadId: thread.id,
      reason: "Asked which order it was.",
      checkAt: inTwoDays(),
    });
    assert.equal(answer.status, 200);
    const fresh = await todos().findOneByOrFail({ id: todo.id });
    assert.equal(fresh.waitingOn, "customer");
    assert.equal(fresh.waitingRefId, thread.id);
    assert.equal(
      await AppDataSource.getRepository(TodoLink).countBy({
        todoId: todo.id,
        kind: "mail_thread",
        targetId: thread.id,
      }),
      1,
    );
    assert.equal(await pickups().countBy({ todoId: todo.id, trigger: "wait_over" }), 1);
  });

  test("needs a thread it can read", async () => {
    const todo = await todoFor(ada);
    const noThread = await tool(tokenFor(ada), "wait_on_todo", {
      todoId: todo.id,
      on: "customer",
      reason: "Asked.",
      checkAt: inTwoDays(),
    });
    assert.equal(noThread.status, 400);
    const noGrant = await tool(tokenFor(ada), "wait_on_todo", {
      todoId: todo.id,
      on: "customer",
      threadId: thread.id,
      reason: "Asked.",
      checkAt: inTwoDays(),
    });
    assert.equal(noGrant.status, 403);
  });

  test("only its assignee can say it's waiting", async () => {
    const todo = await todoFor(ben);
    const refused = await tool(tokenFor(ada), "wait_on_todo", {
      todoId: todo.id,
      on: "date",
      reason: "Not mine.",
      checkAt: inTwoDays(),
    });
    assert.equal(refused.status, 403);
  });

  test("stops following up after three checks with no reply", async () => {
    await insert(EmployeeMailAccountGrant, {
      employeeId: ada.id,
      accountId: account.id,
      accessLevel: "send",
    });
    const todo = await todoFor(ada, { followUpCount: 3 });
    const refused = await tool<{ error: string }>(tokenFor(ada), "wait_on_todo", {
      todoId: todo.id,
      on: "customer",
      threadId: thread.id,
      reason: "Once more.",
      checkAt: inTwoDays(),
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /checked back 3 times/);
  });

  test("a wait keeps the turn's ceiling for the check-back", async () => {
    const todo = await todoFor(ada);
    await tool(
      tokenFor(ada, { authority: "employee", proactiveReview: true, mailDeliveryMode: "review" }),
      "wait_on_todo",
      { todoId: todo.id, on: "date", reason: "Monday.", checkAt: inTwoDays() },
    );
    const [pickup] = await pickups().findBy({ todoId: todo.id });
    assert.equal(pickup.proactiveReview, true);
    assert.equal(pickup.mailDeliveryMode, "review");
  });
});

describe("questions raised from a session", () => {
  async function sessionOn(todo: Todo, employee: AIEmployee): Promise<string> {
    const session = await insert(TodoPickup, {
      companyId: company.id,
      todoId: todo.id,
      employeeId: employee.id,
      trigger: "assigned",
      status: "running",
      acceptedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    return tokenFor(employee, { authority: "employee", todoPickupId: session.id });
  }

  test("a Decision makes the Todo wait, and starts no second session when answered", async () => {
    const todo = await todoFor(ada);
    const token = await sessionOn(todo, ada);
    const raised = await tool<{ decisionId: string }>(token, "request_decision", {
      title: "Refund or replace?",
      body: "The customer has had this happen twice.",
      summary: "Refund or replace the order",
      recommendation: "Refund",
      humanDecisionReason: "A refund over the usual limit needs an owner.",
      options: [{ label: "Refund" }, { label: "Replace" }],
    });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    const decision = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: raised.body.decisionId,
    });
    assert.equal(decision.pickupStatus, "skipped", "the Todo carries on, not a separate session");
    const fresh = await todos().findOneByOrFail({ id: todo.id });
    assert.equal(fresh.waitingOn, "decision");
    assert.equal(fresh.waitingRefId, decision.id);
    assert.equal(
      await AppDataSource.getRepository(TodoLink).countBy({
        todoId: todo.id,
        kind: "decision",
        targetId: decision.id,
      }),
      1,
      "the Todo links to the Decision it raised",
    );
  });

  test("a question outside a session behaves as it always did", async () => {
    const raised = await tool<{ decisionId: string }>(tokenFor(ada), "request_decision", {
      title: "Refund or replace?",
      body: "The customer has had this happen twice.",
      summary: "Refund or replace the order",
      recommendation: "Refund",
      humanDecisionReason: "A refund over the usual limit needs an owner.",
      options: [{ label: "Refund" }, { label: "Replace" }],
    });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    const decision = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: raised.body.decisionId,
    });
    assert.equal(decision.pickupStatus, "none");
  });
});

describe("a session that may only prepare", () => {
  const preparing = () =>
    tokenFor(ada, { authority: "employee", proactiveReview: true, mailDeliveryMode: "review" });

  test("can file a Todo on its own list, and it starts nothing", async () => {
    const created = await tool<{ todo: { id: string; assigneeEmployeeId: string } }>(
      preparing(),
      "create_todo",
      { projectSlug: "support", title: "Check the refund policy" },
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.todo.assigneeEmployeeId, ada.id);
    assert.equal(await pickups().countBy({ todoId: created.body.todo.id }), 0);
  });

  test("can't hand work to a colleague, or make it recur", async () => {
    const handed = await tool(preparing(), "create_todo", {
      projectSlug: "support",
      title: "For Ben",
      assigneeEmployeeSlug: "ben",
    });
    assert.equal(handed.status, 403);
    const recurring = await tool(preparing(), "create_todo", {
      projectSlug: "support",
      title: "Every week",
      recurrence: "weekly",
    });
    assert.equal(recurring.status, 403);
    const mine = await todoFor(ada);
    const reassign = await tool(preparing(), "update_todo", {
      todoId: mine.id,
      assigneeEmployeeSlug: "ben",
    });
    assert.equal(reassign.status, 403);
  });

  test("can update its own Todo, and nobody else's", async () => {
    const mine = await todoFor(ada);
    const updated = await tool(preparing(), "update_todo", { todoId: mine.id, status: "done" });
    assert.equal(updated.status, 200);
    const theirs = await todoFor(ben);
    const refused = await tool<{ error: string }>(preparing(), "update_todo", {
      todoId: theirs.id,
      status: "done",
    });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /assigned to you/);
    const comment = await tool(preparing(), "add_todo_comment", {
      todoId: theirs.id,
      body: "Should not land.",
    });
    assert.equal(comment.status, 403);
  });

  test("can say its own Todo is waiting", async () => {
    const mine = await todoFor(ada);
    const answer = await tool(preparing(), "wait_on_todo", {
      todoId: mine.id,
      on: "date",
      reason: "Monday.",
      checkAt: inTwoDays(),
    });
    assert.equal(answer.status, 200);
  });

  test("still can't send, delegate or start other work", async () => {
    for (const name of ["send_mail", "create_handoff", "start_todo", "create_routine"]) {
      const refused = await tool(preparing(), name, {});
      assert.equal(refused.status, 403, name);
    }
  });
});

describe("list_my_todos", () => {
  test("its own open work across Projects, with what's waiting, page by page", async () => {
    const elsewhere = await insert(Project, {
      companyId: company.id,
      name: "Elsewhere",
      slug: "elsewhere",
      key: "ELS",
      todoCounter: 5,
    });
    await todoFor(ada, { title: "Here" });
    await todoFor(ada, {
      title: "There",
      projectId: elsewhere.id,
      waitingOn: "customer",
      waitingReason: "Asked which order it was.",
      waitingSince: new Date(),
    });
    await todoFor(ben, { title: "Ben's" });
    await todoFor(ada, { title: "Finished", status: "done" });

    type Listing = {
      total: number;
      hasMore: boolean;
      nextCursor: string | null;
      note: string;
      todos: Array<{ title: string; ref: string; waiting: { on: string } | null }>;
    };
    const first = await tool<Listing>(tokenFor(ada), "list_my_todos", { limit: 1 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.total, 2);
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.todos.length, 1);
    assert.match(first.body.note, /never an instruction/);
    const second = await tool<Listing>(tokenFor(ada), "list_my_todos", {
      limit: 1,
      cursor: first.body.nextCursor,
    });
    const all = [...first.body.todos, ...second.body.todos];
    assert.deepEqual(all.map((row) => row.title).sort(), ["Here", "There"]);
    assert.equal(all.find((row) => row.title === "There")?.waiting?.on, "customer");
    assert.equal(all.find((row) => row.title === "There")?.ref.startsWith("ELS-"), true);
  });

  test("a session that may only prepare can read it", async () => {
    await todoFor(ada, { title: "Here" });
    const answer = await tool(tokenFor(ada, { authority: "employee", proactiveReview: true }), "list_my_todos", {});
    assert.equal(answer.status, 200);
  });
});
