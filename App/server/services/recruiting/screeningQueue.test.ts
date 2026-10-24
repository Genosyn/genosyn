import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { Company } from "../../db/entities/Company.js";
import { Notification } from "../../db/entities/Notification.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import { RecruitingApplicationEvent } from "../../db/entities/RecruitingApplicationEvent.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingScorecard } from "../../db/entities/RecruitingScorecard.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import type { OpeningCriterion } from "../../../shared/recruiting.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { withSubscriptionModelLock } from "../codexSubscription.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "../standdowns.js";
import {
  setCriteriaDraftRunnerForTests,
  setScreenRunnerForTests,
  type ScreenOutcome,
  type ScreenRunner,
  type ScreenRunnerArgs,
} from "./screening.js";
import {
  MAX_SCREEN_ATTEMPTS,
  STALE_RUNNING_MS,
  enqueueScreen,
  reclaimStaleScreens,
  runScreeningQueueOnce,
  setScreeningAutoKickForTests,
} from "./screeningQueue.js";

/**
 * The screening queue (`services/recruiting/screeningQueue.ts`): the durable
 * line between an Application arriving and its AI screen, kept on the
 * Application row itself.
 *
 * What is pinned here is what keeps the queue honest across restarts and
 * replicas: a screen is claimed `queued → running` by exactly one drain; a
 * screen that errs is retried after a growing pause and, after
 * {@link MAX_SCREEN_ATTEMPTS}, shown as failed — never scored low; a missing
 * screener or model fails at once, because no retry can fix it; a Standdown
 * defers the screen without spending an attempt, because work a person
 * stopped is waiting, not failing; and a running screen whose process died
 * is put back after {@link STALE_RUNNING_MS}.
 *
 * The model is faked through `setScreenRunnerForTests`, the queue is driven
 * by hand with `runScreeningQueueOnce`, and the automatic kick stays off
 * except in the one test about it. `bootScreeningQueue`'s timer is never
 * started.
 */

const CRITERIA: OpeningCriterion[] = [
  { id: "crit-ts", name: "TypeScript", description: "Ships production TypeScript.", importance: "must_have" },
  { id: "crit-pg", name: "Postgres", description: "Tunes slow queries.", importance: "important" },
  { id: "crit-oss", name: "Open source", description: "Maintains a public project.", importance: "nice_to_have" },
];

const MINUTE = 60_000;
const STANDDOWN_RECHECK_MS = 5 * MINUTE;

let company: Company;
let screener: AIEmployee;
let model: AIModel;
let settings: RecruitingSettings;
let opening: RecruitingOpening;

/** Every screen the fake model was asked for, in order. */
let calls: ScreenRunnerArgs[] = [];
/** What the fake model does with the next screen. */
let behaviour: ScreenRunner;

/** Rate every criterion the same: 3 is a 100 (strong), 2 a 67 (good). */
function rateAll(rating: 0 | 1 | 2 | 3): ScreenRunner {
  return async (args) => ({
    ratings: args.criteria.map((criterion) => ({ criterionId: criterion.id, rating, evidence: [], note: "" })),
    summary: `Rated ${rating} across the board.`,
    strengths: [],
    concerns: [],
    interviewQuestions: [],
    injectionDetected: false,
  });
}

function failing(message: string): ScreenRunner {
  return async () => {
    throw new Error(message);
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed(): Promise<void> {
  company = await insert(Company, { name: "Analytical Engines Ltd", slug: "analytical-engines", ownerId: "owner-1" });
  screener = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rita Reviewer",
    slug: "rita-reviewer",
    role: "Talent partner",
  });
  model = await insertEmployeeModel({
    employeeId: screener.id,
    provider: "anthropic",
    model: "claude-test-model",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
  });
  settings = await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: screener.id });
  opening = await insert(RecruitingOpening, {
    companyId: company.id,
    slug: "backend-engineer",
    title: "Backend Engineer",
    status: "open",
    description: "Own the billing platform: TypeScript services on Postgres.",
    criteriaJson: JSON.stringify(CRITERIA),
  });
}

/**
 * An Application in whatever queue state a test needs. The location names it,
 * so a test can tell from the fake model's arguments which one it was shown.
 */
