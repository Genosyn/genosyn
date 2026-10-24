import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeNotebookGrant } from "../db/entities/EmployeeNotebookGrant.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import type { ChatOptions, ChatResult } from "../services/chat.js";
import { setColleagueConsultRunnerForTests } from "../services/colleagueConsult.js";
import { isTokenTainted, issueMcpToken, markTokenTainted, revokeMcpToken } from "../services/mcpTokens.js";
import { placeStanddown, stopStanddowns } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { detachAllModels, insertEmployeeModel } from "../test/modelFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The MCP seam for talking turns, and `ask_colleague` through it.
 *
 * A turn in a group discussion, or one answering a colleague's question,
 * carries `collaboration` on its token. Whatever the model asks for, the seam
 * lets reads through and refuses everything else — so a discussion cannot
 * send, write, delegate or ask a third colleague, however its prompt is
 * steered. And each employee still reads only what its own Grants open.
 */

let server: Server;
let baseUrl: string;
const originalPort = config.port;
const tokens: string[] = [];
let company: Company;
let owner: User;
let ada: AIEmployee;
let ben: AIEmployee;

type ConsultCall = { employeeId: string; message: string; options: ChatOptions };
let consultCalls: ConsultCall[];
let consultReply: Partial<ChatResult>;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  stopStanddowns();
  owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  ben = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ben",
    slug: "ben",
    role: "CFO",
    soulBody: "",
  });
  for (const e of [ada, ben]) {
    await insertEmployeeModel({
      employeeId: e.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
  }
  consultCalls = [];
  consultReply = { status: "ok", reply: "Gross margin is 71%." };
  setColleagueConsultRunnerForTests(async (_companyId, employeeId, message, _history, _onChunk, options) => {
    consultCalls.push({ employeeId, message, options });
    return { attachmentIds: [], sidecars: {}, status: "ok", reply: "", ...consultReply } as ChatResult;
  });
});

afterEach(() => {
  for (const t of tokens.splice(0)) revokeMcpToken(t);
  setColleagueConsultRunnerForTests(null);
  stopStanddowns();
});

function token(
  employee: AIEmployee,
  origin: Parameters<typeof issueMcpToken>[2] = { authority: "employee" },
): string {
  const t = issueMcpToken(employee.id, company.id, origin);
  tokens.push(t);
  return t;
}

function talking(employee: AIEmployee, kind: "discussion" | "consult" = "discussion") {
  return token(employee, { authority: "employee", collaboration: { kind, id: "d-1" } });
}

async function call(bearer: string, path: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("a talking turn at the seam", () => {
  test("reads go through, as the employee the token was minted for", async () => {
    const asBen = await call(talking(ben), "/tools/get_self");
    assert.equal(asBen.status, 200, JSON.stringify(asBen.body));
    assert.match(JSON.stringify(asBen.body), /"Ben"/);
    assert.doesNotMatch(JSON.stringify(asBen.body), /"Ada"/);
  });

  test("writes, delivery, delegation and a third colleague are all refused", async () => {
    const t = talking(ada);
    for (const tool of [
      "send_workspace_message",
      "create_routine",
      "send_mail",
      "create_handoff",
      "ask_colleague",
      "add_memory",
      "request_decision",
      "create_todo",
    ]) {
      const result = await call(t, `/tools/${tool}`, {});
      assert.equal(result.status, 403, tool);
      assert.match(result.body.error, /can read, not act/, tool);
    }
  });

  test("the refusal is case- and slash-proof", async () => {
    const t = talking(ada);
    for (const path of ["/tools/SEND_MAIL", "/tools/send_mail/", "/TOOLS/send_mail"]) {
      const result = await call(t, path, {});
      assert.equal(result.status, 403, path);
    }
  });

  test("external Connections are invisible and unreachable", async () => {
    const t = talking(ada);
    const listed = await call(t, "/integrations/_list");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { tools: [] });
    const invoked = await call(t, "/integrations/invoke", { tool: "stripe_refund", args: {} });
    assert.equal(invoked.status, 403);
  });

  test("a consult turn is refused the same way, in its own words", async () => {
    const result = await call(talking(ben, "consult"), "/tools/create_routine", {});
    assert.equal(result.status, 403);
    assert.match(result.body.error, /answering a colleague/);
  });

  test("each employee reads only what its own Grants open — nobody borrows another's", async () => {
    const notebook = await insert(Notebook, {
      companyId: company.id,
      title: "Finance",
      slug: "finance",
      icon: "",
      sortOrder: 0,
    });
    await insert(Note, {
      companyId: company.id,
      notebookId: notebook.id,
      title: "Q3 margins",
      slug: "q3-margins",
      body: "Gross margin 71%",
      icon: "",
      parentId: null,
      sortOrder: 0,
    });
    await insert(EmployeeNotebookGrant, {
      employeeId: ben.id,
      notebookId: notebook.id,
      accessLevel: "read",
    });
    const asBen = await call(talking(ben), "/tools/list_notes", {});
    const asAda = await call(talking(ada), "/tools/list_notes", {});
    assert.equal(asBen.status, 200);
    assert.equal(asAda.status, 200);
    assert.match(JSON.stringify(asBen.body), /Q3 margins/);
    assert.doesNotMatch(JSON.stringify(asAda.body), /Q3 margins/, "Ada holds no Grant on it");
  });

  test("an ordinary turn is not narrowed", async () => {
    const result = await call(token(ada), "/tools/list_handoffs", {});
    assert.equal(result.status, 200);
  });
});

