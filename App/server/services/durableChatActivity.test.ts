import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { listChatActivity } from "./chatTurnActivity.js";
import {
  enqueueDurableChatTurn,
  executeDurableChatTurn,
  interruptDurableChatTurn,
  retryDurableChatTurn,
} from "./durableChatTurns.js";
import { acquireChatWorkloadLease, releaseChatWorkloadLease } from "./workloadLeases.js";

/**
 * A durable chat turn's activity, end to end: a real OpenCode runtime driving
 * a scripted AI Model, the durable worker, and the rows a Member's browser
 * reads. Each test is a situation the chat used to show as three typing dots
 * — a tool call, a stop, a thread already busy, a retry — and checks what is
 * now recorded about it.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** One scripted completion: text, or a single tool call. `finish: false` hangs. */
type UpstreamTurn =
  | { chunks: string[]; finish: boolean }
  | { tool: { name: string; args: Record<string, unknown> } };

let upstream: Server | null = null;
let upstreamBaseUrl = "";
let previousAllowlist: string[] = [];

async function startUpstream(script: UpstreamTurn[]): Promise<void> {
  let served = 0;
  upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body.
    }
    const turn = script[Math.min(served, script.length - 1)];
    served += 1;
    send(response, turn);
  });
  await new Promise<void>((resolve, reject) => {
    upstream!.once("error", reject);
    upstream!.listen(0, "127.0.0.1", resolve);
  });
  upstreamBaseUrl = `http://127.0.0.1:${(upstream!.address() as AddressInfo).port}/v1`;
  previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "activity-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: "activity-test",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function send(response: ServerResponse, turn: UpstreamTurn): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  if ("tool" in turn) {
    response.write(
      chunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_activity_1",
              type: "function",
              function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) },
            },
          ],
        },
        null,
      ),
    );
    response.write(chunk({}, "tool_calls"));
    response.end("data: [DONE]\n\n");
    return;
  }
  for (const text of turn.chunks) {
    response.write(chunk({ role: "assistant", content: text }, turn.finish ? "stop" : null));
  }
  if (turn.finish) response.end("data: [DONE]\n\n");
}

