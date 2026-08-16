import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { ContextUsage } from "./agent/types.js";
import { enqueueDurableChatTurn, executeDurableChatTurn } from "./durableChatTurns.js";

/**
 * End-to-end cover for the context gauge, from the provider's token counts to
 * the persisted chat row.
 *
 * The layers above and below are unit-tested (`agent/contextUsage.test.ts`,
 * `agent/loop.test.ts`, `chatTurnContextUsage.test.ts`), but the wiring between
 * them is the part that compiles clean while doing nothing: the SSE payload is
 * untyped, the entity columns break no consumer, and an omitted callback is
 * legal everywhere. So this drives a real AI Model — a `custom` OpenAI-
 * compatible endpoint served from a local HTTP server — through the whole
 * durable turn and reads the row back.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

type UpstreamTurn = {
  /** Emitted as the model's reply text. */
  text: string;
  /** Omitted to simulate a server that reports no token counts at all. */
  usage?: { promptTokens: number; completionTokens: number };
};

let upstream: Server | null = null;
let upstreamBaseUrl = "";
let previousAllowlist: string[] = [];

/** Serve a scripted sequence of OpenAI-compatible streamed completions. */
async function startUpstream(turns: UpstreamTurn[]): Promise<void> {
  let served = 0;
  upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body; the assertions here are about the response.
    }
    const turn = turns[Math.min(served, turns.length - 1)];
    served += 1;
    sendCompletion(response, turn);
  });
  await new Promise<void>((resolve, reject) => {
    upstream!.once("error", reject);
    upstream!.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream!.address() as AddressInfo;
  upstreamBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
}

function sendCompletion(response: ServerResponse, turn: UpstreamTurn): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(
    `data: ${JSON.stringify({
      id: "chat-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: "context-gauge-test",
      choices: [
        { index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: "stop" },
      ],
    })}\n\n`,
  );
  if (turn.usage) {
    // The usage chunk arrives last with an empty `choices` array — this is what
    // `stream_options: { include_usage: true }` buys, and the only trustworthy
    // measure of how full the window is.
    response.write(
      `data: ${JSON.stringify({
        id: "chat-turn",
        object: "chat.completion.chunk",
        created: 1,
        model: "context-gauge-test",
        choices: [],
        usage: {
          prompt_tokens: turn.usage.promptTokens,
          completion_tokens: turn.usage.completionTokens,
          total_tokens: turn.usage.promptTokens + turn.usage.completionTokens,
        },
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

afterEach(async () => {
  if (previousAllowlist.length > 0 || config.security.outboundPrivateHostAllowlist.length > 0) {
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
    previousAllowlist = [];
  }
  const server = upstream;
  upstream = null;
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function fixture(contextWindow: number | null) {
  const requester = await insert(User, {
    email: "owner@context.example",
    passwordHash: "hash",
    name: "Context Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Context Co",
    slug: "context-co",
    ownerId: requester.id,
  });
  await insert(Membership, { companyId: company.id, userId: requester.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Robin Gauge",
    slug: "robin-gauge",
    role: "Operations",
  });
  const model = await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "context-gauge-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    contextWindow,
    contextWindowSource: contextWindow === null ? null : "manual",
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(upstreamBaseUrl),
      modelId: "context-gauge-test",
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

async function runTurn(
  seed: Awaited<ReturnType<typeof fixture>>,
  message = "How full is this?",
): Promise<{ readings: ContextUsage[]; row: ConversationMessage }> {
  const enqueued = await enqueueDurableChatTurn({
    companyId: seed.company.id,
    employeeId: seed.employee.id,
    conversationId: seed.conversation.id,
    message,
    attachmentIds: [],
    modelId: seed.model.id,
    requesterUserId: seed.requester.id,
    requesterSessionVersion: 0,
  });
  const readings: ContextUsage[] = [];
  const outcome = await executeDurableChatTurn(enqueued.assistantMessage.id, {
    onContextUsage: (usage) => readings.push(usage),
  });
  assert.equal(outcome, "completed");
  const row = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
    id: enqueued.assistantMessage.id,
  });
  return { readings, row };
}

describe("durable chat turn context gauge", () => {
  test("streams and persists the provider's prompt count against the model window", async () => {
    await startUpstream([{ text: "All good.", usage: { promptTokens: 92_000, completionTokens: 40 } }]);
    const seed = await fixture(200_000);

    const { readings, row } = await runTurn(seed);

    assert.equal(row.status, "ok");
    assert.equal(row.content, "All good.");
    assert.deepEqual(readings, [
      { promptTokens: 92_000, contextWindow: 200_000, percent: 46 },
    ]);
    // Persisted, not just streamed: a browser that reloads or never had the
    // stream at all reads the row.
    assert.equal(row.contextTokens, 92_000);
    assert.equal(row.contextWindow, 200_000);
  });

  test("records the prompt count with no window when the model has none", async () => {
    await startUpstream([
      { text: "Still working.", usage: { promptTokens: 142_311, completionTokens: 12 } },
    ]);
    const seed = await fixture(null);

    const { readings, row } = await runTurn(seed);

    assert.deepEqual(readings, [
      { promptTokens: 142_311, contextWindow: null, percent: null },
    ]);
    assert.equal(row.contextTokens, 142_311);
    assert.equal(row.contextWindow, null);
  });

  test("leaves the gauge empty when the provider reports no token counts", async () => {
    // Plenty of OpenAI-compatible servers ignore `include_usage`. Guessing a
    // number for them would be worse than showing nothing.
    await startUpstream([{ text: "No counts here." }]);
    const seed = await fixture(200_000);

    const { readings, row } = await runTurn(seed);

    assert.deepEqual(readings, []);
    assert.equal(row.contextTokens, null);
    assert.equal(row.contextWindow, null);
    assert.equal(row.status, "ok");
  });

  test("clears progress on completion but keeps the context reading", async () => {
    await startUpstream([{ text: "Done.", usage: { promptTokens: 10_000, completionTokens: 5 } }]);
    const seed = await fixture(128_000);

    const { row } = await runTurn(seed);

    // Progress describes work in flight and is meaningless afterwards; the
    // gauge describes the turn that just ran and is exactly what the Member
    // wants to read now.
    assert.equal(row.progressPercent, null);
    assert.equal(row.progressLabel, null);
    assert.equal(row.contextTokens, 10_000);
    assert.equal(row.contextWindow, 128_000);
  });

  test("each turn reports its own reading rather than accumulating", async () => {
    await startUpstream([
      { text: "First.", usage: { promptTokens: 20_000, completionTokens: 5 } },
      { text: "Second.", usage: { promptTokens: 65_000, completionTokens: 5 } },
    ]);
    const seed = await fixture(200_000);

    const first = await runTurn(seed, "one");
    const second = await runTurn(seed, "two");

    assert.equal(first.row.contextTokens, 20_000);
    assert.deepEqual(second.readings, [
      { promptTokens: 65_000, contextWindow: 200_000, percent: 33 },
    ]);
    assert.equal(second.row.contextTokens, 65_000);
    // The earlier turn keeps the number it was measured with — the gauge is
    // per-message history, not a single mutable counter.
    const reloadedFirst = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: first.row.id,
    });
    assert.equal(reloadedFirst.contextTokens, 20_000);
  });

  test("a recovered turn that sees no counts keeps the earlier attempt's reading", async () => {
    // A process died mid-turn after the gauge was persisted, and the
    // replacement worker's provider reports nothing. The finalize patch must
    // omit the columns rather than write nulls over a real measurement.
    await startUpstream([{ text: "Resumed." }]);
    const seed = await fixture(200_000);
    const messages = AppDataSource.getRepository(ConversationMessage);
    const enqueued = await enqueueDurableChatTurn({
      companyId: seed.company.id,
      employeeId: seed.employee.id,
      conversationId: seed.conversation.id,
      message: "keep going",
      attachmentIds: [],
      modelId: seed.model.id,
      requesterUserId: seed.requester.id,
      requesterSessionVersion: 0,
    });
    await messages.update(
      { id: enqueued.assistantMessage.id },
      { contextTokens: 88_000, contextWindow: 200_000 },
    );

    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");

    const row = await messages.findOneByOrFail({ id: enqueued.assistantMessage.id });
    assert.equal(row.status, "ok");
    assert.equal(row.contextTokens, 88_000);
    assert.equal(row.contextWindow, 200_000);
  });

  test("a recovered turn that does see counts replaces the earlier reading", async () => {
    // The mirror of the test above: a real measurement always wins over a
    // stale one, so the omission is scoped to "nothing to say" and not a
    // blanket refusal to update.
    await startUpstream([
      { text: "Resumed.", usage: { promptTokens: 120_000, completionTokens: 8 } },
    ]);
    const seed = await fixture(200_000);
    const messages = AppDataSource.getRepository(ConversationMessage);
    const enqueued = await enqueueDurableChatTurn({
      companyId: seed.company.id,
      employeeId: seed.employee.id,
      conversationId: seed.conversation.id,
      message: "keep going",
      attachmentIds: [],
      modelId: seed.model.id,
      requesterUserId: seed.requester.id,
      requesterSessionVersion: 0,
    });
    await messages.update(
      { id: enqueued.assistantMessage.id },
      { contextTokens: 88_000, contextWindow: 200_000 },
    );

    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");

    const row = await messages.findOneByOrFail({ id: enqueued.assistantMessage.id });
    assert.equal(row.contextTokens, 120_000);
  });

  test("a subscriber that throws never fails the turn", async () => {
    await startUpstream([{ text: "Fine.", usage: { promptTokens: 1_000, completionTokens: 2 } }]);
    const seed = await fixture(200_000);
    const enqueued = await enqueueDurableChatTurn({
      companyId: seed.company.id,
      employeeId: seed.employee.id,
      conversationId: seed.conversation.id,
      message: "go",
      attachmentIds: [],
      modelId: seed.model.id,
      requesterUserId: seed.requester.id,
      requesterSessionVersion: 0,
    });

    const outcome = await executeDurableChatTurn(enqueued.assistantMessage.id, {
      onContextUsage: () => {
        throw new Error("browser hung up");
      },
    });

    assert.equal(outcome, "completed");
    const row = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: enqueued.assistantMessage.id,
    });
    assert.equal(row.status, "ok");
    assert.equal(row.contextTokens, 1_000);
  });
});
