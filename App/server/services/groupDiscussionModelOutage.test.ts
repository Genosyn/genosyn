import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModelWait } from "../db/entities/AIModelWait.js";
import type { Channel } from "../db/entities/Channel.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { GroupDiscussion } from "../db/entities/GroupDiscussion.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import type { ChatOptions, ChatResult, ChatTurn } from "./chat.js";
import {
  getGroupDiscussion,
  parseOutcome,
  setGroupDiscussionDepsForTests,
  settleGroupDiscussionsForTests,
  startDiscussionFollowThrough,
  startGroupDiscussion,
  stopGroupDiscussion,
  summarizeDiscussion,
  sweepStaleGroupDiscussions,
  type OutcomeWriter,
} from "./groupDiscussions.js";
import { GROUP_DISCUSSION_LIMITS, parseDiscussionState } from "./groupDiscussionPlan.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { resetModelWaitsForTests, settleModelWaitsForTests } from "./modelWaits.js";
import { placeStanddown, stopStanddowns } from "./standdowns.js";
import { createGroupChat } from "./workspaceChat.js";

/**
 * A group discussion an AI Model outage interrupts. Nobody decided anyone
 * should sit out: a speaker whose model is down keeps their turn, and when
 * nobody else is left to speak the discussion waits — saying so — and carries
 * on by itself once the model is back. The wall clock still bounds it: past
 * it, the discussion ends with what was said, or, when the outcome itself
 * cannot be written, without one, saying why. Never a half-written outcome.
 * "Start the work" waits for an owner's model too. The turn runner and the
 * outcome writer are scripted; the driver, the breaker and the wait ledger are
 * real.
 */

let company: Company;
let owner: User;
let ada: AIEmployee;
let ben: AIEmployee;
let cy: AIEmployee;
const models = new Map<string, AIModel>();

type Call = { employeeId: string; message: string; history: ChatTurn[]; options: ChatOptions };
type Reply = string | ChatResult | ((call: Call) => Promise<string | ChatResult>);

let calls: Call[];
let script: Map<string, Reply[]>;
let outcomeScript: Array<(args: Parameters<OutcomeWriter>[0]) => Promise<Awaited<ReturnType<OutcomeWriter>>>>;
let clock: () => Date;

function say(employee: AIEmployee, ...replies: Reply[]) {
  script.set(employee.id, [...(script.get(employee.id) ?? []), ...replies]);
}

function okOutcome(actionItems: Array<{ owner: string; action: string }> = []) {
  return async (args: Parameters<OutcomeWriter>[0]) => {
    const { resolveOutcome } = await import("./groupDiscussionPrompts.js");
    return {
      ok: true as const,
      outcome: resolveOutcome(
        {
          summary: "We agree to raise Pro to $49.",
          recommendation: "Announce it on Monday.",
          openQuestions: [],
          actionItems,
        },
        args.people,
        args.lead.id,
      ),
    };
  };
}

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  stopStanddowns();
  models.clear();
  owner = await insert(User, {
    email: "ruth@example.test",
    name: "Ruth",
    handle: "ruth",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await hire("Ada", "ada", "Head of Product");
  ben = await hire("Ben", "ben", "CFO");
  cy = await hire("Cy", "cy", "Sales lead");

  calls = [];
  script = new Map();
  outcomeScript = [];
  clock = () => new Date();
  setGroupDiscussionDepsForTests({
    pollIntervalMs: 10,
    modelWaitPollMs: 15,
    heartbeatMs: 60_000,
    now: () => clock(),
    runTurn: async (_companyId, employeeId, message, history, _onChunk, options) => {
      const call: Call = { employeeId, message, history, options };
      calls.push(call);
      const queue = script.get(employeeId) ?? [];
      const next = queue.shift() ?? "PASS";
      const value = typeof next === "function" ? await next(call) : next;
      if (typeof value === "string") {
        return { status: "ok", reply: value, attachmentIds: [], sidecars: {} } as ChatResult;
      }
      return value;
    },
    writeOutcome: async (args) => {
      const next = outcomeScript.shift() ?? okOutcome();
      return next(args);
    },
  });
});

afterEach(async () => {
  await settleGroupDiscussionsForTests();
  setGroupDiscussionDepsForTests(null);
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});

