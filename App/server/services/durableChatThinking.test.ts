import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import type { ModelEffort } from "../../shared/modelEffort.js";
import { parseTurnThinking } from "../../shared/thinkingLevels.js";
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
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { chatTurnThinking } from "./chatThinking.js";
import { listChatActivity } from "./chatTurnActivity.js";
import { serializeMessage } from "./conversationSerialization.js";
import {
  enqueueDurableChatTurn,
  executeDurableChatTurn,
  retryDurableChatTurn,
} from "./durableChatTurns.js";

/**
 * A conversation's thinking level through a durable chat turn, end to end: a
 * real OpenCode runtime driving a scripted self-hosted AI Model with thinking
 * levels turned on. The level is resolved when the turn is accepted, reaches
 * the model as `reasoning_effort`, and the reply records what it ran at —
 * including when the model refused it, and when the model's settings moved it
 * before the turn ran. The model's thinking reaches the activity either way.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** One scripted completion: optional thinking then text, or a refusal. */
type UpstreamReply =
  | { reasoning?: string; text: string }
  | { reject: { status: number; body: Record<string, unknown> } };

let upstream: Server | null = null;
let upstreamBaseUrl = "";
let previousAllowlist: string[] = [];
let requests: Array<Record<string, unknown>> = [];

async function startUpstream(answer: (body: Record<string, unknown>) => UpstreamReply) {
  requests = [];
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push(body);
    send(response, answer(body));
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
    id: "thinking-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: "thinking-test",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function send(response: ServerResponse, reply: UpstreamReply): void {
  if ("reject" in reply) {
    response
      .writeHead(reply.reject.status, { "content-type": "application/json", connection: "close" })
      .end(JSON.stringify(reply.reject.body));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  if (reply.reasoning) response.write(chunk({ role: "assistant", reasoning_content: reply.reasoning }, null));
  response.write(chunk({ role: "assistant", content: reply.text }, null));
  response.write(chunk({}, "stop"));
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
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

/** A self-hosted model whose owners turned thinking levels on, and a thread at `level`. */
async function fixture(level: ModelEffort | null, modelValues: Partial<AIModel> = {}) {
  const requester = await insert(User, {
    email: "owner@thinking.example",
    passwordHash: "hash",
    name: "Thinking Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Thinking Co",
    slug: "thinking-co",
    ownerId: requester.id,
  });
  await insert(Membership, { companyId: company.id, userId: requester.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rae Ponder",
    slug: "rae-ponder",
    role: "Analyst",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "custom",
    model: "thinking-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    contextWindow: null,
    contextWindowSource: null,
    customThinkingLevels: true,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(upstreamBaseUrl),
      modelId: "thinking-test",
    }),
    ...modelValues,
  });
  const conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: requester.id,
    title: null,
    source: "web",
    effort: level,
  });
  return { company, employee, model, conversation, requester };
}

/** Accept a message the way the send route does: the thread's level, resolved on its model. */
async function accept(seed: Awaited<ReturnType<typeof fixture>>, message: string) {
  const { effort, thinking } = chatTurnThinking(seed.model, seed.conversation.effort);
  return enqueueDurableChatTurn({
    companyId: seed.company.id,
    employeeId: seed.employee.id,
    conversationId: seed.conversation.id,
    message,
    attachmentIds: [],
    modelId: seed.model.id,
    effort,
    thinking,
    requesterUserId: seed.requester.id,
    requesterSessionVersion: 0,
  });
}

const reload = (id: string) =>
  AppDataSource.getRepository(ConversationMessage).findOneByOrFail({ id });

