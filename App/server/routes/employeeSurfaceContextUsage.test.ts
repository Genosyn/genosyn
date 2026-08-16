import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";

/**
 * The wire contract for the chat context gauge: what `serializeMessage`
 * projects onto every message, and the live `context` stream frame.
 *
 * Three separate paths deliver message state to a browser — the initial
 * conversation load, the reconnect poll, and the SSE stream — and the first two
 * both funnel through the serializer. All three are covered here because none
 * of them is type-checked end to end: `writeEvent` takes `unknown` and the
 * client casts.
 */

type SerializedContext = { tokens: number; window: number | null; percent: number | null } | null;
type SerializedMessage = {
  id: string;
  role: "user" | "assistant";
  status: string | null;
  context: SerializedContext;
};

let server: Server;
let baseUrl: string;
let company: Company;
let employee: AIEmployee;
let owner: User;
let conversation: Conversation;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? { userId, sessionVersion: 0 }
      : {};
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
    email: "owner@context-wire.example",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Wire Co", slug: "wire-co", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Wire Analyst",
    slug: "wire-analyst",
    role: "Analyst",
    soulBody: "",
  });
  conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: owner.id,
    title: "Gauge thread",
    archivedAt: null,
    source: "web",
  });
});

async function loadMessages(): Promise<SerializedMessage[]> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/conversations/${conversation.id}`,
    { headers: { "x-test-user": owner.id } },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages: SerializedMessage[] };
  return body.messages;
}

describe("context usage on the conversation wire", () => {
  test("projects the stored counts plus a derived share", async () => {
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Done.",
      status: "ok",
      contextTokens: 92_000,
      contextWindow: 200_000,
    });

    const [message] = await loadMessages();
    assert.deepEqual(message.context, { tokens: 92_000, window: 200_000, percent: 46 });
  });

  test("reports the tokens with a null share when the window was unknown", async () => {
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Done.",
      status: "ok",
      contextTokens: 142_311,
      contextWindow: null,
    });

    const [message] = await loadMessages();
    assert.deepEqual(message.context, { tokens: 142_311, window: null, percent: null });
  });

  test("is null on rows that never carried a reading", async () => {
    // Legacy replies, Telegram-authored turns, and user messages all land here.
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "user",
      content: "Ask",
      status: null,
    });
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Answer from before this shipped",
      status: "ok",
    });

    const messages = await loadMessages();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].context, null);
    assert.equal(messages[1].context, null);
  });

  test("a zero-token reading is still a reading", async () => {
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Done.",
      status: "ok",
      contextTokens: 0,
      contextWindow: 200_000,
    });

    const [message] = await loadMessages();
    assert.deepEqual(message.context, { tokens: 0, window: 200_000, percent: 0 });
  });

  test("serves a working turn's reading so a reload keeps the live gauge", async () => {
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "working",
      progressPercent: 30,
      progressLabel: "Reading records",
      contextTokens: 40_000,
      contextWindow: 200_000,
    });

    const [message] = await loadMessages();
    assert.equal(message.status, "working");
    assert.deepEqual(message.context, { tokens: 40_000, window: 200_000, percent: 20 });
  });

  test("reads each message against the window it was measured with", async () => {
    // The window is editable and a thread can switch models mid-way. Reading
    // both turns against one number would misreport the older one.
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Small model",
      status: "ok",
      contextTokens: 30_000,
      contextWindow: 64_000,
    });
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Big model",
      status: "ok",
      contextTokens: 30_000,
      contextWindow: 200_000,
    });

    const messages = await loadMessages();
    assert.equal(messages[0].context?.percent, 47);
    assert.equal(messages[1].context?.percent, 15);
  });
});

// ---------- live stream ----------

/**
 * Read `event:`/`data:` frames off an SSE response.
 *
 * The repo's usual `await response.text()` + `JSON.parse` helper cannot be used
 * on this route: it blocks until the whole turn ends and then fails to parse a
 * multi-frame body. `: keepalive` comment frames are skipped the way a browser
 * `EventSource` skips them.
 */
async function readSseEvents(response: Response): Promise<{ event: string; data: unknown }[]> {
  assert.ok(response.body, "expected a streamed body");
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = "";

  const flush = (frame: string) => {
    let name = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    events.push({ event: name, data: JSON.parse(dataLines.join("\n")) });
  };

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      flush(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) flush(buffer);
  return events;
}

describe("context usage on the chat stream", () => {
  let upstream: Server | null = null;
  let previousAllowlist: string[] = [];

  async function connectModel(args: {
    promptTokens?: number;
    contextWindow: number | null;
  }): Promise<AIModel> {
    upstream = createServer(async (request, response: ServerResponse) => {
      for await (const _chunk of request) {
        // Drain the request body.
      }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.write(
        `data: ${JSON.stringify({
          id: "t",
          object: "chat.completion.chunk",
          created: 1,
          model: "stream-gauge",
          choices: [
            { index: 0, delta: { role: "assistant", content: "Here you go." }, finish_reason: "stop" },
          ],
        })}\n\n`,
      );
      if (args.promptTokens !== undefined) {
        response.write(
          `data: ${JSON.stringify({
            id: "t",
            object: "chat.completion.chunk",
            created: 1,
            model: "stream-gauge",
            choices: [],
            usage: {
              prompt_tokens: args.promptTokens,
              completion_tokens: 7,
              total_tokens: args.promptTokens + 7,
            },
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject);
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream!.address() as AddressInfo;
    previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
    return insert(AIModel, {
      employeeId: employee.id,
      provider: "custom",
      model: "stream-gauge",
      authMode: "customEndpoint",
      isActive: true,
      connectedAt: new Date(),
      contextWindow: args.contextWindow,
      contextWindowSource: args.contextWindow === null ? null : "manual",
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret(`http://127.0.0.1:${address.port}/v1`),
        modelId: "stream-gauge",
      }),
    });
  }

  async function stopUpstream(): Promise<void> {
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
    previousAllowlist = [];
    const running = upstream;
    upstream = null;
    if (!running) return;
    await new Promise<void>((resolve, reject) => {
      running.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async function send(): Promise<{ event: string; data: unknown }[]> {
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": owner.id },
        body: JSON.stringify({ message: "How full is the window?" }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    return readSseEvents(response);
  }

  test("emits a context frame in the same shape a stored message carries", async () => {
    await connectModel({ promptTokens: 92_000, contextWindow: 200_000 });
    try {
      const events = await send();

      const contextFrames = events.filter((entry) => entry.event === "context");
      assert.deepEqual(contextFrames, [
        { event: "context", data: { tokens: 92_000, window: 200_000, percent: 46 } },
      ]);

      // The finalized assistant row carries the same reading, so a client that
      // missed the frame still lands on the right number.
      const assistant = events.find((entry) => entry.event === "assistant");
      assert.deepEqual((assistant?.data as SerializedMessage | undefined)?.context, {
        tokens: 92_000,
        window: 200_000,
        percent: 46,
      });
      assert.ok(events.some((entry) => entry.event === "done"));
    } finally {
      await stopUpstream();
    }
  });

  test("emits a null share for a model with no known window", async () => {
    await connectModel({ promptTokens: 142_311, contextWindow: null });
    try {
      const events = await send();
      assert.deepEqual(
        events.filter((entry) => entry.event === "context").map((entry) => entry.data),
        [{ tokens: 142_311, window: null, percent: null }],
      );
    } finally {
      await stopUpstream();
    }
  });

  test("emits no context frame when the provider reported no counts", async () => {
    await connectModel({ contextWindow: 200_000 });
    try {
      const events = await send();
      assert.equal(
        events.filter((entry) => entry.event === "context").length,
        0,
      );
      // The turn itself still completes normally.
      const assistant = events.find((entry) => entry.event === "assistant");
      assert.equal((assistant?.data as SerializedMessage | undefined)?.status, "ok");
      assert.equal((assistant?.data as SerializedMessage | undefined)?.context, null);
    } finally {
      await stopUpstream();
    }
  });
});