afterEach(async () => {
  if (previousAllowlist.length > 0 || config.security.outboundPrivateHostAllowlist.length > 0) {
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
    previousAllowlist = [];
  }
  const server = upstream;
  upstream = null;
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function fixture() {
  const requester = await insert(User, {
    email: "owner@activity.example",
    passwordHash: "hash",
    name: "Activity Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Activity Co",
    slug: "activity-co",
    ownerId: requester.id,
  });
  await insert(Membership, { companyId: company.id, userId: requester.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sam Flinch",
    slug: "sam-flinch",
    role: "Infrastructure",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "custom",
    model: "activity-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    contextWindow: null,
    contextWindowSource: null,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(upstreamBaseUrl),
      modelId: "activity-test",
    }),
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

describe("recording a durable chat turn", () => {
  test("a tool call and the reply after it: recorded live, persisted, summarized on the reply", async () => {
    await startUpstream([
      { tool: { name: "genosyn_find_tools", args: { query: "banking transactions" } } },
      { chunks: ["Found the ", "Banking tools."], finish: true },
    ]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Which tools list bank transactions?");
    const live: ChatActivityEvent[] = [];
    const chunks: string[] = [];
    const outcome = await executeDurableChatTurn(enqueued.assistantMessage.id, {
      onActivity: (event) => live.push(event),
      onChunk: (text) => chunks.push(text),
    });
    assert.equal(outcome, "completed");

    const events = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    assert.deepEqual(
      events.map((event) => [event.kind, event.name]),
      [
        ["turn_started", ""],
        ["tool_use", "find_tools"],
        ["tool_result", "find_tools"],
        ["turn_finished", ""],
      ],
    );
    assert.deepEqual(
      live.map((event) => event.ordinal),
      events.map((event) => event.ordinal),
      "the sending browser saw exactly the persisted events",
    );
    assert.equal((events[0].detail as { reason: string }).reason, "start");
    assert.equal(events[1].summary, "Looking for the right tool · “banking transactions”");
    assert.equal(events[2].callId, events[1].callId);
    assert.equal(typeof (events[2].detail as { durationMs: unknown }).durationMs, "number");

    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.status, "ok");
    assert.equal(row.content, "Found the Banking tools.");
    assert.equal(chunks.join(""), "Found the Banking tools.");
    const summary = JSON.parse(row.activityJson) as Record<string, unknown>;
    assert.equal(summary.status, "ok");
    assert.equal(summary.steps, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.lastOrdinal, events.at(-1)?.ordinal);
  });

  test("a stop is recorded once and the reply keeps what was written", async () => {
    await startUpstream([{ chunks: ["Spinning up the GPU machine, "], finish: false }]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Go on-demand.");
    let stopped = false;
    const outcome = await executeDurableChatTurn(enqueued.assistantMessage.id, {
      onChunk: () => {
        if (stopped) return;
        stopped = true;
        void interruptDurableChatTurn(enqueued.assistantMessage.id);
      },
    });
    assert.equal(outcome, "completed");
    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.status, "interrupted");
    assert.equal(row.content, "Spinning up the GPU machine,");
    const kinds = (await listChatActivity(row.id, 0, 100)).map((event) => event.kind);
    assert.equal(kinds.filter((kind) => kind === "stopped").length, 1);
    assert.equal(kinds.at(-1), "turn_finished");
    assert.equal((JSON.parse(row.activityJson) as { status: string }).status, "interrupted");
  });

  test("a thread already busy is one recorded wait, however many times the turn is picked up", async () => {
    await startUpstream([{ chunks: ["On it."], finish: true }]);
    const seed = await fixture();
    const blocker = await acquireChatWorkloadLease(
      seed.company.id,
      seed.employee.id,
      `conversation:${seed.conversation.id}`,
      60_000,
      { ownerKey: "another-reply" },
    );
    const enqueued = await enqueue(seed, "Next message");
    const repo = AppDataSource.getRepository(ConversationMessage);
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "deferred");
    await repo.update({ id: enqueued.assistantMessage.id }, { turnLeaseExpiresAt: new Date(0) });
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "deferred");
    let events = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    assert.deepEqual(
      events.map((event) => [event.kind, event.name]),
      [["waiting", "thread_busy"]],
    );

    await releaseChatWorkloadLease(blocker);
    await repo.update({ id: enqueued.assistantMessage.id }, { turnLeaseExpiresAt: new Date(0) });
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");
    events = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["waiting", "turn_started", "turn_finished"],
    );
    assert.equal(
      (events[1].detail as { reason: string }).reason,
      "start",
      "a turn that only waited starts, it does not resume",
    );
    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.status, "ok");
  });

  test("a retried reply runs again in place and says so", async () => {
    await startUpstream([{ chunks: ["Here it is."], finish: true }]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Try again");
    const repo = AppDataSource.getRepository(ConversationMessage);
    // The first attempt failed outright.
    await repo.update(
      { id: enqueued.assistantMessage.id },
      { status: "error", content: "Genosyn couldn’t complete this chat turn.", turnAttempt: 1 },
    );
    const retried = await retryDurableChatTurn({
      companyId: seed.company.id,
      employeeId: seed.employee.id,
      conversationId: seed.conversation.id,
      messageId: enqueued.assistantMessage.id,
      requesterUserId: seed.requester.id,
      requesterSessionVersion: 0,
    });
    assert.equal(retried.status, "working");
    assert.equal(await executeDurableChatTurn(retried.id), "completed");
    const events = await listChatActivity(retried.id, 0, 100);
    assert.deepEqual(
      events.map((event) => [event.kind, event.name]),
      [
        ["notice", "retry_requested"],
        ["turn_started", ""],
        ["turn_finished", ""],
      ],
    );
    assert.equal((events[1].detail as { reason: string }).reason, "retry");
    const row = await reload(retried.id);
    assert.equal(row.status, "ok");
    assert.equal(row.content, "Here it is.");
    const summary = JSON.parse(row.activityJson) as { durationMs: number; startedAt: string };
    assert.ok(summary.durationMs < 60_000, "the clock started at the retry, not the first send");
  });
});
