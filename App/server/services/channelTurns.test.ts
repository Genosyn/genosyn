import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { config } from "../../config.js";
import {
  MODEL_RESUMING_WAIT_CAUSE,
  MODEL_UNAVAILABLE_WAIT_CAUSE,
} from "../../shared/chatActivity.js";
import { turnActivityAccess } from "../../shared/turnActivityAccess.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { ChannelTurn } from "../db/entities/ChannelTurn.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { attachExistingModel, insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import { openCodeError } from "./agent/opencodeEvents.js";
import { agentRuntime } from "./agent/runtime.js";
import { CHAT_HARD_TIMEOUT_MS, INTERRUPTED_BEFORE_REPLY } from "./chat.js";
import { listChatActivity } from "./chatTurnActivity.js";
import { channelTurnAuthority } from "./channelTurnViews.js";
import {
  bootChannelTurnRecovery,
  ChannelTurnError,
  executeChannelTurn,
  interruptChannelTurn,
  recoverChannelTurns,
  retryChannelTurn,
  settleChannelTurnsForTests,
  stopChannelTurnRecovery,
} from "./channelTurns.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { waitingWorkByModel } from "./modelOutageViews.js";
import { placeStanddown, refreshStanddowns } from "./standdowns.js";
import {
  AI_MENTION_CHAIN_LIMIT,
  PAUSED_MENTION_CHAIN_NOTE,
  getMessageSummary,
  postIncomingWebhookMessage,
  postMessage,
} from "./workspaceChat.js";

/**
 * An AI Employee's reply in a Workspace channel, as a turn the room watches.
 *
 * The bar: the room sees each reply work — its steps recorded with the chat
 * feed's redaction, the reply carrying "Worked for…" — several replies run at
 * once, an AI colleague's @mention and a webhook's run under their own
 * authority with the chain guard intact, a second reply of the same employee
 * waits its turn, Stop keeps what was written and says who, a failed reply
 * can be asked again, and a restart hands a reply on rather than losing it.
 * While its AI Model is unavailable a reply never fails: it waits, saying so,
 * and is answered when the model is back — one at a time — unless someone
 * stops it or a Standdown lands first.
 */

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];

let company: Company;
let ruth: User;
let sam: User;
let ada: AIEmployee;
let ben: AIEmployee;
let adaModel: AIModel;
let ops: Channel;
let tempDir = "";
const originalDataDir = config.dataDir;

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-channel-turns-"));
  (config as { dataDir: string }).dataDir = tempDir;
});

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
  await closeTestDb();
});

