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
import { INTERRUPTED_BEFORE_REPLY } from "./chat.js";
import {
  claimDurableChatTurn,
  enqueueDurableChatTurn,
  executeDurableChatTurn,
  interruptDurableChatTurn,
} from "./durableChatTurns.js";

/**
 * End-to-end cover for stopping a reply a Member no longer wants.
 *
 * The interesting behaviour only exists across three layers at once: the agent
 * has to notice the abort, the chat seam has to read the stop as "the human
 * got what they asked for" rather than as the transport error an aborted
 * provider stream really is, and the durable worker has to keep its claim long
 * enough to write down what was already on screen. Each of those compiles
 * perfectly while doing the wrong thing, so this drives a real AI Model — a
 * `custom` OpenAI-compatible endpoint served locally — and reads the row back.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/**
 * One scripted completion. `finish: false` leaves the stream open forever,
 * which is what a turn the Member is about to stop actually looks like.
 */
type UpstreamTurn = { chunks: string[]; finish: boolean };

let upstream: Server | null = null;
let upstreamBaseUrl = "";
let previousAllowlist: string[] = [];
/** Fires as each model call begins, before any text has been sent back. */
let onUpstreamRequest: (() => void) | null = null;
/** Every prompt the model was actually sent, in order. */
let prompts: { role: string; content: unknown }[][] = [];

async function startUpstream(script: UpstreamTurn[]): Promise<void> {
  let served = 0;
  prompts = [];
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try {
      prompts.push(JSON.parse(Buffer.concat(chunks).toString()).messages ?? []);
    } catch {
      prompts.push([]);
    }
    const turn = script[Math.min(served, script.length - 1)];
    served += 1;
    onUpstreamRequest?.();
    sendTurn(response, turn);
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

function sendTurn(response: ServerResponse, turn: UpstreamTurn): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const text of turn.chunks) {
    response.write(
      `data: ${JSON.stringify({
        id: "chat-turn",
        object: "chat.completion.chunk",
        created: 1,
        model: "interrupt-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: text },
            finish_reason: turn.finish ? "stop" : null,
          },
        ],
      })}\n\n`,
    );
  }
  if (turn.finish) response.end("data: [DONE]\n\n");
}

