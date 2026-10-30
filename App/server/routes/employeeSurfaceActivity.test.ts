import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationActivityEvent } from "../db/entities/ConversationActivityEvent.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import type { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { ChatTurnActivityRecorder, listChatActivity } from "../services/chatTurnActivity.js";
import { openLiveTurn, releaseLiveTurn } from "../services/chatTurnLive.js";
import { RETRY_PROGRESS_LABEL } from "../services/durableChatTurns.js";
import { addEmployee, addMember } from "../test/accessFixtures.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * A chat turn's activity over HTTP, through the real `createApp()` stack: the
 * page that loads a finished reply's steps, the stream a reload re-attaches
 * to, Retry, and Stop. The activity is part of a private conversation, so the
 * rule throughout is the conversation's own: its owner reads it, nobody else
 * does — not another Member, not an owner, not an API key.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let owner: User;
let colleague: User;
let employee: AIEmployee;
let conversation: Conversation;
let ownerCookie: string;

beforeEach(async () => {
  await resetTestDb();
  const created = await createMemberOfNewCompany("owner", { name: "Olivia Owner" });
  company = created.company;
  owner = created.user;
  colleague = await addMember(company.id, "admin", { name: "Ada Admin" });
  employee = await addEmployee(company.id, "Sam Flinch");
  conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: owner.id,
    title: "Spot GPUs",
    source: "web",
  });
  ownerCookie = await sessionCookieFor(owner);
});

const turnPath = (messageId: string, conversationId = conversation.id) =>
  `/api/companies/${company.id}/employees/${employee.id}/conversations/${conversationId}/messages/${messageId}`;

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, text };
}

/** Parse a finished SSE body into frames. */
function frames(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("event:"))
    .map((frame) => {
      const event = /event: (.*)/.exec(frame)?.[1] ?? "";
      const data = /data: (.*)/.exec(frame)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function turnWithActivity(status: ConversationMessage["status"] = "ok") {
  const user = await insert(ConversationMessage, {
    conversationId: conversation.id,
    role: "user",
    content: "Go on-demand.",
    status: null,
  });
  const reply = await insert(ConversationMessage, {
    conversationId: conversation.id,
    role: "assistant",
    content: status === "working" ? "" : "Done.",
    status,
    turnUserMessageId: user.id,
    turnRequesterUserId: owner.id,
    turnRequesterSessionVersion: 0,
    turnAttempt: 1,
    turnDeadlineAt: new Date(Date.now() + 6 * 60 * 60_000),
  });
  const recorder = new ChatTurnActivityRecorder(
    { companyId: company.id, conversationId: conversation.id, messageId: reply.id, attempt: 1 },
    1,
  );
  recorder.turnStarted("start");
  recorder.toolUse("list_banking_transactions", { status: "unreviewed" }, "c1");
  recorder.toolResult("list_banking_transactions", { content: "[]" }, "c1");
  await recorder.flush();
  return { user, reply };
}

describe("reading a reply's activity", () => {
  test("its owner reads the steps, page by page", async () => {
    const { reply } = await turnWithActivity();
    const all = await call("GET", `${turnPath(reply.id)}/activity`, { cookie: ownerCookie });
    assert.equal(all.status, 200);
    const events = all.body.events as Array<{ ordinal: number; kind: string; summary: string }>;
    assert.deepEqual(
      events.map((event) => event.kind),
      ["turn_started", "tool_use", "tool_result"],
    );
    assert.equal(events[1].summary, "Searching Banking transactions · unreviewed");
    assert.equal(all.body.more, false);
    assert.equal(all.body.status, "ok");

    const page = await call("GET", `${turnPath(reply.id)}/activity?after=1&limit=1`, {
      cookie: ownerCookie,
    });
    assert.deepEqual(
      (page.body.events as Array<{ ordinal: number }>).map((event) => event.ordinal),
      [2],
    );
    assert.equal(page.body.more, true);
  });

  test("nobody else reads it: another Member, the owner of the company, or an API key", async () => {
    const { reply } = await turnWithActivity();
    const colleagueCookie = await sessionCookieFor(colleague);
    for (const suffix of ["/activity", "/activity/stream"]) {
      const asColleague = await call("GET", `${turnPath(reply.id)}${suffix}`, {
        cookie: colleagueCookie,
      });
      assert.equal(asColleague.status, 404, `${suffix} as another Member`);
    }
    // The company's owner who is not this conversation's owner.
    const otherOwner = await addMember(company.id, "owner", { name: "Other Owner" });
    const asOtherOwner = await call("GET", `${turnPath(reply.id)}/activity`, {
      cookie: await sessionCookieFor(otherOwner),
    });
    assert.equal(asOtherOwner.status, 404);

    const { token } = await mintTestApiKey(owner.id, company.id);
    const asKey = await call("GET", `${turnPath(reply.id)}/activity`, {
      authorization: `Bearer ${token}`,
    });
    assert.ok([401, 403].includes(asKey.status), `an API key got ${asKey.status}`);
    assert.ok(!asKey.text.includes("list_banking_transactions"));
  });

  test("a reply is reachable only through its own conversation", async () => {
    const { reply } = await turnWithActivity();
    const elsewhere = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: owner.id,
      title: "Other",
      source: "web",
    });
    const crossed = await call("GET", `${turnPath(reply.id, elsewhere.id)}/activity`, {
      cookie: ownerCookie,
    });
    assert.equal(crossed.status, 404);
    const unknown = await call(
      "GET",
      `${turnPath("6f9619ff-8b86-4011-b42d-00c04fc964ff")}/activity`,
      {
        cookie: ownerCookie,
      },
    );
    assert.equal(unknown.status, 404);
    const invalid = await call("GET", `${turnPath("not-a-uuid")}/activity`, {
      cookie: ownerCookie,
    });
    assert.equal(invalid.status, 400);
    const badCursor = await call("GET", `${turnPath(reply.id)}/activity?after=-1`, {
      cookie: ownerCookie,
    });
    assert.equal(badCursor.status, 400);
  });
});