async function applicant(
  label: string,
  overrides: Partial<RecruitingApplication> = {},
): Promise<RecruitingApplication> {
  return insert(RecruitingApplication, {
    companyId: company.id,
    openingId: opening.id,
    candidateName: "Ada Lovelace",
    candidateEmail: `${label.toLowerCase()}@example.com`,
    candidateLocation: label,
    stageChangedAt: new Date(),
    resumeText: "Built a TypeScript billing service on Postgres.",
    resumeTextStatus: "extracted",
    ...overrides,
  });
}

/** Queued and due a second ago, as `enqueueScreen` leaves it. */
async function queued(label: string, overrides: Partial<RecruitingApplication> = {}): Promise<RecruitingApplication> {
  return applicant(label, {
    screenStatus: "queued",
    screenQueuedAt: new Date(Date.now() - 1_000),
    ...overrides,
  });
}

async function reload(id: string): Promise<RecruitingApplication> {
  return AppDataSource.getRepository(RecruitingApplication).findOneByOrFail({ id });
}

/** Let the clock run out on a pause without waiting for it. */
async function makeDue(id: string): Promise<void> {
  await AppDataSource.getRepository(RecruitingApplication).update(
    { id },
    { screenQueuedAt: new Date(Date.now() - 1_000) },
  );
}

async function scorecardCount(applicationId: string): Promise<number> {
  return AppDataSource.getRepository(RecruitingScorecard).countBy({ applicationId });
}

async function timeline(applicationId: string): Promise<RecruitingApplicationEvent[]> {
  return AppDataSource.getRepository(RecruitingApplicationEvent).find({
    where: { applicationId },
    order: { occurredAt: "ASC" },
  });
}

/** `at` lies within [from, to], give or take the database's clock precision. */
function assertBetween(at: Date | null, from: number, to: number, what: string): void {
  assert.ok(at instanceof Date, `${what} is set`);
  const time = at.getTime();
  assert.ok(time >= from - 5 && time <= to + 5, `${what}: ${at.toISOString()} not within the expected window`);
}

/** Run one pass and report when it ran, for checking the pause it chose. */
async function pass(): Promise<{ outcomes: ScreenOutcome[]; started: number; finished: number }> {
  const started = Date.now();
  const outcomes = await runScreeningQueueOnce();
  return { outcomes, started, finished: Date.now() };
}

before(async () => {
  await initTestDb();
  setScreeningAutoKickForTests(false);
});

after(async () => {
  setScreeningAutoKickForTests(true);
  setScreenRunnerForTests(null);
  setCriteriaDraftRunnerForTests(null);
  stopStanddowns();
  await closeTestDb();
});

beforeEach(async () => {
  stopStanddowns();
  await resetTestDb();
  await seed();
  calls = [];
  behaviour = rateAll(2);
  setScreenRunnerForTests(async (args) => {
    calls.push(args);
    return behaviour(args);
  });
  setCriteriaDraftRunnerForTests(async () => {
    throw new Error("these Openings have criteria; nothing should be drafted");
  });
});

afterEach(() => {
  setScreeningAutoKickForTests(false);
  setScreenRunnerForTests(null);
  setCriteriaDraftRunnerForTests(null);
  stopStanddowns();
});

describe("enqueueScreen", () => {
  test("queues the Application now and clears what the last screen left behind", async () => {
    const row = await applicant("Lisbon", {
      screenStatus: "failed",
      screenAttempts: 2,
      screenQueuedAt: new Date(Date.now() - 60 * MINUTE),
      screenStartedAt: new Date(Date.now() - 30 * MINUTE),
      screenError: "The screen took too long.",
    });
    const started = Date.now();
    await enqueueScreen(row.id);
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "queued");
    assertBetween(current.screenQueuedAt, started, Date.now(), "screenQueuedAt");
    assert.equal(current.screenStartedAt, null);
    assert.equal(current.screenError, "");
    assert.equal(current.screenAttempts, 2, "a plain re-queue keeps the attempts already spent");
  });

  test("a fresh request resets the attempt count", async () => {
    const row = await applicant("Lisbon", { screenStatus: "failed", screenAttempts: MAX_SCREEN_ATTEMPTS });
    await enqueueScreen(row.id, { fresh: true });
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "queued");
    assert.equal(current.screenAttempts, 0);
  });

  test("with the automatic kick off, queueing screens nothing by itself", async () => {
    const row = await applicant("Lisbon");
    await enqueueScreen(row.id, { fresh: true });
    await sleep(50);
    assert.equal(calls.length, 0);
    assert.equal((await reload(row.id)).screenStatus, "queued");
  });

  test("an id that matches nothing is ignored", async () => {
    await enqueueScreen("00000000-0000-4000-8000-000000000000", { fresh: true });
    assert.deepEqual(await runScreeningQueueOnce(), []);
  });
});

