import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { turnActivityAccess } from "../../shared/turnActivityAccess.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { ChannelTurn } from "../db/entities/ChannelTurn.js";
import { Company } from "../db/entities/Company.js";
import { GroupDiscussion } from "../db/entities/GroupDiscussion.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import type { ChatOptions, ChatResult } from "./chat.js";
import { listChatActivity } from "./chatTurnActivity.js";
import { channelTurnAuthority } from "./channelTurnViews.js";
import { recoverChannelTurns, settleChannelTurnsForTests } from "./channelTurns.js";
import {
  setGroupDiscussionDepsForTests,
  settleGroupDiscussionsForTests,
  startDiscussionFollowThrough,
  startGroupDiscussion,
  stopGroupDiscussion,
} from "./groupDiscussions.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { resetModelWaitsForTests, settleModelWaitsForTests } from "./modelWaits.js";
import { stopStanddowns } from "./standdowns.js";
import { createGroupChat, getMessageSummary } from "./workspaceChat.js";

/**
 * A group discussion, as the room watches it: every speaker's turn is a
 * channel turn with its own live activity, round by round, and the message it
 * writes says how it went — as does each AI Employee's share of the work its
 * outcome started. The turn runner and outcome writer are scripted; the
 * recording is real.
 */

let company: Company;
let ruth: User;
let sam: User;
let ada: AIEmployee;
let ben: AIEmployee;
const models = new Map<string, AIModel>();

type Script = (args: {
  employeeId: string;
  onChunk: (chunk: string) => void;
  options: ChatOptions;
}) => Promise<string | Partial<ChatResult>>;

let script: Map<string, Script[]>;

function plays(employee: AIEmployee, ...turns: Script[]) {
  script.set(employee.id, [...(script.get(employee.id) ?? []), ...turns]);
}

/** A turn that looks something up, then speaks. */
function speaks(text: string): Script {
  return async ({ options, onChunk }) => {
    options.onWorkStarted?.();
    options.activity?.onToolUse?.("get_finance_report", { report: "profit_and_loss" }, "c1");
    options.activity?.onToolResult?.("get_finance_report", { content: '{"net":120000}' }, "c1");
    onChunk(text);
    return text;
  };
}

/**
 * A turn whose AI Model goes down under it, and trips the breaker as the
 * runtime does: what it had done so far is recorded, nothing is posted.
 */
function outage(employee: AIEmployee): Script {
  return async ({ options, onChunk }) => {
    options.onWorkStarted?.();
    options.activity?.onToolUse?.("get_finance_report", { report: "profit_and_loss" }, "c1");
    onChunk("Half a thought about");
    recordModelFailure(
      models.get(employee.id)!,
      modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
    );
    return {
      status: "error",
      reply: "The AI Model answered with a server error (HTTP 529).",
      unavailable: modelUnavailability("overloaded", { status: 529, code: "overloaded_error" }),
    };
  };
}

/** The AI Model answers its check again. */
async function back(employee: AIEmployee): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(models.get(employee.id)!);
  await flushModelAvailabilityWrites();
}

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  stopStanddowns();
  models.clear();
  ruth = await insert(User, {
    email: "ruth@discuss.test",
    name: "Ruth",
    handle: "ruth",
    passwordHash: "x",
    sessionVersion: 0,
  });
  sam = await insert(User, {
    email: "sam@discuss.test",
    name: "Sam",
    handle: "sam",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: ruth.id });
  await insert(Membership, { companyId: company.id, userId: ruth.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: sam.id, role: "member" });
  ada = await hire("Ada", "ada", "Head of Product");
  ben = await hire("Ben", "ben", "CFO");
  script = new Map();
  setGroupDiscussionDepsForTests({
    pollIntervalMs: 10,
    modelWaitPollMs: 15,
    heartbeatMs: 60_000,
    runTurn: async (_companyId, employeeId, _message, _history, onChunk, options) => {
      const next = script.get(employeeId)?.shift();
      const value = next ? await next({ employeeId, onChunk, options }) : "PASS";
      const base = { attachmentIds: [], sidecars: {} };
      if (typeof value === "string") return { status: "ok", reply: value, ...base } as ChatResult;
      return { status: "ok", reply: "", ...base, ...value } as ChatResult;
    },
    writeOutcome: async (args) => {
      const { resolveOutcome } = await import("./groupDiscussionPrompts.js");
      return {
        ok: true as const,
        outcome: resolveOutcome(
          {
            summary: "Raise Pro to $49.",
            recommendation: "Announce on Monday.",
            openQuestions: [],
            actionItems: [{ owner: "@ben", action: "Update the pricing page" }],
          },
          args.people,
          args.lead.id,
        ),
      };
    },
  });
});

