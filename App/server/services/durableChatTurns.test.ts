import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { createChatTurnProgressRecorder } from "./chatTurnProgress.js";
import {
  claimDurableChatTurn,
  enqueueDurableChatTurn,
  executeDurableChatTurn,
} from "./durableChatTurns.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function fixture() {
  const requester = await insert(User, {
    email: "owner@durable.example",
    passwordHash: "hash",
    name: "Durable Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Durable Co",
    slug: "durable-co",
    ownerId: requester.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: requester.id,
    role: "owner",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Durable",
    slug: "jamie-durable",
    role: "Operations",
  });
  const conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: requester.id,
    title: null,
    source: "web",
  });
  return { company, employee, conversation, requester };
}

describe("durable chat turns", () => {
  test("atomically persists the recovery job and binds its input attachments", async () => {
    const { company, employee, conversation, requester } = await fixture();
    const attachment = await insert(Attachment, {
      companyId: company.id,
      messageId: null,
      filename: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storageKey: "brief.txt",
      uploadedByUserId: requester.id,
    });

    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Complete the long-running migration",
      attachmentIds: [attachment.id],
      modelId: "model-selected-for-turn",
      effort: "high",
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
    });

    assert.equal(queued.assistantMessage.status, "working");
    assert.equal(queued.assistantMessage.modelId, "model-selected-for-turn");
    assert.equal(queued.assistantMessage.effort, "high");
    // The human message never carries a choice of its own.
    assert.equal(queued.userMessage.effort, null);
    assert.equal(queued.assistantMessage.turnRequesterUserId, requester.id);
    assert.equal(queued.assistantMessage.turnRequesterSessionVersion, 0);
    assert.equal(queued.assistantMessage.turnUserMessageId, queued.userMessage.id);
    assert.equal(queued.assistantMessage.turnAttempt, 0);
    assert.equal(queued.assistantMessage.turnWorkerId, null);
    assert.ok((queued.assistantMessage.turnDeadlineAt?.getTime() ?? 0) > Date.now());
    assert.equal(queued.userAttachments[0]?.id, attachment.id);

    const rebound = await AppDataSource.getRepository(Attachment).findOneByOrFail({
      id: attachment.id,
    });
    assert.equal(rebound.messageId, queued.userMessage.id);
    const refreshedConversation = await AppDataSource.getRepository(Conversation).findOneByOrFail({
      id: conversation.id,
    });
    assert.equal(refreshedConversation.title, "Complete the long-running migration");
  });

  test("allows exactly one worker and reclaims an expired process lease", async () => {
    const { company, employee, conversation, requester } = await fixture();
    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Keep this reliable",
      attachmentIds: [],
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
    });
    const start = new Date("2026-07-28T12:00:00.000Z");

    const first = await claimDurableChatTurn(queued.assistantMessage.id, start, "worker-a");
    assert.equal(first?.message.turnAttempt, 1);
    assert.equal(first?.message.turnWorkerId, "worker-a");

    const concurrent = await claimDurableChatTurn(
      queued.assistantMessage.id,
      new Date(start.getTime() + 1_000),
      "worker-b",
    );
    assert.equal(concurrent, null);

    const recovered = await claimDurableChatTurn(
      queued.assistantMessage.id,
      new Date(start.getTime() + 16_000),
      "worker-b",
    );
    assert.equal(recovered?.message.turnAttempt, 2);
    assert.equal(recovered?.message.turnWorkerId, "worker-b");
    assert.equal(recovered?.message.progressLabel, "Resuming durable work");

    // The interrupted worker can no longer overwrite the recovered worker's
    // persisted milestone.
    const staleProgress = createChatTurnProgressRecorder({
      repository: AppDataSource.getRepository(ConversationMessage),
      messageId: queued.assistantMessage.id,
      workerId: "worker-a",
    });
    staleProgress.report({ percent: 90, label: "Stale update" });
    await staleProgress.flush();
    const row = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: queued.assistantMessage.id,
    });
    assert.equal(row.progressLabel, "Resuming durable work");
  });

  test("never lets a different Member enqueue into another Member's transcript", async () => {
    const { company, employee, conversation } = await fixture();
    await assert.rejects(
      enqueueDurableChatTurn({
        companyId: company.id,
        employeeId: employee.id,
        conversationId: conversation.id,
        message: "Replay somebody else's context",
        attachmentIds: [],
        requesterUserId: "other-member",
        requesterSessionVersion: 0,
      }),
      /Conversation not found/,
    );
    assert.equal(
      await AppDataSource.getRepository(ConversationMessage).countBy({
        conversationId: conversation.id,
      }),
      0,
    );
  });

  test("legacy unowned transcripts fail closed instead of becoming company-wide", async () => {
    const { company, employee, conversation, requester } = await fixture();
    conversation.ownerUserId = null;
    await AppDataSource.getRepository(Conversation).save(conversation);
    await assert.rejects(
      enqueueDurableChatTurn({
        companyId: company.id,
        employeeId: employee.id,
        conversationId: conversation.id,
        message: "Try a legacy transcript",
        attachmentIds: [],
        requesterUserId: requester.id,
        requesterSessionVersion: requester.sessionVersion,
      }),
      /Conversation not found/,
    );
  });

  test("does not re-authorize a queued turn from the User's newer auth epoch", async () => {
    const { company, employee, conversation, requester } = await fixture();
    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Run this after my password reset",
      attachmentIds: [],
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
    });

    requester.sessionVersion += 1;
    await AppDataSource.getRepository(User).save(requester);

    assert.equal(await executeDurableChatTurn(queued.assistantMessage.id), "completed");
    const finalized = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: queued.assistantMessage.id,
    });
    assert.equal(finalized.status, "error");
    assert.match(finalized.content, /company access changed/i);
    assert.equal(finalized.turnRequesterSessionVersion, 0);
  });

  test("runs a turn at the nearest level its model still offers, recording the move", async () => {
    const { company, employee, conversation, requester } = await fixture();
    // A custom endpoint without thinking levels runs at its own default, so any
    // stored level is one this model cannot honour — the state a turn is in
    // when its model was edited between acceptance and a recovery.
    const model = await insertEmployeeModel({
      employeeId: employee.id,
      provider: "custom",
      model: "local-model",
      authMode: "customEndpoint",
      isActive: true,
      connectedAt: new Date(),
      configJson: "{}",
      contextWindow: null,
      contextWindowSource: null,
    });
    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Think hard about this",
      attachmentIds: [],
      modelId: model.id,
      effort: "high",
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
    });

    assert.equal(await executeDurableChatTurn(queued.assistantMessage.id), "completed");
    const finalized = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: queued.assistantMessage.id,
    });
    // Not refused for the level: this fixture's endpoint is unconfigured, and
    // that is the only thing the reply reports.
    assert.equal(finalized.status, "error");
    assert.doesNotMatch(finalized.content, /effort|thinking level/i);
    assert.match(finalized.content, /not fully configured/);
    // The turn keeps the level it was accepted at, and its reply records the move.
    assert.equal(finalized.effort, "high");
    assert.deepEqual(JSON.parse(finalized.thinkingJson), {
      level: null,
      requested: "high",
      adjusted: "unsupported",
    });
  });

  test("keeps the reply's thinking record from acceptance", async () => {
    const { company, employee, conversation, requester } = await fixture();
    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Think it through",
      attachmentIds: [],
      modelId: "model-selected-for-turn",
      effort: "xhigh",
      thinking: { level: "xhigh", requested: "max", adjusted: "unsupported" },
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
    });
    assert.deepEqual(JSON.parse(queued.assistantMessage.thinkingJson), {
      level: "xhigh",
      requested: "max",
      adjusted: "unsupported",
    });
    assert.equal(queued.userMessage.thinkingJson, "");
  });
});
