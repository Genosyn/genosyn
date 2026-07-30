import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../test/dbHarness.js";
import { createChatTurnProgressRecorder } from "./chatTurnProgress.js";
import {
  claimDurableChatTurn,
  enqueueDurableChatTurn,
} from "./durableChatTurns.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function fixture() {
  const company = await insert(Company, {
    name: "Durable Co",
    slug: "durable-co",
    ownerId: "owner-1",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Durable",
    slug: "jamie-durable",
    role: "Operations",
  });
  const conversation = await insert(Conversation, {
    employeeId: employee.id,
    title: null,
    source: "web",
  });
  return { company, employee, conversation };
}

describe("durable chat turns", () => {
  test("atomically persists the recovery job and binds its input attachments", async () => {
    const { company, employee, conversation } = await fixture();
    const attachment = await insert(Attachment, {
      companyId: company.id,
      messageId: null,
      filename: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storageKey: "brief.txt",
      uploadedByUserId: "owner-1",
    });

    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Complete the long-running migration",
      attachmentIds: [attachment.id],
      modelId: "model-selected-for-turn",
    });

    assert.equal(queued.assistantMessage.status, "working");
    assert.equal(queued.assistantMessage.modelId, "model-selected-for-turn");
    assert.equal(
      queued.assistantMessage.turnUserMessageId,
      queued.userMessage.id,
    );
    assert.equal(queued.assistantMessage.turnAttempt, 0);
    assert.equal(queued.assistantMessage.turnWorkerId, null);
    assert.ok(
      (queued.assistantMessage.turnDeadlineAt?.getTime() ?? 0) > Date.now(),
    );
    assert.equal(queued.userAttachments[0]?.id, attachment.id);

    const rebound = await AppDataSource.getRepository(Attachment).findOneByOrFail({
      id: attachment.id,
    });
    assert.equal(rebound.messageId, queued.userMessage.id);
    const refreshedConversation = await AppDataSource.getRepository(
      Conversation,
    ).findOneByOrFail({ id: conversation.id });
    assert.equal(
      refreshedConversation.title,
      "Complete the long-running migration",
    );
  });

  test("allows exactly one worker and reclaims an expired process lease", async () => {
    const { company, employee, conversation } = await fixture();
    const queued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Keep this reliable",
      attachmentIds: [],
    });
    const start = new Date("2026-07-28T12:00:00.000Z");

    const first = await claimDurableChatTurn(
      queued.assistantMessage.id,
      start,
      "worker-a",
    );
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
    const row = await AppDataSource.getRepository(
      ConversationMessage,
    ).findOneByOrFail({ id: queued.assistantMessage.id });
    assert.equal(row.progressLabel, "Resuming durable work");
  });
});