describe("runScreeningQueueOnce: a screen that succeeds", () => {
  test("claims the queued Application, screens it once and records the score", async () => {
    const row = await queued("Lisbon", { screenError: "An earlier failure." });
    const outcomes = await runScreeningQueueOnce();
    assert.equal(outcomes.length, 1);
    const [outcome] = outcomes;
    assert.equal(outcome.outcome, "scored");
    assert.equal(outcome.outcome === "scored" && outcome.scorecard.applicationId, row.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].employee.id, screener.id);

    const current = await reload(row.id);
    assert.equal(current.screenStatus, "scored");
    assert.equal(current.screenAttempts, 1);
    assert.equal(current.screenStartedAt, null);
    assert.equal(current.screenError, "");
    assert.equal(current.score, 67);
    assert.equal(current.scoreLabel, "good");
    assert.equal(await scorecardCount(row.id), 1);
    assert.deepEqual(
      (await timeline(row.id)).map((event) => event.kind),
      ["scored"],
    );

    assert.deepEqual(await runScreeningQueueOnce(), [], "nothing is left to do");
    assert.equal(calls.length, 1);
  });

  test("screens what is due oldest first, and nothing else", async () => {
    const now = Date.now();
    const second = await queued("Oslo", { screenQueuedAt: new Date(now - 2 * MINUTE) });
    const first = await queued("Lisbon", { screenQueuedAt: new Date(now - 3 * MINUTE) });
    const third = await queued("Kyoto", { screenQueuedAt: new Date(now - MINUTE) });
    const waiting = await queued("Lima", { screenQueuedAt: new Date(now + 5 * MINUTE), screenAttempts: 1 });
    const idle = await applicant("Quito", { screenStatus: "none" });
    const failed = await applicant("Accra", {
      screenStatus: "failed",
      screenAttempts: MAX_SCREEN_ATTEMPTS,
      screenQueuedAt: new Date(now - 10 * MINUTE),
    });
    const running = await applicant("Hanoi", {
      screenStatus: "running",
      screenAttempts: 1,
      screenQueuedAt: new Date(now - 4 * MINUTE),
      screenStartedAt: new Date(now - MINUTE),
    });

    const outcomes = await runScreeningQueueOnce();
    assert.deepEqual(
      calls.map((args) => args.application.location),
      ["Lisbon", "Oslo", "Kyoto"],
    );
    assert.deepEqual(
      outcomes.map((outcome) => (outcome.outcome === "scored" ? outcome.scorecard.applicationId : outcome.outcome)),
      [first.id, second.id, third.id],
    );

    const notDue = await reload(waiting.id);
    assert.equal(notDue.screenStatus, "queued");
    assert.equal(notDue.screenAttempts, 1);
    assert.equal(notDue.screenQueuedAt?.getTime(), now + 5 * MINUTE);
    for (const [row, status, attempts] of [
      [idle, "none", 0],
      [failed, "failed", MAX_SCREEN_ATTEMPTS],
      [running, "running", 1],
    ] as const) {
      const current = await reload(row.id);
      assert.equal(current.screenStatus, status, row.candidateLocation);
      assert.equal(current.screenAttempts, attempts, row.candidateLocation);
      assert.equal(await scorecardCount(row.id), 0, row.candidateLocation);
    }
  });
});