describe("following a reply", () => {
  test("a finished reply replays what the reader has not seen and ends with the reply", async () => {
    const { reply } = await turnWithActivity();
    const response = await call("GET", `${turnPath(reply.id)}/activity/stream?after=1`, {
      cookie: ownerCookie,
    });
    assert.equal(response.status, 200);
    const parsed = frames(response.text);
    assert.deepEqual(
      parsed.map((frame) => frame.event),
      ["turn", "activity", "activity", "assistant", "done"],
    );
    assert.equal(parsed[3].data.id, reply.id);
    assert.equal(parsed[3].data.content, "Done.");
  });

  test("a running reply streams live and the stream ends when the reply lands", async () => {
    const { reply } = await turnWithActivity("working");
    const live = openLiveTurn(reply.id, conversation.id);
    live.appendText("Checking ");
    const responsePromise = fetch(`${baseUrl}${turnPath(reply.id)}/activity/stream?after=3`, {
      headers: { cookie: ownerCookie },
      signal: AbortSignal.timeout(30_000),
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(/event: snapshot/);
    assert.match(text, /"text":"Checking "/);
    live.appendText("the books.");
    await readUntil(/event: chunk/);
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: reply.id },
      { status: "ok", content: "Checking the books." },
    );
    live.finish();
    releaseLiveTurn(live);
    await readUntil(/event: done/);
    const parsed = frames(text);
    assert.equal(
      parsed.filter((frame) => frame.event === "activity").length,
      0,
      "nothing at or before the cursor",
    );
    assert.deepEqual(parsed.find((frame) => frame.event === "chunk")?.data, { text: "the books." });
    assert.equal(
      parsed.find((frame) => frame.event === "assistant")?.data.content,
      "Checking the books.",
    );
  });
});

