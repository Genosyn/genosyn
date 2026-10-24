import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { Company } from "../db/entities/Company.js";
import { GroupDiscussion } from "../db/entities/GroupDiscussion.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import type { ChatOptions, ChatResult } from "../services/chat.js";
import {
  setGroupDiscussionDepsForTests,
  settleGroupDiscussionsForTests,
} from "../services/groupDiscussions.js";
import { resolveOutcome } from "../services/groupDiscussionPrompts.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { persistTestSession } from "../test/userSession.js";
import { workspaceRouter } from "./workspace.js";
import { workspaceDiscussionsRouter } from "./workspaceDiscussions.js";

/**
 * The HTTP surface for group chats and group discussions: who may open one,
 * start one, read one, stop one, finish one and start its work — and what a
 * malformed request gets back. Model turns are scripted; the routers, the
 * services behind them and the database are real.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let outsider: User;
let ada: AIEmployee;
let ben: AIEmployee;
let cy: AIEmployee;
let stranger: AIEmployee;

let turnCalls: Array<{ employeeId: string; options: ChatOptions }>;
let replies: Map<string, string[]>;
let blockTurns: Promise<void> | null;
let withItems: boolean;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/workspace", workspaceRouter);
  app.use("/api/companies/:cid/workspace", workspaceDiscussionsRouter);
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
  owner = await insert(User, { email: "ruth@example.test", name: "Ruth", passwordHash: "x", sessionVersion: 0 });
  member = await insert(User, { email: "sam@example.test", name: "Sam", passwordHash: "x", sessionVersion: 0 });
  outsider = await insert(User, { email: "olive@example.test", name: "Olive", passwordHash: "x", sessionVersion: 0 });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" as Role });
  ada = await hire(company, "Ada", "ada");
  ben = await hire(company, "Ben", "ben");
  cy = await hire(company, "Cy", "cy");
  stranger = await hire(otherCompany, "Stranger", "stranger");
  actingUserId = owner.id;

  turnCalls = [];
  replies = new Map();
  blockTurns = null;
  withItems = false;
  setGroupDiscussionDepsForTests({
    pollIntervalMs: 10,
    runTurn: async (_companyId, employeeId, _message, _history, _onChunk, options) => {
      turnCalls.push({ employeeId, options });
      if (blockTurns && options.collaboration) {
        await Promise.race([
          blockTurns,
          new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve())),
        ]);
      }
      const reply = replies.get(employeeId)?.shift() ?? "PASS";
      return { status: "ok", reply, attachmentIds: [], sidecars: {} } as ChatResult;
    },
    writeOutcome: async (args) => ({
      ok: true,
      outcome: resolveOutcome(
        {
          summary: "Raise Pro to $49.",
          recommendation: "Announce Monday.",
          openQuestions: [],
          actionItems: withItems ? [{ owner: "@ben", action: "Update the forecast." }] : [],
        },
        args.people,
        args.lead.id,
      ),
    }),
  });
});

afterEach(async () => {
  await settleGroupDiscussionsForTests();
  setGroupDiscussionDepsForTests(null);
});

async function hire(co: Company, name: string, slug: string): Promise<AIEmployee> {
  const e = await insert(AIEmployee, { companyId: co.id, name, slug, role: `${name}'s role`, soulBody: "" });
  await insertEmployeeModel({
    employeeId: e.id,
    provider: "anthropic",
    model: "claude-sonnet-4",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  return e;
}

type ApiResult = { status: number; body: any };

async function api(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/workspace${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function openGroupChat(extra: Record<string, unknown> = {}): Promise<ApiResult> {
  return api("POST", "/group-chats", { employeeIds: [ada.id, ben.id], ...extra });
}

async function waitForEnd(discussionId: string): Promise<GroupDiscussion> {
  await settleGroupDiscussionsForTests();
  return AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({ id: discussionId });
}

describe("POST /group-chats", () => {
  test("opens a group chat and, given a question, starts the discussion", async () => {
    replies.set(ada.id, ["Opening view."]);
    const result = await openGroupChat({
      employeeIds: [ada.id, ben.id, cy.id],
      memberUserIds: [member.id],
      question: "Should we raise the Pro plan to $49?\nContext below.",
      maxRounds: 2,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const { channel, discussion } = result.body;
    assert.equal(channel.kind, "group");
    assert.equal(channel.name, "Should we raise the Pro plan to $49?", "named after the question");
    assert.deepEqual(
      channel.members.map((m: { name: string }) => m.name).sort(),
      ["Ada", "Ben", "Cy", "Ruth", "Sam"],
    );
    assert.equal(discussion.status, "running");
    assert.equal(discussion.rounds, 2);
    assert.equal(discussion.leadEmployeeId, ada.id);
    const d = await waitForEnd(discussion.id);
    assert.equal(d.status, "concluded");
    assert.ok(turnCalls.every((c) => c.options.requesterUserId === owner.id));
  });

  test("without a question it opens empty, under the name given", async () => {
    const result = await openGroupChat({ name: "Launch room" });
    assert.equal(result.status, 201);
    assert.equal(result.body.channel.name, "Launch room");
    assert.equal(result.body.discussion, null);
    assert.equal(await AppDataSource.getRepository(GroupDiscussion).count(), 0);
  });

  test("validates the roster: two to six AI Employees, each once", async () => {
    for (const employeeIds of [
      [ada.id],
      [ada.id, ada.id],
      Array.from({ length: 7 }, () => crypto.randomUUID()),
      ["not-a-uuid", ben.id],
    ]) {
      const result = await openGroupChat({ employeeIds });
      assert.equal(result.status, 400, JSON.stringify(employeeIds));
      assert.equal(result.body.error, "ValidationError");
    }
  });

  test("refuses unknown fields, an overlong question and rounds out of range", async () => {
    assert.equal((await openGroupChat({ autoSend: true })).status, 400);
    assert.equal((await openGroupChat({ question: "x".repeat(8_001) })).status, 400);
    assert.equal((await openGroupChat({ maxRounds: 0 })).status, 400);
    assert.equal((await openGroupChat({ maxRounds: 6 })).status, 400);
    assert.equal((await openGroupChat({ name: "n".repeat(81) })).status, 400);
  });

  test("another company's AI Employee or Member reads as not found, and nothing is written", async () => {
    const employee = await openGroupChat({ employeeIds: [ada.id, stranger.id] });
    assert.equal(employee.status, 404);
    const person = await openGroupChat({ memberUserIds: [outsider.id] });
    assert.equal(person.status, 404);
    assert.equal(await AppDataSource.getRepository(Channel).count(), 0);
  });

  test("a non-Member of the company is refused", async () => {
    actingUserId = outsider.id;
    const result = await openGroupChat();
    assert.equal(result.status, 403);
  });

  test("signed out is unauthorized", async () => {
    actingUserId = null;
    assert.equal((await openGroupChat()).status, 401);
  });
});

describe("discussions in a channel", () => {
  async function publicChannel(): Promise<Channel> {
    return insert(Channel, {
      companyId: company.id,
      kind: "public",
      name: "general",
      slug: "general",
      topic: "",
      webhookToken: null,
      createdByUserId: owner.id,
      archivedAt: null,
      lastMessageAt: null,
    });
  }

  test("POST starts one with the chosen AI Employees, who join the channel", async () => {
    const channel = await publicChannel();
    replies.set(ada.id, ["View."]);
    const result = await api("POST", `/channels/${channel.id}/discussions`, {
      question: "  How do we cut churn?  ",
      employeeIds: [ada.id, ben.id],
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.question, "How do we cut churn?");
    const joined = await AppDataSource.getRepository(ChannelMember).countBy({ channelId: channel.id, memberKind: "ai" });
    assert.equal(joined, 2);
    await waitForEnd(result.body.id);
    const list = await api("GET", `/channels/${channel.id}/discussions`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].status, "concluded");
    assert.equal(list.body[0].outcome.recommendation, "Announce Monday.");
  });

  test("a second while one runs is a conflict", async () => {
    const channel = await publicChannel();
    let release!: () => void;
    blockTurns = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await api("POST", `/channels/${channel.id}/discussions`, {
      question: "One",
      employeeIds: [ada.id, ben.id],
    });
    assert.equal(first.status, 201);
    const second = await api("POST", `/channels/${channel.id}/discussions`, {
      question: "Two",
      employeeIds: [ada.id, ben.id],
    });
    assert.equal(second.status, 409);
    release();
    await waitForEnd(first.body.id);
  });

  test("validation: a question is required, the roster is two to six", async () => {
    const channel = await publicChannel();
    assert.equal(
      (await api("POST", `/channels/${channel.id}/discussions`, { question: "  " })).status,
      400,
    );
    assert.equal(
      (await api("POST", `/channels/${channel.id}/discussions`, { question: "Q", employeeIds: [ada.id] })).status,
      400,
    );
    assert.equal(
      (await api("POST", `/channels/not-a-uuid/discussions`, { question: "Q" })).status,
      400,
    );
  });

  test("a private group chat is invisible to a Member who is not in it", async () => {
    const opened = await openGroupChat({ question: "Private matter" });
    await waitForEnd(opened.body.discussion.id);
    actingUserId = member.id;
    const channelId = opened.body.channel.id;
    assert.equal((await api("GET", `/channels/${channelId}/discussions`)).status, 404);
    assert.equal(
      (await api("POST", `/channels/${channelId}/discussions`, { question: "Peek", employeeIds: [ada.id, ben.id] }))
        .status,
      404,
    );
    assert.equal((await api("GET", `/discussions/${opened.body.discussion.id}`)).status, 404);
    assert.equal((await api("POST", `/discussions/${opened.body.discussion.id}/stop`, {})).status, 404);
  });

  test("a discussion id from another company reads as not found", async () => {
    const opened = await openGroupChat({ question: "Ours" });
    await waitForEnd(opened.body.discussion.id);
    actingUserId = outsider.id;
    const viaTheirCompany = await api(
      "GET",
      `/discussions/${opened.body.discussion.id}`,
      undefined,
      otherCompany.id,
    );
    assert.equal(viaTheirCompany.status, 404);
  });

  test("a DM refuses a discussion", async () => {
    const dm = await insert(Channel, {
      companyId: company.id,
      kind: "dm",
      name: null,
      slug: null,
      topic: "",
      webhookToken: null,
      createdByUserId: owner.id,
      archivedAt: null,
      lastMessageAt: null,
    });
    await insert(ChannelMember, { channelId: dm.id, memberKind: "user", userId: owner.id, employeeId: null, lastReadAt: null });
    const result = await api("POST", `/channels/${dm.id}/discussions`, {
      question: "Q",
      employeeIds: [ada.id, ben.id],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /group chat/);
  });
});

describe("controls", () => {
  test("GET returns the summary", async () => {
    const opened = await openGroupChat({ question: "Read me" });
    await waitForEnd(opened.body.discussion.id);
    const result = await api("GET", `/discussions/${opened.body.discussion.id}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.id, opened.body.discussion.id);
    assert.equal(result.body.status, "concluded");
    assert.deepEqual(
      result.body.participants.map((p: { slug: string }) => p.slug),
      ["ada", "ben"],
    );
  });

  test("Stop ends a running discussion; stopping again is a conflict", async () => {
    blockTurns = new Promise<void>(() => {});
    const opened = await openGroupChat({ question: "Stop me" });
    const id = opened.body.discussion.id;
    for (let i = 0; i < 300 && turnCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stopped = await api("POST", `/discussions/${id}/stop`, {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, "stopped");
    assert.equal(stopped.body.endReason, "stopped");
    const again = await api("POST", `/discussions/${id}/stop`, {});
    assert.equal(again.status, 409);
    assert.equal((await api("POST", `/discussions/${id}/stop`, { force: true })).status, 400);
  });

  test("Finish writes the outcome after the turn in flight", async () => {
    let release!: () => void;
    blockTurns = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened = await openGroupChat({ question: "Finish me" });
    const id = opened.body.discussion.id;
    for (let i = 0; i < 300 && turnCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finishing = await api("POST", `/discussions/${id}/finish`, {});
    assert.equal(finishing.status, 200);
    release();
    const d = await waitForEnd(id);
    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "wrapped_up");
    assert.equal((await api("POST", `/discussions/${id}/finish`, {})).status, 409);
  });

  test("Start the work runs the owners' turns once, and only after an outcome", async () => {
    withItems = true;
    const opened = await openGroupChat({ question: "Who does what?" });
    const id = opened.body.discussion.id;
    await waitForEnd(id);
    turnCalls = [];
    actingUserId = owner.id;
    const started = await api("POST", `/discussions/${id}/start-work`, {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.ok(started.body.followThrough);
    await settleGroupDiscussionsForTests();
    assert.deepEqual(
      turnCalls.map((c) => [c.employeeId, Boolean(c.options.collaboration)]),
      [[ben.id, false]],
    );
    assert.equal((await api("POST", `/discussions/${id}/start-work`, {})).status, 409);
  });

  test("Start the work with nothing assigned is a conflict", async () => {
    const opened = await openGroupChat({ question: "Nothing to do" });
    await waitForEnd(opened.body.discussion.id);
    const result = await api("POST", `/discussions/${opened.body.discussion.id}/start-work`, {});
    assert.equal(result.status, 409);
  });

  test("unknown discussion ids are not found; malformed ones invalid", async () => {
    const id = crypto.randomUUID();
    assert.equal((await api("GET", `/discussions/${id}`)).status, 404);
    assert.equal((await api("POST", `/discussions/${id}/stop`, {})).status, 404);
    assert.equal((await api("POST", `/discussions/${id}/finish`, {})).status, 404);
    assert.equal((await api("POST", `/discussions/${id}/start-work`, {})).status, 404);
    assert.equal((await api("GET", `/discussions/nope`)).status, 400);
  });
});

describe("posting into a group chat", () => {
  test("a Member's message there starts a discussion through the ordinary message route", async () => {
    const opened = await openGroupChat({ name: "Room" });
    const channelId = opened.body.channel.id;
    replies.set(ada.id, ["View."]);
    const posted = await api("POST", `/channels/${channelId}/messages`, { content: "Plan the launch" });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    for (let i = 0; i < 300 && (await AppDataSource.getRepository(GroupDiscussion).count()) === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [row] = await AppDataSource.getRepository(GroupDiscussion).find();
    assert.equal(row.questionMessageId, posted.body.id);
    await waitForEnd(row.id);
    const messages = await api("GET", `/channels/${channelId}/messages`);
    const roles = messages.body.map((m: { discussionRole: string | null }) => m.discussionRole);
    assert.deepEqual(roles, ["question", "turn", "outcome"]);
  });
});