async function hire(name: string, slug: string, role: string): Promise<AIEmployee> {
  const employee = await insert(AIEmployee, { companyId: company.id, name, slug, role });
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

function down(...employees: AIEmployee[]): void {
  for (const employee of employees) {
    recordModelFailure(
      models.get(employee.id)!,
      modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
    );
  }
}

async function back(...employees: AIEmployee[]): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  for (const employee of employees) await checkModelAvailabilityNow(models.get(employee.id)!);
  await flushModelAvailabilityWrites();
}

/** What a turn returns when its AI Model goes down under it — and the breaker trips, as the runtime's does. */
function outageFor(employee: AIEmployee): () => Promise<ChatResult> {
  return async () => {
    down(employee);
    return {
      status: "error",
      reply: "The AI Model answered with a server error (HTTP 529).",
      attachmentIds: [],
      sidecars: {},
      unavailable: modelUnavailability("overloaded", { status: 529, code: "overloaded_error" }),
    };
  };
}

async function groupChat(employees: AIEmployee[] = [ada, ben, cy]) {
  return createGroupChat({
    companyId: company.id,
    createdByUserId: owner.id,
    name: "Pricing",
    employeeIds: employees.map((e) => e.id),
    memberUserIds: [],
  });
}

async function start(channel: Channel) {
  return startGroupDiscussion({
    channel,
    requester: { userId: owner.id, sessionVersion: 0 },
    question: "Should we raise the Pro plan to $49?",
    minParticipants: 2,
  });
}