describe("the claim: queued → running, exactly once", () => {
  test("two drains racing for one Application screen it once", async () => {
    const row = await queued("Lisbon");
    behaviour = async (args) => {
      await sleep(20);
      return rateAll(2)(args);
    };
    const [left, right] = await Promise.all([runScreeningQueueOnce(), runScreeningQueueOnce()]);
    assert.equal(calls.length, 1, "one screen, not two");
    assert.equal(left.length + right.length, 1);
    const current = await reload(row.id);
    assert.equal(current.screenAttempts, 1, "one claim, one attempt");
    assert.equal(current.screenStatus, "scored");
    assert.equal(await scorecardCount(row.id), 1);
  });

  test("many drains share many Applications without screening any of them twice", async () => {
    const rows = await Promise.all(
      ["Lisbon", "Oslo", "Kyoto", "Lima"].map((label, index) =>
        queued(label, { screenQueuedAt: new Date(Date.now() - (index + 1) * 1_000) }),
      ),
    );
    behaviour = async (args) => {
      await sleep(10);
      return rateAll(2)(args);
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => runScreeningQueueOnce()));
    assert.equal(
      results.reduce((total, outcomes) => total + outcomes.length, 0),
      rows.length,
    );
    assert.deepEqual(
      calls.map((args) => args.application.location).sort(),
      ["Kyoto", "Lima", "Lisbon", "Oslo"],
    );
    for (const row of rows) {
      const current = await reload(row.id);
      assert.equal(current.screenAttempts, 1, row.candidateLocation);
      assert.equal(await scorecardCount(row.id), 1, row.candidateLocation);
    }
  });
});

