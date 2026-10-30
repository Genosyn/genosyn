import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import { MODEL_UNAVAILABLE_WAIT_CAUSE } from "../../shared/chatActivity.js";
import { MODEL_WAIT_PROGRESS_LABEL } from "../../shared/modelAvailability.js";
import { AppDataSource } from "../db/datasource.js";
import { openCodeError } from "./agent/opencodeEvents.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import { agentRuntime } from "./agent/runtime.js";
import { CHAT_HARD_TIMEOUT_MS } from "./chat.js";
import { listChatActivity } from "./chatTurnActivity.js";
import {
  bootDurableChatTurnRecovery,
  enqueueDurableChatTurn,
  executeDurableChatTurn,
  interruptDurableChatTurn,
  stopDurableChatTurnRecovery,
} from "./durableChatTurns.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  isModelAvailable,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { waitingWorkByModel } from "./modelOutageViews.js";

/**
 * A Member's message to an AI Employee whose AI Model is unavailable.
 *
 * The bar: it never comes back as an error. It waits — still a reply in
 * progress, saying plainly in the conversation that the AI Model is
 * unavailable and the message will be answered when it is back — and it is
 * answered once the model answers, or cancelled when the Member stops it. A
 * turn the outage cut short waits the same way and starts again told to check
 * what it already did; a turn that never reached the model is not counted as
 * an attempt.
 */

before(initTestDb);
beforeEach(async () => {
  resetModelAvailabilityForTests();
  await resetTestDb();
});
afterEach(() => {
  stopDurableChatTurnRecovery();
  resetModelAvailabilityForTests();
});
after(closeTestDb);

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];

async function fixture() {
  const requester = await insert(User, {
    email: "owner@outage.example",
    passwordHash: "hash",
    name: "Outage Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Outage Co",
    slug: "outage-co",
    ownerId: requester.id,
  });
  await insert(Membership, { companyId: company.id, userId: requester.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rowan",
    slug: "rowan",
    role: "Support",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: "{}",
  });
  const conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: requester.id,
    title: null,
    source: "web",
  });
  return { company, employee, model, conversation, requester };
}

async function enqueue(seed: Awaited<ReturnType<typeof fixture>>, message: string) {
  return enqueueDurableChatTurn({
    companyId: seed.company.id,
    employeeId: seed.employee.id,
    conversationId: seed.conversation.id,
    message,
    attachmentIds: [],
    modelId: seed.model.id,
    requesterUserId: seed.requester.id,
    requesterSessionVersion: 0,
  });
}

const reload = (id: string) =>
  AppDataSource.getRepository(ConversationMessage).findOneByOrFail({ id });

/** Its next look is due now, as if its lease ran out. */
async function due(id: string): Promise<void> {
  await AppDataSource.getRepository(ConversationMessage).update(
    { id },
    { turnLeaseExpiresAt: new Date(Date.now() - 1) },
  );
}

function down(model: AIModel): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

/** What OpenCode throws once its retries are spent on an overloaded service. */
function overloadedError(): Error {
  return openCodeError({
    name: "APIError",
    data: {
      message: "Overloaded",
      statusCode: 529,
      isRetryable: true,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    },
  } as never);
}