beforeEach(async () => {
  resetModelAvailabilityForTests();
  await resetTestDb();
  await refreshStanddowns();
  ruth = await insert(User, {
    email: "ruth@turns.test",
    name: "Ruth",
    handle: "ruth",
    passwordHash: "x",
    sessionVersion: 0,
  });
  sam = await insert(User, {
    email: "sam@turns.test",
    name: "Sam",
    handle: "sam",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: ruth.id });
  await insert(Membership, { companyId: company.id, userId: ruth.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: sam.id, role: "member" });
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
  adaModel = await insertEmployeeModel({
    employeeId: ada.id,
    provider: "anthropic",
    model: "claude-sonnet-4",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  ops = await insert(Channel, {
    companyId: company.id,
    kind: "public",
    name: "ops",
    slug: "ops",
    topic: "",
    webhookToken: null,
    createdByUserId: ruth.id,
    archivedAt: null,
    lastMessageAt: null,
  });
  for (const employee of [ada, ben]) {
    await insert(ChannelMember, {
      channelId: ops.id,
      memberKind: "ai",
      userId: null,
      employeeId: employee.id,
      lastReadAt: null,
    });
  }
});

afterEach(async () => {
  stopChannelTurnRecovery();
  await settleChannelTurnsForTests();
  resetModelAvailabilityForTests();
});

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  what: string,
): Promise<T> {
  for (let i = 0; i < 600; i += 1) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const turnRepo = () => AppDataSource.getRepository(ChannelTurn);
const reload = (id: string) => turnRepo().findOneByOrFail({ id });

/** Every turn in the room, oldest first. */
const turnsIn = (channel: Channel) =>
  turnRepo().find({ where: { channelId: channel.id }, order: { acceptedAt: "ASC" } });

async function say(author: User, content: string, channel: Channel = ops) {
  return postMessage({
    channelId: channel.id,
    companyId: company.id,
    author: { kind: "user", userId: author.id },
    requesterSessionVersion: 0,
    content,
  });
}

/** The `n`th turn to appear in the room, once it does. */
async function nthTurn(n: number, channel: Channel = ops): Promise<ChannelTurn> {
  return waitFor(async () => (await turnsIn(channel))[n - 1], `turn ${n}`);
}

async function settled(id: string): Promise<ChannelTurn> {
  await settleChannelTurnsForTests();
  return reload(id);
}

/** Its next look is due now, as if its lease ran out. */
async function due(id: string): Promise<void> {
  await turnRepo().update({ id }, { leaseExpiresAt: new Date(Date.now() - 1) });
}

function down(model: AIModel): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

/** What OpenCode throws once its retries are spent on an overloaded service. */
function overloadedError(): Error {
  return openCodeError({
    name: "APIError",
    data: {
      message: "Overloaded",
      statusCode: 529,
      isRetryable: true,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    },
  } as never);
}

function answers(text: string) {
  return async (params: RuntimeParams) => {
    params.callbacks?.onText?.(text);
    return { finalText: text, steps: 1, stopReason: "end_turn" };
  };
}

describe("a reply in a channel", () => {
  test("is a turn the room watches: its steps are recorded, and the reply says how it went", async (t) => {
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      params.callbacks?.onToolUse?.(
        "list_banking_transactions",
        { status: "unreviewed", apiKey: "sk-live-abcdefghijklmnop" },
        "c1",
      );
      params.callbacks?.onToolResult?.(
        "list_banking_transactions",
        { content: '{"total":3,"rows":[]}' },
        "c1",
      );
      params.callbacks?.onText?.("Three are unreviewed.");
      return { finalText: "Three are unreviewed.", steps: 2, stopReason: "end_turn" };
    });
    await say(ruth, "@ada how many transactions are unreviewed?");
    const turn = await settled((await nthTurn(1)).id);

    assert.equal(turn.kind, "reply");
    assert.equal(turn.status, "ok");
    assert.equal(turn.employeeId, ada.id);
    assert.equal(turn.authority, "member");
    assert.equal(turn.requesterUserId, ruth.id);
    assert.equal(turn.attempt, 1);
    assert.ok(turn.replyMessageId, "the reply is linked to its turn");

    const events = await listChatActivity(turn.id, 0, 100);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["turn_started", "tool_use", "tool_result", "turn_finished"],
    );
    const input = (events[1].detail as { input: Record<string, unknown> }).input;
    assert.equal(input.status, "unreviewed");
    assert.notEqual(input.apiKey, "sk-live-abcdefghijklmnop", "redacted like any chat turn");
    assert.doesNotMatch(JSON.stringify(events), /sk-live-abcdefghijklmnop/);

    const reply = await getMessageSummary(turn.replyMessageId!, ruth.id);
    assert.equal(reply?.content, "Three are unreviewed.");
    assert.equal(reply?.author?.kind, "ai");
    assert.equal(reply?.aiTurn?.id, turn.id);
    assert.equal(reply?.aiTurn?.status, "ok");
    assert.equal(reply?.aiTurn?.activity?.steps, 1);
    assert.deepEqual(reply?.aiTurn?.requester, { id: ruth.id, name: "Ruth" });
  });

  test("several AI Employees asked at once reply at the same time", async (t) => {
    await insertEmployeeModel({
      employeeId: ben.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
    let inFlight = 0;
    let most = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      // Neither answers until both have started: run one after the other and
      // this never resolves.
      for (let i = 0; i < 300 && most < 2; i += 1) await delay(10);
      inFlight -= 1;
      params.callbacks?.onText?.(most >= 2 ? "Here is my view." : "Alone.");
      return { finalText: "", steps: 1, stopReason: "end_turn" };
    });
    await say(ruth, "@ada @ben what do you each make of the Q3 numbers?");
    await nthTurn(2);
    await settleChannelTurnsForTests();
    const turns = await turnsIn(ops);
    assert.deepEqual(turns.map((turn) => turn.employeeId).sort(), [ada.id, ben.id].sort());
    assert.ok(turns.every((turn) => turn.status === "ok"));
    assert.equal(most, 2, "both replies were in flight together");
    const replies = await AppDataSource.getRepository(ChannelMessage).find({
      where: { channelId: ops.id, authorKind: "ai" },
    });
    assert.deepEqual(
      replies.map((reply) => reply.content),
      ["Here is my view.", "Here is my view."],
    );
  });

  test("an AI colleague's @mention runs under that employee's authority, within the chain limit", async (t) => {
    await insertEmployeeModel({
      employeeId: ben.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
    t.mock.method(agentRuntime, "run", answers("Totals check out."));
    await postMessage({
      channelId: ops.id,
      companyId: company.id,
      author: { kind: "ai", employeeId: ada.id },
      content: "@ben can you check the invoice totals?",
    });
    const turn = await settled((await nthTurn(1)).id);
    assert.equal(turn.employeeId, ben.id);
    assert.equal(turn.authority, "employee");
    assert.equal(turn.requesterUserId, null);
    assert.equal(turn.status, "ok");
    // Like that employee's Run transcripts, any Member who reads the room
    // reads its steps in full.
    assert.equal(
      turnActivityAccess({
        audience: "internal",
        authority: channelTurnAuthority(turn),
        viewer: { kind: "member", userId: sam.id },
      }),
      "full",
    );

    // Past the limit, an AI's @mention starts no turn at all.
    for (let i = 0; i < AI_MENTION_CHAIN_LIMIT; i += 1) {
      await insert(ChannelMessage, {
        channelId: ops.id,
        authorKind: "ai",
        authorEmployeeId: i % 2 ? ben.id : ada.id,
        content: `exchange ${i}`,
        createdAt: new Date(Date.now() - 60_000 + i * 10),
      } as never);
    }
    await postMessage({
      channelId: ops.id,
      companyId: company.id,
      author: { kind: "ai", employeeId: ada.id },
      content: "@ben and again?",
    });
    await waitFor(
      async () =>
        (await AppDataSource.getRepository(ChannelMessage).count({
          where: { channelId: ops.id, content: PAUSED_MENTION_CHAIN_NOTE },
        })) === 1,
      "the pause note",
    );
    await settleChannelTurnsForTests();
    assert.equal((await turnsIn(ops)).length, 1, "the paused chain started no turn");
  });

  test("a webhook's @mention runs under nobody's authority", async (t) => {
    t.mock.method(agentRuntime, "run", answers("Noted the deploy."));
    await postIncomingWebhookMessage({
      channel: ops,
      authorName: "Deployments",
      content: "@ada production deploy finished",
    });
    const turn = await settled((await nthTurn(1)).id);
    assert.equal(turn.authority, "untrusted");
    assert.equal(turn.requesterUserId, null);
    assert.equal(turn.status, "ok");
  });

  test("taint travels: replaying a tainted message taints the turn and its reply", async (t) => {
    t.mock.method(agentRuntime, "run", answers("Noted."));
    await insert(ChannelMessage, {
      channelId: ops.id,
      authorKind: "ai",
      authorEmployeeId: ben.id,
      content: "Their pricing page says $59.",
      tainted: true,
      createdAt: new Date(Date.now() - 1_000),
    } as never);
    await say(ruth, "@ada does that match ours?");
    const turn = await settled((await nthTurn(1)).id);
    assert.equal(turn.tainted, true);
    const reply = await AppDataSource.getRepository(ChannelMessage).findOneByOrFail({
      id: turn.replyMessageId!,
    });
    assert.equal(reply.tainted, true);
  });

  test("a second reply of the same AI Employee here waits its turn instead of answering busy", async (t) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls += 1;
      if (calls === 1) await held;
      params.callbacks?.onText?.(`Answer ${calls}.`);
      return { finalText: "", steps: 1, stopReason: "end_turn" };
    });
    await say(ruth, "@ada first question");
    const first = await nthTurn(1);
    await waitFor(async () => calls === 1, "the first reply to run");
    await say(sam, "@ada second question");
    const second = await nthTurn(2);
    const waiting = await waitFor(async () => {
      const row = await reload(second.id);
      return row.waitingFor === "thread_busy" ? row : null;
    }, "the second reply to wait");
    assert.equal(waiting.status, "working");
    assert.equal(waiting.attempt, 0, "a reply that only waited has not been attempted");
    const waits = (await listChatActivity(second.id, 0, 100)).filter((e) => e.kind === "waiting");
    assert.deepEqual(waits.map((e) => e.name), ["thread_busy"]);

    release();
    assert.equal((await settled(first.id)).status, "ok");
    await due(second.id);
    assert.equal(await executeChannelTurn(second.id), "completed");
    const done = await reload(second.id);
    assert.equal(done.status, "ok");
    const replies = await AppDataSource.getRepository(ChannelMessage).find({
      where: { channelId: ops.id, authorKind: "ai" },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      replies.map((reply) => reply.content),
      ["Answer 1.", "Answer 2."],
      "no busy notice in the room",
    );
  });

  test("Stop keeps what was written, and the activity names who stopped it", async (t) => {
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      params.callbacks?.onText?.("Partial answer");
      for (let i = 0; i < 500 && !params.signal?.aborted; i += 1) await delay(5);
      return { finalText: "", steps: 1, stopReason: "aborted" };
    });
    await say(ruth, "@ada write the long report");
    const turn = await nthTurn(1);
    await waitFor(async () => (await listChatActivity(turn.id, 0, 10)).length > 0, "the turn to start");
    assert.equal(
      await interruptChannelTurn({
        companyId: company.id,
        channelId: ops.id,
        turnId: turn.id,
        byUserId: sam.id,
      }),
      "interrupted",
    );
    const stopped = await settled(turn.id);
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.stoppedByUserId, sam.id);
    const reply = await getMessageSummary(stopped.replyMessageId!, ruth.id);
    assert.equal(reply?.content, "Partial answer");
    assert.equal(reply?.aiTurn?.status, "interrupted");
    const events = await listChatActivity(turn.id, 0, 100);
    assert.equal(events.find((event) => event.kind === "stopped")?.summary, "Stopped by Sam");
    assert.equal(events.at(-1)?.kind, "turn_finished");
    assert.equal(
      await interruptChannelTurn({
        companyId: company.id,
        channelId: ops.id,
        turnId: turn.id,
        byUserId: ruth.id,
      }),
      "not_running",
      "nothing left to stop",
    );
  });

  test("a failed reply can be asked again: a new turn for the same message, told an attempt failed", async (t) => {
    const prompts: string[] = [];
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls += 1;
      prompts.push(JSON.stringify(params.messages));
      if (calls === 1) throw Object.assign(new Error("prompt is too long"), { status: 400 });
      params.callbacks?.onText?.("Fixed it.");
      return { finalText: "Fixed it.", steps: 1, stopReason: "end_turn" };
    });
    await say(ruth, "@ada summarize everything");
    const failed = await settled((await nthTurn(1)).id);
    assert.equal(failed.status, "error");
    const failedReply = await getMessageSummary(failed.replyMessageId!, ruth.id);
    assert.equal(failedReply?.aiTurn?.status, "error");

    const retried = await retryChannelTurn({
      companyId: company.id,
      channelId: ops.id,
      turnId: failed.id,
      requester: { userId: sam.id, sessionVersion: 0 },
    });
    assert.notEqual(retried.id, failed.id);
    assert.equal(retried.triggerMessageId, failed.triggerMessageId);
    assert.equal(retried.authority, "member");
    assert.equal(retried.requesterUserId, sam.id, "under the asker's authority now");
    const done = await settled(retried.id);
    assert.equal(done.status, "ok");
    assert.match(prompts[1], /Durable recovery note/);
    const events = await listChatActivity(done.id, 0, 100);
    assert.equal(events[0].summary, "Retry requested by Sam");
    assert.equal(events.find((e) => e.kind === "turn_started")?.summary, "Started again");

    await assert.rejects(
      retryChannelTurn({
        companyId: company.id,
        channelId: ops.id,
        turnId: failed.id,
        requester: { userId: ruth.id, sessionVersion: 0 },
      }),
      (error: unknown) => error instanceof ChannelTurnError && error.status === 409,
      "it was already retried",
    );
    await assert.rejects(
      retryChannelTurn({
        companyId: company.id,
        channelId: ops.id,
        turnId: done.id,
        requester: { userId: ruth.id, sessionVersion: 0 },
      }),
      (error: unknown) => error instanceof ChannelTurnError && error.status === 409,
      "only a failed reply",
    );
  });

  test("a restart mid-reply hands it to the next worker, told to check what it did", async (t) => {
    const prompts: string[] = [];
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      prompts.push(JSON.stringify(params.messages));
      params.callbacks?.onText?.("Carried on.");
      return { finalText: "Carried on.", steps: 1, stopReason: "end_turn" };
    });
    const trigger = await insert(ChannelMessage, {
      channelId: ops.id,
      authorKind: "user",
      authorUserId: ruth.id,
      content: "@ada reconcile October",
      createdAt: new Date(Date.now() - 5_000),
    } as never);
    const orphan = await insert(ChannelTurn, {
      companyId: company.id,
      channelId: ops.id,
      employeeId: ada.id,
      kind: "reply",
      triggerMessageId: trigger.id,
      authority: "member",
      requesterUserId: ruth.id,
      requesterSessionVersion: 0,
      status: "working",
      workerId: "a-worker-that-died",
      leaseExpiresAt: new Date(Date.now() - 1_000),
      attempt: 1,
      acceptedAt: new Date(Date.now() - 5_000),
      deadlineAt: new Date(Date.now() + CHAT_HARD_TIMEOUT_MS),
    } as never);
    await recoverChannelTurns();
    const done = await settled(orphan.id);
    assert.equal(done.status, "ok");
    assert.equal(done.attempt, 2);
    assert.match(prompts[0], /Durable recovery note/);
    const started = (await listChatActivity(orphan.id, 0, 100)).find(
      (event) => event.kind === "turn_started",
    );
    assert.equal(started?.summary, "Resumed after a server restart");
  });
});

