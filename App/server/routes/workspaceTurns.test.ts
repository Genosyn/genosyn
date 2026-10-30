import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { ChannelTurn, type ChannelTurnStatus } from "../db/entities/ChannelTurn.js";
import type { Company } from "../db/entities/Company.js";
import type { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { agentRuntime } from "../services/agent/runtime.js";
import { ChatTurnActivityRecorder } from "../services/chatTurnActivity.js";
import { openLiveTurn, releaseLiveTurn } from "../services/chatTurnLive.js";
import { settleChannelTurnsForTests, stopChannelTurnRecovery } from "../services/channelTurns.js";
import { insertChannelMessage } from "../services/workspaceChat.js";
import { addEmployee, addMember } from "../test/accessFixtures.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";

/**
 * An AI Employee's turns in a Workspace room over HTTP, through the real
 * `createApp()` stack: who is working, each turn's steps, the live stream a
 * room follows, Stop and Retry.
 *
 * The rules throughout: only someone who can read the room reads anything
 * about its turns, and what they read of a turn's steps follows whose access
 * the turn used — everything for that Member, the steps without what they
 * read or returned for the rest of the room. Steps and their stream need a
 * signed-in browser, as a direct chat's do.
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
let ruth: User;
let sam: User;
let olive: User;
let ada: AIEmployee;
let general: Channel;
let finance: Channel;
let ruthCookie: string;
let samCookie: string;
let oliveCookie: string;

beforeEach(async () => {
  await resetTestDb();
  const created = await createMemberOfNewCompany("owner", { name: "Ruth" });
  company = created.company;
  ruth = created.user;
  sam = await addMember(company.id, "member", { name: "Sam" });
  olive = await addMember(company.id, "member", { name: "Olive" });
  ada = await addEmployee(company.id, "Ada");
  general = await insert(Channel, {
    companyId: company.id,
    kind: "public",
    name: "general",
    slug: "general",
    topic: "",
    webhookToken: null,
    createdByUserId: ruth.id,
    archivedAt: null,
    lastMessageAt: null,
  });
  finance = await insert(Channel, {
    companyId: company.id,
    kind: "private",
    name: "finance",
    slug: "finance",
    topic: "",
    webhookToken: null,
    createdByUserId: ruth.id,
    archivedAt: null,
    lastMessageAt: null,
  });
  for (const channel of [general, finance]) {
    await insert(ChannelMember, {
      channelId: channel.id,
      memberKind: "ai",
      userId: null,
      employeeId: ada.id,
      lastReadAt: null,
    });
  }
  for (const user of [ruth, sam]) {
    await insert(ChannelMember, {
      channelId: finance.id,
      memberKind: "user",
      userId: user.id,
      employeeId: null,
      lastReadAt: null,
    });
  }
  ruthCookie = await sessionCookieFor(ruth);
  samCookie = await sessionCookieFor(sam);
  oliveCookie = await sessionCookieFor(olive);
});

afterEach(async () => {
  stopChannelTurnRecovery();
  await settleChannelTurnsForTests();
});

const turnsPath = (channel: Channel) =>
  `/api/companies/${company.id}/workspace/channels/${channel.id}/turns`;

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; list: unknown[]; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: (Array.isArray(parsed) ? {} : parsed) as Record<string, unknown>,
    list: Array.isArray(parsed) ? parsed : [],
    text,
  };
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

/** A reply Ruth asked Ada for in `channel`, with its steps recorded. */
async function turnWithActivity(
  channel: Channel,
  status: ChannelTurnStatus = "ok",
): Promise<{ turn: ChannelTurn; trigger: ChannelMessage }> {
  const trigger = await insert(ChannelMessage, {
    channelId: channel.id,
    authorKind: "user",
    authorUserId: ruth.id,
    content: "@ada what did we spend on contractors?",
    createdAt: new Date(Date.now() - 60_000),
  } as never);
  const turn = await insert(ChannelTurn, {
    companyId: company.id,
    channelId: channel.id,
    employeeId: ada.id,
    kind: "reply",
    triggerMessageId: trigger.id,
    authority: "member",
    requesterUserId: ruth.id,
    requesterSessionVersion: 0,
    status,
    attempt: 1,
    acceptedAt: new Date(Date.now() - 60_000),
    deadlineAt: new Date(Date.now() + 60 * 60_000),
  } as never);
  const recorder = new ChatTurnActivityRecorder(
    { companyId: company.id, conversationId: channel.id, messageId: turn.id, attempt: 1 },
    1,
  );
  recorder.turnStarted("start");
  recorder.toolUse("list_finance_transactions", { search: "contractor payroll Q3" }, "c1");
  recorder.toolResult(
    "list_finance_transactions",
    { content: JSON.stringify({ rows: [{ memo: "Payroll — Dana Contractor", amount: 4200 }] }) },
    "c1",
  );
  recorder.reasoning("Dana's invoice is the biggest line.", "b1");
  if (status !== "working") {
    const summary = recorder.summarize({ status, startedAt: turn.acceptedAt });
    await recorder.finish(summary);
    await AppDataSource.getRepository(ChannelTurn).update(
      { id: turn.id },
      { activityJson: JSON.stringify(summary), endedAt: new Date() },
    );
    await insertChannelMessage({
      channel,
      author: { kind: "ai", employeeId: ada.id },
      content: status === "ok" ? "About $4,200." : "Ada couldn't finish this reply.",
      turnId: turn.id,
    });
  } else {
    await recorder.flush();
  }
  return { turn: await AppDataSource.getRepository(ChannelTurn).findOneByOrFail({ id: turn.id }), trigger };
}

describe("a turn's steps", () => {
  test("the Member who asked reads every step; the rest of the room the steps alone", async () => {
    const { turn } = await turnWithActivity(general);
    const mine = await call("GET", `${turnsPath(general)}/${turn.id}/activity`, { cookie: ruthCookie });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.access, "full");
    const full = mine.body.events as Array<{ kind: string; detail: Record<string, unknown> }>;
    assert.deepEqual(
      full.map((event) => event.kind),
      ["turn_started", "tool_use", "tool_result", "reasoning", "turn_finished"],
    );
    assert.match(JSON.stringify(full), /contractor payroll Q3/);
    assert.match(JSON.stringify(full), /Dana Contractor/);

    const theirs = await call("GET", `${turnsPath(general)}/${turn.id}/activity`, {
      cookie: samCookie,
    });
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.access, "steps");
    const steps = theirs.body.events as Array<{ kind: string; summary: string; detail: Record<string, unknown> }>;
    assert.deepEqual(
      steps.map((event) => event.kind),
      ["turn_started", "tool_use", "tool_result", "reasoning", "turn_finished"],
      "the same steps, in the same order",
    );
    assert.doesNotMatch(JSON.stringify(steps), /contractor|Dana|4200|biggest/i);
    assert.equal(steps[1].detail.withheld, "steps");
    assert.equal(steps[1].summary, "Searching Finance transactions");
    assert.equal(steps[2].detail.output, null);
    assert.equal(typeof steps[2].detail.durationMs, "number", "how long it took is kept");
  });

  test("a room someone cannot read has no turns to them, and a turn is reached only through its own room", async () => {
    const { turn } = await turnWithActivity(finance);
    for (const path of [
      `${turnsPath(finance)}/${turn.id}/activity`,
      `${turnsPath(finance)}/${turn.id}/activity/stream`,
      turnsPath(finance),
    ]) {
      const res = await call("GET", path, { cookie: oliveCookie });
      assert.equal(res.status, 404, `${path} for someone outside the room`);
    }
    const stop = await call("POST", `${turnsPath(finance)}/${turn.id}/stop`, { cookie: oliveCookie }, {});
    assert.equal(stop.status, 404);
    // The right turn through the wrong room reads as missing too.
    const elsewhere = await call("GET", `${turnsPath(general)}/${turn.id}/activity`, {
      cookie: ruthCookie,
    });
    assert.equal(elsewhere.status, 404);
  });

  test("an API key reads who is working and may press Stop, but never a turn's steps", async () => {
    const { turn } = await turnWithActivity(general);
    const { token } = await mintTestApiKey(ruth.id, company.id);
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await call("GET", turnsPath(general), auth)).status, 200);
    assert.equal((await call("GET", `${turnsPath(general)}/${turn.id}/activity`, auth)).status, 403);
    assert.equal(
      (await call("GET", `${turnsPath(general)}/${turn.id}/activity/stream`, auth)).status,
      403,
    );
    assert.equal(
      (await call("POST", `${turnsPath(general)}/${turn.id}/retry`, auth, {})).status,
      403,
      "Retry starts AI work under the caller's authority",
    );
    const stop = await call("POST", `${turnsPath(general)}/${turn.id}/stop`, auth, {});
    assert.equal(stop.status, 200);
    assert.equal(stop.body.interrupted, false, "nothing was running");
  });

  test("a message in the room says how its turn went", async () => {
    const { turn } = await turnWithActivity(general);
    const res = await call("GET", `/api/companies/${company.id}/workspace/channels/${general.id}/messages`, {
      cookie: samCookie,
    });
    assert.equal(res.status, 200);
    const reply = (res.list as Array<Record<string, unknown>>).find((m) => m.authorKind === "ai");
    const aiTurn = reply?.aiTurn as Record<string, unknown>;
    assert.equal(aiTurn.id, turn.id);
    assert.equal(aiTurn.status, "ok");
    assert.equal(aiTurn.authority, "member");
    assert.deepEqual(aiTurn.requester, { id: ruth.id, name: "Ruth" });
    assert.equal((aiTurn.activity as { steps: number }).steps, 1);
  });
});