afterEach(async () => {
  onUpstreamRequest = null;
  if (previousAllowlist.length > 0 || config.security.outboundPrivateHostAllowlist.length > 0) {
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
    previousAllowlist = [];
  }
  const server = upstream;
  upstream = null;
  if (!server) return;
  // A scripted response is still open by design; without this the close below
  // waits on a socket nothing is ever going to end.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function fixture() {
  const requester = await insert(User, {
    email: "owner@interrupt.example",
    passwordHash: "hash",
    name: "Interrupt Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Interrupt Co",
    slug: "interrupt-co",
    ownerId: requester.id,
  });
  await insert(Membership, { companyId: company.id, userId: requester.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie-mallers",
    role: "Reviewer",
  });
  const model = await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "interrupt-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    contextWindow: null,
    contextWindowSource: null,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(upstreamBaseUrl),
      modelId: "interrupt-test",
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

/**
 * Run a turn and press the stop button once the browser has actually seen a
 * delta — the moment a Member could realistically react to what is on screen.
 */
async function runAndStopOnFirstChunk(
  messageId: string,
  onFinal?: (message: ConversationMessage) => void,
) {
  let stopped = false;
  return executeDurableChatTurn(messageId, {
    onChunk: () => {
      if (stopped) return;
      stopped = true;
      void interruptDurableChatTurn(messageId);
    },
    onFinal: ({ message }) => onFinal?.(message),
  });
}

async function reload(id: string): Promise<ConversationMessage> {
  return AppDataSource.getRepository(ConversationMessage).findOneByOrFail({ id });
}

describe("stopping a durable chat turn", () => {
  test("keeps what the employee had already said on screen", async () => {
    await startUpstream([
      { chunks: ["The existing OneUptime session is still running, so "], finish: false },
    ]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Review the attribution issue");

    const finals: ConversationMessage[] = [];
    const outcome = await runAndStopOnFirstChunk(enqueued.assistantMessage.id, (message) =>
      finals.push(message),
    );

    assert.equal(outcome, "completed");
    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.status, "interrupted");
    assert.equal(row.content, "The existing OneUptime session is still running, so");
    // Subscribers hear the same thing the row says — the browser that pressed
    // the button must not be left following a turn that already ended.
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.status, "interrupted");
  });

  test("releases the employee so the queued follow-up runs straight after", async () => {
    await startUpstream([
      { chunks: ["Starting the checkout"], finish: false },
      { chunks: ["Here are the updates."], finish: true },
    ]);
    const seed = await fixture();
    const first = await enqueue(seed, "Review the attribution issue");
    await runAndStopOnFirstChunk(first.assistantMessage.id);

    // Nothing is left holding the employee's reply lease, so the message the
    // Member interrupted for is not answered "still finishing another message".
    const second = await enqueue(seed, "What are the updates?");
    assert.equal(await executeDurableChatTurn(second.assistantMessage.id), "completed");
    const row = await reload(second.assistantMessage.id);
    assert.equal(row.status, "ok");
    assert.equal(row.content, "Here are the updates.");
  });

  test("says so plainly when the stop lands before the first word", async () => {
    await startUpstream([{ chunks: [], finish: false }]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Never mind, stop");
    onUpstreamRequest = () => void interruptDurableChatTurn(enqueued.assistantMessage.id);

    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");
    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.status, "interrupted");
    // An empty bubble would read as a reply that silently failed.
    assert.equal(row.content, INTERRUPTED_BEFORE_REPLY);
  });

  test("leaves nothing for the recovery sweep to resume", async () => {
    await startUpstream([{ chunks: ["Half an answer"], finish: false }]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Review the attribution issue");
    await runAndStopOnFirstChunk(enqueued.assistantMessage.id);

    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.turnWorkerId, null);
    assert.equal(row.turnLeaseExpiresAt, null);
    assert.equal(row.progressPercent, null);
    assert.equal(row.progressLabel, null);
    // A stopped turn is finished. Re-running it must not start the model again
    // or overwrite what the Member kept.
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "claimed_elsewhere");
    assert.equal((await reload(enqueued.assistantMessage.id)).content, "Half an answer");
  });

  test("still stops a turn this worker was overtaken on", async () => {
    await startUpstream([{ chunks: ["Half an answer"], finish: false }]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Review the attribution issue");

    // A sibling replica takes the turn over — as if this worker had stalled
    // past its lease — in the same instant the Member presses stop. The stop
    // must still land: leaving the row `working` would let the new claimant
    // keep answering a question that has been withdrawn.
    let raced = false;
    const outcome = await executeDurableChatTurn(enqueued.assistantMessage.id, {
      onChunk: () => {
        if (raced) return;
        raced = true;
        void (async () => {
          await claimDurableChatTurn(
            enqueued.assistantMessage.id,
            new Date(Date.now() + 60_000),
            "worker-sibling",
          );
          await interruptDurableChatTurn(enqueued.assistantMessage.id);
        })();
      },
    });

    assert.equal(outcome, "completed");
    const row = await reload(enqueued.assistantMessage.id);
    assert.equal(row.status, "interrupted");
    assert.equal(row.turnWorkerId, null);
    assert.equal(row.turnLeaseExpiresAt, null);
  });

  test("tells the employee its previous reply was cut short", async () => {
    await startUpstream([
      { chunks: ["Checking the OneUptime checkout"], finish: false },
      { chunks: ["Here are the updates."], finish: true },
    ]);
    const seed = await fixture();
    const first = await enqueue(seed, "Review the attribution issue");
    await runAndStopOnFirstChunk(first.assistantMessage.id);

    const second = await enqueue(seed, "What are the updates?");
    assert.equal(await executeDurableChatTurn(second.assistantMessage.id), "completed");

    // Replayed verbatim, a half-sentence reads as a finished answer and the
    // employee can carry on as though it had delivered something it never did.
    const replayed = (prompts.at(-1) ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) => JSON.stringify(message.content))
      .join("\n");
    assert.match(replayed, /Checking the OneUptime checkout/);
    assert.match(replayed, /cut short/);
  });

  test("reports that there was nothing to stop once the turn has settled", async () => {
    await startUpstream([{ chunks: ["Half an answer"], finish: false }]);
    const seed = await fixture();
    const enqueued = await enqueue(seed, "Review the attribution issue");
    await runAndStopOnFirstChunk(enqueued.assistantMessage.id);

    assert.equal(await interruptDurableChatTurn(enqueued.assistantMessage.id), "not_running");
  });
});