afterEach(async () => {
  await settleGroupDiscussionsForTests();
  await settleChannelTurnsForTests();
  setGroupDiscussionDepsForTests(null);
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});

async function hire(name: string, slug: string, role: string): Promise<AIEmployee> {
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name,
    slug,
    role,
    soulBody: `${name}'s soul.`,
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: `claude-${slug}`,
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  models.set(employee.id, model);
  return employee;
}

async function discussion(maxRounds = 2) {
  const channel = await createGroupChat({
    companyId: company.id,
    createdByUserId: ruth.id,
    name: "Pricing",
    employeeIds: [ada.id, ben.id],
    memberUserIds: [sam.id],
  });
  const started = await startGroupDiscussion({
    channel,
    requester: { userId: ruth.id, sessionVersion: 0 },
    question: "Should we raise the Pro plan to $49?",
    minParticipants: 2,
    maxRounds,
  });
  return { channel, started };
}

const turnsOf = (discussionId: string) =>
  AppDataSource.getRepository(ChannelTurn).find({
    where: { discussionId },
    order: { acceptedAt: "ASC" },
  });

describe("watching a group discussion", () => {
  test("every speaker's turn is watched round by round, and its message says how it went", async () => {
    plays(ada, speaks("Margins can take it — we net $120k."), speaks("Agreed with Ben's timing."));
    plays(ben, speaks("Then announce it Monday, @ada."));
    const { started } = await discussion();
    await settleGroupDiscussionsForTests();

    const turns = await turnsOf(started.id);
    const spoken = turns.filter((turn) => turn.replyMessageId);
    assert.ok(spoken.length >= 2, "each turn that spoke is a channel turn");
    assert.ok(turns.every((turn) => turn.kind === "discussion"));
    assert.ok(
      turns.every((turn) => turn.status !== "working"),
      "every turn ended",
    );
    assert.deepEqual(
      spoken.slice(0, 2).map((turn) => [turn.employeeId, turn.round]),
      [
        [ada.id, 1],
        [ben.id, 1],
      ],
      "who spoke, in which round",
    );
    assert.ok(
      turns.every((turn) => turn.authority === "member" && turn.requesterUserId === ruth.id),
    );

    const first = spoken[0];
    const events = await listChatActivity(first.id, 0, 100);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["turn_started", "tool_use", "tool_result", "turn_finished"],
    );
    const message = await getMessageSummary(first.replyMessageId!, sam.id);
    assert.equal(message?.discussionRole, "turn");
    assert.equal(message?.aiTurn?.id, first.id);
    assert.equal(message?.aiTurn?.kind, "discussion");
    assert.equal(message?.aiTurn?.round, 1);
    assert.equal(message?.aiTurn?.activity?.steps, 1);
    // The turns run with the starter's access: she sees them in full, the
    // rest of the group chat the steps.
    assert.equal(
      turnActivityAccess({
        audience: "internal",
        authority: channelTurnAuthority(first),
        viewer: { kind: "member", userId: sam.id },
      }),
      "steps",
    );
  });

  test("a speaker who passes leaves a turn that says so, and no message", async () => {
    plays(ada, speaks("Raise it."));
    plays(ben, async ({ options }) => {
      options.onWorkStarted?.();
      return "PASS";
    });
    const { started } = await discussion();
    await settleGroupDiscussionsForTests();
    const passed = (await turnsOf(started.id)).find(
      (turn) => turn.employeeId === ben.id && !turn.replyMessageId,
    );
    assert.ok(passed, "Ben's pass is a turn");
    assert.equal(passed.status, "ok");
    const notice = (await listChatActivity(passed.id, 0, 100)).find((e) => e.kind === "notice");
    assert.equal(notice?.name, "passed");
    assert.equal(notice?.summary, "Had nothing to add this round");
  });

  test("Stop cuts the speaker's turn short, and its record says who stopped it", async () => {
    plays(ada, async ({ options, onChunk }) => {
      options.onWorkStarted?.();
      onChunk("Let me think about the annual plans");
      for (let i = 0; i < 400 && !options.signal?.aborted; i += 1) await delay(5);
      return "Unfinished.";
    });
    const { started } = await discussion();
    const speaking = await (async () => {
      for (let i = 0; i < 400; i += 1) {
        const [turn] = await turnsOf(started.id);
        if (turn && (await listChatActivity(turn.id, 0, 10)).length > 0) return turn;
        await delay(10);
      }
      throw new Error("Ada never started");
    })();
    await stopGroupDiscussion({ companyId: company.id, discussionId: started.id, userId: sam.id });
    await settleGroupDiscussionsForTests();
    const stopped = await AppDataSource.getRepository(ChannelTurn).findOneByOrFail({
      id: speaking.id,
    });
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.replyMessageId, null, "the half-written turn is dropped");
    const events = await listChatActivity(stopped.id, 0, 100);
    assert.equal(events.find((e) => e.kind === "stopped")?.summary, "Stopped by Sam");
    assert.equal(events.at(-1)?.kind, "turn_finished");
  });

  test("each AI Employee's share of the work its outcome started is watched too", async () => {
    plays(ada, speaks("Raise it."));
    plays(ben, speaks("Agreed."), speaks("I updated the pricing page draft."));
    const { started } = await discussion(1);
    await settleGroupDiscussionsForTests();
    const concluded = await AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({
      id: started.id,
    });
    assert.equal(concluded.status, "concluded");
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: started.id,
      requester: { userId: sam.id, sessionVersion: 0 },
    });
    await settleGroupDiscussionsForTests();
    const share = (await turnsOf(started.id)).find((turn) => turn.kind === "follow_through");
    assert.ok(share, "the share is a channel turn");
    assert.equal(share.employeeId, ben.id);
    assert.equal(share.status, "ok");
    assert.equal(share.requesterUserId, sam.id, "under the Member who pressed Start the work");
    const message = await AppDataSource.getRepository(ChannelMessage).findOneByOrFail({
      id: share.replyMessageId!,
    });
    assert.equal(message.discussionRole, "follow_through");
    assert.equal(message.content, "I updated the pricing page draft.");
  });

  test("a turn whose driver died with its process is closed, saying so", async () => {
    const { channel } = await discussion();
    await settleGroupDiscussionsForTests();
    const orphan = await insert(ChannelTurn, {
      companyId: company.id,
      channelId: channel.id,
      employeeId: ada.id,
      kind: "discussion",
      discussionId: "gone",
      round: 2,
      authority: "member",
      requesterUserId: ruth.id,
      requesterSessionVersion: 0,
      status: "working",
      workerId: "a-driver-that-died",
      leaseExpiresAt: new Date(Date.now() - 1_000),
      attempt: 1,
      acceptedAt: new Date(Date.now() - 120_000),
    } as never);
    await recoverChannelTurns();
    const closed = await AppDataSource.getRepository(ChannelTurn).findOneByOrFail({
      id: orphan.id,
    });
    assert.equal(closed.status, "interrupted");
    const notice = (await listChatActivity(orphan.id, 0, 10)).find((e) => e.kind === "notice");
    assert.equal(notice?.summary, "The server restarted before this turn finished");
  });
});