describe("following a turn", () => {
  test("a finished turn replays what the reader has not seen, then hands over its reply", async () => {
    const { turn } = await turnWithActivity(general);
    const res = await call("GET", `${turnsPath(general)}/${turn.id}/activity/stream?after=1`, {
      cookie: samCookie,
    });
    assert.equal(res.status, 200);
    const parsed = frames(res.text);
    assert.equal(parsed[0].event, "turn");
    assert.equal(parsed[0].data.access, "steps");
    const activity = parsed.filter((frame) => frame.event === "activity");
    assert.deepEqual(
      activity.map((frame) => frame.data.kind),
      ["tool_use", "tool_result", "reasoning", "turn_finished"],
      "only what follows the cursor",
    );
    assert.doesNotMatch(JSON.stringify(activity), /contractor|Dana/i);
    const final = parsed.find((frame) => frame.event === "final");
    assert.equal((final?.data.turn as { id: string }).id, turn.id);
    assert.equal((final?.data.message as { content: string }).content, "About $4,200.");
    assert.equal(parsed.at(-1)?.event, "done");
  });

  test("a running turn streams live to the room, and the stream ends when its reply lands", async () => {
    const { turn } = await turnWithActivity(general, "working");
    const live = openLiveTurn(turn.id, general.id);
    live.appendText("Adding up ");
    const response = await fetch(`${baseUrl}${turnsPath(general)}/${turn.id}/activity/stream?after=0`, {
      headers: { cookie: samCookie },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200);
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
    assert.match(text, /"text":"Adding up "/);
    live.pushEvent({
      ordinal: 50,
      attempt: 1,
      kind: "tool_use",
      name: "get_finance_report",
      callId: "c9",
      summary: "Reading a Finance report · profit_and_loss",
      detail: { input: { report: "profit_and_loss" }, worker: null },
      isError: false,
      at: new Date().toISOString(),
    });
    await readUntil(/"ordinal":50/);
    live.appendText("the invoices.");
    await readUntil(/event: chunk/);
    await AppDataSource.getRepository(ChannelTurn).update({ id: turn.id }, { status: "ok" });
    live.finish();
    releaseLiveTurn(live);
    await readUntil(/event: done/);
    const parsed = frames(text);
    const liveStep = parsed.find((frame) => frame.event === "activity" && frame.data.ordinal === 50);
    assert.equal(liveStep?.data.summary, "Reading a Finance report", "the room's view, live too");
    assert.doesNotMatch(JSON.stringify(liveStep), /profit_and_loss/);
    assert.deepEqual(parsed.find((frame) => frame.event === "chunk")?.data, { text: "the invoices." });
    assert.ok(parsed.some((frame) => frame.event === "final"));
  });
});

describe("the room's controls", () => {
  test("the running turns are listed for the room, and a finished one is not", async () => {
    const { turn: running } = await turnWithActivity(general, "working");
    await turnWithActivity(general, "ok");
    const res = await call("GET", turnsPath(general), { cookie: samCookie });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.list.map((row) => (row as { id: string }).id),
      [running.id],
    );
    const row = res.list[0] as Record<string, unknown>;
    assert.equal(row.kind, "reply");
    assert.deepEqual(row.employee, { id: ada.id, name: "Ada", slug: ada.slug, role: ada.role });
    assert.deepEqual(row.requester, { id: ruth.id, name: "Ruth" });
  });

  test("anyone in the room can stop a waiting reply; what it had is kept and the room is told who", async () => {
    const { turn } = await turnWithActivity(general, "working");
    await AppDataSource.getRepository(ChannelTurn).update(
      { id: turn.id },
      { waitingFor: "model_unavailable", leaseExpiresAt: new Date(Date.now() + 30_000) },
    );
    const res = await call("POST", `${turnsPath(general)}/${turn.id}/stop`, { cookie: samCookie }, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.interrupted, true);
    const stopped = await AppDataSource.getRepository(ChannelTurn).findOneByOrFail({ id: turn.id });
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.stoppedByUserId, sam.id);
    assert.ok(stopped.replyMessageId);
    const again = await call("POST", `${turnsPath(general)}/${turn.id}/stop`, { cookie: ruthCookie }, {});
    assert.deepEqual(again.body, { interrupted: false });
  });

  test("a discussion's turn stops with its discussion, not on its own", async () => {
    const { turn } = await turnWithActivity(general, "working");
    await AppDataSource.getRepository(ChannelTurn).update({ id: turn.id }, { kind: "discussion" });
    const res = await call("POST", `${turnsPath(general)}/${turn.id}/stop`, { cookie: ruthCookie }, {});
    assert.equal(res.status, 409);
  });

  test("Retry asks a failed reply again as a new turn under the asker", async (t) => {
    await insertEmployeeModel({
      employeeId: ada.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      params.callbacks?.onText?.("About $4,200 this quarter.");
      return { finalText: "", steps: 1, stopReason: "end_turn" };
    });
    const { turn } = await turnWithActivity(general, "error");
    const res = await call("POST", `${turnsPath(general)}/${turn.id}/retry`, { cookie: samCookie }, {});
    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, turn.id);
    assert.equal(res.body.triggerMessageId, turn.triggerMessageId);
    assert.deepEqual(res.body.requester, { id: sam.id, name: "Sam" });
    await settleChannelTurnsForTests();
    const done = await AppDataSource.getRepository(ChannelTurn).findOneByOrFail({
      id: res.body.id as string,
    });
    assert.equal(done.status, "ok");
    const twice = await call("POST", `${turnsPath(general)}/${turn.id}/retry`, { cookie: samCookie }, {});
    assert.equal(twice.status, 409);
    const invalid = await call("POST", `${turnsPath(general)}/${turn.id}/retry`, { cookie: samCookie }, {
      force: true,
    });
    assert.equal(invalid.status, 400, "the body is validated");
  });
});