describe("a conversation's thinking level in a durable chat turn", () => {
  test("reaches the AI Model, its thinking reaches the activity, and the reply records the level", async () => {
    await startUpstream(() => ({ reasoning: "Comparing both quotes line by line.", text: "Go with B." }));
    const seed = await fixture("high");
    const accepted = await accept(seed, "Which quote should we take?");
    assert.equal(accepted.assistantMessage.effort, "high");

    assert.equal(await executeDurableChatTurn(accepted.assistantMessage.id), "completed");
    assert.equal(requests[0].reasoning_effort, "high");

    const row = await reload(accepted.assistantMessage.id);
    assert.equal(row.status, "ok");
    assert.equal(row.content, "Go with B.");
    assert.deepEqual(parseTurnThinking(row.thinkingJson), {
      level: "high",
      requested: "high",
      adjusted: null,
    });
    assert.deepEqual(serializeMessage(row).thinking, {
      level: "high",
      requested: "high",
      adjusted: null,
    });
    const events = await listChatActivity(row.id, 0, 100);
    const thought = events.filter((event) => event.kind === "reasoning");
    assert.equal(thought.map((event) => event.summary).join(""), "Comparing both quotes line by line.");
    assert.equal((JSON.parse(row.activityJson) as { reasoning: boolean }).reasoning, true);
  });

  test("a level the AI Model refuses: answered at its default, said inline, recorded on the reply", async () => {
    await startUpstream((body) =>
      body.reasoning_effort !== undefined
        ? {
            reject: {
              status: 422,
              body: {
                detail: [
                  {
                    loc: ["body", "reasoning_effort"],
                    msg: "Extra inputs are not permitted",
                    type: "extra_forbidden",
                  },
                ],
              },
            },
          }
        : { text: "Here is my answer." },
    );
    const seed = await fixture("high");
    const accepted = await accept(seed, "Think hard about this.");
    assert.equal(await executeDurableChatTurn(accepted.assistantMessage.id), "completed");

    assert.equal(requests.length, 2);
    assert.equal(Object.hasOwn(requests[1], "reasoning_effort"), false);
    const row = await reload(accepted.assistantMessage.id);
    assert.equal(row.status, "ok");
    assert.equal(row.content, "Here is my answer.");
    assert.deepEqual(parseTurnThinking(row.thinkingJson), {
      level: null,
      requested: "high",
      adjusted: "rejected",
      refused: "high",
    });
    const notices = (await listChatActivity(row.id, 0, 100)).filter(
      (event) => event.kind === "notice" && event.name === "thinking_fallback",
    );
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0].summary,
      "The AI Model didn't accept the High thinking level; it answers at its own default",
    );
  });

  test("a Retry after a refusal sends the level again, and the reply says what it ran at", async () => {
    let refuse = true;
    await startUpstream((body) =>
      refuse && body.reasoning_effort !== undefined
        ? {
            reject: {
              status: 400,
              body: { error: { message: "reasoning_effort is not supported by this model" } },
            },
          }
        : { text: refuse ? "Fallback answer." : "Thoughtful answer." },
    );
    const seed = await fixture("medium");
    const accepted = await accept(seed, "First try.");
    await executeDurableChatTurn(accepted.assistantMessage.id);
    assert.equal(parseTurnThinking((await reload(accepted.assistantMessage.id)).thinkingJson)?.adjusted, "rejected");

    // A failed reply is what Retry takes; mark this one failed by hand.
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: accepted.assistantMessage.id },
      { status: "error" },
    );
    refuse = false;
    await retryDurableChatTurn({
      companyId: seed.company.id,
      employeeId: seed.employee.id,
      conversationId: seed.conversation.id,
      messageId: accepted.assistantMessage.id,
      requesterUserId: seed.requester.id,
      requesterSessionVersion: 0,
    });
    assert.equal(await executeDurableChatTurn(accepted.assistantMessage.id), "completed");
    assert.equal(requests.at(-1)?.reasoning_effort, "medium");
    const row = await reload(accepted.assistantMessage.id);
    assert.equal(row.content, "Thoughtful answer.");
    assert.deepEqual(parseTurnThinking(row.thinkingJson), {
      level: "medium",
      requested: "medium",
      adjusted: null,
    });
  });

  test("a level the model stopped offering before the turn ran is moved, not refused", async () => {
    await startUpstream(() => ({ text: "Answered at my default." }));
    const seed = await fixture("high");
    const accepted = await accept(seed, "Queued before the change.");
    // An owner turns the server's levels off while the turn waits.
    await AppDataSource.getRepository(AIModel).update(
      { id: seed.model.id },
      { customThinkingLevels: false },
    );
    assert.equal(await executeDurableChatTurn(accepted.assistantMessage.id), "completed");
    assert.equal(Object.hasOwn(requests[0], "reasoning_effort"), false);
    const row = await reload(accepted.assistantMessage.id);
    assert.equal(row.status, "ok");
    assert.deepEqual(parseTurnThinking(row.thinkingJson), {
      level: null,
      requested: "high",
      adjusted: "unsupported",
    });
  });

  test("a ceiling set before the turn ran holds it to the ceiling", async () => {
    await startUpstream(() => ({ text: "Kept it light." }));
    const seed = await fixture("high");
    const accepted = await accept(seed, "Queued before the ceiling.");
    await AppDataSource.getRepository(AIModel).update({ id: seed.model.id }, { effortCeiling: "low" });
    await executeDurableChatTurn(accepted.assistantMessage.id);
    assert.equal(requests[0].reasoning_effort, "low");
    assert.deepEqual(parseTurnThinking((await reload(accepted.assistantMessage.id)).thinkingJson), {
      level: "low",
      requested: "high",
      adjusted: "ceiling",
    });
  });

  test("Default takes the owners' default for chat when the turn is accepted", async () => {
    await startUpstream(() => ({ text: "At the company's default." }));
    const seed = await fixture(null, { defaultEffort: "low" });
    const accepted = await accept(seed, "Default please.");
    assert.equal(accepted.assistantMessage.effort, "low");
    await executeDurableChatTurn(accepted.assistantMessage.id);
    assert.equal(requests[0].reasoning_effort, "low");
    assert.deepEqual(parseTurnThinking((await reload(accepted.assistantMessage.id)).thinkingJson), {
      level: "low",
      requested: null,
      adjusted: null,
    });
  });

  test("a level never widens what the turn may do: the tools offered are the same", async () => {
    const offered: string[][] = [];
    await startUpstream((body) => {
      offered.push(
        ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
          .map((tool) => tool.function?.name ?? "")
          .sort(),
      );
      return { text: "Done." };
    });
    const plain = await fixture(null);
    await executeDurableChatTurn((await accept(plain, "At default.")).assistantMessage.id);
    await AppDataSource.getRepository(Conversation).update(
      { id: plain.conversation.id },
      { effort: "high" },
    );
    plain.conversation.effort = "high";
    await executeDurableChatTurn((await accept(plain, "At High.")).assistantMessage.id);
    assert.equal(requests[0].reasoning_effort, undefined);
    assert.equal(requests[1].reasoning_effort, "high");
    assert.deepEqual(offered[1], offered[0]);
  });
});
