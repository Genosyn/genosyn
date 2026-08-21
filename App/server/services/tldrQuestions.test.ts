import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrQuestion } from "../db/entities/TldrQuestion.js";
import { TldrQuestionMessage } from "../db/entities/TldrQuestionMessage.js";
import { User } from "../db/entities/User.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { EmployeeWorkloadBusyError } from "./workloadLeases.js";
import {
  deleteTldrQuestion,
  finalizeInterruptedTldrQuestionTurns,
  listTldrQuestions,
  MAX_QUESTIONS_PER_TLDR,
  runTldrQuestionTurn,
  type TldrQuestionTurnArgs,
} from "./tldrQuestions.js";
import { deleteUserCascade } from "./userDelete.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const NOW = new Date("2026-08-20T12:00:00.000Z");

type Fixture = {
  company: Company;
  employee: AIEmployee;
  owner: User;
  member: User;
  model: AIModel;
  tldr: Tldr;
};

async function fixture(): Promise<Fixture> {
  const owner = await insert(User, {
    email: "owner-tq@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  const member = await insert(User, {
    email: "member-tq@example.test",
    name: "Member",
    passwordHash: "x",
  });
  const company = await insert(Company, {
    name: "Acme Questions",
    slug: "acme-questions",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Chief of staff",
    soulBody: "Be clear and factual.",
  });
  const model = await insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "gpt-test",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "ciphertext" }),
    connectedAt: NOW,
    contextWindow: null,
    contextWindowSource: null,
  });
  const tldr = await insert(Tldr, {
    companyId: company.id,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeSlug: employee.slug,
    employeeRole: employee.role,
    employeeAvatarKey: null,
    status: "ready",
    triggerKind: "schedule",
    periodStart: new Date(NOW.getTime() - 86_400_000),
    periodEnd: NOW,
    title: "Daily progress",
    summary: "The team shipped the important work.",
    body: "## Done\n\nDeployment completed.",
    sourceStatsJson: "{}",
    errorMessage: "",
    finishedAt: NOW,
  });
  return { company, employee, owner, member, model, tldr };
}

/** Collects every callback the turn emits so a test can assert the grammar. */
function recorder() {
  const events: Array<[string, unknown]> = [];
  return {
    events,
    callbacks: {
      onQuestion: (q: unknown) => events.push(["question", q]),
      onUser: (m: unknown) => events.push(["user", m]),
      onWorking: (m: unknown) => events.push(["working", m]),
      onChunk: (t: string) => events.push(["chunk", t]),
      onAssistant: (m: unknown) => events.push(["assistant", m]),
    } as TldrQuestionTurnArgs["callbacks"],
  };
}

type RestrictedSeam = NonNullable<TldrQuestionTurnArgs["runRestricted"]>;
type ChatSeam = NonNullable<TldrQuestionTurnArgs["runChat"]>;

const answeringAgent =
  (
    reply = "Ship fewer things, finish more of them.",
    inspect?: (prompt: string, system: string, toolNames: string[]) => void,
  ): RestrictedSeam =>
  async (params) => {
    inspect?.(
      JSON.stringify(params.messages),
      params.system,
      params.tools.map((tool) => tool.name),
    );
    params.callbacks?.onText?.(reply);
    return { status: "ok", finalText: reply, steps: 1 };
  };

const replyingChat =
  (
    reply = "Done — I added the Routine.",
    inspect?: (args: {
      message: string;
      history: Array<{ role: string; content: string }>;
      options: Record<string, unknown>;
    }) => void,
  ): ChatSeam =>
  async (_companyId, _employeeId, message, history, onChunk, options) => {
    inspect?.({
      message,
      history: history as Array<{ role: string; content: string }>,
      options: options as unknown as Record<string, unknown>,
    });
    onChunk(reply);
    return { status: "ok", reply, attachmentIds: [], sidecars: {} };
  };

type ChatCall = {
  message: string;
  history: Array<{ role: string; content: string }>;
  options: Record<string, unknown>;
};

