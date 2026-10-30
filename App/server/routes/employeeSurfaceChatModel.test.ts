import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import type { ModelEffort } from "../../shared/modelEffort.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";

/**
 * The chat composer must reopen a past thread on the brain that thread was
 * held with, at the effort it was asked to think with. These tests pin the
 * wire contract that makes that possible: every conversation the surface hands
 * back carries `lastModelId` and `lastEffort`, and a send's effort is checked
 * against its model before the turn is accepted.
 */

let server: Server;
let baseUrl: string;
let company: Company;
let employee: AIEmployee;
let owner: User;
let activeModel: AIModel;
let otherModel: AIModel;

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
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Analyst",
    slug: "analyst",
    role: "Analyst",
    soulBody: "",
  });
  activeModel = await model({ name: "claude-active", isActive: true });
  otherModel = await model({ name: "gpt-other" });
});

async function model(args: {
  name: string;
  isActive?: boolean;
  connected?: boolean;
}): Promise<AIModel> {
  return insertEmployeeModel({
    employeeId: employee.id,
    provider: "openai",
    model: args.name,
    authMode: "apikey",
    isActive: args.isActive ?? false,
    configJson: (args.connected ?? true) ? '{"apiKeyEncrypted":"v2:ciphertext"}' : "{}",
    connectedAt: (args.connected ?? true) ? new Date() : null,
    contextWindow: null,
    contextWindowSource: null,
  });
}

async function conversation(args: {
  title: string;
  ownerUserId?: string | null;
  archivedAt?: Date | null;
}): Promise<Conversation> {
  return insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: args.ownerUserId === undefined ? owner.id : args.ownerUserId,
    title: args.title,
    archivedAt: args.archivedAt ?? null,
    source: "web",
    externalKey: null,
    connectionId: null,
  });
}

async function turn(args: {
  conversationId: string;
  modelId: string | null;
  at: string;
  effort?: ModelEffort | null;
}): Promise<void> {
  await insert(ConversationMessage, {
    conversationId: args.conversationId,
    role: "user",
    content: "question",
    status: null,
    createdAt: new Date(args.at),
  });
  await insert(ConversationMessage, {
    conversationId: args.conversationId,
    role: "assistant",
    content: "answer",
    status: "ok",
    modelId: args.modelId,
    effort: args.effort ?? null,
    createdAt: new Date(args.at),
  });
}

type Summary = {
  id: string;
  title: string | null;
  lastModelId: string | null;
  lastEffort: ModelEffort | null;
};

