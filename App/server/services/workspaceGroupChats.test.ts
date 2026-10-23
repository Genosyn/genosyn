import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { getChannelWebhookSettings } from "./channelWebhooks.js";
import { setGroupDiscussionDepsForTests, settleGroupDiscussionsForTests } from "./groupDiscussions.js";
import {
  AI_MENTION_CHAIN_LIMIT,
  PAUSED_MENTION_CHAIN_NOTE,
  aiMentionChainLength,
  createGroupChat,
  groupChatNameFromQuestion,
  listChannelsForUser,
  postIncomingWebhookMessage,
  postMessage,
  renameChannel,
} from "./workspaceChat.js";

/**
 * Group chats as Workspace channels, and the two guards this change added to
 * every channel: an AI-to-AI @mention chain pauses until a Member writes, and
 * a reply to a tainted message is tainted too.
 *
 * Group discussions themselves have their own suite (`groupDiscussions.test`);
 * here the discussion runner is stubbed to pass, so a Member's message in a
 * group chat stays cheap.
 */

let company: Company;
let other: Company;
let owner: User;
let sam: User;
let outsider: User;
let ada: AIEmployee;
let ben: AIEmployee;
let tempDir = "";
const originalDataDir = config.dataDir;

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-group-chats-"));
  (config as { dataDir: string }).dataDir = tempDir;
});

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, { email: "ruth@example.test", name: "Ruth", handle: "ruth", passwordHash: "x" });
  sam = await insert(User, { email: "sam@example.test", name: "Sam", handle: "sam", passwordHash: "x" });
  outsider = await insert(User, { email: "o@example.test", name: "Olive", passwordHash: "x" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  other = await insert(Company, { name: "Other", slug: "other", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: sam.id, role: "member" });
  await insert(Membership, { companyId: other.id, userId: outsider.id, role: "owner" });
  ada = await insert(AIEmployee, { companyId: company.id, name: "Ada", slug: "ada", role: "Analyst", soulBody: "" });
  ben = await insert(AIEmployee, { companyId: company.id, name: "Ben", slug: "ben", role: "CFO", soulBody: "" });
  setGroupDiscussionDepsForTests({
    pollIntervalMs: 10,
    runTurn: async () => ({ status: "ok", reply: "PASS", attachmentIds: [], sidecars: {} }),
    writeOutcome: async () => ({ ok: false, error: "not under test here" }),
  });
});