async function row(id: string): Promise<GroupDiscussion> {
  return AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({ id });
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitingForModel(id: string): Promise<void> {
  await waitFor(
    async () => parseDiscussionState((await row(id)).stateJson).modelWaitSince !== null,
    "the discussion to wait for its AI Model",
  );
}

async function notes(id: string): Promise<string[]> {
  const rows = await AppDataSource.getRepository(ChannelMessage).find({
    where: { discussionId: id, discussionRole: "note" },
    order: { createdAt: "ASC" },
  });
  return rows.map((m) => m.content);
}

async function roles(id: string): Promise<string[]> {
  const rows = await AppDataSource.getRepository(ChannelMessage).find({
    where: { discussionId: id },
    order: { createdAt: "ASC" },
  });
  return rows.map((m) => m.discussionRole ?? "");
}

describe("a discussion an AI Model outage interrupts", () => {
  test("a speaker whose model goes down mid-turn keeps their turn; the discussion waits and carries on when it is back", async () => {
    const channel = await groupChat();
    say(ada, outageFor(ada), "Raise it to $49 — usage doubled.");
    say(ben, "Margin goes from 62% to 71%.");
    say(cy, "Sales can live with it.");
    const started = await start(channel);
    await waitingForModel(started.id);

    const waiting = await row(started.id);
    assert.equal(waiting.status, "running");
    const state = parseDiscussionState(waiting.stateJson);
    assert.ok(!state.spoken.includes(ada.id), "Ada keeps her turn");
    assert.ok(!state.skipped.some((s) => s.employeeId === ada.id), "nothing recorded against her");
    assert.equal(waiting.turnsTaken, 2, "a turn the outage cut short is not a turn");
    const summary = await summarizeDiscussion(waiting);
    assert.ok(summary.waitingForModelSince);
    assert.ok((await notes(started.id)).some((n) => /AI Model is unavailable, so the discussion is waiting/.test(n)));
    assert.ok(
      !(await notes(started.id)).some((n) => /couldn't take their turn/.test(n)),
      "never the model's error, posted",
    );

    await back(ada);
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "concluded");
    assert.ok((await notes(started.id)).some((n) => /AI Model is back/.test(n)));
    const turns = await AppDataSource.getRepository(ChannelMessage).find({
      where: { discussionId: started.id, discussionRole: "turn" },
    });
    assert.ok(turns.some((m) => m.authorEmployeeId === ada.id && /usage doubled/.test(m.content)));
    assert.ok(!turns.some((m) => /HTTP 529/.test(m.content)), "nothing half-written is posted");
    assert.equal((await summarizeDiscussion(d)).waitingForModelSince, null);
  });

  test("every AI Model down before the first turn: it waits, and starts once they are back", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Raise it to $49.");
    say(ben, "Agreed on numbers: margin improves.");
    down(ada, ben);
    const started = await start(channel);
    await waitingForModel(started.id);
    assert.equal(calls.length, 0, "nobody is asked while their model is down");
    await back(ada, ben);
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "concluded");
    assert.ok(calls.length >= 2);
  });

  test("the wall clock runs out while it waits: it ends with what was said, written by someone who can", async () => {
    const channel = await groupChat();
    say(ben, "Margin goes from 62% to 71%.");
    say(cy, "Sales can live with it.");
    down(ada);
    const started = await start(channel);
    await waitingForModel(started.id);
    clock = () => new Date(Date.now() + GROUP_DISCUSSION_LIMITS.discussionTimeoutMs + 60_000);
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "time_limit");
    const outcome = parseOutcome(d.outcomeJson);
    assert.equal(outcome?.writtenByEmployeeId, ben.id, "the lead's model was down, so the next writer");
    assert.deepEqual(
      (await roles(started.id)).filter((r) => r === "outcome"),
      ["outcome"],
    );
  });

  test("the outcome waits for a writer's AI Model, and is written once — whole — when it is back", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Raise it to $49.");
    say(ben, "Margin improves.");
    const unavailable = async () => {
      down(ada, ben);
      return { ok: false as const, error: "Ada's AI Model became unavailable.", unavailable: true };
    };
    outcomeScript.push(unavailable, unavailable, okOutcome());
    const started = await start(channel);
    await waitingForModel(started.id);
    const waiting = await row(started.id);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.phase, "concluding");
    assert.ok((await notes(started.id)).some((n) => /outcome waits for it/.test(n)));
    assert.deepEqual((await roles(started.id)).filter((r) => r === "outcome"), []);

    await back(ada, ben);
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "concluded");
    assert.deepEqual((await roles(started.id)).filter((r) => r === "outcome"), ["outcome"]);
    assert.ok(!(await notes(started.id)).some((n) => /no outcome could be written/.test(n)));
  });

  test("the wall clock runs out while the outcome waits: it ends without one, saying the AI Model was unavailable", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Raise it to $49.");
    say(ben, "Margin improves.");
    const unavailable = async () => {
      down(ada, ben);
      return { ok: false as const, error: "unavailable", unavailable: true };
    };
    outcomeScript.push(unavailable, unavailable);
    const started = await start(channel);
    await waitingForModel(started.id);
    clock = () => new Date(Date.now() + GROUP_DISCUSSION_LIMITS.discussionTimeoutMs + 60_000);
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "failed");
    assert.match(d.endDetail ?? "", /no outcome could be written: the AI Model is unavailable/);
    assert.deepEqual((await roles(started.id)).filter((r) => r === "outcome"), [], "never half-written");
    const bell = await AppDataSource.getRepository(Notification).findBy({
      userId: owner.id,
      kind: "group_discussion",
    });
    assert.ok(bell.some((n) => /ended without an outcome/.test(n.title)));
  });

  test("Stop while it waits ends it at once", async () => {
    const channel = await groupChat([ada, ben]);
    down(ada, ben);
    const started = await start(channel);
    await waitingForModel(started.id);
    await stopGroupDiscussion({ companyId: company.id, discussionId: started.id, userId: owner.id });
    await settleGroupDiscussionsForTests();
    assert.equal((await row(started.id)).status, "stopped");
  });

  test("a company Standdown while it waits ends it", async () => {
    const channel = await groupChat([ada, ben]);
    down(ada, ben);
    const started = await start(channel);
    await waitingForModel(started.id);
    await placeStanddown({ companyId: company.id, scope: "company", reason: "Board review." });
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "stopped");
    assert.equal(d.endReason, "standdown");
  });

  test("a restart while it waited ends it as interrupted, saying it was waiting for its AI Model", async () => {
    const channel = await groupChat([ada, ben]);
    const stale = await insert(GroupDiscussion, {
      companyId: company.id,
      channelId: channel.id,
      startedByUserId: owner.id,
      requesterSessionVersion: 0,
      question: "Should we raise the Pro plan to $49?",
      participantsJson: JSON.stringify([ada.id, ben.id]),
      leadEmployeeId: ada.id,
      status: "running",
      phase: "discussing",
      round: 1,
      maxRounds: 3,
      maxTurns: 10,
      tokenBudget: 1000,
      stateJson: JSON.stringify({ modelWaitSince: new Date().toISOString() }),
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
    });
    assert.equal(await sweepStaleGroupDiscussions(), 1);
    const d = await row(stale.id);
    assert.equal(d.status, "interrupted");
    assert.match(d.endDetail ?? "", /waiting for its AI Model when the server restarted/);
  });
});