/** A recorder for what the chat seam was actually called with. */
function capture() {
  const calls: ChatCall[] = [];
  return {
    calls,
    record: (call: ChatCall) => calls.push(call),
    only(): ChatCall {
      assert.equal(calls.length, 1, "expected exactly one chat-seam call");
      return calls[0];
    },
  };
}

async function ask(
  f: Fixture,
  prompt: string,
  overrides: Partial<TldrQuestionTurnArgs> = {},
): Promise<TldrQuestion> {
  await runTldrQuestionTurn({
    companyId: f.company.id,
    tldrId: f.tldr.id,
    prompt,
    userId: f.owner.id,
    requesterSessionVersion: 1,
    callbacks: recorder().callbacks,
    runRestricted: answeringAgent(),
    ...overrides,
  });
  return AppDataSource.getRepository(TldrQuestion).findOneByOrFail({
    tldrId: f.tldr.id,
    prompt,
  });
}

describe("asking a question about a TLDR", () => {
  test("creates one card, seeds the prompt row, and finalizes the answer in place", async () => {
    const f = await fixture();
    const rec = recorder();

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      prompt: "What can be improved?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: rec.callbacks,
      runRestricted: answeringAgent(),
    });

    assert.deepEqual(
      rec.events.map(([name]) => name),
      ["question", "working", "chunk", "assistant"],
    );

    const cards = await AppDataSource.getRepository(TldrQuestion).find();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].prompt, "What can be improved?");
    assert.equal(cards[0].employeeId, f.employee.id);
    assert.equal(cards[0].createdByUserId, f.owner.id);

    // The seeded prompt row and exactly one assistant row — the `working` row
    // is updated in place rather than joined by a second reply.
    const rows = await AppDataSource.getRepository(TldrQuestionMessage).find({
      order: { createdAt: "ASC" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, cards[0].promptMessageId);
    assert.equal(rows[0].role, "user");
    assert.equal(rows[1].role, "assistant");
    assert.equal(rows[1].status, "ok");
    assert.equal(rows[1].content, "Ship fewer things, finish more of them.");
    assert.equal(rows[1].modelId, f.model.id);
  });

  test("answers with no tools at all, so a card can never become a way to act", async () => {
    const f = await fixture();
    let toolNames: string[] | null = null;

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      prompt: "What should we stop doing?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runRestricted: answeringAgent("Stop the weekly status meeting.", (_p, _s, names) => {
        toolNames = names;
      }),
    });

    assert.deepEqual(toolNames, []);
  });

  test("hands the briefing over as untrusted reference data, never as a discussion link", async () => {
    const f = await fixture();
    let prompt = "";
    let system = "";

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      prompt: "What is the biggest risk?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runRestricted: answeringAgent("Deployment fragility.", (p, s) => {
        prompt = p;
        system = s;
      }),
    });

    assert.match(prompt, /UNTRUSTED TLDR REFERENCE DATA/);
    assert.match(prompt, /Deployment completed/);
    // The chat seam short-circuits on a `[TLDR](/c/…/tldrs#tldr-…)` link into a
    // bound, read-only turn. Composing that shape here would strip the tools a
    // follow-up depends on, so the context block must never contain it.
    assert.doesNotMatch(prompt, /\/tldrs#tldr-/);
    assert.match(system, /no tools on this turn/);
  });

  test("caps the number of cards per briefing", async () => {
    const f = await fixture();
    for (let i = 0; i < MAX_QUESTIONS_PER_TLDR; i += 1) {
      await ask(f, `Question ${i}`);
    }

    await assert.rejects(
      () => ask(f, "One too many"),
      /already has 12 question cards/,
    );
  });

  test("refuses a briefing from another company, and one that is not ready", async () => {
    const f = await fixture();
    const other = await insert(Company, {
      name: "Other",
      slug: "other-questions",
      ownerId: f.owner.id,
    });
    const draft = await insert(Tldr, {
      companyId: f.company.id,
      employeeId: f.employee.id,
      employeeName: f.employee.name,
      employeeSlug: f.employee.slug,
      employeeRole: f.employee.role,
      employeeAvatarKey: null,
      status: "generating",
      triggerKind: "manual",
      periodStart: NOW,
      periodEnd: NOW,
      title: "",
      summary: "",
      body: "",
      sourceStatsJson: "{}",
      errorMessage: "",
      finishedAt: null,
    });

    const base = {
      prompt: "What can be improved?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runRestricted: answeringAgent(),
    };
    await assert.rejects(
      () => runTldrQuestionTurn({ ...base, companyId: other.id, tldrId: f.tldr.id }),
      /TLDR not found/,
    );
    await assert.rejects(
      () => runTldrQuestionTurn({ ...base, companyId: f.company.id, tldrId: draft.id }),
      /TLDR not found/,
    );
  });

  test("refuses a new card once the writing employee is gone, but keeps the old ones readable", async () => {
    const f = await fixture();
    await ask(f, "What can be improved?");
    await AppDataSource.getRepository(Tldr).update({ id: f.tldr.id }, { employeeId: null });

    await assert.rejects(
      () => ask(f, "And what else?"),
      /can no longer answer questions/,
    );

    const listed = await listTldrQuestions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      userId: f.owner.id,
    });
    assert.equal(listed.canAsk, false);
    assert.equal(listed.questions.length, 1);
    // The stored snapshot still names who answered, even with no live pin.
    assert.equal(listed.questions[0].employee.name, "Rey");
    assert.equal(listed.questions[0].employee.id, null);
  });
});