describe("while its AI Model is unavailable", () => {
  test("a reply waits, says so in the room, and is answered when the model is back", async (t) => {
    down(adaModel);
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls += 1;
      return answers("Here is the refund policy.")(params);
    });
    await say(ruth, "@ada what is our refund policy?");
    const turn = await nthTurn(1);
    const waiting = await waitFor(async () => {
      const row = await reload(turn.id);
      return row.waitingFor === "model_unavailable" && row.workerId === null ? row : null;
    }, "the reply to wait");
    await settleChannelTurnsForTests();
    assert.equal(calls, 0, "the model is not asked while it is unavailable");
    assert.equal(waiting.status, "working", "a reply in progress, never an error");
    assert.equal(waiting.attempt, 0, "a reply that never reached the model is no attempt");
    assert.ok(waiting.leaseExpiresAt && waiting.leaseExpiresAt.getTime() > Date.now());
    assert.ok(
      waiting.deadlineAt &&
        waiting.deadlineAt.getTime() > Date.now() + CHAT_HARD_TIMEOUT_MS - 60_000,
      "waiting does not spend the six hours",
    );
    assert.equal(
      await AppDataSource.getRepository(ChannelMessage).count({
        where: { channelId: ops.id, authorKind: "ai" },
      }),
      0,
      "no 'unavailable' reply in the room",
    );
    const events = await listChatActivity(turn.id, 0, 100);
    assert.deepEqual(
      events.map((event) => [event.kind, event.name]),
      [["waiting", MODEL_UNAVAILABLE_WAIT_CAUSE]],
    );
    assert.match(events[0].summary, /AI Model is unavailable — this will be answered when it is back/);
    assert.deepEqual(
      (await waitingWorkByModel(company.id, [adaModel.id])).get(adaModel.id),
      { runs: 0, chats: 1 },
      "the AI Models page counts it as waiting",
    );

    // Looked at again while still unavailable: still waiting, one line in the room.
    await due(turn.id);
    assert.equal(await executeChannelTurn(turn.id), "deferred");
    assert.equal((await listChatActivity(turn.id, 0, 100)).length, 1);

    await back(adaModel);
    await due(turn.id);
    assert.equal(await executeChannelTurn(turn.id), "completed");
    const answered = await reload(turn.id);
    assert.equal(answered.status, "ok");
    assert.equal(answered.attempt, 1);
    assert.equal(calls, 1);
    const reply = await getMessageSummary(answered.replyMessageId!, ruth.id);
    assert.equal(reply?.content, "Here is the refund policy.");
    const after = await listChatActivity(turn.id, 0, 100);
    assert.equal(after[1]?.kind, "turn_started");
    assert.equal(after[1]?.summary, "Started working", "a reply that only waited starts fresh");
    assert.deepEqual(
      (await waitingWorkByModel(company.id, [adaModel.id])).get(adaModel.id),
      { runs: 0, chats: 0 },
    );
  });

  test("it is answered the moment the model is back, without waiting for its next look", async (t) => {
    down(adaModel);
    t.mock.method(agentRuntime, "run", answers("Back and answering."));
    await bootChannelTurnRecovery();
    await say(ruth, "@ada are you there?");
    const turn = await nthTurn(1);
    await waitFor(async () => {
      const row = await reload(turn.id);
      return row.waitingFor === "model_unavailable" && row.workerId === null ? row : null;
    }, "the reply to wait");
    assert.ok(
      ((await reload(turn.id)).leaseExpiresAt?.getTime() ?? 0) > Date.now() + 1_000,
      "its next look is a while off",
    );
    await back(adaModel);
    const answered = await waitFor(async () => {
      const row = await reload(turn.id);
      return row.status === "ok" ? row : null;
    }, "the reply once the model is back");
    const reply = await getMessageSummary(answered.replyMessageId!, ruth.id);
    assert.equal(reply?.content, "Back and answering.");
  });

  test("a reply the outage cuts short waits too, and starts again told to check what it did", async (t) => {
    const prompts: string[] = [];
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls += 1;
      prompts.push(JSON.stringify(params.messages));
      if (calls === 1) {
        params.callbacks?.onText?.("Looking up the order");
        throw overloadedError();
      }
      params.callbacks?.onText?.("Order 1042 shipped yesterday.");
      return { finalText: "", steps: 1, stopReason: "end_turn" };
    });
    await say(ruth, "@ada where is order 1042?");
    const turn = await nthTurn(1);
    const waiting = await waitFor(async () => {
      const row = await reload(turn.id);
      return row.waitingFor === "model_unavailable" && row.workerId === null ? row : null;
    }, "the reply to wait");
    await settleChannelTurnsForTests();
    assert.equal(waiting.status, "working");
    assert.equal(waiting.attempt, 1, "the attempt that ran keeps its count");
    assert.equal(waiting.resumeAs, "model_back");
    assert.equal(waiting.replyText, "", "nothing half-written is kept as the answer");

    await back(adaModel);
    await due(turn.id);
    assert.equal(await executeChannelTurn(turn.id), "completed");
    const answered = await reload(turn.id);
    assert.equal(answered.status, "ok");
    assert.match(prompts[1], /Durable recovery note/);
    const started = (await listChatActivity(turn.id, 0, 100)).filter(
      (event) => event.kind === "turn_started",
    );
    assert.equal(started.at(-1)?.summary, "Started again now that the AI Model is back");
    const reply = await getMessageSummary(answered.replyMessageId!, ruth.id);
    assert.equal(reply?.content, "Order 1042 shipped yesterday.");
  });

  test("the replies that waited start one at a time once the model is back", async (t) => {
    await attachExistingModel({ employeeId: ben.id, modelId: adaModel.id, isActive: true });
    down(adaModel);
    t.mock.method(agentRuntime, "run", answers("On it."));
    await say(ruth, "@ada @ben both of you, please");
    const [first, second] = [await nthTurn(1), await nthTurn(2)];
    for (const turn of [first, second]) {
      await waitFor(async () => {
        const row = await reload(turn.id);
        return row.waitingFor === "model_unavailable" && row.workerId === null ? row : null;
      }, "both replies to wait");
    }
    await settleChannelTurnsForTests();
    await back(adaModel);
    await due(first.id);
    await due(second.id);
    assert.equal(await executeChannelTurn(first.id), "completed");
    const before = Date.now();
    assert.equal(await executeChannelTurn(second.id), "deferred", "the second takes its turn");
    const paced = await reload(second.id);
    assert.equal(paced.waitingFor, "model_resuming");
    assert.ok(paced.leaseExpiresAt && paced.leaseExpiresAt.getTime() > before);
    assert.ok(paced.leaseExpiresAt!.getTime() <= before + 11_000, "a few seconds behind");
    const waits = (await listChatActivity(second.id, 0, 100)).filter((e) => e.kind === "waiting");
    assert.deepEqual(waits.map((e) => e.name), [
      MODEL_UNAVAILABLE_WAIT_CAUSE,
      MODEL_RESUMING_WAIT_CAUSE,
    ]);
  });

  test("Stop cancels a reply waiting for its model, and it is never answered", async (t) => {
    down(adaModel);
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls += 1;
      return answers("Too late.")(params);
    });
    await say(ruth, "@ada draft the newsletter");
    const turn = await nthTurn(1);
    await waitFor(async () => {
      const row = await reload(turn.id);
      return row.waitingFor === "model_unavailable" && row.workerId === null ? row : null;
    }, "the reply to wait");
    await settleChannelTurnsForTests();
    assert.equal(
      await interruptChannelTurn({
        companyId: company.id,
        channelId: ops.id,
        turnId: turn.id,
        byUserId: ruth.id,
      }),
      "interrupted",
    );
    const stopped = await reload(turn.id);
    assert.equal(stopped.status, "interrupted");
    const reply = await getMessageSummary(stopped.replyMessageId!, ruth.id);
    assert.equal(reply?.content, INTERRUPTED_BEFORE_REPLY);
    const events = await listChatActivity(turn.id, 0, 100);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["waiting", "stopped", "turn_finished"],
    );
    await back(adaModel);
    await due(turn.id);
    assert.equal(await executeChannelTurn(turn.id), "claimed_elsewhere");
    assert.equal(calls, 0, "a cancelled reply is never answered");
  });

  test("a Standdown placed while it waits wins: the reply says so and never reaches the model", async (t) => {
    down(adaModel);
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      calls += 1;
      return answers("Should not run.")(params);
    });
    await say(ruth, "@ada pay the vendors");
    const turn = await nthTurn(1);
    await waitFor(async () => {
      const row = await reload(turn.id);
      return row.waitingFor === "model_unavailable" && row.workerId === null ? row : null;
    }, "the reply to wait");
    await settleChannelTurnsForTests();
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: ada.id,
      reason: "Quarter close: hold Ada's work.",
    });
    await back(adaModel);
    await due(turn.id);
    assert.equal(await executeChannelTurn(turn.id), "completed");
    const ended = await reload(turn.id);
    assert.equal(ended.status, "error");
    assert.equal(calls, 0, "recovery never starts work a Standdown covers");
    const reply = await getMessageSummary(ended.replyMessageId!, ruth.id);
    assert.match(reply?.content ?? "", /Ada is stood down/);
    assert.match(reply?.content ?? "", /Quarter close/);
  });
});
