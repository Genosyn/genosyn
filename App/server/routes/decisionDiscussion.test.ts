import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Decision } from "../db/entities/Decision.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { decisionsRouter } from "./decisions.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";

let server: Server;
let baseUrl: string;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? { userId, sessionVersion: 0, authenticatedAt: Date.now() }
      : {};
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", decisionsRouter);
  app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

let company: Company;
let otherCompany: Company;
let asker: AIEmployee;
let decider: AIEmployee;
let member: User;
let teammate: User;
let outsider: User;
let decision: Decision;
let bearer = "";

type DiscussionBody = {
  conversation: {
    id: string;
    employeeId: string;
    title: string | null;
    discussedDecisionId: string | null;
  } | null;
  messages: Array<{ id: string; role: string; content: string }>;
  error?: string;
};

beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, { email: "member@example.test", name: "Member", passwordHash: "x" });
  teammate = await insert(User, {
    email: "teammate@example.test",
    name: "Teammate",
    passwordHash: "x",
  });
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "x",
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: company.id, userId: teammate.id, role: "member" });
  asker = await insert(AIEmployee, {
    companyId: company.id,
    name: "Alex",
    slug: "alex",
    role: "Operations",
  });
  decider = await insert(AIEmployee, {
    companyId: company.id,
    name: "Dana",
    slug: "dana",
    role: "Manager",
  });
  decision = await insert(Decision, {
    companyId: company.id,
    employeeId: asker.id,
    routedToEmployeeId: decider.id,
    assigneeUserId: teammate.id,
    title: "Send the customer update?",
    body: "The draft and its trade-offs.",
    optionsJson: JSON.stringify([
      { id: "send", label: "Send it", detail: null, tone: "primary" },
      { id: "wait", label: "Wait", detail: null, tone: "neutral" },
    ]),
    status: "pending",
  });
  const tokenBody = "D".repeat(43);
  await insert(ApiKey, {
    userId: member.id,
    companyId: company.id,
    name: "automation",
    prefix: tokenBody.slice(0, 8),
    tokenHash: hashApiToken(tokenBody),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  });
  bearer = `gen_${tokenBody}`;
});

async function call<T = DiscussionBody>(
  method: "GET" | "POST",
  path: string,
  options: { user?: User; bearer?: string; body?: unknown; companyId?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.user) headers["x-test-user"] = options.user.id;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  const body = method === "POST" ? JSON.stringify(options.body ?? {}) : undefined;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(
    `${baseUrl}/api/companies/${options.companyId ?? company.id}${path}`,
    { method, headers, body },
  );
  return { status: response.status, body: (await response.json()) as T };
}

const discussion = (id = decision.id) => `/decisions/${id}/discussion`;

describe("a Decision's own discussion", () => {
  test("is empty and creates nothing until the Member sends", async () => {
    const empty = await call("GET", discussion(), { user: member });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { conversation: null, messages: [] });
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 0);
  });

  test("opens one private thread per Member with the employee who asked", async () => {
    const opened = await call("POST", discussion(), { user: member });
    assert.equal(opened.status, 200);
    const thread = opened.body.conversation;
    assert.ok(thread);
    // The asker, never the AI decider the question was routed to.
    assert.equal(thread.employeeId, asker.id);
    assert.equal(thread.discussedDecisionId, decision.id);
    assert.equal(thread.title, "Discuss: Send the customer update?");
    assert.deepEqual(opened.body.messages, []);
    const row = await AppDataSource.getRepository(Conversation).findOneByOrFail({ id: thread.id });
    assert.equal(row.ownerUserId, member.id);
    assert.equal(row.source, "web");

    // Opening again, or from two tabs at once, keeps the same thread.
    const again = await Promise.all([
      call("POST", discussion(), { user: member }),
      call("POST", discussion(), { user: member }),
    ]);
    for (const response of again) assert.equal(response.body.conversation?.id, thread.id);
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 1);

    await insert(ConversationMessage, {
      conversationId: thread.id,
      role: "user",
      content: "Why wait?",
      createdAt: new Date("2026-10-08T09:00:00.000Z"),
    });
    await insert(ConversationMessage, {
      conversationId: thread.id,
      role: "assistant",
      content: "Support coverage is thin this week.",
      status: "ok",
      createdAt: new Date("2026-10-08T09:00:05.000Z"),
    });
    const read = await call("GET", discussion(), { user: member });
    assert.equal(read.body.conversation?.id, thread.id);
    assert.deepEqual(
      read.body.messages.map((message) => [message.role, message.content]),
      [
        ["user", "Why wait?"],
        ["assistant", "Support coverage is thin this week."],
      ],
    );
    // The same thread is the Member's ordinary chat with that employee.
    const chat = await call<{ conversation: { id: string } }>(
      "GET",
      `/employees/${asker.id}/conversations/${thread.id}`,
      { user: member },
    );
    assert.equal(chat.status, 200);
    assert.equal(chat.body.conversation.id, thread.id);

    // Another Member — the assignee here — gets a separate, private thread.
    const theirs = await call("GET", discussion(), { user: teammate });
    assert.deepEqual(theirs.body, { conversation: null, messages: [] });
    const opensOwn = await call("POST", discussion(), { user: teammate });
    assert.ok(opensOwn.body.conversation);
    assert.notEqual(opensOwn.body.conversation.id, thread.id);
    assert.equal(
      (
        await call("GET", `/employees/${asker.id}/conversations/${thread.id}`, {
          user: teammate,
        })
      ).status,
      404,
    );
  });

  test("keeps a long Decision title to one short chat title", async () => {
    await AppDataSource.getRepository(Decision).update(decision.id, {
      title: `${"Confirm the pricing basis for the renewal ".repeat(3)}\nSecond line`,
    });
    const opened = await call("POST", discussion(), { user: member });
    const title = opened.body.conversation?.title ?? "";
    assert.ok(title.length <= 60, title);
    assert.match(title, /^Discuss: Confirm the pricing basis/);
    assert.match(title, /…$/);
    assert.doesNotMatch(title, /Second line/);
  });

  test("stays inside the company, its Members and their browser sessions", async () => {
    for (const method of ["GET", "POST"] as const) {
      assert.equal((await call(method, discussion(), { bearer })).status, 403);
      assert.equal((await call(method, discussion(), { user: outsider })).status, 403);
      assert.equal(
        (await call(method, discussion(), { user: member, companyId: otherCompany.id })).status,
        404,
      );
      assert.equal((await call(method, discussion("not-a-uuid"), { user: member })).status, 400);
    }
    assert.equal(
      (await call("POST", discussion(), { user: member, body: { conversationId: "x" } })).status,
      400,
    );
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 0);
  });

  test("reports a deleted asking employee instead of opening a thread", async () => {
    await AppDataSource.getRepository(AIEmployee).delete(asker.id);
    for (const method of ["GET", "POST"] as const) {
      const response = await call(method, discussion(), { user: member });
      assert.equal(response.status, 409);
      assert.match(response.body.error ?? "", /deleted/);
    }
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 0);
  });
});