describe("a message while the AI Model is unavailable", () => {
  test("waits, says so in the conversation, and is answered when the model is back", async (t) => {
    const seed = await fixture();
    down(seed.model);
    const calls: RuntimeParams[] = [];
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls.push(params);
      params.callbacks?.onText?.("Here is the refund policy.");
      return { finalText: "Here is the refund policy.", steps: 1, stopReason: "end_turn" };
    });
    const enqueued = await enqueue(seed, "What is our refund policy?");
    const live: ChatActivityEvent[] = [];
    const progress: string[] = [];
    const outcome = await executeDurableChatTurn(enqueued.assistantMessage.id, {
      onActivity: (event) => live.push(event),
      onProgress: (p) => progress.push(p.label),
    });
    assert.equal(outcome, "deferred");
    assert.equal(calls.length, 0, "the model is not asked while it is unavailable");

    const waiting = await reload(enqueued.assistantMessage.id);
    assert.equal(waiting.status, "working", "still a reply in progress, never an error");
    assert.equal(waiting.content, "");
    assert.equal(waiting.progressLabel, MODEL_WAIT_PROGRESS_LABEL);
    assert.equal(waiting.turnWorkerId, null);
    assert.ok(waiting.turnLeaseExpiresAt && waiting.turnLeaseExpiresAt.getTime() > Date.now());
    assert.equal(waiting.turnAttempt, 0, "a turn that never reached the model is no attempt");
    assert.ok(
      waiting.turnDeadlineAt &&
        waiting.turnDeadlineAt.getTime() > Date.now() + CHAT_HARD_TIMEOUT_MS - 60_000,
      "waiting does not spend the turn's six hours",
    );
    assert.deepEqual(progress, [MODEL_WAIT_PROGRESS_LABEL]);
    const events = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    assert.deepEqual(
      events.map((event) => [event.kind, event.name]),
      [["waiting", MODEL_UNAVAILABLE_WAIT_CAUSE]],
    );
    assert.match(events[0].summary, /AI Model is unavailable — this will be answered when it is back/);
    assert.deepEqual(
      live.map((event) => event.name),
      [MODEL_UNAVAILABLE_WAIT_CAUSE],
      "followed live by every browser on the turn",
    );
    assert.deepEqual(
      (await waitingWorkByModel(seed.company.id, [seed.model.id])).get(seed.model.id),
      { runs: 0, chats: 1 },
      "the AI Models page counts it as waiting",
    );

    // Looked at again while still unavailable: still waiting, one line in the chat.
    await due(enqueued.assistantMessage.id);
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "deferred");
    assert.equal(
      (await listChatActivity(enqueued.assistantMessage.id, 0, 100)).length,
      1,
      "one waiting line for the whole wait",
    );
    assert.equal((await reload(enqueued.assistantMessage.id)).turnAttempt, 0);

    await back(seed.model);
    await due(enqueued.assistantMessage.id);
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");
    const answered = await reload(enqueued.assistantMessage.id);
    assert.equal(answered.status, "ok");
    assert.equal(answered.content, "Here is the refund policy.");
    assert.equal(answered.turnAttempt, 1);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(
      JSON.stringify(calls[0].messages),
      /Durable recovery note/,
      "a turn that only waited starts fresh",
    );
    const after = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    assert.equal(after[1]?.kind, "turn_started");
    assert.equal(after[1]?.summary, "Started working");
    assert.deepEqual(
      (await waitingWorkByModel(seed.company.id, [seed.model.id])).get(seed.model.id),
      { runs: 0, chats: 0 },
    );
  });

  test("a turn the outage cuts short waits too, and starts again told to check what it did", async (t) => {
    const seed = await fixture();
    const prompts: string[] = [];
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      turn += 1;
      prompts.push(JSON.stringify(params.messages));
      if (turn === 1) {
        params.callbacks?.onText?.("Looking up the order");
        throw overloadedError();
      }
      params.callbacks?.onText?.("Order 1042 shipped yesterday.");
      return { finalText: "Order 1042 shipped yesterday.", steps: 1, stopReason: "end_turn" };
    });
    const enqueued = await enqueue(seed, "Where is order 1042?");
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "deferred");
    assert.equal(isModelAvailable(seed.model), false, "the exhausted turn marked the model");
    const waiting = await reload(enqueued.assistantMessage.id);
    assert.equal(waiting.status, "working");
    assert.equal(waiting.progressLabel, MODEL_WAIT_PROGRESS_LABEL);
    assert.equal(waiting.turnAttempt, 1, "the attempt that ran keeps its count");
    assert.equal(waiting.content, "", "nothing half-written is kept as the answer");

    await back(seed.model);
    await due(enqueued.assistantMessage.id);
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");
    const answered = await reload(enqueued.assistantMessage.id);
    assert.equal(answered.status, "ok");
    assert.equal(answered.content, "Order 1042 shipped yesterday.");
    assert.match(prompts[1], /Durable recovery note/);
    assert.match(prompts[1], /the AI Model became unavailable/);
    const events = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    const started = events.filter((event) => event.kind === "turn_started");
    assert.equal(started.at(-1)?.summary, "Started again now that the AI Model is back");
  });

  test("a request about the request itself still fails as it always has", async (t) => {
    const seed = await fixture();
    t.mock.method(agentRuntime, "run", async () => {
      throw Object.assign(new Error("prompt is too long"), { status: 400 });
    });
    const enqueued = await enqueue(seed, "Summarize everything.");
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");
    const answered = await reload(enqueued.assistantMessage.id);
    assert.equal(answered.status, "error");
    assert.equal(isModelAvailable(seed.model), true);
  });

  test("the Member can cancel a message that is waiting for its AI Model", async (t) => {
    const seed = await fixture();
    down(seed.model);
    let calls = 0;
    t.mock.method(agentRuntime, "run", async () => {
      calls += 1;
      return { finalText: "Too late.", steps: 1, stopReason: "end_turn" };
    });
    const enqueued = await enqueue(seed, "Draft the newsletter.");
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "deferred");
    assert.equal(await interruptDurableChatTurn(enqueued.assistantMessage.id), "interrupted");
    const stopped = await reload(enqueued.assistantMessage.id);
    assert.equal(stopped.status, "interrupted");
    await back(seed.model);
    await due(enqueued.assistantMessage.id);
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "claimed_elsewhere");
    assert.equal(calls, 0, "a cancelled message is never answered");
  });

  test("it is answered the moment the model is back, without waiting for its next look", async (t) => {
    const seed = await fixture();
    down(seed.model);
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      params.callbacks?.onText?.("Back online and answering.");
      return { finalText: "Back online and answering.", steps: 1, stopReason: "end_turn" };
    });
    const enqueued = await enqueue(seed, "Are you there?");
    await bootDurableChatTurnRecovery();
    for (let i = 0; i < 200; i++) {
      const row = await reload(enqueued.assistantMessage.id);
      if (row.progressLabel === MODEL_WAIT_PROGRESS_LABEL && row.turnWorkerId === null) break;
      await delay(10);
    }
    const waiting = await reload(enqueued.assistantMessage.id);
    assert.equal(waiting.progressLabel, MODEL_WAIT_PROGRESS_LABEL);
    assert.ok(
      (waiting.turnLeaseExpiresAt?.getTime() ?? 0) > Date.now() + 1_000,
      "its next look is a while off",
    );
    await back(seed.model);
    for (let i = 0; i < 300; i++) {
      if ((await reload(enqueued.assistantMessage.id)).status === "ok") break;
      await delay(10);
    }
    const answered = await reload(enqueued.assistantMessage.id);
    assert.equal(answered.status, "ok");
    assert.equal(answered.content, "Back online and answering.");
  });
});