describe("Start the work while an owner's AI Model is unavailable", () => {
  async function concludedWithWork(): Promise<GroupDiscussion> {
    const channel = await groupChat([ada, ben]);
    say(ada, "Raise it to $49.");
    say(ben, "Margin improves.");
    outcomeScript.push(
      okOutcome([
        { owner: "@ada", action: "Draft the announcement." },
        { owner: "@ben", action: "Model the grandfathering cost." },
      ]),
    );
    const started = await start(channel);
    await settleGroupDiscussionsForTests();
    const d = await row(started.id);
    assert.equal(d.status, "concluded");
    return d;
  }

  test("that owner's share waits, says so, and starts once the model is back — under the Member who pressed it", async () => {
    const d = await concludedWithWork();
    say(ada, "Draft announcement posted.");
    say(ben, "Grandfathering costs $4k a month.");
    down(ada);
    calls = [];
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: d.id,
      requester: { userId: owner.id, sessionVersion: 0 },
    });
    await settleGroupDiscussionsForTests();
    let outcome = parseOutcome((await row(d.id)).outcomeJson);
    const adaItem = outcome?.actionItems.find((i) => i.owner?.id === ada.id);
    const benItem = outcome?.actionItems.find((i) => i.owner?.id === ben.id);
    assert.equal(benItem?.status, "done", "the other owner is not held up");
    assert.equal(adaItem?.status, "waiting");
    assert.match(adaItem?.detail ?? "", /Waiting for the AI Model/);
    assert.deepEqual(calls.map((c) => c.employeeId), [ben.id]);
    const [wait] = await AppDataSource.getRepository(AIModelWait).find();
    assert.equal(wait.kind, "discussion_work");

    await settleModelWaitsForTests();
    assert.deepEqual(calls.map((c) => c.employeeId), [ben.id], "still down");

    await back(ada);
    await settleModelWaitsForTests();
    await settleGroupDiscussionsForTests();
    outcome = parseOutcome((await row(d.id)).outcomeJson);
    assert.equal(outcome?.actionItems.find((i) => i.owner?.id === ada.id)?.status, "done");
    const adaCall = calls.find((c) => c.employeeId === ada.id);
    assert.equal(adaCall?.options.requesterUserId, owner.id);
    assert.equal(adaCall?.options.requesterSessionVersion, 0, "the authority it was given, not re-read");
    assert.equal(await AppDataSource.getRepository(AIModelWait).count(), 0);
  });

  test("a share the outage cut short waits too, and nothing half-done is posted", async () => {
    const d = await concludedWithWork();
    say(ada, outageFor(ada), "Draft announcement posted.");
    say(ben, "Done.");
    calls = [];
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: d.id,
      requester: { userId: owner.id, sessionVersion: 0 },
    });
    await settleGroupDiscussionsForTests();
    assert.equal(
      parseOutcome((await row(d.id)).outcomeJson)?.actionItems.find((i) => i.owner?.id === ada.id)?.status,
      "waiting",
    );
    assert.ok(!(await notes(d.id)).some((n) => /couldn't start on the work/.test(n)));
    await back(ada);
    await settleModelWaitsForTests();
    await settleGroupDiscussionsForTests();
    assert.equal(
      parseOutcome((await row(d.id)).outcomeJson)?.actionItems.find((i) => i.owner?.id === ada.id)?.status,
      "done",
    );
  });

  test("a Standdown placed on the owner while it waited: the share is skipped, saying so", async () => {
    const d = await concludedWithWork();
    down(ada);
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: d.id,
      requester: { userId: owner.id, sessionVersion: 0 },
    });
    await settleGroupDiscussionsForTests();
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: ada.id,
      reason: "Messaging review.",
    });
    calls = [];
    await back(ada);
    await settleModelWaitsForTests();
    const item = parseOutcome((await row(d.id)).outcomeJson)?.actionItems.find(
      (i) => i.owner?.id === ada.id,
    );
    assert.equal(item?.status, "skipped");
    assert.match(item?.detail ?? "", /Stood down/);
    assert.equal(calls.length, 0);
    assert.ok(await getGroupDiscussion(company.id, d.id));
  });
});
