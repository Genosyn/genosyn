import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { lastChatModelId, lastChatModelIds } from "./conversationModels.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const EMPLOYEE = "employee-thread-model";
const OTHER_EMPLOYEE = "employee-other";

async function model(args: {
  employeeId?: string;
  name: string;
  connected?: boolean;
  isActive?: boolean;
}): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: args.employeeId ?? EMPLOYEE,
    provider: "openai",
    model: args.name,
    authMode: "apikey",
    isActive: args.isActive ?? false,
    // `isModelConnected` reads the encrypted key out of configJson; an empty
    // object is exactly how a registered-but-not-connected model looks.
    configJson: (args.connected ?? true) ? '{"apiKeyEncrypted":"v2:ciphertext"}' : "{}",
    connectedAt: (args.connected ?? true) ? new Date() : null,
    contextWindow: null,
    contextWindowSource: null,
  });
}

async function conversation(title: string): Promise<Conversation> {
  return insert(Conversation, {
    employeeId: EMPLOYEE,
    ownerUserId: "user-1",
    title,
    archivedAt: null,
    source: "web",
    externalKey: null,
    connectionId: null,
  });
}

/** One accepted turn: the human message plus the assistant reply that ran on `modelId`. */
async function turn(args: {
  conversationId: string;
  modelId: string | null;
  at: string;
  status?: "ok" | "working" | "error";
}): Promise<ConversationMessage> {
  await insert(ConversationMessage, {
    conversationId: args.conversationId,
    role: "user",
    content: "question",
    status: null,
    createdAt: new Date(args.at),
  });
  return insert(ConversationMessage, {
    conversationId: args.conversationId,
    role: "assistant",
    content: "answer",
    status: args.status ?? "ok",
    modelId: args.modelId,
    createdAt: new Date(args.at),
  });
}