describe("retries: a screen that errs is tried again, then shown as failed", () => {
  test(`retries after a pause that doubles, and fails for good after ${MAX_SCREEN_ATTEMPTS} attempts`, async () => {
    assert.equal(MAX_SCREEN_ATTEMPTS, 3);
    behaviour = failing("provider returned 529 overloaded");
    const row = await queued("Lisbon");

    for (let attempt = 1; attempt < MAX_SCREEN_ATTEMPTS; attempt++) {
      const { outcomes, started, finished } = await pass();
      assert.deepEqual(outcomes, [{ outcome: "retry", cause: "error", detail: "provider returned 529 overloaded" }]);
      const current = await reload(row.id);
      assert.equal(current.screenStatus, "queued", `after attempt ${attempt}`);
      assert.equal(current.screenAttempts, attempt);
      assert.equal(current.screenStartedAt, null);
      assert.equal(current.screenError, "provider returned 529 overloaded");
      const pause = MINUTE * 2 ** (attempt - 1);
      assertBetween(current.screenQueuedAt, started + pause, finished + pause, `retry ${attempt}`);
      // The retry is not due yet, so the same pass and the next one leave it.
      assert.deepEqual(await runScreeningQueueOnce(), []);
      await makeDue(row.id);
    }

    const { outcomes } = await pass();
    assert.deepEqual(outcomes, [{ outcome: "retry", cause: "error", detail: "provider returned 529 overloaded" }]);
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "failed");
    assert.equal(current.screenAttempts, MAX_SCREEN_ATTEMPTS);
    assert.equal(current.screenStartedAt, null);
    assert.equal(current.screenError, "provider returned 529 overloaded");
    assert.equal(calls.length, MAX_SCREEN_ATTEMPTS);

    // A failed screen is the absence of a judgement, never a low one.
    assert.equal(current.score, null);
    assert.equal(current.scoreLabel, null);
    assert.equal(await scorecardCount(row.id), 0);
    const events = await timeline(row.id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["screen_failed"],
    );
    assert.equal(events[0].actorKind, "system");
    assert.equal(events[0].actorName, "Genosyn");
    assert.equal(events[0].body, "provider returned 529 overloaded");
    assert.deepEqual(JSON.parse(events[0].metaJson), { cause: "error", attempts: MAX_SCREEN_ATTEMPTS });

    // Nothing picks a failed screen up again by itself…
    await makeDue(row.id);
    assert.deepEqual(await runScreeningQueueOnce(), []);
    // …until a person asks for a fresh one, which starts the count over.
    behaviour = rateAll(2);
    await enqueueScreen(row.id, { fresh: true });
    const [again] = await runScreeningQueueOnce();
    assert.equal(again.outcome, "scored");
    assert.equal((await reload(row.id)).screenAttempts, 1);
  });

  test("a screen that succeeds on a retry clears the failure it left", async () => {
    let attempts = 0;
    behaviour = async (args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return rateAll(2)(args);
    };
    const row = await queued("Lisbon");
    await runScreeningQueueOnce();
    assert.equal((await reload(row.id)).screenError, "connection reset");
    await makeDue(row.id);
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome, "scored");
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "scored");
    assert.equal(current.screenAttempts, 2);
    assert.equal(current.screenError, "");
    assert.deepEqual(
      (await timeline(row.id)).map((event) => event.kind),
      ["scored"],
    );
  });

  test("a scorecard the server refuses is retried, never stored", async () => {
    behaviour = async () => ({
      ratings: [{ criterionId: "crit-ts", rating: 3, evidence: [], note: "" }],
      summary: "Only rated one.",
      strengths: [],
      concerns: [],
      interviewQuestions: [],
      injectionDetected: false,
    });
    const row = await queued("Lisbon");
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome === "retry" && outcome.cause, "error");
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "queued");
    assert.match(current.screenError, /Rate every criterion/);
    assert.equal(current.score, null);
    assert.equal(await scorecardCount(row.id), 0);
  });

  test("a subscription model busy with another turn is retried later", async () => {
    await AppDataSource.getRepository(AIModel).update(
      { id: model.id },
      { authMode: "subscription", configJson: JSON.stringify({ codexAuthEncrypted: "sealed" }) },
    );
    const row = await queued("Lisbon");
    const started = Date.now();
    const outcomes = await withSubscriptionModelLock(model.id, undefined, () => runScreeningQueueOnce());
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome === "retry" && outcome.cause),
      ["model_busy"],
    );
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "queued");
    assert.equal(current.screenAttempts, 1);
    assertBetween(current.screenQueuedAt, started + MINUTE, Date.now() + MINUTE, "busy retry");
    assert.equal(calls.length, 0);
  });

  test("a missing screener fails at once, with nothing spent on retries", async () => {
    await AppDataSource.getRepository(RecruitingSettings).update({ id: settings.id }, { screenerEmployeeId: null });
    const row = await queued("Lisbon");
    const outcomes = await runScreeningQueueOnce();
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome === "failed" && outcome.cause),
      ["no_screener"],
    );
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "failed");
    assert.equal(current.screenAttempts, 1);
    assert.match(current.screenError, /No AI screener is appointed/);
    const [event] = await timeline(row.id);
    assert.equal(event.kind, "screen_failed");
    assert.deepEqual(JSON.parse(event.metaJson), { cause: "no_screener", attempts: 1 });
    assert.equal(calls.length, 0);
    assert.equal(await scorecardCount(row.id), 0);
  });

  test("a screener without a connected model fails at once", async () => {
    await AppDataSource.getRepository(AIModel).delete({ id: model.id });
    const row = await queued("Lisbon");
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome === "failed" && outcome.cause, "no_model");
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "failed");
    assert.match(current.screenError, /Rita Reviewer has no connected AI Model/);
    assert.deepEqual(JSON.parse((await timeline(row.id))[0].metaJson), { cause: "no_model", attempts: 1 });
  });

  test("an Application whose Opening is gone fails at once", async () => {
    const row = await queued("Lisbon");
    await AppDataSource.getRepository(RecruitingOpening).delete({ id: opening.id });
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome === "failed" && outcome.cause, "gone");
    assert.equal((await reload(row.id)).screenStatus, "failed");
    assert.deepEqual(JSON.parse((await timeline(row.id))[0].metaJson), { cause: "gone", attempts: 1 });
  });
});

