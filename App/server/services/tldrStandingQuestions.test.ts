import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrQuestion } from "../db/entities/TldrQuestion.js";
import { TldrStandingQuestion } from "../db/entities/TldrStandingQuestion.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { TldrQuestionTurnArgs } from "./tldrQuestions.js";
import {
  answerStandingQuestions,
  listStandingQuestions,
  MAX_STANDING_QUESTIONS,
  replaceStandingQuestions,
  retireStaleStandingClaims,
  sweepPendingStandingQuestions,
  TldrStandingQuestionValidationError,
} from "./tldrStandingQuestions.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const NOW = new Date("2026-08-21T09:00:00.000Z");

type Fixture = { company: Company; employee: AIEmployee; owner: User; tldr: Tldr };

async function fixture(): Promise<Fixture> {
  const owner = await insert(User, {
    email: "owner-sq@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  const company = await insert(Company, {
    name: "Acme Standing",
    slug: "acme-standing",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Chief of staff",
    soulBody: "Be clear.",
  });
  await insert(AIModel, {
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
    summary: "The team shipped.",
    body: "## Done\n\nDeployment completed.",
    sourceStatsJson: "{}",
    errorMessage: "",
    finishedAt: NOW,
    standingAnsweredAt: null,
    // Pin the row's own clock to the fixture's: the sweep windows on
    // `createdAt`, so a database-stamped value would leave these tests passing
    // only while real time sat near NOW.
    createdAt: NOW,
  });
  return { company, employee, owner, tldr };
}

/** Records what the pass asked the turn runner to do, without running a model. */
function turnRecorder() {
  const calls: TldrQuestionTurnArgs[] = [];
  const runTurn = async (args: TldrQuestionTurnArgs) => {
    calls.push(args);
  };
  return { calls, runTurn: runTurn as typeof import("./tldrQuestions.js").runTldrQuestionTurn };
}

describe("standing question list", () => {
  test("creates, orders, and reports questions back", async () => {
    const f = await fixture();
    const saved = await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "What should we stop doing?", enabled: true },
        { prompt: "What needs a decision from me?", enabled: false },
      ],
    });
    assert.equal(saved.length, 2);
    assert.deepEqual(
      saved.map((q) => [q.prompt, q.enabled, q.position]),
      [
        ["What should we stop doing?", true, 0],
        ["What needs a decision from me?", false, 1],
      ],
    );
  });

  test("a second save reorders in place instead of duplicating", async () => {
    const f = await fixture();
    const first = await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "First", enabled: true },
        { prompt: "Second", enabled: true },
      ],
    });
    const reordered = await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { id: first[1].id, prompt: "Second", enabled: true },
        { id: first[0].id, prompt: "First renamed", enabled: false },
      ],
    });
    assert.equal(reordered.length, 2);
    assert.deepEqual(
      reordered.map((q) => [q.id, q.prompt, q.enabled]),
      [
        [first[1].id, "Second", true],
        [first[0].id, "First renamed", false],
      ],
    );
    assert.equal(
      await AppDataSource.getRepository(TldrStandingQuestion).countBy({ companyId: f.company.id }),
      2,
    );
  });

  test("omitting a question deletes it", async () => {
    const f = await fixture();
    const saved = await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "Keep me", enabled: true },
        { prompt: "Drop me", enabled: true },
      ],
    });
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ id: saved[0].id, prompt: "Keep me", enabled: true }],
    });
    const remaining = await listStandingQuestions(f.company.id);
    assert.deepEqual(
      remaining.map((q) => q.prompt),
      ["Keep me"],
    );
  });

  test("blank and duplicate questions are dropped rather than stored", async () => {
    const f = await fixture();
    const saved = await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "What should we stop doing?", enabled: true },
        { prompt: "   ", enabled: true },
        { prompt: "what should we STOP doing?", enabled: true },
      ],
    });
    assert.deepEqual(
      saved.map((q) => q.prompt),
      ["What should we stop doing?"],
    );
  });

  test("an id from another company is treated as a new question, never adopted", async () => {
    const f = await fixture();
    const other = await insert(Company, {
      name: "Other co",
      slug: "other-co",
      ownerId: f.owner.id,
    });
    const foreign = await insert(TldrStandingQuestion, {
      companyId: other.id,
      prompt: "Theirs",
      enabled: true,
      position: 0,
      createdByUserId: f.owner.id,
    });
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ id: foreign.id, prompt: "Mine", enabled: true }],
    });
    const theirs = await AppDataSource.getRepository(TldrStandingQuestion).findOneBy({
      id: foreign.id,
    });
    assert.equal(theirs?.companyId, other.id, "the other company's row must be untouched");
    assert.equal(theirs?.prompt, "Theirs");
    const mine = await listStandingQuestions(f.company.id);
    assert.deepEqual(
      mine.map((q) => q.prompt),
      ["Mine"],
    );
  });

  test("refuses more than the ceiling", async () => {
    const f = await fixture();
    await assert.rejects(
      replaceStandingQuestions({
        companyId: f.company.id,
        userId: f.owner.id,
        questions: Array.from({ length: MAX_STANDING_QUESTIONS + 1 }, (_, index) => ({
          prompt: `Question ${index}`,
          enabled: true,
        })),
      }),
      TldrStandingQuestionValidationError,
    );
  });
});