async function call(method: string, suffix: string, body?: unknown) {
  const headers: Record<string, string> = { "x-test-user": owner.id };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employee.id}${suffix}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("conversation lastModelId", () => {
  test("the thread list reports each thread's own model, not the active one", async () => {
    const onOther = await conversation({ title: "ran on the other model" });
    const onActive = await conversation({ title: "ran on the active model" });
    const untouched = await conversation({ title: "never sent" });
    await turn({ conversationId: onOther.id, modelId: otherModel.id, at: "2026-08-01T10:00Z" });
    await turn({ conversationId: onActive.id, modelId: activeModel.id, at: "2026-08-02T10:00Z" });

    const listed = await call("GET", "/conversations");
    assert.equal(listed.status, 200);
    const byId = new Map((listed.body as Summary[]).map((row) => [row.id, row.lastModelId]));
    assert.equal(byId.get(onOther.id), otherModel.id);
    assert.equal(byId.get(onActive.id), activeModel.id);
    assert.equal(byId.get(untouched.id), null);
  });

  test("opening a thread reports the model its newest turn ran on", async () => {
    const conv = await conversation({ title: "switched brains mid-thread" });
    await turn({ conversationId: conv.id, modelId: activeModel.id, at: "2026-08-01T10:00Z" });
    await turn({ conversationId: conv.id, modelId: otherModel.id, at: "2026-08-01T11:00Z" });

    const detail = await call("GET", `/conversations/${conv.id}`);
    assert.equal(detail.status, 200);
    assert.equal(
      (detail.body as { conversation: Summary }).conversation.lastModelId,
      otherModel.id,
    );
  });

  test("a model deleted after the fact stops being offered", async () => {
    const conv = await conversation({ title: "model removed later" });
    await turn({ conversationId: conv.id, modelId: otherModel.id, at: "2026-08-01T10:00Z" });
    await AppDataSource.getRepository(AIModel).delete({ id: otherModel.id });

    const detail = await call("GET", `/conversations/${conv.id}`);
    assert.equal((detail.body as { conversation: Summary }).conversation.lastModelId, null);
  });

  test("a disconnected model stops being offered", async () => {
    const revoked = await model({ name: "gpt-revoked", connected: false });
    const conv = await conversation({ title: "key revoked later" });
    await turn({ conversationId: conv.id, modelId: revoked.id, at: "2026-08-01T10:00Z" });

    const detail = await call("GET", `/conversations/${conv.id}`);
    assert.equal((detail.body as { conversation: Summary }).conversation.lastModelId, null);
  });

  test("a brand-new thread has no model of its own yet", async () => {
    const created = await call("POST", "/conversations", {});
    assert.equal(created.status, 200);
    assert.equal((created.body as Summary).lastModelId, null);
  });

  test("archive and unarchive keep the sidebar summary complete", async () => {
    const conv = await conversation({ title: "archived thread" });
    await turn({ conversationId: conv.id, modelId: otherModel.id, at: "2026-08-01T10:00Z" });

    const archived = await call("POST", `/conversations/${conv.id}/archive`, {});
    assert.equal(archived.status, 200);
    assert.equal((archived.body as Summary).lastModelId, otherModel.id);

    const archivedList = await call("GET", "/conversations?archived=1");
    assert.deepEqual(
      (archivedList.body as Summary[]).map((row) => row.lastModelId),
      [otherModel.id],
    );

    const restored = await call("POST", `/conversations/${conv.id}/unarchive`, {});
    assert.equal((restored.body as Summary).lastModelId, otherModel.id);
  });

  test("claiming a legacy thread returns the model it ran on", async () => {
    const legacy = await conversation({ title: "pre-owner thread", ownerUserId: null });
    await turn({ conversationId: legacy.id, modelId: otherModel.id, at: "2026-08-01T10:00Z" });

    const claimed = await call("POST", `/conversations/${legacy.id}/claim`, {});
    assert.equal(claimed.status, 200);
    assert.equal((claimed.body as Summary).lastModelId, otherModel.id);
  });

  test("one thread's model never bleeds into a sibling thread", async () => {
    const loud = await conversation({ title: "busy thread" });
    const quiet = await conversation({ title: "quiet thread" });
    for (let i = 0; i < 5; i += 1) {
      await turn({
        conversationId: loud.id,
        modelId: otherModel.id,
        at: `2026-08-0${i + 1}T10:00Z`,
      });
    }

    const detail = await call("GET", `/conversations/${quiet.id}`);
    assert.equal((detail.body as { conversation: Summary }).conversation.lastModelId, null);
  });

  test("a model registered to another employee is never offered", async () => {
    const stranger = await insert(AIEmployee, {
      companyId: company.id,
      name: "Writer",
      slug: "writer",
      role: "Writer",
      soulBody: "",
    });
    const foreign = await insertEmployeeModel({
      employeeId: stranger.id,
      provider: "openai",
      model: "gpt-foreign",
      authMode: "apikey",
      isActive: true,
      configJson: '{"apiKeyEncrypted":"v2:ciphertext"}',
      connectedAt: new Date(),
      contextWindow: null,
      contextWindowSource: null,
    });
    const conv = await conversation({ title: "cross-employee id" });
    await turn({ conversationId: conv.id, modelId: foreign.id, at: "2026-08-01T10:00Z" });

    const detail = await call("GET", `/conversations/${conv.id}`);
    assert.equal((detail.body as { conversation: Summary }).conversation.lastModelId, null);
  });
});

