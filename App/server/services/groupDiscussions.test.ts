import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { GroupDiscussion } from "../db/entities/GroupDiscussion.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { ChatOptions, ChatResult, ChatTurn } from "./chat.js";
import {
  GroupDiscussionError,
  getGroupDiscussion,
  parseOutcome,
  setGroupDiscussionDepsForTests,
  settleGroupDiscussionsForTests,
  startDiscussionFollowThrough,
  startGroupDiscussion,
  stopGroupDiscussion,
  summarizeDiscussion,
  sweepStaleGroupDiscussions,
  wrapUpGroupDiscussion,
  type OutcomeWriter,
} from "./groupDiscussions.js";
import { parseDiscussionState } from "./groupDiscussionPlan.js";
import { placeStanddown, stopStanddowns } from "./standdowns.js";
import { createGroupChat, postMessage } from "./workspaceChat.js";

/**
 * Group discussions end to end, with every model turn scripted: who speaks
 * and in what order, what ends a discussion, what the Member gets back, and
 * the stops a discussion has to obey — Stop, a Standdown, a changed sign-in.
 * Nothing here calls a model; `setGroupDiscussionDepsForTests` replaces the
 * turn runner and the outcome writer, and every other seam is real.
 */

let company: Company;
let owner: User;
let teammate: User;
let ada: AIEmployee;
let ben: AIEmployee;
let cy: AIEmployee;
let dee: AIEmployee;

type Call = {
  employeeId: string;
  message: string;
  history: ChatTurn[];
  options: ChatOptions;
};

let calls: Call[];
let outcomeCalls: Array<Parameters<OutcomeWriter>[0]>;

/** Replies by employee, consumed in order; a function reply runs mid-turn. */
type Reply =
  | string
  | Partial<ChatResult>
  | ((call: Call) => Promise<string | Partial<ChatResult>> | string | Partial<ChatResult>);

let script: Map<string, Reply[]>;

function say(employee: AIEmployee, ...replies: Reply[]) {
  script.set(employee.id, [...(script.get(employee.id) ?? []), ...replies]);
}

let outcomeScript: Array<Awaited<ReturnType<OutcomeWriter>> | ((args: Parameters<OutcomeWriter>[0]) => Promise<Awaited<ReturnType<OutcomeWriter>>>)>;