describe("ask_colleague", () => {
  test("asks the colleague in a read-only consult turn and returns the answer", async () => {
    const asker = token(ada);
    const result = await call(asker, "/tools/ask_colleague", {
      colleague: "ben",
      question: "What is our gross margin?",
      context: "I am drafting the pricing memo.",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.answer, "Gross margin is 71%.");
    assert.equal(result.body.colleague.slug, "ben");

    assert.equal(consultCalls.length, 1);
    const [consult] = consultCalls;
    assert.equal(consult.employeeId, ben.id, "the colleague answers as itself");
    assert.equal(consult.options.collaboration?.kind, "consult");
    assert.equal(consult.options.toolAuthority, "employee");
    assert.equal(consult.options.startTainted, false);
    assert.match(consult.message, /Ada \(@ada, Analyst\) asks you/);
    assert.match(consult.message, /What is our gross margin\?/);
    assert.match(consult.message, /I am drafting the pricing memo\./);
    assert.match(consult.options.extraSystem ?? "", /cannot ask anyone else/);

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "colleague.ask",
    });
    assert.equal(audit.actorEmployeeId, ada.id);
    assert.equal(audit.targetId, ben.id);
    const journals = await AppDataSource.getRepository(JournalEntry).find();
    assert.deepEqual(
      journals.map((j) => [j.employeeId, j.title]).sort(),
      [
        [ada.id, "Asked Ben: What is our gross margin?"],
        [ben.id, "Answered a question from Ada"],
      ].sort(),
    );
  });

  test("under a Member's turn the answer runs under that same Member", async () => {
    const asker = token(ada, {
      authority: "member",
      requesterUserId: owner.id,
      requesterSessionVersion: 0,
    });
    const result = await call(asker, "/tools/ask_colleague", { colleague: ben.id, question: "Margin?" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(consultCalls[0].options.requesterUserId, owner.id);
    assert.equal(consultCalls[0].options.requesterSessionVersion, 0);
    assert.equal(consultCalls[0].options.toolAuthority, undefined);
  });

  test("taint travels both ways", async () => {
    const tainted = token(ada);
    markTokenTainted(tainted);
    await call(tainted, "/tools/ask_colleague", { colleague: "ben", question: "Check this page's claim" });
    assert.equal(consultCalls[0].options.startTainted, true, "a tainted question taints the answer");

    const clean = token(ada);
    consultReply = { status: "ok", reply: "Their site says $59.", tainted: true };
    await call(clean, "/tools/ask_colleague", { colleague: "ben", question: "Competitor price?" });
    assert.equal(isTokenTainted(clean), true, "an answer that read a page taints the asker");
  });

  test("three per turn, counted before the colleague runs", async () => {
    const asker = token(ada);
    consultReply = { status: "error", reply: "The AI Model request failed." };
    for (let i = 0; i < 3; i += 1) {
      const result = await call(asker, "/tools/ask_colleague", { colleague: "ben", question: `Q${i}` });
      assert.equal(result.status, 502);
      assert.match(result.body.error, /Ben couldn't answer: The AI Model request failed\./);
    }
    const fourth = await call(asker, "/tools/ask_colleague", { colleague: "ben", question: "Q4" });
    assert.equal(fourth.status, 429);
    assert.match(fourth.body.error, /already asked colleagues 3 times/);
    assert.equal(consultCalls.length, 3, "the fourth never reached Ben");
    const fresh = await call(token(ada), "/tools/ask_colleague", { colleague: "ben", question: "New turn" });
    assert.equal(fresh.status, 502, "the cap is per turn, not per employee");
  });

  test("cannot ask yourself, an unknown colleague, or one of another company", async () => {
    const asker = token(ada);
    const self = await call(asker, "/tools/ask_colleague", { colleague: "ada", question: "Me?" });
    assert.equal(self.status, 400);
    const unknown = await call(asker, "/tools/ask_colleague", { colleague: "nobody", question: "Hi" });
    assert.equal(unknown.status, 404);
    const otherCompany = await insert(Company, { name: "O", slug: "o", ownerId: owner.id });
    const stranger = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Stranger",
      slug: "stranger",
      role: "R",
      soulBody: "",
    });
    const foreign = await call(asker, "/tools/ask_colleague", { colleague: stranger.id, question: "Hi" });
    assert.equal(foreign.status, 404);
    assert.equal(consultCalls.length, 0);
  });

  test("a stood-down colleague, or one with no AI Model, is not asked", async () => {
    await placeStanddown({ companyId: company.id, scope: "employee", scopeId: ben.id, reason: "Audit" });
    const stood = await call(token(ada), "/tools/ask_colleague", { colleague: "ben", question: "Hi" });
    assert.equal(stood.status, 409);
    assert.match(stood.body.error, /Ben is stood down.*Audit/);
    stopStanddowns();
    await detachAllModels(ben.id);
    const noModel = await call(token(ada), "/tools/ask_colleague", { colleague: "ben", question: "Hi" });
    assert.equal(noModel.status, 409);
    assert.match(noModel.body.error, /no AI Model connected/);
    assert.equal(consultCalls.length, 0);
  });

  test("validation refuses an empty question and unknown fields", async () => {
    const asker = token(ada);
    const empty = await call(asker, "/tools/ask_colleague", { colleague: "ben", question: "   " });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "ValidationError");
    const extra = await call(asker, "/tools/ask_colleague", {
      colleague: "ben",
      question: "Hi",
      act: true,
    });
    assert.equal(extra.status, 400);
    const long = await call(asker, "/tools/ask_colleague", {
      colleague: "ben",
      question: "x".repeat(4_001),
    });
    assert.equal(long.status, 400);
  });

  test("a long answer is clipped to what the asking turn can hold", async () => {
    consultReply = { status: "ok", reply: "y".repeat(9_000) };
    const result = await call(token(ada), "/tools/ask_colleague", { colleague: "ben", question: "Long?" });
    assert.equal(result.status, 200);
    assert.ok(result.body.answer.length <= 8_001);
    assert.ok(result.body.answer.endsWith("…"));
  });
});