describe("discussing a card", () => {
  test("runs the ordinary chat seam with the action tools and the Member's own authority", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    const seen = capture();

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "Add a routine for that.",
      userId: f.owner.id,
      requesterSessionVersion: 7,
      callbacks: recorder().callbacks,
      runChat: replyingChat("Added.", seen.record),
    });

    const captured = seen.only();
    assert.ok((captured.options.extraToolset as string[]).includes("create_routine"));
    assert.equal(captured.options.throwOnWorkloadUnavailable, true);
    assert.equal(captured.options.requesterUserId, f.owner.id);
    assert.equal(captured.options.requesterSessionVersion, 7);
    // Passing `surface: "chat"` would divert this turn into the bound,
    // read-only TLDR-link path and take every action tool with it.
    assert.equal(captured.options.surface, undefined);
    assert.match(captured.options.extraSystem as string, /can delegate company automation/);

    // The lease is keyed to the durable row, so recovery can free it.
    const working = await AppDataSource.getRepository(TldrQuestionMessage).findOneByOrFail({
      questionId: card.id,
      role: "assistant",
      content: "Added.",
    });
    assert.equal(captured.options.workloadKey, working.id);
  });

  test("sends the model exactly the message it persisted in the thread", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    const seen = capture();
    // Leading/trailing slop the persist path trims; the model must see the
    // same string the transcript shows, or the Member cannot trust either.
    const typed = "   Add a routine for that.   ";

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: typed,
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runChat: replyingChat("Added.", seen.record),
    });

    const persisted = await AppDataSource.getRepository(TldrQuestionMessage).findOneByOrFail({
      questionId: card.id,
      role: "user",
      content: "Add a routine for that.",
    });
    assert.ok(seen.only().message.endsWith(persisted.content));
    assert.doesNotMatch(seen.only().message, / {3}Add a routine/);
  });

  test("tells the employee not to promise automation a plain Member cannot delegate", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    let extraSystem = "";

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "Add a routine for that.",
      userId: f.member.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runChat: replyingChat("An owner or admin needs to schedule this.", (args) => {
        extraSystem = args.options.extraSystem as string;
      }),
    });

    assert.match(extraSystem, /cannot delegate company automation tools/);
  });

  test("replays prior turns as speech but never the context block or an in-flight row", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    const repo = AppDataSource.getRepository(TldrQuestionMessage);
    // A sibling turn that is still running has an empty placeholder row.
    await insert(TldrQuestionMessage, {
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      role: "assistant",
      employeeId: f.employee.id,
      modelId: null,
      content: "",
      status: "working",
      actionsJson: "",
      createdByUserId: null,
    });
    const seen = capture();

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "Why?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runChat: replyingChat("Because throughput beats starts.", seen.record),
    });

    const captured = seen.only();
    assert.deepEqual(captured.history, [
      { role: "user", content: "What can be improved?" },
      { role: "assistant", content: "Ship fewer things, finish more of them." },
    ]);
    // Exactly one copy of the briefing is ever in the window, and it is on the
    // current message rather than compounding through history.
    assert.match(captured.message, /UNTRUSTED TLDR REFERENCE DATA/);
    assert.match(captured.message, /Why\?$/);
    for (const turn of captured.history) {
      assert.doesNotMatch(turn.content, /UNTRUSTED TLDR REFERENCE DATA/);
    }

    assert.equal(await repo.countBy({ questionId: card.id, status: "working" }), 1);
  });

  test("waits for a busy employee, then records an honest skip rather than a failure", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    let attempts = 0;
    const busyOnce: ChatSeam = async (_c, _e, _m, _h, onChunk) => {
      attempts += 1;
      if (attempts === 1) throw new EmployeeWorkloadBusyError();
      onChunk("Here you go.");
      return { status: "ok", reply: "Here you go.", attachmentIds: [], sidecars: {} };
    };

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "Why?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runChat: busyOnce,
      busyRetryDelayMs: 1,
      busyMaxWaitMs: 5_000,
    });
    assert.equal(attempts, 2);

    const alwaysBusy: ChatSeam = async () => {
      throw new EmployeeWorkloadBusyError();
    };
    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "And again?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runChat: alwaysBusy,
      busyRetryDelayMs: 1,
      busyMaxWaitMs: 5,
    });

    const rows = await AppDataSource.getRepository(TldrQuestionMessage).find({
      where: { questionId: card.id, role: "assistant" },
      order: { createdAt: "ASC" },
    });
    assert.equal(rows.at(-1)!.status, "skipped");
    assert.match(rows.at(-1)!.content, /was busy with another conversation/);
  });

  test("a throwing turn finalizes its own row instead of leaving a spinner", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    const exploding: ChatSeam = async () => {
      throw new Error("provider exploded");
    };

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "Why?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: recorder().callbacks,
      runChat: exploding,
    });

    const rows = await AppDataSource.getRepository(TldrQuestionMessage).find({
      where: { questionId: card.id, role: "assistant" },
      order: { createdAt: "ASC" },
    });
    assert.equal(rows.at(-1)!.status, "error");
    assert.match(rows.at(-1)!.content, /provider exploded/);
    assert.equal(
      await AppDataSource.getRepository(TldrQuestionMessage).countBy({ status: "working" }),
      0,
    );
  });

  test("rejects a card that belongs to a different briefing", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    const otherTldr = await insert(Tldr, {
      companyId: f.company.id,
      employeeId: f.employee.id,
      employeeName: f.employee.name,
      employeeSlug: f.employee.slug,
      employeeRole: f.employee.role,
      employeeAvatarKey: null,
      status: "ready",
      triggerKind: "manual",
      periodStart: NOW,
      periodEnd: NOW,
      title: "Another",
      summary: "Another",
      body: "Another",
      sourceStatsJson: "{}",
      errorMessage: "",
      finishedAt: NOW,
    });

    await assert.rejects(
      () =>
        runTldrQuestionTurn({
          companyId: f.company.id,
          tldrId: otherTldr.id,
          questionId: card.id,
          message: "Why?",
          userId: f.owner.id,
          requesterSessionVersion: 1,
          callbacks: recorder().callbacks,
          runChat: replyingChat(),
        }),
      /Question not found/,
    );
  });
});