afterEach(async () => {
  await settleGroupDiscussionsForTests();
  setGroupDiscussionDepsForTests(null);
});

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("opening a group chat", () => {
  test("seats the Member, the other Members and the AI Employees, privately", async () => {
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "  Pricing review  ",
      employeeIds: [ada.id, ben.id, ada.id],
      memberUserIds: [sam.id, owner.id],
    });
    assert.equal(chat.kind, "group");
    assert.equal(chat.name, "Pricing review");
    assert.equal(chat.slug, null, "a group chat never takes a channel's name");
    const members = await AppDataSource.getRepository(ChannelMember).find({ where: { channelId: chat.id } });
    assert.deepEqual(
      members.map((m) => m.userId ?? m.employeeId).sort(),
      [owner.id, sam.id, ada.id, ben.id].sort(),
      "everyone once",
    );
    const creator = members.find((m) => m.userId === owner.id)!;
    assert.ok(creator.lastReadAt, "the creator has read their own empty room");
    assert.equal(members.find((m) => m.userId === sam.id)!.lastReadAt, null);
  });

  test("no name is fine: the sidebar falls back to the members", async () => {
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "   ",
      employeeIds: [ada.id, ben.id],
      memberUserIds: [],
    });
    assert.equal(chat.name, null);
    const second = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: null,
      employeeIds: [ada.id, ben.id],
      memberUserIds: [],
    });
    assert.notEqual(second.id, chat.id, "two group chats with the same people are two chats");
  });

  test("nobody from another company can be seated, and nothing is written", async () => {
    const stranger = await insert(AIEmployee, { companyId: other.id, name: "X", slug: "x", role: "R", soulBody: "" });
    await assert.rejects(
      createGroupChat({
        companyId: company.id,
        createdByUserId: owner.id,
        name: "Leak",
        employeeIds: [ada.id, stranger.id],
        memberUserIds: [],
      }),
      /Employee not found/,
    );
    await assert.rejects(
      createGroupChat({
        companyId: company.id,
        createdByUserId: owner.id,
        name: "Leak",
        employeeIds: [ada.id, ben.id],
        memberUserIds: [outsider.id],
      }),
      /User not found/,
    );
    assert.equal(await AppDataSource.getRepository(Channel).count(), 0);
  });

  test("is listed only for the people in it", async () => {
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "Secret plan",
      employeeIds: [ada.id, ben.id],
      memberUserIds: [],
    });
    const forOwner = await listChannelsForUser(company.id, owner.id);
    const forSam = await listChannelsForUser(company.id, sam.id);
    assert.deepEqual(forOwner.map((c) => c.id), [chat.id]);
    assert.equal(forOwner[0].kind, "group");
    assert.deepEqual(
      forOwner[0].members.map((m) => m.name).sort(),
      ["Ada", "Ben", "Ruth"],
    );
    assert.deepEqual(forSam, []);
  });

  test("renaming keeps no slug, and clearing the name falls back to members", async () => {
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "Old",
      employeeIds: [ada.id, ben.id],
      memberUserIds: [],
    });
    const renamed = await renameChannel({ channelId: chat.id, name: "New name" });
    assert.equal(renamed.name, "New name");
    assert.equal(renamed.slug, null);
    const cleared = await renameChannel({ channelId: chat.id, name: "" });
    assert.equal(cleared.name, null);
  });

  test("takes no incoming webhook", async () => {
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "Hooks",
      employeeIds: [ada.id, ben.id],
      memberUserIds: [],
    });
    await assert.rejects(getChannelWebhookSettings(company.id, chat.id), /Channel not found/);
    await assert.rejects(
      postIncomingWebhookMessage({ channel: chat, authorName: "Bot", content: "hi" }),
      /Channel not found/,
    );
  });

  test("every Member in it hears about a Member's message, like a DM", async () => {
    const chat = await createGroupChat({
      companyId: company.id,
      createdByUserId: owner.id,
      name: "Launch",
      employeeIds: [ada.id, ben.id],
      memberUserIds: [sam.id],
    });
    await postMessage({
      channelId: chat.id,
      companyId: company.id,
      author: { kind: "user", userId: owner.id },
      requesterSessionVersion: 0,
      content: "Kicking this off.",
    });
    await waitFor(
      async () => (await AppDataSource.getRepository(Notification).countBy({ kind: "mention" })) > 0,
      "the bell",
    );
    const bells = await AppDataSource.getRepository(Notification).findBy({ kind: "mention" });
    assert.deepEqual(bells.map((b) => b.userId), [sam.id], "not the author");
    assert.equal(bells[0].title, "Ruth wrote in the group chat “Launch”");
  });
});

describe("naming a group chat after its question", () => {
  test("takes the first line, without markdown", () => {
    assert.equal(groupChatNameFromQuestion("## Pricing for Q3\nmore detail"), "Pricing for Q3");
    assert.equal(groupChatNameFromQuestion("\n\n  **Hiring plan**  "), "Hiring plan");
  });

  test("cuts a long first line at a word", () => {
    const name = groupChatNameFromQuestion(
      "Should we move the whole support team to a follow-the-sun rota before the APAC launch next quarter?",
    );
    assert.ok(name);
    assert.ok(name.length <= 61);
    assert.ok(name.endsWith("…"));
    assert.doesNotMatch(name, /\s…$/);
  });

  test("a question with no words names nothing", () => {
    assert.equal(groupChatNameFromQuestion("   \n  "), null);
    assert.equal(groupChatNameFromQuestion("**"), null);
  });
});

