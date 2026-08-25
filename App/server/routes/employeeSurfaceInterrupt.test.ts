import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";

/**
 * Stopping a reply is a Member telling their employee to put down what it is
 * doing so the follow-up they already typed can go now. These tests pin the
 * two things that makes true: the durable row leaves `working` — so nothing
 * resumes it and the queue drains — and only the Member who owns the thread
 * can do it.
 */

let server: Server;
let baseUrl: string;
let company: Company;
let employee: AIEmployee;
let owner: User;
let stranger: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? { userId, sessionVersion: 0, authenticatedAt: Date.now() }
      : {};
    next();
  });
  app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
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

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  stranger = await insert(User, {
    email: "stranger@example.com",
    name: "Stranger",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: stranger.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie-mallers",
    role: "Reviewer",
    soulBody: "",
  });
});

async function conversation(ownerUserId: string | null = owner.id): Promise<Conversation> {
  return insert(Conversation, {
    employeeId: employee.id,
    ownerUserId,
    title: "Repository review",
    archivedAt: null,
    source: "web",
    externalKey: null,
    connectionId: null,
  });
}

async function workingReply(conversationId: string): Promise<ConversationMessage> {
  await insert(ConversationMessage, {
    conversationId,
    role: "user",
    content: "Review the attribution issue",
    status: null,
    createdAt: new Date("2026-08-25T09:00:00.000Z"),
  });
  return insert(ConversationMessage, {
    conversationId,
    role: "assistant",
    content: "",
    status: "working",
    progressPercent: 40,
    progressLabel: "Reading the checkout",
    turnWorkerId: "worker-elsewhere",
    turnLeaseExpiresAt: new Date(Date.now() + 15_000),
    createdAt: new Date("2026-08-25T09:00:01.000Z"),
  });
}

async function interrupt(convId: string, asUser: User = owner) {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/conversations/${convId}/interrupt`,
    {
      method: "POST",
      headers: { "x-test-user": asUser.id, "content-type": "application/json" },
      body: "{}",
    },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function reload(id: string): Promise<ConversationMessage> {
  return AppDataSource.getRepository(ConversationMessage).findOneByOrFail({ id });
}

describe("interrupting a chat turn", () => {
  test("takes the reply out of working so nothing resumes it", async () => {
    const conv = await conversation();
    const reply = await workingReply(conv.id);

    const response = await interrupt(conv.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { interrupted: true });

    const stopped = await reload(reply.id);
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.progressPercent, null);
    assert.equal(stopped.progressLabel, null);
    // A row still carrying a worker claim would be picked back up by the
    // recovery sweep the moment its lease expired.
    assert.equal(stopped.turnWorkerId, null);
    assert.equal(stopped.turnLeaseExpiresAt, null);
    assert.ok(stopped.content.trim().length > 0, "an empty bubble reads as a broken reply");
  });

  test("a thread with nothing running answers plainly instead of erroring", async () => {
    const conv = await conversation();
    const finished = await insert(ConversationMessage, {
      conversationId: conv.id,
      role: "assistant",
      content: "Here is the review.",
      status: "ok",
    });

    const response = await interrupt(conv.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { interrupted: false });
    assert.equal((await reload(finished.id)).status, "ok");
  });

  test("pressing it twice does not turn a stopped turn into a second event", async () => {
    const conv = await conversation();
    await workingReply(conv.id);

    assert.deepEqual((await interrupt(conv.id)).body, { interrupted: true });
    assert.deepEqual((await interrupt(conv.id)).body, { interrupted: false });
  });

  test("only the Member who owns the thread can stop its reply", async () => {
    const conv = await conversation();
    const reply = await workingReply(conv.id);

    const response = await interrupt(conv.id, stranger);
    assert.equal(response.status, 404);
    assert.equal((await reload(reply.id)).status, "working");
  });

  test("stops only the reply in flight, leaving earlier turns intact", async () => {
    const conv = await conversation();
    const earlier = await insert(ConversationMessage, {
      conversationId: conv.id,
      role: "assistant",
      content: "Earlier answer.",
      status: "ok",
      createdAt: new Date("2026-08-25T08:00:00.000Z"),
    });
    const reply = await workingReply(conv.id);

    assert.deepEqual((await interrupt(conv.id)).body, { interrupted: true });
    assert.equal((await reload(earlier.id)).status, "ok");
    assert.equal((await reload(earlier.id)).content, "Earlier answer.");
    assert.equal((await reload(reply.id)).status, "interrupted");
  });

  test("frees the employee's reply lease so the next message is not answered busy", async () => {
    const conv = await conversation();
    const reply = await workingReply(conv.id);
    // The worker that acquired this died mid-turn — the state a Member is
    // usually reacting to when they reach for Stop. Nothing will ever
    // re-acquire under this key once the row is terminal, so the stop is the
    // last chance to release it.
    await insert(WorkloadLease, {
      companyId: company.id,
      employeeId: employee.id,
      kind: "chat",
      ownerKey: reply.id,
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
    });

    assert.deepEqual((await interrupt(conv.id)).body, { interrupted: true });
    assert.equal(
      await AppDataSource.getRepository(WorkloadLease).countBy({ ownerKey: reply.id }),
      0,
      "a leftover reply lease reads as busy to every later chat turn for six hours",
    );
  });

  test("stops the turn a worker is running, not one still waiting its turn", async () => {
    const conv = await conversation();
    const running = await workingReply(conv.id);
    // A second tab accepted another turn; it lost the employee's reply lease
    // and sits unclaimed at `working` until the first one finishes.
    const waiting = await insert(ConversationMessage, {
      conversationId: conv.id,
      role: "assistant",
      content: "",
      status: "working",
      progressLabel: "Waiting for another reply",
      turnWorkerId: null,
      turnLeaseExpiresAt: null,
      createdAt: new Date("2026-08-25T09:05:00.000Z"),
    });

    assert.deepEqual((await interrupt(conv.id)).body, { interrupted: true });
    assert.equal((await reload(running.id)).status, "interrupted");
    assert.equal(
      (await reload(waiting.id)).status,
      "working",
      "the follow-up the Member interrupted for must still be waiting to send",
    );
  });

  test("does not reach into another thread's live reply", async () => {
    const target = await conversation();
    const other = await conversation();
    const otherReply = await workingReply(other.id);

    assert.deepEqual((await interrupt(target.id)).body, { interrupted: false });
    assert.equal((await reload(otherReply.id)).status, "working");
  });
});