describe("card housekeeping", () => {
  test("the asker can remove their own card; another Member cannot; an admin can", async () => {
    const f = await fixture();
    const mine = await ask(f, "What can be improved?");
    const theirs = await ask(f, "What should we stop doing?", { userId: f.member.id });

    await assert.rejects(
      () =>
        deleteTldrQuestion({
          companyId: f.company.id,
          tldrId: f.tldr.id,
          questionId: theirs.id,
          userId: f.owner.id,
          isAdmin: false,
        }),
      /Only the Member who asked/,
    );

    await deleteTldrQuestion({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: mine.id,
      userId: f.owner.id,
      isAdmin: false,
    });
    await deleteTldrQuestion({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: theirs.id,
      userId: f.owner.id,
      isAdmin: true,
    });

    assert.equal(await AppDataSource.getRepository(TldrQuestion).count(), 0);
    // The thread goes with the card rather than outliving it.
    assert.equal(await AppDataSource.getRepository(TldrQuestionMessage).count(), 0);
  });

  test("deleting the asking Member keeps the card and unlinks the author", async () => {
    const f = await fixture();
    await ask(f, "What can be improved?", { userId: f.member.id });

    await deleteUserCascade({ userId: f.member.id });

    const card = await AppDataSource.getRepository(TldrQuestion).findOneByOrFail({
      tldrId: f.tldr.id,
    });
    assert.equal(card.createdByUserId, null);
    assert.equal(card.prompt, "What can be improved?");
  });

  test("a card removed mid-answer ends the turn quietly instead of surfacing ORM internals", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    let assistantEvents = 0;

    // The Member confirms the delete while the reply is still streaming.
    const deletingChat: ChatSeam = async () => {
      await deleteTldrQuestion({
        companyId: f.company.id,
        tldrId: f.tldr.id,
        questionId: card.id,
        userId: f.owner.id,
        isAdmin: false,
      });
      return { status: "ok", reply: "Too late.", attachmentIds: [], sidecars: {} };
    };

    await runTldrQuestionTurn({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      message: "Why?",
      userId: f.owner.id,
      requesterSessionVersion: 1,
      callbacks: {
        ...recorder().callbacks,
        onAssistant: () => {
          assistantEvents += 1;
        },
      },
      runChat: deletingChat,
    });

    // The card is gone, so there is no bubble to finalize and nothing to say
    // about it — the turn must not throw TypeORM's EntityNotFoundError at the
    // Member who deliberately deleted the thing.
    assert.equal(assistantEvents, 0);
    assert.equal(await AppDataSource.getRepository(TldrQuestion).count(), 0);
    assert.equal(await AppDataSource.getRepository(TldrQuestionMessage).count(), 0);
  });

  test("boot recovery closes an abandoned turn and frees its reply lease", async () => {
    const f = await fixture();
    const card = await ask(f, "What can be improved?");
    const stranded = await insert(TldrQuestionMessage, {
      companyId: f.company.id,
      tldrId: f.tldr.id,
      questionId: card.id,
      role: "assistant",
      employeeId: f.employee.id,
      modelId: null,
      content: "",
      status: "working",
      actionsJson: "",
      createdByUserId: null,
    });
    await insert(WorkloadLease, {
      companyId: f.company.id,
      employeeId: f.employee.id,
      kind: "chat",
      ownerKey: stranded.id,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });

    assert.equal(await finalizeInterruptedTldrQuestionTurns(), 1);

    const repo = AppDataSource.getRepository(TldrQuestionMessage);
    const closed = await repo.findOneByOrFail({ id: stranded.id });
    assert.equal(closed.status, "error");
    assert.match(closed.content, /Genosyn restarted/);
    assert.equal(await AppDataSource.getRepository(WorkloadLease).count(), 0);

    // A finished answer is left exactly as it was.
    const answered = await repo.findOneByOrFail({ questionId: card.id, status: "ok" });
    assert.equal(answered.content, "Ship fewer things, finish more of them.");
    assert.equal(await finalizeInterruptedTldrQuestionTurns(), 0);
  });

  test("the card list hides the seeded prompt row and reports the Member's automation reach", async () => {
    const f = await fixture();
    await ask(f, "What can be improved?");

    const asOwner = await listTldrQuestions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      userId: f.owner.id,
    });
    assert.equal(asOwner.questions.length, 1);
    assert.equal(asOwner.canAsk, true);
    assert.equal(asOwner.canDelegateAutomation, true);
    // Only the answer — the question itself is the card's header.
    assert.deepEqual(
      asOwner.questions[0].messages.map((m) => m.role),
      ["assistant"],
    );

    const asMember = await listTldrQuestions({
      companyId: f.company.id,
      tldrId: f.tldr.id,
      userId: f.member.id,
    });
    assert.equal(asMember.canDelegateAutomation, false);
  });
});