describe("retrying a failed reply", () => {
  test("runs the newest failed reply again, in place, under the Member who asks", async () => {
    const { user, reply } = await turnWithActivity("error");
    const response = await call("POST", `${turnPath(reply.id)}/retry`, { cookie: ownerCookie }, {});
    assert.equal(response.status, 200);
    const message = response.body.message as { id: string; status: string; content: string };
    assert.equal(message.id, reply.id);
    assert.equal(message.status, "working");
    assert.equal(message.content, "");
    const startedAt = Date.parse(String(response.body.startedAt));
    assert.ok(Math.abs(startedAt - Date.now()) < 60_000, "the retried turn's clock starts now");

    // The employee has no AI Model, so the retried run ends quickly — as
    // "not available", which is itself retryable once a model is connected.
    const repo = AppDataSource.getRepository(ConversationMessage);
    let row = await repo.findOneByOrFail({ id: reply.id });
    for (let i = 0; i < 100 && row.status === "working"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = await repo.findOneByOrFail({ id: reply.id });
    }
    assert.equal(row.status, "skipped");
    assert.equal(row.turnUserMessageId, user.id, "the same request, not a new one");
    assert.ok(row.turnAttempt >= 2);
    const events = await listChatActivity(reply.id, 0, 100);
    const kinds = events.map((event) => event.kind);
    assert.deepEqual(
      kinds.slice(0, 3),
      ["turn_started", "tool_use", "tool_result"],
      "the failed attempt is kept",
    );
    assert.ok(events.some((event) => event.kind === "notice" && event.name === "retry_requested"));
    assert.equal(kinds.at(-1), "turn_finished");
    const summary = JSON.parse(row.activityJson) as { status: string };
    assert.equal(summary.status, "skipped");
  });

  test("refuses what a retry cannot honor", async () => {
    const { reply: answered } = await turnWithActivity("ok");
    const okRetry = await call(
      "POST",
      `${turnPath(answered.id)}/retry`,
      { cookie: ownerCookie },
      {},
    );
    assert.equal(okRetry.status, 409, "a reply that did not fail");

    // An older failure the thread has moved past.
    const older = await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Failed",
      status: "error",
      turnUserMessageId: (
        await insert(ConversationMessage, {
          conversationId: conversation.id,
          role: "user",
          content: "a",
        })
      ).id,
      createdAt: new Date(Date.now() - 60 * 60_000),
    });
    const stale = await call("POST", `${turnPath(older.id)}/retry`, { cookie: ownerCookie }, {});
    assert.equal(stale.status, 409);

    const colleagueRetry = await call(
      "POST",
      `${turnPath(answered.id)}/retry`,
      { cookie: await sessionCookieFor(colleague) },
      {},
    );
    assert.equal(colleagueRetry.status, 404, "another Member cannot run someone else's request");

    const extra = await call(
      "POST",
      `${turnPath(answered.id)}/retry`,
      { cookie: ownerCookie },
      { force: true },
    );
    assert.equal(extra.status, 400, "the body is validated");
  });

  test("waits for a reply already running in the thread", async () => {
    const { reply: failed } = await turnWithActivity("error");
    await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "working",
      progressLabel: RETRY_PROGRESS_LABEL,
    });
    const busy = await call("POST", `${turnPath(failed.id)}/retry`, { cookie: ownerCookie }, {});
    assert.equal(busy.status, 409);
    assert.match(String(busy.body.error), /in progress/);
  });
});

describe("stopping and deleting", () => {
  test("a stop on a turn running elsewhere is recorded with the turn's summary", async () => {
    const { reply } = await turnWithActivity("working");
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: reply.id },
      { content: "Partial answer" },
    );
    const response = await call(
      "POST",
      `/api/companies/${company.id}/employees/${employee.id}/conversations/${conversation.id}/interrupt`,
      { cookie: ownerCookie },
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.interrupted, true);
    const row = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: reply.id,
    });
    assert.equal(row.status, "interrupted");
    assert.equal(row.content, "Partial answer", "the saved text is kept, not thrown away");
    const events = await listChatActivity(reply.id, 0, 100);
    assert.deepEqual(
      events.slice(-2).map((event) => event.kind),
      ["stopped", "turn_finished"],
    );
    const summary = JSON.parse(row.activityJson) as { status: string; steps: number };
    assert.equal(summary.status, "interrupted");
    assert.equal(summary.steps, 1);
  });

  test("deleting a conversation deletes its activity", async () => {
    const { reply } = await turnWithActivity();
    const response = await call(
      "DELETE",
      `/api/companies/${company.id}/employees/${employee.id}/conversations/${conversation.id}`,
      { cookie: ownerCookie },
    );
    assert.equal(response.status, 200);
    assert.equal(
      await AppDataSource.getRepository(ConversationActivityEvent).countBy({ messageId: reply.id }),
      0,
    );
  });
});