describe("answering a briefing's standing questions", () => {
  test("answers only the enabled ones, in order, as standing cards", async () => {
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "What should we stop doing?", enabled: true },
        { prompt: "Paused question", enabled: false },
        { prompt: "What is the biggest risk?", enabled: true },
      ],
    });
    const recorder = turnRecorder();
    const answered = await answerStandingQuestions(f.tldr.id, {
      runTurn: recorder.runTurn,
      now: () => NOW,
    });

    assert.equal(answered, 2);
    assert.deepEqual(
      recorder.calls.map((call) => call.prompt),
      ["What should we stop doing?", "What is the biggest risk?"],
    );
    for (const call of recorder.calls) {
      assert.equal(call.origin, "standing");
      assert.equal(call.userId, null, "a standing answer has no Member behind it");
      assert.equal(call.questionId, undefined, "the pass creates cards, never replies on one");
      assert.equal(call.message, undefined);
    }
  });

  test("stamps the briefing so the pass is claimed exactly once", async () => {
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    const first = turnRecorder();
    assert.equal(
      await answerStandingQuestions(f.tldr.id, { runTurn: first.runTurn, now: () => NOW }),
      1,
    );
    const stamped = await AppDataSource.getRepository(Tldr).findOneBy({ id: f.tldr.id });
    assert.ok(stamped?.standingAnsweredAt, "the pass must leave a durable cursor");

    const second = turnRecorder();
    assert.equal(
      await answerStandingQuestions(f.tldr.id, { runTurn: second.runTurn, now: () => NOW }),
      0,
    );
    assert.equal(second.calls.length, 0, "a claimed briefing must not answer twice");
  });

  test("a company with no standing questions is stamped without running anything", async () => {
    const f = await fixture();
    const recorder = turnRecorder();
    assert.equal(
      await answerStandingQuestions(f.tldr.id, { runTurn: recorder.runTurn, now: () => NOW }),
      0,
    );
    assert.equal(recorder.calls.length, 0);
    const stamped = await AppDataSource.getRepository(Tldr).findOneBy({ id: f.tldr.id });
    assert.ok(stamped?.standingAnsweredAt, "an empty list must not stay a sweep candidate");
  });

  test("one question failing does not stop the rest", async () => {
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "Explodes", enabled: true },
        { prompt: "Succeeds", enabled: true },
      ],
    });
    const seen: string[] = [];
    const runTurn = (async (args: TldrQuestionTurnArgs) => {
      seen.push(args.prompt ?? "");
      if (args.prompt === "Explodes") throw new Error("model unavailable");
    }) as typeof import("./tldrQuestions.js").runTldrQuestionTurn;

    const answered = await answerStandingQuestions(f.tldr.id, { runTurn, now: () => NOW });
    assert.equal(answered, 1);
    assert.deepEqual(seen, ["Explodes", "Succeeds"]);
  });

  test("a briefing that is not ready is never answered", async () => {
    const f = await fixture();
    await AppDataSource.getRepository(Tldr).update({ id: f.tldr.id }, { status: "failed" });
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    const recorder = turnRecorder();
    assert.equal(
      await answerStandingQuestions(f.tldr.id, { runTurn: recorder.runTurn, now: () => NOW }),
      0,
    );
    assert.equal(recorder.calls.length, 0);
  });

  test("standing questions never crowd out the per-briefing card ceiling", async () => {
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [
        { prompt: "First", enabled: true },
        { prompt: "Second", enabled: true },
      ],
    });
    // A brief already full of Member-asked cards leaves no room.
    for (let index = 0; index < 12; index += 1) {
      await insert(TldrQuestion, {
        companyId: f.company.id,
        tldrId: f.tldr.id,
        employeeId: f.employee.id,
        prompt: `Asked ${index}`,
        origin: "member",
        standingQuestionId: null,
        promptMessageId: null,
        createdByUserId: f.owner.id,
      });
    }
    const recorder = turnRecorder();
    assert.equal(
      await answerStandingQuestions(f.tldr.id, { runTurn: recorder.runTurn, now: () => NOW }),
      0,
    );
    assert.equal(recorder.calls.length, 0);
  });
});

describe("standing question recovery", () => {
  /** Captures what the sweep handed off, in place of fire-and-forget model work. */
  function dispatchRecorder() {
    const dispatched: string[] = [];
    return { dispatched, dispatch: (tldrId: string) => dispatched.push(tldrId) };
  }

  test("the sweep hands off a recent briefing whose pass never ran", async () => {
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    const recorder = dispatchRecorder();
    assert.equal(await sweepPendingStandingQuestions(NOW, recorder), 1);
    assert.deepEqual(recorder.dispatched, [f.tldr.id]);
  });

  test("the sweep never waits on the model turns it starts", async () => {
    // The cron heartbeat holds the scheduler lease for as long as this call
    // takes, so a pass that blocks here starves every other phase behind prose
    // generation. Proven by a dispatch that never settles: the sweep must
    // still return.
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    let started = false;
    const swept = await sweepPendingStandingQuestions(NOW, {
      dispatch: () => {
        started = true;
        void new Promise<void>(() => {});
      },
    });
    assert.equal(swept, 1);
    assert.equal(started, true);
  });

  test("the sweep leaves briefings older than its window alone", async () => {
    const f = await fixture();
    await replaceStandingQuestions({
      companyId: f.company.id,
      userId: f.owner.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    const recorder = dispatchRecorder();
    const wayLater = new Date(NOW.getTime() + 48 * 60 * 60_000);
    assert.equal(await sweepPendingStandingQuestions(wayLater, recorder), 0);
    assert.deepEqual(
      recorder.dispatched,
      [],
      "turning questions on today must not back-fill history",
    );
  });

  test("retirement stamps briefings the sweep will never reach again", async () => {
    const f = await fixture();
    const wayLater = new Date(NOW.getTime() + 48 * 60 * 60_000);
    assert.equal(await retireStaleStandingClaims(wayLater), 1);
    const stamped = await AppDataSource.getRepository(Tldr).findOneBy({ id: f.tldr.id });
    assert.ok(stamped?.standingAnsweredAt);
    assert.equal(await retireStaleStandingClaims(wayLater), 0, "retirement must be idempotent");
  });
});