describe("Standdowns: a stopped screen waits, it does not fail", () => {
  test("defers the screen without spending an attempt, however long the stop lasts", async () => {
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: screener.id,
      reason: "Reviewing the screener's scorecards",
    });
    const row = await queued("Lisbon");

    for (let check = 0; check < MAX_SCREEN_ATTEMPTS + 2; check++) {
      const { outcomes, started, finished } = await pass();
      assert.deepEqual(
        outcomes.map((outcome) => outcome.outcome === "retry" && outcome.cause),
        ["standdown"],
      );
      const current = await reload(row.id);
      assert.equal(current.screenStatus, "queued", `check ${check}`);
      assert.equal(current.screenAttempts, 0, "a Standdown spends no attempt");
      assert.equal(current.screenStartedAt, null);
      assert.match(current.screenError, /AI work is stood down: Reviewing the screener's scorecards/);
      assertBetween(
        current.screenQueuedAt,
        started + STANDDOWN_RECHECK_MS,
        finished + STANDDOWN_RECHECK_MS,
        `recheck ${check}`,
      );
      assert.deepEqual(await runScreeningQueueOnce(), [], "not rechecked before its time");
      await makeDue(row.id);
    }
    assert.equal(calls.length, 0, "the model is never called while stood down");
    assert.equal((await timeline(row.id)).length, 0, "no failure is recorded");

    await liftStanddown({ standdown });
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome, "scored");
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "scored");
    assert.equal(current.screenAttempts, 1);
    assert.equal(current.screenError, "");
  });

  test("a company-wide Standdown after earlier failures leaves the count where it was", async () => {
    behaviour = failing("provider returned 500");
    const row = await queued("Lisbon");
    await runScreeningQueueOnce();
    await makeDue(row.id);
    await runScreeningQueueOnce();
    await makeDue(row.id);
    assert.equal((await reload(row.id)).screenAttempts, 2);

    await placeStanddown({ companyId: company.id, scope: "company", reason: "Incident drill" });
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome === "retry" && outcome.cause, "standdown");
    const deferred = await reload(row.id);
    assert.equal(deferred.screenStatus, "queued");
    assert.equal(deferred.screenAttempts, 2);

    // Lifted, the last attempt is still there to use.
    stopStanddowns();
    behaviour = rateAll(2);
    await makeDue(row.id);
    const [after] = await runScreeningQueueOnce();
    assert.equal(after.outcome, "scored");
    assert.equal((await reload(row.id)).screenAttempts, MAX_SCREEN_ATTEMPTS);
  });
});

describe("reclaimStaleScreens: a screen whose process died is put back", () => {
  test(`a screen running for more than ${STALE_RUNNING_MS / MINUTE} minutes is queued again; younger ones are left`, async () => {
    const now = new Date();
    const stale = await applicant("Lisbon", {
      screenStatus: "running",
      screenAttempts: 1,
      screenQueuedAt: new Date(now.getTime() - STALE_RUNNING_MS - 2 * MINUTE),
      screenStartedAt: new Date(now.getTime() - STALE_RUNNING_MS - 1_000),
    });
    const young = await applicant("Oslo", {
      screenStatus: "running",
      screenAttempts: 1,
      screenQueuedAt: new Date(now.getTime() - STALE_RUNNING_MS),
      screenStartedAt: new Date(now.getTime() - STALE_RUNNING_MS + 1_000),
    });
    const settled = await applicant("Kyoto", {
      screenStatus: "scored",
      screenAttempts: 1,
      screenStartedAt: new Date(now.getTime() - 2 * STALE_RUNNING_MS),
    });

    assert.equal(await reclaimStaleScreens(now), 1);
    const reclaimed = await reload(stale.id);
    assert.equal(reclaimed.screenStatus, "queued");
    assert.equal(reclaimed.screenQueuedAt?.getTime(), now.getTime());
    assert.equal(reclaimed.screenStartedAt, null);
    assert.equal(reclaimed.screenAttempts, 1, "the attempt the dead process claimed stays spent");

    const stillRunning = await reload(young.id);
    assert.equal(stillRunning.screenStatus, "running");
    assert.ok(stillRunning.screenStartedAt);
    assert.equal((await reload(settled.id)).screenStatus, "scored");

    assert.equal(await reclaimStaleScreens(now), 0, "nothing twice");
    // Two seconds later the younger one has run too long as well.
    assert.equal(await reclaimStaleScreens(new Date(now.getTime() + 2_000)), 1);
    assert.equal((await reload(young.id)).screenStatus, "queued");
  });

  test("the next pass screens a reclaimed Application", async () => {
    const row = await applicant("Lisbon", {
      screenStatus: "running",
      screenAttempts: 1,
      screenQueuedAt: new Date(Date.now() - STALE_RUNNING_MS - 2 * MINUTE),
      screenStartedAt: new Date(Date.now() - STALE_RUNNING_MS - MINUTE),
    });
    assert.deepEqual(await runScreeningQueueOnce(), [], "a running screen is not claimed again");
    assert.equal(await reclaimStaleScreens(), 1);
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome, "scored");
    const current = await reload(row.id);
    assert.equal(current.screenStatus, "scored");
    assert.equal(current.screenAttempts, 2);
    assert.equal(calls.length, 1);
  });

  test(`a screen that died on its last attempt fails instead of being put back forever`, async () => {
    const now = new Date();
    const spent = await applicant("Lisbon", {
      screenStatus: "running",
      screenAttempts: MAX_SCREEN_ATTEMPTS,
      screenQueuedAt: new Date(now.getTime() - STALE_RUNNING_MS - 2 * MINUTE),
      screenStartedAt: new Date(now.getTime() - STALE_RUNNING_MS - MINUTE),
    });
    assert.equal(await reclaimStaleScreens(now), 1);
    const current = await reload(spent.id);
    assert.equal(current.screenStatus, "failed");
    assert.equal(current.screenStartedAt, null);
    assert.match(current.screenError, /stopped before it finished/);
    const failures = (await timeline(spent.id)).filter((event) => event.kind === "screen_failed");
    assert.equal(failures.length, 1);
    assert.deepEqual(await runScreeningQueueOnce(), [], "a failed screen is not picked up again");
    assert.equal(await reclaimStaleScreens(now), 0, "nothing twice");
  });
});