function okOutcome(actionItems: Array<{ owner: string; action: string }> = []) {
  return async (args: Parameters<OutcomeWriter>[0]) => {
    const { resolveOutcome } = await import("./groupDiscussionPrompts.js");
    return {
      ok: true as const,
      outcome: resolveOutcome(
        {
          summary: "We agree to raise Pro to $49.",
          recommendation: "Announce it on Monday.",
          openQuestions: ["Should annual plans be grandfathered?"],
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
  await resetTestDb();
  stopStanddowns();
  owner = await insert(User, {
    email: "ruth@example.test",
    name: "Ruth",
    handle: "ruth",
    passwordHash: "x",
    sessionVersion: 0,
  });
  teammate = await insert(User, {
    email: "sam@example.test",
    name: "Sam",
    handle: "sam",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: teammate.id, role: "member" });
  ada = await hire("Ada", "ada", "Head of Product");
  ben = await hire("Ben", "ben", "CFO");
  cy = await hire("Cy", "cy", "Sales lead");
  dee = await hire("Dee", "dee", "Support lead");

  calls = [];
  outcomeCalls = [];
  script = new Map();
  outcomeScript = [];
  setGroupDiscussionDepsForTests({
    pollIntervalMs: 10,
    heartbeatMs: 60_000,
    runTurn: async (_companyId, employeeId, message, history, _onChunk, options) => {
      const call: Call = { employeeId, message, history, options };
      calls.push(call);
      const queue = script.get(employeeId) ?? [];
      const next = queue.shift() ?? "PASS";
      const value = typeof next === "function" ? await next(call) : next;
      const base = { attachmentIds: [], sidecars: {} };
      if (typeof value === "string") return { status: "ok", reply: value, ...base } as ChatResult;
      return { status: "ok", reply: "", ...base, ...value } as ChatResult;
    },
    writeOutcome: async (args) => {
      outcomeCalls.push(args);
      const next = outcomeScript.shift() ?? okOutcome();
      return typeof next === "function" ? next(args) : next;
    },
  });
});

afterEach(async () => {
  await settleGroupDiscussionsForTests();
  setGroupDiscussionDepsForTests(null);
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
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  return employee;
}

async function groupChat(employees: AIEmployee[] = [ada, ben, cy], members: User[] = []) {
  return createGroupChat({
    companyId: company.id,
    createdByUserId: owner.id,
    name: "Pricing",
    employeeIds: employees.map((e) => e.id),
    memberUserIds: members.map((m) => m.id),
  });
}

async function start(
  channel: Channel,
  overrides: Partial<Parameters<typeof startGroupDiscussion>[0]> = {},
) {
  return startGroupDiscussion({
    channel,
    requester: { userId: owner.id, sessionVersion: 0 },
    question: "Should we raise the Pro plan to $49?",
    minParticipants: 2,
    ...overrides,
  });
}

async function finished(id: string): Promise<GroupDiscussion> {
  await settleGroupDiscussionsForTests();
  return (await AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({ id }))!;
}

async function messagesOf(discussionId: string): Promise<ChannelMessage[]> {
  return AppDataSource.getRepository(ChannelMessage).find({
    where: { discussionId },
    order: { createdAt: "ASC" },
  });
}

const speakers = () => calls.map((c) => c.employeeId);

/** Poll until a condition holds — for work a post starts behind its response. */
async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A Member writes into the group chat; resolves once the discussion has it. */
async function memberWrites(channel: Channel, content: string): Promise<void> {
  const message = await postMessage({
    channelId: channel.id,
    companyId: company.id,
    author: { kind: "user", userId: owner.id },
    requesterSessionVersion: 0,
    content,
  });
  await waitFor(
    async () =>
      (await AppDataSource.getRepository(ChannelMessage).findOneBy({ id: message.id }))
        ?.discussionRole === "input",
    "the input to join the discussion",
  );
}

const discussionCount = () => AppDataSource.getRepository(GroupDiscussion).count();

/** A promise the test resolves, for a turn that must stay in flight. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("a discussion that converges", () => {
  test("takes turns lead first, posts what they said, and hands back the outcome", async () => {
    const channel = await groupChat();
    say(ada, "We should raise Pro to $49 — usage doubled. @ben can finance carry it?");
    say(ben, "Yes. Gross margin goes from 62% to 71%; churn would have to triple to lose money.");
    say(cy, "Sales can live with it if we grandfather annual plans for six months.");
    outcomeScript.push(
      okOutcome([
        { owner: "@ben", action: "Model the grandfathering cost." },
        { owner: "@cy", action: "Draft the customer announcement." },
        { owner: "Ruth", action: "Approve the announcement." },
      ]),
    );

    const started = await start(channel);
    assert.equal(started.status, "running");
    assert.equal(started.leadEmployeeId, ada.id);
    const d = await finished(started.id);

    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "converged");
    // Round one: everyone speaks. Round two: everyone passes, so it ends.
    assert.deepEqual(speakers(), [ada.id, ben.id, cy.id, ada.id, ben.id, cy.id]);
    assert.equal(d.round, 2);
    assert.equal(d.turnsTaken, 6);

    const rows = await messagesOf(d.id);
    assert.deepEqual(
      rows.map((m) => m.discussionRole),
      ["question", "turn", "turn", "turn", "outcome"],
      "passes are recorded, not posted",
    );
    assert.equal(rows[0].authorUserId, owner.id);
    assert.equal(rows[4].authorEmployeeId, ada.id, "the lead writes the outcome");
    assert.match(rows[4].content, /\*\*Recommendation\*\*\n\nAnnounce it on Monday\./);
    assert.match(rows[4].content, /- @ben: Model the grandfathering cost\./);

    const outcome = parseOutcome(d.outcomeJson);
    assert.ok(outcome);
    assert.equal(outcome.writtenByEmployeeId, ada.id);
    assert.deepEqual(
      outcome.actionItems.map((i) => i.owner?.id ?? null),
      [ben.id, cy.id, owner.id],
    );
    assert.equal(d.outcomeMessageId, rows[4].id);

    const state = parseDiscussionState(d.stateJson);
    assert.deepEqual(
      state.passes.map((p) => [p.employeeId, p.round]),
      [
        [ada.id, 2],
        [ben.id, 2],
        [cy.id, 2],
      ],
    );

    const bell = await AppDataSource.getRepository(Notification).find({
      where: { userId: owner.id, kind: "group_discussion" },
    });
    assert.equal(bell.length, 1, "the Member who asked hears it is done");
    assert.match(bell[0].title, /Your group discussion is done/);
    assert.equal(bell[0].link, `/c/acme/workspace/${channel.id}`);

    const audits = await AppDataSource.getRepository(AuditEvent).find({
      where: { targetId: d.id },
    });
    assert.deepEqual(audits.map((a) => a.action).sort(), [
      "group_discussion.conclude",
      "group_discussion.start",
    ]);
  });

  test("every turn talks read-only, as itself, under the Member who asked", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Opening view.");
    say(ben, "Finance view.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    for (const call of calls) {
      assert.deepEqual(call.options.collaboration, { kind: "discussion", id: d.id });
      assert.equal(call.options.requesterUserId, owner.id);
      assert.equal(call.options.requesterSessionVersion, 0);
      assert.equal("toolAuthority" in call.options && call.options.toolAuthority, false);
      assert.equal(call.options.workloadScope, `group-discussion:${d.id}`);
      assert.equal(call.options.maxSteps, 8);
      assert.match(call.options.extraSystem ?? "", /Should we raise the Pro plan to \$49\?/);
    }
    const adaBrief = calls.find((c) => c.employeeId === ada.id)!.options.extraSystem!;
    assert.match(adaBrief, /You lead this discussion/);
    assert.match(adaBrief, /- Ben \(@ben\) — CFO/);
    const benFirst = calls.find((c) => c.employeeId === ben.id)!;
    assert.match(benFirst.message, /^Round 1 of 3\. It is your turn, Ben\./);
    // Ben reads what Ada said before him.
    assert.ok(benFirst.history.some((t) => t.role === "user" && /Ada \(@ada, Head of Product\): Opening view\./.test(t.content)));
    // Ada's second turn replays her own first turn as hers.
    const adaSecond = calls.filter((c) => c.employeeId === ada.id)[1];
    assert.ok(adaSecond.history.some((t) => t.role === "assistant" && t.content === "Opening view."));
  });

  test("someone addressed by @handle answers before the others", async () => {
    const channel = await groupChat();
    say(ada, "Price question. @cy what do customers say?");
    say(cy, "They grumble but stay.");
    say(ben, "Margins are fine either way.");
    await finished((await start(channel)).id);
    assert.deepEqual(speakers().slice(0, 3), [ada.id, cy.id, ben.id]);
    const cyTurn = calls.find((c) => c.employeeId === cy.id)!;
    assert.match(cyTurn.message, /Ada asked for your view — answer them first/);
  });

  test("agreement and repeats count as nothing new", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Raise Pro to $49 and grandfather annual plans for six months so churn stays flat.");
    say(ben, "Agreed.");
    say(ada, "Raise Pro to $49 and grandfather annual plans for six months, so churn stays flat.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "repetition");
    const state = parseDiscussionState(d.stateJson);
    // Round one: Ben only agrees. Round two: Ada says it again, Ben passes.
    assert.deepEqual(
      state.passes.map((p) => [p.reason, p.round]),
      [
        ["agree", 1],
        ["repeat", 2],
        ["pass", 2],
      ],
    );
    assert.equal((await messagesOf(d.id)).filter((m) => m.discussionRole === "turn").length, 1);
  });
});

describe("bounds", () => {
  test("ends after the last round however much there is to say", async () => {
    const channel = await groupChat([ada, ben]);
    for (let i = 0; i < 5; i += 1) {
      say(ada, `Ada point ${i}: a genuinely new consideration number ${i * 7}.`);
      say(ben, `Ben point ${i}: another distinct angle on cost ${i * 11}.`);
    }
    const d = await finished((await start(channel, { maxRounds: 2 })).id);
    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "max_rounds");
    assert.equal(d.turnsTaken, 4);
    assert.deepEqual(speakers(), [ada.id, ben.id, ada.id, ben.id]);
  });

  test("the usage budget stops the rounds and still writes the outcome", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, (call) => {
      call.options.onUsage?.({ inputTokens: 700_000, outputTokens: 50_000 });
      return "A very expensive opening.";
    });
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "usage_budget");
    assert.deepEqual(speakers(), [ada.id], "no turn starts past the budget");
    assert.equal(d.tokensUsed, 750_000);
    assert.equal(outcomeCalls.length, 1, "the reserve pays for the outcome");
  });

  test("the turn ceiling stops the rounds", async () => {
    const channel = await groupChat([ada, ben, cy]);
    say(ada, async (call) => {
      const id = (call.options.collaboration as { id: string }).id;
      await AppDataSource.getRepository(GroupDiscussion).update({ id }, { maxTurns: 2 });
      return "Opening.";
    });
    say(ben, "Second.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.endReason, "turn_budget");
    assert.deepEqual(speakers(), [ada.id, ben.id]);
  });

  test("a Member's Finish ends the rounds after the turn in flight", async () => {
    const channel = await groupChat([ada, ben, cy]);
    let discussionId = "";
    say(ada, async () => {
      await wrapUpGroupDiscussion({ companyId: company.id, discussionId, userId: owner.id });
      return "Opening view.";
    });
    const started = await start(channel);
    discussionId = started.id;
    const d = await finished(started.id);
    assert.equal(d.status, "concluded");
    assert.equal(d.endReason, "wrapped_up");
    assert.deepEqual(speakers(), [ada.id]);
  });

  test("an overlong turn is clipped and says so", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "x ".repeat(5_000) + "end");
    const d = await finished((await start(channel)).id);
    const turn = (await messagesOf(d.id)).find((m) => m.discussionRole === "turn")!;
    assert.match(turn.content, /_\(Clipped to 6,000 characters\.\)_$/);
  });
});

describe("stopping", () => {
  test("Stop abandons the turn in flight, writes no outcome and says who stopped it", async () => {
    const channel = await groupChat([ada, ben, cy]);
    const inFlight = gate();
    say(ada, "Opening view.");
    say(ben, async (call) => {
      inFlight.open();
      await new Promise<void>((resolve) => call.options.signal?.addEventListener("abort", () => resolve()));
      return "A half-written thought that must never be posted.";
    });
    const started = await start(channel);
    await inFlight.opened;
    const stopped = await stopGroupDiscussion({
      companyId: company.id,
      discussionId: started.id,
      userId: teammate.id,
    });
    assert.equal(stopped.status, "stopped");
    const d = await finished(started.id);
    assert.equal(d.status, "stopped");
    assert.equal(d.endReason, "stopped");
    assert.equal(d.endDetail, "Stopped by Sam.");
    assert.equal(outcomeCalls.length, 0);
    const rows = await messagesOf(d.id);
    assert.equal(rows.some((m) => /half-written/.test(m.content)), false);
    assert.equal(rows.at(-1)?.discussionRole, "note");
    assert.equal(rows.at(-1)?.content, "Stopped by Sam.");
    assert.deepEqual(speakers(), [ada.id, ben.id], "Cy never starts");
  });

  test("Stop on a discussion that already ended is refused", async () => {
    const channel = await groupChat([ada, ben]);
    const d = await finished((await start(channel)).id);
    await assert.rejects(
      stopGroupDiscussion({ companyId: company.id, discussionId: d.id, userId: owner.id }),
      (error: unknown) => error instanceof GroupDiscussionError && error.status === 409,
    );
  });

  test("a company Standdown mid-turn ends the discussion with no outcome", async () => {
    const channel = await groupChat([ada, ben, cy]);
    say(ada, "Opening view.");
    say(ben, async (call) => {
      await placeStanddown({
        companyId: company.id,
        scope: "company",
        reason: "Quarterly audit",
        placedByUserId: owner.id,
      });
      await new Promise<void>((resolve) => call.options.signal?.addEventListener("abort", () => resolve()));
      return "Never posted.";
    });
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "stopped");
    assert.equal(d.endReason, "standdown");
    assert.match(d.endDetail ?? "", /Quarterly audit/);
    assert.equal(outcomeCalls.length, 0, "a company Standdown stops the outcome too");
    assert.deepEqual(speakers(), [ada.id, ben.id]);
  });

  test("a company Standdown before it starts stops it before any turn", async () => {
    const channel = await groupChat([ada, ben]);
    await placeStanddown({ companyId: company.id, scope: "company", reason: "Freeze" });
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "stopped");
    assert.equal(d.endReason, "standdown");
    assert.deepEqual(speakers(), []);
  });

  test("a stood-down employee sits it out, once noted, and the rest carry on", async () => {
    const channel = await groupChat([ada, ben, cy]);
    await placeStanddown({ companyId: company.id, scope: "employee", scopeId: cy.id, reason: "Retraining" });
    say(ada, "Opening view.");
    say(ben, "Finance view.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    assert.equal(speakers().includes(cy.id), false, "a stood-down employee never speaks");
    const notes = (await messagesOf(d.id)).filter((m) => m.discussionRole === "note");
    assert.deepEqual(
      notes.map((n) => n.content),
      ["Cy is stood down and is sitting this discussion out."],
    );
    const state = parseDiscussionState(d.stateJson);
    assert.ok(state.skipped.every((s) => s.employeeId === cy.id && s.reason === "standdown"));
  });

  test("a stood-down lead does not write the outcome; the next participant does", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, async () => {
      await placeStanddown({ companyId: company.id, scope: "employee", scopeId: ada.id, reason: "Paused" });
      return "Opening view.";
    });
    say(ben, "Finance view.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    assert.equal(outcomeCalls.length, 1);
    assert.equal(outcomeCalls[0].lead.id, ben.id);
    assert.equal(parseOutcome(d.outcomeJson)?.writtenByEmployeeId, ben.id);
  });

  test("everyone stood down ends it as stopped", async () => {
    const channel = await groupChat([ada, ben]);
    await placeStanddown({ companyId: company.id, scope: "employee", scopeId: ada.id, reason: "A" });
    await placeStanddown({ companyId: company.id, scope: "employee", scopeId: ben.id, reason: "B" });
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "stopped");
    assert.equal(d.endReason, "standdown");
    assert.deepEqual(speakers(), []);
  });

  test("a changed sign-in ends it: every turn runs on the Member's authority", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, async () => {
      await AppDataSource.getRepository(User).update({ id: owner.id }, { sessionVersion: 1 });
      return "Opening view.";
    });
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "stopped");
    assert.equal(d.endReason, "access_changed");
    assert.deepEqual(speakers(), [ada.id]);
  });

  test("removing the Member from the company ends it", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, async () => {
      await AppDataSource.getRepository(Membership).delete({ companyId: company.id, userId: owner.id });
      return "Opening view.";
    });
    const d = await finished((await start(channel)).id);
    assert.equal(d.endReason, "access_changed");
  });

  test("archiving the conversation ends it", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, async () => {
      await AppDataSource.getRepository(Channel).update({ id: channel.id }, { archivedAt: new Date() });
      return "Opening view.";
    });
    const d = await finished((await start(channel)).id);
    assert.equal(d.endReason, "channel_archived");
  });
});

describe("turns that cannot happen", () => {
  test("an employee with no AI Model is benched for the discussion, with a note", async () => {
    const channel = await groupChat([ada, ben]);
    say(ben, { status: "skipped", reply: "Ben has no AI Model connected." });
    say(ada, "Opening view.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    assert.equal(speakers().filter((id) => id === ben.id).length, 1, "asked once, never again");
    const state = parseDiscussionState(d.stateJson);
    assert.deepEqual(state.benched, [ben.id]);
    const notes = (await messagesOf(d.id)).filter((m) => m.discussionRole === "note");
    assert.match(notes[0].content, /Ben has no AI Model connected/);
  });

  test("a failed turn leaves a note and the discussion goes on", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, { status: "error", reply: "The AI Model request failed (HTTP 401)." });
    say(ben, "Finance view.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    const notes = (await messagesOf(d.id)).filter((m) => m.discussionRole === "note");
    assert.match(notes[0].content, /Ada couldn't take their turn: The AI Model request failed/);
  });

  test("an outcome that cannot be written by the lead falls to the next participant", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Opening view.");
    outcomeScript.push({ ok: false, error: "Ada did not submit an outcome." }, okOutcome());
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    assert.deepEqual(
      outcomeCalls.map((c) => c.lead.id),
      [ada.id, ben.id],
    );
    // The writer works from the transcript alone, in its own restricted turn.
    assert.match(outcomeCalls[0].request, /Opening view\./);
    assert.match(outcomeCalls[0].system, /submit_discussion_outcome/);
  });

  test("when nobody can write the outcome it fails honestly, and the Member hears", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Opening view.");
    outcomeScript.push(
      { ok: false, error: "No submission." },
      { ok: false, error: "Still no submission." },
    );
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "failed");
    assert.equal(d.endReason, "converged");
    assert.match(d.endDetail ?? "", /no outcome could be written: Still no submission\./);
    assert.equal(d.outcomeJson, null);
    const bell = await AppDataSource.getRepository(Notification).findOneByOrFail({ userId: owner.id });
    assert.match(bell.title, /ended without an outcome/);
  });
});

describe("taint", () => {
  test("a turn that read a web page taints what it wrote, and every turn after it", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, { reply: "The competitor page says $59.", tainted: true });
    say(ben, "Then $49 undercuts them.");
    const d = await finished((await start(channel)).id);
    assert.equal(d.tainted, true);
    const rows = await messagesOf(d.id);
    const adaTurn = rows.find((m) => m.authorEmployeeId === ada.id && m.discussionRole === "turn")!;
    const benTurn = rows.find((m) => m.authorEmployeeId === ben.id && m.discussionRole === "turn")!;
    assert.equal(adaTurn.tainted, true);
    assert.equal(benTurn.tainted, false, "Ben's own turn read no page");
    assert.equal(calls[0].options.startTainted, false);
    assert.equal(calls[1].options.startTainted, true, "Ben replayed Ada's tainted turn");
    assert.equal(rows.find((m) => m.discussionRole === "outcome")?.tainted, true);
  });
});

describe("people coming and going", () => {
  test("a turn that @mentions a colleague outside brings them in", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "This touches support. @dee how many tickets mention price?");
    say(dee, "About 40 a month.");
    const d = await finished((await start(channel)).id);
    assert.deepEqual(speakers().slice(0, 2), [ada.id, dee.id], "Dee answers first");
    const summary = await summarizeDiscussion(d);
    assert.deepEqual(
      summary.participants.map((p) => p.id),
      [ada.id, ben.id, dee.id],
    );
    const member = await AppDataSource.getRepository(ChannelMember).findOneBy({
      channelId: channel.id,
      employeeId: dee.id,
    });
    assert.ok(member, "Dee can read the room she was brought into");
    const notes = (await messagesOf(d.id)).filter((m) => m.discussionRole === "note");
    assert.deepEqual(notes.map((n) => n.content), ["Ada brought Dee into the discussion."]);
  });

  test("a Member writing mid-discussion is heard, and who they name answers next", async () => {
    const channel = await groupChat([ada, ben, cy]);
    say(ada, async () => {
      await memberWrites(channel, "Remember the EU customers. @cy what about them?");
      return "Opening view.";
    });
    say(cy, "EU customers need 30 days' notice.");
    say(ben, "Finance view.");
    const d = await finished((await start(channel)).id);
    assert.deepEqual(speakers().slice(0, 3), [ada.id, cy.id, ben.id]);
    const input = (await messagesOf(d.id)).find((m) => m.discussionRole === "input");
    assert.ok(input, "the Member's message joined the discussion");
    const cyTurn = calls.find((c) => c.employeeId === cy.id)!;
    assert.ok(
      cyTurn.history.some((t) => /\[Added to the discussion\] Ruth \(Member\): Remember the EU customers/.test(t.content)),
    );
    assert.equal(
      await discussionCount(),
      1,
      "input joins the running discussion rather than starting another",
    );
  });

  test("Member input in the last round buys one more round", async () => {
    const channel = await groupChat([ada, ben]);
    say(ada, "Ada round one, a long and specific point about pricing tiers.");
    say(ben, async () => {
      await memberWrites(channel, "What about students?");
      return "Ben round one, a different point about gross margin and churn.";
    });
    say(ada, "Students should get 50% off, it is how competitors win them.");
    say(ben, "A student tier costs us little; finance agrees with the discount.");
    const d = await finished((await start(channel, { maxRounds: 1 })).id);
    assert.equal(parseDiscussionState(d.stateJson).extraRounds, 1);
    assert.equal(d.turnsTaken, 4, "two rounds, though only one was asked for");
  });
});

describe("in a group chat", () => {
  test("a Member's message starts a discussion with the AI Employees in it", async () => {
    const channel = await groupChat([ada, ben], [teammate]);
    say(ada, "Opening view.");
    await postMessage({
      channelId: channel.id,
      companyId: company.id,
      author: { kind: "user", userId: owner.id },
      requesterSessionVersion: 0,
      content: "How should we price the Pro plan?",
    });
    // The post returns at once; the discussion runs behind it.
    await waitFor(async () => (await discussionCount()) > 0, "the discussion to start");
    const [row] = await AppDataSource.getRepository(GroupDiscussion).find();
    const d = await finished(row.id);
    assert.equal(d.status, "concluded");
    assert.equal(d.question, "How should we price the Pro plan?");
    const question = await AppDataSource.getRepository(ChannelMessage).findOneByOrFail({
      id: d.questionMessageId!,
    });
    assert.equal(question.discussionRole, "question");
    assert.equal(question.authorUserId, owner.id);
  });

  test("a message that only speaks to another person starts nothing", async () => {
    const channel = await groupChat([ada, ben], [teammate]);
    await postMessage({
      channelId: channel.id,
      companyId: company.id,
      author: { kind: "user", userId: owner.id },
      requesterSessionVersion: 0,
      content: "@sam can you look at this tomorrow?",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settleGroupDiscussionsForTests();
    assert.equal(await discussionCount(), 0);
    assert.deepEqual(speakers(), []);
  });

  test("@naming an AI Employee outside the chat brings them in to lead", async () => {
    const channel = await groupChat([ada, ben]);
    say(dee, "Support view first.");
    await postMessage({
      channelId: channel.id,
      companyId: company.id,
      author: { kind: "user", userId: owner.id },
      requesterSessionVersion: 0,
      content: "@dee what do tickets say about price?",
    });
    await waitFor(async () => (await discussionCount()) > 0, "the discussion to start");
    const [row] = await AppDataSource.getRepository(GroupDiscussion).find();
    const d = await finished(row.id);
    assert.equal(d.leadEmployeeId, dee.id);
    assert.equal(speakers()[0], dee.id);
  });
});

describe("starting", () => {
  test("one discussion at a time per conversation", async () => {
    const channel = await groupChat([ada, ben]);
    const inFlight = gate();
    say(ada, async (call) => {
      inFlight.open();
      await new Promise<void>((resolve) => call.options.signal?.addEventListener("abort", () => resolve()));
      return "x";
    });
    const first = await start(channel);
    await inFlight.opened;
    await assert.rejects(start(channel), (error: unknown) => error instanceof GroupDiscussionError && error.status === 409);
    await stopGroupDiscussion({ companyId: company.id, discussionId: first.id, userId: owner.id });
  });

  test("an explicit start needs two AI Employees, and no more than six", async () => {
    const channel = await groupChat([ada]);
    await assert.rejects(start(channel, { participantIds: [ada.id] }), /at least 2/);
    const seven = [ada, ben, cy, dee, await hire("Eve", "eve", "R"), await hire("Fay", "fay", "R"), await hire("Gus", "gus", "R")];
    await assert.rejects(start(channel, { participantIds: seven.map((e) => e.id) }), /at most 6/);
  });

  test("an AI Employee of another company cannot be named", async () => {
    const otherOwner = await insert(User, { email: "o@x.test", name: "O", passwordHash: "x" });
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: otherOwner.id });
    const stranger = await insert(AIEmployee, { companyId: other.id, name: "X", slug: "x", role: "R", soulBody: "" });
    const channel = await groupChat([ada, ben]);
    await assert.rejects(
      start(channel, { participantIds: [ada.id, stranger.id] }),
      (error: unknown) => error instanceof GroupDiscussionError && error.status === 404,
    );
  });

  test("a DM is not a place for a discussion", async () => {
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
    await assert.rejects(start(dm, { participantIds: [ada.id, ben.id] }), /group chat/);
  });

  test("a Member who cannot read the conversation cannot start one in it", async () => {
    const channel = await groupChat([ada, ben]);
    await assert.rejects(
      startGroupDiscussion({
        channel,
        requester: { userId: teammate.id, sessionVersion: 0 },
        question: "Sneaky",
        minParticipants: 2,
      }),
      (error: unknown) => error instanceof GroupDiscussionError && error.status === 404,
    );
  });

  test("in a public channel the roster joins the channel", async () => {
    const channel = await insert(Channel, {
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
    say(ada, "Opening view.");
    const d = await finished((await start(channel, { participantIds: [ada.id, ben.id] })).id);
    assert.equal(d.status, "concluded");
    const members = await AppDataSource.getRepository(ChannelMember).find({ where: { channelId: channel.id } });
    assert.deepEqual(
      members.filter((m) => m.employeeId).map((m) => m.employeeId).sort(),
      [ada.id, ben.id].sort(),
    );
  });
});

describe("starting the work", () => {
  async function concludedWithItems() {
    // Sam is in the chat too, so he can be the Member who starts the work.
    const channel = await groupChat([ada, ben, cy], [teammate]);
    say(ada, { reply: "Competitor charges $59, I read it on their site.", tainted: true });
    outcomeScript.push(
      okOutcome([
        { owner: "@ben", action: "Model the grandfathering cost." },
        { owner: "@cy", action: "Draft the customer announcement." },
        { owner: "@ben", action: "Update the forecast." },
        { owner: "Ruth", action: "Approve the announcement." },
        { owner: "@dee", action: "Not in the discussion." },
      ]),
    );
    const d = await finished((await start(channel)).id);
    assert.equal(d.status, "concluded");
    calls = [];
    return { channel, d };
  }

  test("each owner does its share as an ordinary turn, under the Member who pressed it", async () => {
    const { d } = await concludedWithItems();
    say(ben, "Modelled it: $12k over six months. Forecast updated.");
    say(cy, "Announcement drafted and waiting in the Decision stack for review.");
    const summary = await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: d.id,
      requester: { userId: teammate.id, sessionVersion: 0 },
    });
    assert.ok(summary.followThrough);
    await settleGroupDiscussionsForTests();

    assert.deepEqual(speakers().sort(), [ben.id, cy.id].sort(), "one turn per owner");
    for (const call of calls) {
      assert.equal(call.options.collaboration, undefined, "the work is not a talking turn");
      assert.equal(call.options.requesterUserId, teammate.id);
      assert.equal(call.options.startTainted, true, "the discussion read a web page");
      assert.match(call.message, /Every usual review still applies/);
    }
    const benCall = calls.find((c) => c.employeeId === ben.id)!;
    assert.match(benCall.message, /- Model the grandfathering cost\.\n- Update the forecast\./);

    const rows = await messagesOf(d.id);
    const reports = rows.filter((m) => m.discussionRole === "follow_through");
    assert.equal(reports.length, 2);
    assert.ok(reports.every((m) => m.tainted));
    const fresh = await getGroupDiscussion(company.id, d.id);
    const items = parseOutcome(fresh!.outcomeJson)!.actionItems;
    assert.deepEqual(
      items.map((i) => i.status ?? null),
      ["done", "done", "done", null, null],
    );
    assert.equal(items[4].owner, null, "an owner outside the discussion is never guessed");
  });

  test("the work starts once", async () => {
    const { d } = await concludedWithItems();
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: d.id,
      requester: { userId: owner.id, sessionVersion: 0 },
    });
    await assert.rejects(
      startDiscussionFollowThrough({
        companyId: company.id,
        discussionId: d.id,
        requester: { userId: owner.id, sessionVersion: 0 },
      }),
      (error: unknown) => error instanceof GroupDiscussionError && error.status === 409,
    );
  });

  test("a stood-down owner is skipped, a failed turn is marked failed", async () => {
    const { d } = await concludedWithItems();
    await placeStanddown({ companyId: company.id, scope: "employee", scopeId: cy.id, reason: "Paused" });
    say(ben, { status: "error", reply: "The AI Model request failed." });
    await startDiscussionFollowThrough({
      companyId: company.id,
      discussionId: d.id,
      requester: { userId: owner.id, sessionVersion: 0 },
    });
    await settleGroupDiscussionsForTests();
    const items = parseOutcome((await getGroupDiscussion(company.id, d.id))!.outcomeJson)!.actionItems;
    assert.equal(items[0].status, "failed");
    assert.equal(items[1].status, "skipped");
    assert.match(items[1].detail ?? "", /Stood down/);
    assert.deepEqual(speakers(), [ben.id]);
  });

  test("nothing to act on is refused before anything starts", async () => {
    const channel = await groupChat([ada, ben]);
    const d = await finished((await start(channel)).id);
    await assert.rejects(
      startDiscussionFollowThrough({
        companyId: company.id,
        discussionId: d.id,
        requester: { userId: owner.id, sessionVersion: 0 },
      }),
      /gives no AI Employee anything to do/,
    );
  });

  test("a Member who cannot read the conversation cannot start its work", async () => {
    const { d } = await concludedWithItems();
    const outsider = await insert(User, { email: "z@example.test", name: "Z", passwordHash: "x" });
    await insert(Membership, { companyId: company.id, userId: outsider.id, role: "member" });
    await assert.rejects(
      startDiscussionFollowThrough({
        companyId: company.id,
        discussionId: d.id,
        requester: { userId: outsider.id, sessionVersion: 0 },
      }),
      (error: unknown) => error instanceof GroupDiscussionError && error.status === 404,
    );
  });
});

describe("restarts", () => {
  test("a discussion nobody is driving any more is closed as interrupted", async () => {
    const channel = await groupChat([ada, ben]);
    const stale = await insert(GroupDiscussion, {
      companyId: company.id,
      channelId: channel.id,
      startedByUserId: owner.id,
      requesterSessionVersion: 0,
      question: "Left behind",
      participantsJson: JSON.stringify([ada.id, ben.id]),
      leadEmployeeId: ada.id,
      status: "running",
      phase: "discussing",
      round: 2,
      maxRounds: 3,
      maxTurns: 10,
      tokenBudget: 1000,
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
    });
    const fresh = await insert(GroupDiscussion, {
      companyId: company.id,
      channelId: channel.id,
      startedByUserId: owner.id,
      requesterSessionVersion: 0,
      question: "Still beating",
      participantsJson: JSON.stringify([ada.id]),
      status: "running",
      phase: "discussing",
      heartbeatAt: new Date(),
    });
    assert.equal(await sweepStaleGroupDiscussions(), 1);
    const closed = await AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({ id: stale.id });
    assert.equal(closed.status, "interrupted");
    assert.equal(closed.endReason, "restart");
    const note = (await messagesOf(stale.id)).at(-1);
    assert.match(note?.content ?? "", /cut off by a restart in round 2\. Write again to pick it up\./);
    const untouched = await AppDataSource.getRepository(GroupDiscussion).findOneByOrFail({ id: fresh.id });
    assert.equal(untouched.status, "running", "a live heartbeat is left alone");
    await AppDataSource.getRepository(GroupDiscussion).update({ id: fresh.id }, { status: "stopped" });
  });

  test("Stop on a discussion whose process died closes it on the spot", async () => {
    const channel = await groupChat([ada, ben]);
    const stale = await insert(GroupDiscussion, {
      companyId: company.id,
      channelId: channel.id,
      startedByUserId: owner.id,
      requesterSessionVersion: 0,
      question: "Orphan",
      participantsJson: JSON.stringify([ada.id, ben.id]),
      status: "running",
      phase: "discussing",
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
    });
    const stopped = await stopGroupDiscussion({ companyId: company.id, discussionId: stale.id, userId: owner.id });
    assert.equal(stopped.status, "stopped");
  });
});

describe("summaries", () => {
  test("say who is speaking, who passed and how far it has got", async () => {
    const channel = await groupChat([ada, ben]);
    const inFlight = gate();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    say(ada, "Opening view.");
    say(ben, async () => {
      inFlight.open();
      await released;
      return "Finance view.";
    });
    const started = await start(channel);
    await inFlight.opened;
    const live = await summarizeDiscussion((await getGroupDiscussion(company.id, started.id))!);
    assert.equal(live.status, "running");
    assert.equal(live.round, 1);
    assert.equal(live.rounds, 3);
    assert.equal(live.currentEmployeeId, ben.id);
    assert.deepEqual(
      live.participants.map((p) => [p.slug, p.state]),
      [
        ["ada", "spoke"],
        ["ben", "speaking"],
      ],
    );
    assert.equal(live.startedBy?.name, "Ruth");
    release();
    const d = await finished(started.id);
    const done = await summarizeDiscussion(d);
    assert.equal(done.status, "concluded");
    assert.ok(done.outcome);
    assert.equal(done.outcomeMessageId, d.outcomeMessageId);
  });
});