describe("watching a group discussion through an AI Model outage", () => {
  test("a speaker's turn the outage cuts short ends saying so, and the retaken turn is watched afresh", async () => {
    plays(ada, outage(ada), speaks("Raise it to $49 — usage doubled."));
    plays(ben, speaks("Margins can take it."));
    const { started } = await discussion(1);
    const cut = await (async () => {
      for (let i = 0; i < 600; i += 1) {
        const turn = (await turnsOf(started.id)).find(
          (t) => t.employeeId === ada.id && t.status !== "working",
        );
        if (turn) return turn;
        await delay(10);
      }
      throw new Error("Ada's cut-short turn never ended");
    })();
    // Never left on the room's screen as working, nor posted half-written.
    assert.equal(cut.status, "interrupted");
    assert.equal(cut.replyMessageId, null);
    const events = await listChatActivity(cut.id, 0, 100);
    assert.equal(
      events.find((e) => e.kind === "notice" && e.name === "model_unavailable")?.summary,
      "The AI Model became unavailable; this turn is taken again once it is back",
    );
    assert.ok(
      events.some((e) => e.kind === "tool_use"),
      "what it did before is kept",
    );
    assert.equal(
      events.find((e) => e.kind === "stopped"),
      undefined,
      "nobody stopped it",
    );
    assert.equal(events.at(-1)?.kind, "turn_finished");

    await back(ada);
    await settleGroupDiscussionsForTests();
    const adaTurns = (await turnsOf(started.id)).filter((t) => t.employeeId === ada.id);
    assert.equal(adaTurns.length, 2, "the retaken turn is a turn of its own");
    assert.equal(adaTurns[1].status, "ok");
    const message = await AppDataSource.getRepository(ChannelMessage).findOneByOrFail({
      id: adaTurns[1].replyMessageId!,
    });
    assert.equal(message.content, "Raise it to $49 — usage doubled.");
    assert.ok((await turnsOf(started.id)).every((t) => t.status !== "working"));
  });

  test("a share of the work the outage cuts short ends saying so, and its restart is watched afresh", async () => {
    plays(ada, speaks("Raise it."));
    plays(ben, speaks("Margins can take it."), outage(ben), speaks("I updated the pricing page."));
    const { started } = await discussion(1);
    await settleGroupDiscussionsForTests();
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: started.id,
      requester: { userId: sam.id, sessionVersion: 0 },
    });
    await settleGroupDiscussionsForTests();
    const [cut] = (await turnsOf(started.id)).filter((t) => t.kind === "follow_through");
    assert.ok(cut, "the share's first attempt is a turn");
    assert.equal(cut.status, "interrupted");
    assert.equal(cut.replyMessageId, null, "nothing half-done is posted");
    assert.equal(
      (await listChatActivity(cut.id, 0, 100)).find(
        (e) => e.kind === "notice" && e.name === "model_unavailable",
      )?.summary,
      "The AI Model became unavailable; this work starts again once it is back",
    );

    await back(ben);
    await settleModelWaitsForTests();
    await settleGroupDiscussionsForTests();
    const shares = (await turnsOf(started.id)).filter((t) => t.kind === "follow_through");
    assert.equal(shares.length, 2, "the restart is a turn of its own");
    assert.equal(shares[1].status, "ok");
    assert.equal(
      shares[1].requesterUserId,
      sam.id,
      "still under the Member who pressed Start the work",
    );
    const message = await AppDataSource.getRepository(ChannelMessage).findOneByOrFail({
      id: shares[1].replyMessageId!,
    });
    assert.equal(message.content, "I updated the pricing page.");
    assert.equal(message.discussionRole, "follow_through");
  });
});