describe("the AI @mention chain guard", () => {
  async function channelWith(employees: AIEmployee[]) {
    const channel = await insert(Channel, {
      companyId: company.id,
      kind: "public",
      name: "ops",
      slug: "ops",
      topic: "",
      webhookToken: null,
      createdByUserId: owner.id,
      archivedAt: null,
      lastMessageAt: null,
    });
    for (const e of employees) {
      await insert(ChannelMember, { channelId: channel.id, memberKind: "ai", userId: null, employeeId: e.id, lastReadAt: null });
    }
    return channel;
  }

  async function aiPosts(channel: Channel, n: number, at = Date.now() - 60_000) {
    for (let i = 0; i < n; i += 1) {
      await insert(ChannelMessage, {
        channelId: channel.id,
        authorKind: "ai",
        authorEmployeeId: i % 2 ? ben.id : ada.id,
        content: `exchange ${i}`,
        createdAt: new Date(at + i * 1000),
      } as never);
    }
  }

  const replies = (channel: Channel) =>
    AppDataSource.getRepository(ChannelMessage).count({
      where: { channelId: channel.id, authorKind: "ai", authorEmployeeId: ben.id },
    });

  test("counts AI messages back to the last Member message, skipping discussions", async () => {
    const channel = await channelWith([ada, ben]);
    await insert(ChannelMessage, {
      channelId: channel.id,
      authorKind: "user",
      authorUserId: owner.id,
      content: "start",
      createdAt: new Date(Date.now() - 120_000),
    } as never);
    await aiPosts(channel, 3);
    await insert(ChannelMessage, {
      channelId: channel.id,
      authorKind: "ai",
      authorEmployeeId: ada.id,
      content: "a discussion turn",
      discussionId: "d1",
      discussionRole: "turn",
      createdAt: new Date(),
    } as never);
    const last = await AppDataSource.getRepository(ChannelMessage).findOneOrFail({
      where: { channelId: channel.id },
      order: { createdAt: "DESC" },
    });
    assert.equal(await aiMentionChainLength(channel.id, last), 3);
  });

  test("below the limit an AI's @mention still gets its colleague's reply", async () => {
    const channel = await channelWith([ada, ben]);
    await postMessage({
      channelId: channel.id,
      companyId: company.id,
      author: { kind: "ai", employeeId: ada.id },
      content: "@ben can you check the invoice totals?",
    });
    // Ben has no AI Model here, so the reply he is asked for says so — which
    // is what shows the reply was attempted.
    await waitFor(async () => (await replies(channel)) === 1, "Ben's reply");
  });

  test("past the limit the mention starts nothing, and one note says why", async () => {
    const channel = await channelWith([ada, ben]);
    await aiPosts(channel, AI_MENTION_CHAIN_LIMIT);
    const before = await replies(channel);
    for (const content of ["@ben again please", "@ben are you there?"]) {
      await postMessage({
        channelId: channel.id,
        companyId: company.id,
        author: { kind: "ai", employeeId: ada.id },
        content,
      });
    }
    await waitFor(
      async () =>
        (await AppDataSource.getRepository(ChannelMessage).count({
          where: { channelId: channel.id, content: PAUSED_MENTION_CHAIN_NOTE },
        })) === 1,
      "the pause note",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await replies(channel), before, "no reply turn ran");
    assert.equal(
      await AppDataSource.getRepository(ChannelMessage).count({
        where: { channelId: channel.id, content: PAUSED_MENTION_CHAIN_NOTE },
      }),
      1,
      "one note per pause, however often they keep posting",
    );
  });

  test("a Member writing resets the chain", async () => {
    const channel = await channelWith([ada, ben]);
    await aiPosts(channel, AI_MENTION_CHAIN_LIMIT + 2);
    await insert(ChannelMessage, {
      channelId: channel.id,
      authorKind: "user",
      authorUserId: owner.id,
      content: "carry on",
      createdAt: new Date(Date.now() - 1_000),
    } as never);
    await postMessage({
      channelId: channel.id,
      companyId: company.id,
      author: { kind: "ai", employeeId: ada.id },
      content: "@ben over to you",
    });
    await waitFor(async () => (await replies(channel)) > (AI_MENTION_CHAIN_LIMIT + 2) / 2, "Ben's reply");
  });
});

describe("taint through a channel", () => {
  test("a reply to a tainted message is tainted, and to a clean one is not", async (t) => {
    await insert(AIModel, {
      employeeId: ben.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
    const run = agentRuntime.run;
    t.mock.method(agentRuntime, "run", (async () => ({
      finalText: "Noted.",
      steps: 1,
      stopReason: "end_turn",
    })) as unknown as typeof run);

    async function replyTo(tainted: boolean): Promise<ChannelMessage> {
      const channel = await insert(Channel, {
        companyId: company.id,
        kind: "public",
        name: `c-${tainted}`,
        slug: `c-${tainted}`,
        topic: "",
        webhookToken: null,
        createdByUserId: owner.id,
        archivedAt: null,
        lastMessageAt: null,
      });
      await insert(ChannelMember, { channelId: channel.id, memberKind: "ai", userId: null, employeeId: ben.id, lastReadAt: null });
      await postMessage({
        channelId: channel.id,
        companyId: company.id,
        author: { kind: "ai", employeeId: ada.id },
        content: "@ben their pricing page says $59",
        tainted,
      });
      let reply: ChannelMessage | null = null;
      await waitFor(async () => {
        reply = await AppDataSource.getRepository(ChannelMessage).findOneBy({
          channelId: channel.id,
          authorEmployeeId: ben.id,
        });
        return reply !== null;
      }, "Ben's reply");
      return reply!;
    }

    const fromTainted = await replyTo(true);
    assert.equal(fromTainted.content, "Noted.");
    assert.equal(fromTainted.tainted, true, "Ben replayed what a page said");
    const fromClean = await replyTo(false);
    assert.equal(fromClean.tainted, false);
  });
});