/** Every `event:` / `data:` frame of a streamed send, read to the end. */
async function sendEvents(
  conversationId: string,
  body: Record<string, unknown>,
): Promise<{ event: string; data: unknown }[]> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": owner.id },
      body: JSON.stringify(body),
    },
  );
  assert.equal(response.status, 200);
  const events: { event: string; data: unknown }[] = [];
  for (const frame of (await response.text()).split("\n\n")) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

describe("conversation lastEffort", () => {
  test("summaries report the effort of the turn the thread reopens on", async () => {
    const thinking = await conversation({ title: "asked for more thinking" });
    const plain = await conversation({ title: "default effort" });
    await turn({
      conversationId: thinking.id,
      modelId: otherModel.id,
      effort: "xhigh",
      at: "2026-08-01T10:00Z",
    });
    await turn({ conversationId: plain.id, modelId: otherModel.id, at: "2026-08-01T11:00Z" });

    const listed = await call("GET", "/conversations");
    const byId = new Map((listed.body as Summary[]).map((row) => [row.id, row]));
    assert.equal(byId.get(thinking.id)?.lastEffort, "xhigh");
    assert.equal(byId.get(plain.id)?.lastEffort, null);

    const detail = await call("GET", `/conversations/${thinking.id}`);
    assert.deepEqual(
      {
        modelId: (detail.body as { conversation: Summary }).conversation.lastModelId,
        effort: (detail.body as { conversation: Summary }).conversation.lastEffort,
      },
      { modelId: otherModel.id, effort: "xhigh" },
    );

    const created = await call("POST", "/conversations", {});
    assert.equal((created.body as Summary).lastEffort, null);
  });

  test("a level its model does not offer runs at the nearest one, never refused", async () => {
    for (const [modelId, effort, expected] of [
      // This model has no known thinking levels at all: its own default.
      [otherModel.id, "high", { send: null, level: null }],
      // This one does, but tops out below this level.
      [(await model({ name: "gpt-5.4" })).id, "max", { send: "xhigh", level: "xhigh" }],
    ] as const) {
      const conv = await conversation({ title: `level ${effort} on ${modelId}` });
      const events = await sendEvents(conv.id, { message: "Think hard", modelId, effort });
      assert.equal(
        events.some((entry) => entry.event === "error"),
        false,
      );
      const assistant = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
        conversationId: conv.id,
        role: "assistant",
      });
      assert.equal(assistant.effort, expected.send);
      assert.deepEqual(JSON.parse(assistant.thinkingJson), {
        level: expected.level,
        requested: effort,
        adjusted: "unsupported",
      });
    }
  });

  test("an effort the API does not know is rejected by the schema", async () => {
    const conv = await conversation({ title: "made-up effort" });
    const response = await call("POST", `/conversations/${conv.id}/messages`, {
      message: "Think hard",
      effort: "turbo",
    });
    assert.equal(response.status, 400);
  });

  test("a supported effort is stored with the turn and reported on the thread", async () => {
    const reasoning = await model({ name: "gpt-5.4" });
    const conv = await conversation({ title: "think harder" });

    const events = await sendEvents(conv.id, {
      message: "Think hard",
      modelId: reasoning.id,
      effort: "xhigh",
    });
    const accepted = events.find((entry) => entry.event === "conversation")?.data as
      | Summary
      | undefined;
    assert.equal(accepted?.lastModelId, reasoning.id);
    assert.equal(accepted?.lastEffort, "xhigh");

    const assistant = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      conversationId: conv.id,
      role: "assistant",
    });
    assert.equal(assistant.modelId, reasoning.id);
    assert.equal(assistant.effort, "xhigh");
  });
});