describe("send_workspace_message and group chats", () => {
  async function groupChatWith(members: AIEmployee[]) {
    const channel = await insert(Channel, {
      companyId: company.id,
      kind: "group",
      name: "Pricing",
      slug: null,
      topic: "",
      webhookToken: null,
      createdByUserId: owner.id,
      archivedAt: null,
      lastMessageAt: null,
    });
    await insert(ChannelMember, {
      channelId: channel.id,
      memberKind: "user",
      userId: owner.id,
      employeeId: null,
      lastReadAt: null,
    });
    for (const e of members) {
      await insert(ChannelMember, {
        channelId: channel.id,
        memberKind: "ai",
        userId: null,
        employeeId: e.id,
        lastReadAt: null,
      });
    }
    return channel;
  }

  test("an AI Employee outside a group chat cannot post into it, or join it by posting", async () => {
    const channel = await groupChatWith([ben]);
    const result = await call(token(ada), "/tools/send_workspace_message", {
      channel: channel.id,
      content: "Hello",
    });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /Not a member of this group chat/);
    const joined = await AppDataSource.getRepository(ChannelMember).countBy({
      channelId: channel.id,
      employeeId: ada.id,
    });
    assert.equal(joined, 0);
  });

  test("a member AI Employee posts, and a tainted turn's post is stamped tainted", async () => {
    const channel = await groupChatWith([ada]);
    const t = token(ada);
    markTokenTainted(t);
    const result = await call(t, "/tools/send_workspace_message", {
      channel: channel.id,
      content: "Their pricing page says $59.",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const row = await AppDataSource.getRepository(ChannelMessage).findOneByOrFail({
      id: result.body.message.id,
    });
    assert.equal(row.tainted, true);
  });

  test("an AI Employee cannot rename or archive a group chat", async () => {
    const channel = await groupChatWith([ada]);
    const renamed = await call(token(ada), "/tools/rename_workspace_channel", {
      channel: channel.id,
      name: "Mine now",
    });
    assert.equal(renamed.status, 400);
    assert.match(renamed.body.error, /belongs to the Members in it/);
    const archived = await call(token(ada), "/tools/archive_workspace_channel", {
      channel: channel.id,
    });
    assert.equal(archived.status, 400);
    const fresh = await AppDataSource.getRepository(Channel).findOneByOrFail({ id: channel.id });
    assert.equal(fresh.name, "Pricing");
    assert.equal(fresh.archivedAt, null);
  });
});
