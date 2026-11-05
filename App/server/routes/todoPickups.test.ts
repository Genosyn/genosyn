import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, markTokenTainted, revokeMcpToken } from "../services/mcpTokens.js";
import {
  setTodoPickupAutoStartForTests,
  settleTodoPickupsForTests,
} from "../services/todoPickups.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";
import { projectsRouter } from "./projects.js";
import { todoPickupsRouter } from "./todoPickups.js";

/**
 * Who can start an AI Employee on a Todo, and under what. A person's assignment
 * runs under that person. A colleague's hand-off runs with what that colleague's
 * turn had, and can't shed a ceiling or taint by handing the work over.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
const tokens: string[] = [];

let company: Company;
let owner: User;
let member: User;
let ada: AIEmployee;
let ben: AIEmployee;
let project: Project;

before(async () => {
  await initTestDb();
  setTodoPickupAutoStartForTests(false);
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
  app.use("/api/companies/:cid", todoPickupsRouter);
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

async function addMember(email: string, role: Role) {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
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
  owner = await addMember("owner@example.com", "owner");
  member = await addMember("member@example.com", "member");
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  ben = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ben",
    slug: "ben",
    role: "Support",
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
    name: "Ops",
    slug: "ops",
    key: "OPS",
    todoCounter: 0,
  });
});

async function as<T = Record<string, unknown>>(
  userId: string | null,
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

const pickups = () => AppDataSource.getRepository(TodoPickup);

describe("a person handing over a Todo", () => {
  test("queues a session under that person's authority", async () => {
    const created = await as<{ id: string }>(owner.id, "POST", "/projects/ops/todos", {
      title: "Check the numbers",
      assigneeEmployeeId: ada.id,
    });
    assert.equal(created.status, 200);
    await settleTodoPickupsForTests();
    const [pickup] = await pickups().findBy({ todoId: created.body.id });
    assert.equal(pickup.status, "queued");
    assert.equal(pickup.trigger, "assigned");
    assert.equal(pickup.authority, "member");
    assert.equal(pickup.requesterUserId, owner.id);
    assert.equal(pickup.startedByMember, true);
  });

  test("a Todo a person typed reads as their brief", async () => {
    const created = await as<{ id: string }>(owner.id, "POST", "/projects/ops/todos", {
      title: "Check the numbers",
      assigneeEmployeeId: ada.id,
    });
    const row = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: created.body.id });
    assert.equal(row.untrustedText, false);
    assert.equal(row.aiChainDepth, 0);
  });

  test("reassigning swaps the queued session for the new assignee", async () => {
    const created = await as<{ id: string }>(owner.id, "POST", "/projects/ops/todos", {
      title: "Check the numbers",
      assigneeEmployeeId: ada.id,
    });
    await settleTodoPickupsForTests();
    await as(owner.id, "PATCH", `/todos/${created.body.id}`, { assigneeEmployeeId: ben.id });
    await settleTodoPickupsForTests();
    const rows = await pickups().find({
      where: { todoId: created.body.id },
      order: { createdAt: "ASC" },
    });
    assert.equal(rows[0].status, "skipped");
    assert.equal(rows[1].employeeId, ben.id);
    assert.equal(rows[1].status, "queued");
  });

  test("closing it or taking it off an AI Employee stops what was queued", async () => {
    const created = await as<{ id: string }>(owner.id, "POST", "/projects/ops/todos", {
      title: "Check the numbers",
      assigneeEmployeeId: ada.id,
    });
    await settleTodoPickupsForTests();
    await as(owner.id, "PATCH", `/todos/${created.body.id}`, { status: "cancelled" });
    await settleTodoPickupsForTests();
    assert.equal((await pickups().findOneByOrFail({ todoId: created.body.id })).status, "stopped");
  });

  test("deleting a Todo takes its sessions with it", async () => {
    const created = await as<{ id: string }>(owner.id, "POST", "/projects/ops/todos", {
      title: "Check the numbers",
      assigneeEmployeeId: ada.id,
    });
    await settleTodoPickupsForTests();
    await as(owner.id, "DELETE", `/todos/${created.body.id}`);
    assert.equal(await pickups().countBy({ todoId: created.body.id }), 0);
  });
});

describe("Start now and Stop", () => {
  async function assigned(): Promise<string> {
    const row = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Sat a while",
      status: "todo",
      priority: "none",
      assigneeEmployeeId: ada.id,
    });
    return row.id;
  }

  test("Start now queues it under the person who pressed it", async () => {
    const todoId = await assigned();
    const started = await as<{ active: { status: string; requester: { name: string } } }>(
      member.id,
      "POST",
      `/todos/${todoId}/pickups`,
      {},
    );
    assert.equal(started.status, 200);
    assert.equal(started.body.active.status, "queued");
    assert.equal(started.body.active.requester.name, member.email);
  });

  test("Start now says why it can't", async () => {
    const row = await insert(Todo, {
      projectId: project.id,
      number: 2,
      title: "Done already",
      status: "done",
      priority: "none",
      assigneeEmployeeId: ada.id,
    });
    const refused = await as<{ error: string }>(owner.id, "POST", `/todos/${row.id}/pickups`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Reopen it/);
  });

  test("Stop ends a queued one, and can't be pressed twice", async () => {
    const todoId = await assigned();
    const started = await as<{ active: { id: string } }>(
      owner.id,
      "POST",
      `/todos/${todoId}/pickups`,
      {},
    );
    const id = started.body.active.id;
    const stopped = await as<{ stopped: boolean }>(owner.id, "POST", `/todos/${todoId}/pickups/${id}/stop`, {});
    assert.equal(stopped.body.stopped, true);
    const again = await as<{ stopped: boolean }>(owner.id, "POST", `/todos/${todoId}/pickups/${id}/stop`, {});
    assert.equal(again.body.stopped, false);
    assert.equal((await pickups().findOneByOrFail({ id })).stoppedByUserId, owner.id);
  });

  test("a Project you can't open answers nothing, read or write", async () => {
    const todoId = await assigned();
    project.accessMode = "restricted";
    await AppDataSource.getRepository(Project).save(project);
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "user",
      userId: owner.id,
      employeeId: null,
      accessLevel: "write",
    });
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "ai",
      userId: null,
      employeeId: ada.id,
      accessLevel: "write",
    });
    assert.equal((await as(member.id, "GET", `/todos/${todoId}/pickups`)).status, 403);
    assert.equal((await as(member.id, "POST", `/todos/${todoId}/pickups`, {})).status, 403);
  });

  test("a report says which session wrote it", async () => {
    const todoId = await assigned();
    const row = await insert(TodoPickup, {
      companyId: company.id,
      todoId,
      employeeId: ada.id,
      trigger: "assigned",
      status: "done",
      acceptedAt: new Date(),
      activityJson: null,
    });
    await insert(TodoComment, {
      todoId,
      authorEmployeeId: ada.id,
      authorUserId: null,
      body: "Done.",
      pending: false,
      pickupId: row.id,
    });
    const thread = await as<Array<{ pickup: { id: string; employee: { name: string } } }>>(
      owner.id,
      "GET",
      `/todos/${todoId}/comments`,
    );
    assert.equal(thread.body[0].pickup.id, row.id);
    assert.equal(thread.body[0].pickup.employee.name, "Ada");
  });
});

describe("an AI Employee handing over a Todo", () => {
  test("starts a colleague as itself, and marks the words as not a Member's", async () => {
    const created = await tool<{ todo: { id: string } }>(tokenFor(ada), "create_todo", {
      projectSlug: "ops",
      title: "Chase the invoice",
      assigneeEmployeeSlug: "ben",
    });
    assert.equal(created.status, 200);
    await settleTodoPickupsForTests();
    const [pickup] = await pickups().findBy({ todoId: created.body.todo.id });
    assert.equal(pickup.employeeId, ben.id);
    assert.equal(pickup.status, "queued");
    assert.equal(pickup.authority, "employee");
    assert.equal(pickup.startedByMember, false);
    const row = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: pickup.todoId });
    assert.equal(row.untrustedText, true);
  });

  test("a Todo on its own list starts nothing, until it asks", async () => {
    const token = tokenFor(ada);
    const created = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: "ops",
      title: "Plan the launch",
    });
    await settleTodoPickupsForTests();
    assert.equal(await pickups().countBy({ todoId: created.body.todo.id }), 0);

    const queued = await tool<{ queued: boolean }>(token, "start_todo", {
      todoId: created.body.todo.id,
    });
    assert.equal(queued.body.queued, true);
    assert.equal(await pickups().countBy({ todoId: created.body.todo.id, status: "queued" }), 1);
  });

  test("under a Member's delegation it hands on that Member, not its own reach", async () => {
    const token = tokenFor(ada, {
      authority: "member",
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });
    const created = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: "ops",
      title: "Chase the invoice",
      assigneeEmployeeSlug: "ben",
    });
    await settleTodoPickupsForTests();
    const [pickup] = await pickups().findBy({ todoId: created.body.todo.id });
    assert.equal(pickup.authority, "member");
    assert.equal(pickup.requesterUserId, member.id);
  });

  test("a review-only email turn can't shed its ceiling by handing work on", async () => {
    const token = tokenFor(ada, { authority: "employee", mailDeliveryMode: "review" });
    const created = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: "ops",
      title: "Reply to the customer",
      assigneeEmployeeSlug: "ben",
    });
    await settleTodoPickupsForTests();
    const [pickup] = await pickups().findBy({ todoId: created.body.todo.id });
    assert.equal(pickup.mailDeliveryMode, "review");
  });

  test("a tainted turn's hand-off starts tainted, and taints the Todo", async () => {
    const token = tokenFor(ada);
    markTokenTainted(token);
    const created = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: "ops",
      title: "From a page I read",
      assigneeEmployeeSlug: "ben",
    });
    await settleTodoPickupsForTests();
    const [pickup] = await pickups().findBy({ todoId: created.body.todo.id });
    assert.equal(pickup.tainted, true);
    const row = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: pickup.todoId });
    assert.equal(row.tainted, true);
  });

  test("reassigning through update_todo starts the new assignee", async () => {
    const token = tokenFor(ada);
    const created = await tool<{ todo: { id: string } }>(token, "create_todo", {
      projectSlug: "ops",
      title: "Mine for now",
    });
    await tool(token, "update_todo", {
      todoId: created.body.todo.id,
      assigneeEmployeeSlug: "ben",
    });
    await settleTodoPickupsForTests();
    const [pickup] = await pickups().findBy({ todoId: created.body.todo.id });
    assert.equal(pickup.employeeId, ben.id);
  });

  test("a Todo filed inside a session sits one deeper, and a deep chain stops", async () => {
    const parent = await insert(Todo, {
      projectId: project.id,
      number: 9,
      title: "Parent",
      status: "in_progress",
      priority: "none",
      assigneeEmployeeId: ada.id,
      aiChainDepth: 5,
    });
    const session = await insert(TodoPickup, {
      companyId: company.id,
      todoId: parent.id,
      employeeId: ada.id,
      trigger: "assigned",
      status: "running",
      acceptedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const token = tokenFor(ada, { authority: "employee", todoPickupId: session.id });
    const created = await tool<{ todo: { id: string }; note?: string }>(token, "create_todo", {
      projectSlug: "ops",
      title: "Child",
      assigneeEmployeeSlug: "ben",
    });
    assert.match(created.body.note ?? "", /too many AI hand-offs/);
    await settleTodoPickupsForTests();
    assert.equal(await pickups().countBy({ todoId: created.body.todo.id }), 0);
    const child = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: created.body.todo.id });
    assert.equal(child.aiChainDepth, 6);
  });

  test("an assignee with no AI Model is told plainly", async () => {
    const idle = await insert(AIEmployee, {
      companyId: company.id,
      name: "Idle",
      slug: "idle",
      role: "Placeholder",
      soulBody: "",
    });
    const created = await tool<{ note?: string }>(tokenFor(ada), "create_todo", {
      projectSlug: "ops",
      title: "For someone who can't start",
      assigneeEmployeeSlug: idle.slug,
    });
    assert.match(created.body.note ?? "", /no AI Model/);
  });

  test("a comment from a tainted turn taints the thread", async () => {
    const row = await insert(Todo, {
      projectId: project.id,
      number: 10,
      title: "Thread",
      status: "todo",
      priority: "none",
    });
    const token = tokenFor(ada);
    markTokenTainted(token);
    await tool(token, "add_todo_comment", { todoId: row.id, body: "A page said this." });
    const fresh = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: row.id });
    assert.equal(fresh.tainted, true);
  });

  test("a reviewer's session comes from moving the card, and inherits the ceiling", async () => {
    const row = await insert(Todo, {
      projectId: project.id,
      number: 11,
      title: "Review me",
      status: "in_progress",
      priority: "none",
      assigneeEmployeeId: ada.id,
      reviewerEmployeeId: ben.id,
    });
    await tool(
      tokenFor(ada, { authority: "employee", mailDeliveryMode: "review" }),
      "update_todo",
      { todoId: row.id, status: "in_review" },
    );
    await settleTodoPickupsForTests();
    // The kickoff is fire-and-forget on the tool's side.
    for (let i = 0; i < 40; i += 1) {
      if (await pickups().existsBy({ todoId: row.id })) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [pickup] = await pickups().findBy({ todoId: row.id });
    assert.equal(pickup.employeeId, ben.id);
    assert.equal(pickup.trigger, "review");
    assert.equal(pickup.mailDeliveryMode, "review");
    const fresh = await AppDataSource.getRepository(Todo).findOneByOrFail({ id: row.id });
    assert.equal(fresh.aiReviewPasses, 1);
  });
});
