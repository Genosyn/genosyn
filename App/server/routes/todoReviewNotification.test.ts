import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { projectsRouter } from "./projects.js";

/**
 * Asking a teammate to review a todo rings their bell, and that bell opens
 * the todo itself (`?todo=` beside the board), ready to approve or push back —
 * not the project's board, where the reviewer had to find the card first.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let reviewer: User;
let todo: Todo;

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

async function member(email: string, role: Role): Promise<User> {
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
  owner = await member("owner@example.com", "owner" as Role);
  reviewer = await member("reviewer@example.com", "member" as Role);
  const project = await insert(Project, {
    companyId: company.id,
    name: "Launch",
    slug: "launch",
    key: "LAU",
    todoCounter: 1,
  });
  todo = await insert(Todo, { projectId: project.id, number: 1, title: "Write the launch post" });
  actingUserId = owner.id;
});

async function patchTodo(body: unknown): Promise<number> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/todos/${todo.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

/** The bell is rung after the response, so wait for it briefly. */
async function reviewBell(userId: string): Promise<Notification | null> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const row = await AppDataSource.getRepository(Notification).findOneBy({
      userId,
      kind: "todo_review_requested",
    });
    if (row || Date.now() > deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("review requests", () => {
  test("the reviewer's bell opens the todo itself", async () => {
    assert.equal(await patchTodo({ status: "in_review", reviewerUserId: reviewer.id }), 200);
    const bell = await reviewBell(reviewer.id);
    assert.ok(bell, "the reviewer was notified");
    assert.equal(bell.link, `/c/acme/tasks/p/launch?todo=${todo.id}`);
    assert.equal(bell.entityKind, "todo");
    assert.equal(bell.entityId, todo.id);
  });

  test("moving your own card into your own review rings nobody", async () => {
    actingUserId = reviewer.id;
    assert.equal(await patchTodo({ status: "in_review", reviewerUserId: reviewer.id }), 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await AppDataSource.getRepository(Notification).countBy({ kind: "todo_review_requested" }),
      0,
    );
  });
});