describe("a strong match is the one result worth a notification", () => {
  test("the Opening's owner is told about a strong match", async () => {
    await AppDataSource.getRepository(RecruitingOpening).update({ id: opening.id }, { ownerUserId: "user-owner" });
    behaviour = rateAll(3);
    const row = await queued("Lisbon");
    const [outcome] = await runScreeningQueueOnce();
    assert.equal(outcome.outcome, "scored");
    const notices = await AppDataSource.getRepository(Notification).find({ where: { userId: "user-owner" } });
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.equal(notice.companyId, company.id);
    assert.equal(notice.kind, "recruiting_strong_match");
    assert.equal(notice.title, "Strong match: Ada Lovelace for Backend Engineer");
    assert.equal(notice.body, "Scored 100 against the Opening's criteria.");
    assert.equal(notice.link, `/c/analytical-engines/recruiting/applicants/${row.id}`);
    assert.equal(notice.entityKind, "recruiting_application");
    assert.equal(notice.entityId, row.id);
  });

  test("no one is told about a weaker match, nor when the Opening has no owner", async () => {
    await AppDataSource.getRepository(RecruitingOpening).update({ id: opening.id }, { ownerUserId: "user-owner" });
    behaviour = rateAll(2);
    await queued("Lisbon");
    await runScreeningQueueOnce();
    await AppDataSource.getRepository(RecruitingOpening).update({ id: opening.id }, { ownerUserId: null });
    behaviour = rateAll(3);
    await queued("Oslo");
    const outcomes = await runScreeningQueueOnce();
    assert.equal(outcomes[0].outcome === "scored" && outcomes[0].scorecard.label, "strong");
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });
});

describe("setScreeningAutoKickForTests", () => {
  test("with the kick on, a queued Application is screened without anyone draining the queue", async () => {
    const row = await applicant("Lisbon");
    setScreeningAutoKickForTests(true);
    try {
      await enqueueScreen(row.id, { fresh: true });
      const deadline = Date.now() + 5_000;
      let current = await reload(row.id);
      while (current.screenStatus !== "scored" && Date.now() < deadline) {
        await sleep(20);
        current = await reload(row.id);
      }
      assert.equal(current.screenStatus, "scored");
      assert.equal(current.screenAttempts, 1);
    } finally {
      setScreeningAutoKickForTests(false);
    }
    // Let the background drain finish its last look at the queue.
    await sleep(50);
    assert.equal(calls.length, 1);
    assert.equal(await scorecardCount(row.id), 1);
  });
});