describe("thread model resolution", () => {
  test("resolves the model each thread last ran on, independently per thread", async () => {
    const claude = await model({ name: "claude", isActive: true });
    const gpt = await model({ name: "gpt" });
    const [alpha, beta, gamma] = [
      await conversation("alpha"),
      await conversation("beta"),
      await conversation("gamma"),
    ];

    await turn({ conversationId: alpha.id, modelId: claude.id, at: "2026-08-01T10:00:00.000Z" });
    await turn({ conversationId: alpha.id, modelId: gpt.id, at: "2026-08-01T11:00:00.000Z" });
    await turn({ conversationId: beta.id, modelId: claude.id, at: "2026-08-02T09:00:00.000Z" });

    const resolved = await lastChatModelIds(EMPLOYEE, [alpha.id, beta.id, gamma.id]);
    assert.equal(resolved.get(alpha.id), gpt.id);
    assert.equal(resolved.get(beta.id), claude.id);
    // A thread nobody has sent in yet has no model of its own.
    assert.equal(resolved.get(gamma.id), null);
    assert.equal(resolved.size, 3);
  });

  test("the newest turn wins even when an older turn used a different model", async () => {
    const first = await model({ name: "first" });
    const second = await model({ name: "second" });
    const conv = await conversation("switched mid-thread");

    await turn({ conversationId: conv.id, modelId: first.id, at: "2026-08-01T10:00:00.000Z" });
    await turn({ conversationId: conv.id, modelId: second.id, at: "2026-08-01T10:05:00.000Z" });
    await turn({ conversationId: conv.id, modelId: first.id, at: "2026-08-01T10:10:00.000Z" });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), first.id);
  });

  test("orders by when the turn happened, not by row insertion order", async () => {
    const older = await model({ name: "older" });
    const newer = await model({ name: "newer" });
    const conv = await conversation("out-of-order rows");

    // Inserted first, but timestamped last: a resolver that trusted insertion
    // order (or the id) instead of `createdAt` would answer `older` here.
    await turn({ conversationId: conv.id, modelId: newer.id, at: "2026-08-01T18:00:00.000Z" });
    await turn({ conversationId: conv.id, modelId: older.id, at: "2026-08-01T09:00:00.000Z" });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), newer.id);
  });

  test("an in-flight turn already counts — recovery must not swap brains", async () => {
    const active = await model({ name: "active", isActive: true });
    const chosen = await model({ name: "chosen" });
    const conv = await conversation("mid-turn");

    await turn({ conversationId: conv.id, modelId: active.id, at: "2026-08-01T10:00:00.000Z" });
    await turn({
      conversationId: conv.id,
      modelId: chosen.id,
      at: "2026-08-01T10:01:00.000Z",
      status: "working",
    });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), chosen.id);
  });

  test("human messages never decide the thread's model", async () => {
    const claude = await model({ name: "claude" });
    const conv = await conversation("trailing question");

    await turn({ conversationId: conv.id, modelId: claude.id, at: "2026-08-01T10:00:00.000Z" });
    // A user message persisted after the last reply carries a null modelId.
    await insert(ConversationMessage, {
      conversationId: conv.id,
      role: "user",
      content: "follow-up",
      status: null,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
    });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), claude.id);
  });

  test("legacy turns that never recorded a model fall back to the active one", async () => {
    await model({ name: "claude", isActive: true });
    const conv = await conversation("pre-modelId thread");
    await turn({ conversationId: conv.id, modelId: null, at: "2026-08-01T10:00:00.000Z" });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), null);
  });

  test("skips a deleted model in favour of the newest surviving one", async () => {
    const kept = await model({ name: "kept" });
    const removed = await model({ name: "removed" });
    const conv = await conversation("model deleted later");

    await turn({ conversationId: conv.id, modelId: kept.id, at: "2026-08-01T10:00:00.000Z" });
    await turn({ conversationId: conv.id, modelId: removed.id, at: "2026-08-01T11:00:00.000Z" });
    // The models route deletes the row outright; the turn keeps its dangling id.
    await AppDataSource.getRepository(AIModel).delete({ id: removed.id });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), kept.id);
  });

  test("skips a disconnected model in favour of the newest connected one", async () => {
    const connected = await model({ name: "connected" });
    const disconnected = await model({ name: "disconnected", connected: false });
    const conv = await conversation("key revoked later");

    await turn({ conversationId: conv.id, modelId: connected.id, at: "2026-08-01T10:00:00.000Z" });
    await turn({
      conversationId: conv.id,
      modelId: disconnected.id,
      at: "2026-08-01T11:00:00.000Z",
    });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), connected.id);
  });

  test("never offers a model belonging to a different employee", async () => {
    const foreign = await model({ employeeId: OTHER_EMPLOYEE, name: "foreign" });
    const conv = await conversation("cross-employee id");
    await turn({ conversationId: conv.id, modelId: foreign.id, at: "2026-08-01T10:00:00.000Z" });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), null);
  });

  test("resolves to null when the employee has no usable model at all", async () => {
    const disconnected = await model({ name: "disconnected", connected: false });
    const conv = await conversation("nothing connected");
    await turn({
      conversationId: conv.id,
      modelId: disconnected.id,
      at: "2026-08-01T10:00:00.000Z",
    });

    assert.equal(await lastChatModelId(EMPLOYEE, conv.id), null);
  });

  test("a thread's turns never leak into another thread's answer", async () => {
    const claude = await model({ name: "claude" });
    const mine = await conversation("mine");
    const theirs = await conversation("theirs");
    await turn({ conversationId: theirs.id, modelId: claude.id, at: "2026-08-01T10:00:00.000Z" });

    const resolved = await lastChatModelIds(EMPLOYEE, [mine.id]);
    assert.equal(resolved.get(mine.id), null);
    assert.equal(resolved.has(theirs.id), false);
  });

  test("an unknown conversation id resolves to null instead of throwing", async () => {
    await model({ name: "claude" });
    assert.equal(await lastChatModelId(EMPLOYEE, "conversation-that-never-existed"), null);
  });

  test("an empty request short-circuits to an empty map", async () => {
    const resolved = await lastChatModelIds(EMPLOYEE, []);
    assert.equal(resolved.size, 0);
  });
});
