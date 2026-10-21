import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Membership } from "../../db/entities/Membership.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import type { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingScorecard } from "../../db/entities/RecruitingScorecard.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import type { CriterionRating } from "../../../shared/recruiting.js";
import { addEmployeeScorecard, addMemberScorecard, getApplicationDetail } from "./applications.js";
import { parseCriteria } from "./content.js";
import { RecruitingNotFoundError, RecruitingValidationError } from "./errors.js";
import { listApplicationEvents } from "./events.js";
import { createOpening, publishOpening, updateOpening, type RecruitingActor } from "./openings.js";
import {
  applicationCorpus,
  hasScorecard,
  listScorecards,
  normalizeForMatch,
  quoteFound,
  recordScorecard,
  scorecardDto,
  type ScorecardAuthor,
  type ScorecardInput,
} from "./scorecards.js";
import { setScreeningAutoKickForTests } from "./screeningQueue.js";

/**
 * Scorecards: one reading of an Application against its Opening's criteria.
 *
 * The split this file pins is the point of the feature. The author — the AI
 * screener, another AI Employee, or a Member — rates each criterion and quotes
 * evidence; the server does the rest. So the score is always `computeScore`
 * over the ratings (a Scorecard carrying its own number is refused), an AI must
 * rate every criterion, an id that is not a criterion is refused rather than
 * silently ignored, and every quote is looked up in what the candidate actually
 * wrote: found when it is there however it was capitalized or punctuated, not
 * found inside another word or as a paraphrase, and — when made up — kept,
 * marked and counted rather than believed or quietly dropped.
 *
 * A Scorecard is append-only and remembers the criteria it was written against,
 * so a later change to them is shown, not hidden. The Application mirrors the
 * latest AI reading only; a person's Scorecard sits beside it.
 */

const DESCRIPTION =
  "You will design and run the systems that keep our customers' data safe, fast and boring.";

const RESUME =
  "Ada Lovelace\nLed the TypeScript migration at Acme; cut build times by half.\nMaintainer of an open source query planner.";
const COVER_LETTER = "I've run Postgres in production since 2019, and I write JavaScript daily.";

let owner: User;
let outsider: User;
let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let screener: AIEmployee;
let opening: RecruitingOpening;
let application: RecruitingApplication;
let member: RecruitingActor;

before(async () => {
  setScreeningAutoKickForTests(false);
  await initTestDb();
});

after(async () => {
  await closeTestDb();
  setScreeningAutoKickForTests(true);
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, { email: "owner@acme.test", passwordHash: "x", name: "Olive Owner" });
  outsider = await insert(User, { email: "gus@globex.test", passwordHash: "x", name: "Gus" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Globex", slug: "globex", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  employee = await insert(AIEmployee, { companyId: company.id, name: "Rhea", slug: "rhea", role: "Recruiter" });
  screener = await insert(AIEmployee, { companyId: company.id, name: "Sol", slug: "sol", role: "Screener" });
  member = { kind: "member", userId: owner.id, name: "Olive Owner" };
  opening = await openingWithCriteria(company.id, member);
  application = await applicationTo(opening);
});

async function openingWithCriteria(companyId: string, actor: RecruitingActor) {
  const created = await createOpening(
    companyId,
    {
      title: "Platform Engineer",
      description: DESCRIPTION,
      criteria: [
        { id: "ts", name: "TypeScript", importance: "must_have" },
        { id: "pg", name: "Postgres", importance: "important" },
        { id: "oss", name: "Open source", importance: "nice_to_have" },
      ],
    },
    actor,
  );
  return publishOpening(companyId, created.id);
}

function applicationTo(target: RecruitingOpening) {
  return insert(RecruitingApplication, {
    companyId: target.companyId,
    openingId: target.id,
    candidateName: "Ada Lovelace",
    candidateEmail: "ada@example.com",
    candidateLocation: "London",
    websiteUrl: "https://ada.example.com/",
    stage: "applied",
    stageChangedAt: new Date(),
    answersJson: JSON.stringify([{ questionId: "years", label: "Years of experience", kind: "number", value: 7 }]),
    coverLetter: COVER_LETTER,
    resumeText: RESUME,
  });
}

const memberAuthor = (): ScorecardAuthor => ({ kind: "member", userId: owner.id, name: "Olive Owner" });
const employeeAuthor = (): ScorecardAuthor => ({ kind: "employee", employeeId: employee.id, name: employee.name });
const screenerAuthor = (): ScorecardAuthor => ({
  kind: "screener",
  employeeId: screener.id,
  name: screener.name,
  modelLabel: "claude-sonnet-4-5",
});

type Rating = CriterionRating | null;

/** Ratings in criterion order: TypeScript (must have), Postgres (important), Open source (nice to have). */
function rated(ts: Rating, pg: Rating, oss: Rating): ScorecardInput["ratings"] {
  return [
    { criterionId: "ts", rating: ts },
    { criterionId: "pg", rating: pg },
    { criterionId: "oss", rating: oss },
  ];
}

function score(author: ScorecardAuthor, input: ScorecardInput, extra: { corpus?: string; target?: RecruitingApplication } = {}) {
  return recordScorecard({ application: extra.target ?? application, opening, author, input, corpus: extra.corpus });
}

/** The verdict on each quote, for a Scorecard that quotes only the TypeScript criterion. */
async function verdicts(quotes: string[], corpus?: string): Promise<boolean[]> {
  const scorecard = await score(
    memberAuthor(),
    { ratings: [{ criterionId: "ts", rating: 2, evidence: quotes }] },
    { corpus },
  );
  const dto = scorecardDto(scorecard, parseCriteria(opening.criteriaJson));
  return dto.ratings[0].evidence.map((evidence) => evidence.found);
}

const reloadApplication = () =>
  AppDataSource.getRepository(RecruitingApplication).findOneByOrFail({ id: application.id });
const scorecardCount = () => AppDataSource.getRepository(RecruitingScorecard).count();

describe("the score is the server's arithmetic", () => {
  test("computes the score and its label from the weighted ratings", async () => {
    // (3·3 + 2·2 + 1·1) / (3·6) = 14/18 → 78
    const scorecard = await score(memberAuthor(), { ratings: rated(3, 2, 1) });
    assert.equal(scorecard.score, 78);
    assert.equal(scorecard.label, "good");
    const dto = scorecardDto(scorecard, parseCriteria(opening.criteriaJson));
    assert.equal(dto.labelText, "Good match");
    assert.deepEqual(dto.missingMustHaves, []);
    assert.deepEqual(dto.partialMustHaves, []);
  });

  test("Exceeds on everything is 100, a Strong match", async () => {
    const scorecard = await score(employeeAuthor(), { ratings: rated(3, 3, 3) });
    assert.equal(scorecard.score, 100);
    assert.equal(scorecard.label, "strong");
  });

  test("a must-have that is Not shown makes the match Weak, whatever the total", async () => {
    // (0 + 6 + 3) / 18 = 50, which alone would be "possible".
    const scorecard = await score(employeeAuthor(), { ratings: rated(0, 3, 3) });
    assert.equal(scorecard.score, 50);
    assert.equal(scorecard.label, "weak");
    assert.deepEqual(scorecardDto(scorecard, parseCriteria(opening.criteriaJson)).missingMustHaves, ["TypeScript"]);
  });

  test("a must-have that is only Partly shown caps the match at Possible", async () => {
    // (3 + 6 + 3) / 18 = 67, which alone would be "good".
    const scorecard = await score(employeeAuthor(), { ratings: rated(1, 3, 3) });
    assert.equal(scorecard.score, 67);
    assert.equal(scorecard.label, "possible");
    assert.deepEqual(scorecardDto(scorecard, parseCriteria(opening.criteriaJson)).partialMustHaves, ["TypeScript"]);
  });

  test("a Scorecard that brings its own score is refused", async () => {
    const input = { ratings: rated(0, 0, 0), score: 100, label: "strong" } as unknown as ScorecardInput;
    await assert.rejects(score(employeeAuthor(), input), RecruitingValidationError);
    assert.equal(await scorecardCount(), 0);
  });

  test("a rating is one of 0, 1, 2 or 3 — nothing else", async () => {
    for (const bad of [4, -1, 2.5, "3"]) {
      await assert.rejects(
        score(memberAuthor(), { ratings: [{ criterionId: "ts", rating: bad as unknown as CriterionRating }] }),
        RecruitingValidationError,
        String(bad),
      );
    }
    assert.equal(await scorecardCount(), 0);
  });
});

describe("who must rate what", () => {
  test("a Member may leave criteria unrated; those earn nothing and stay listed", async () => {
    const scorecard = await score(memberAuthor(), {
      ratings: [
        { criterionId: "ts", rating: 3 },
        { criterionId: "pg", rating: null },
      ],
    });
    // Only TypeScript's 9 of 18 possible points.
    assert.equal(scorecard.score, 50);
    const dto = scorecardDto(scorecard, parseCriteria(opening.criteriaJson));
    assert.deepEqual(
      dto.ratings.map((rating) => [rating.criterionId, rating.name, rating.importance, rating.rating]),
      [
        ["ts", "TypeScript", "must_have", 3],
        ["pg", "Postgres", "important", null],
        ["oss", "Open source", "nice_to_have", null],
      ],
    );
  });

  test("an AI Employee must rate every criterion, using Not shown rather than skipping one", async () => {
    await assert.rejects(
      score(employeeAuthor(), { ratings: rated(3, 3, 3).slice(0, 2) }),
      (error: unknown) => error instanceof RecruitingValidationError && /Missing: Open source/.test(error.message),
    );
    await assert.rejects(
      score(employeeAuthor(), { ratings: rated(3, null, 3) }),
      (error: unknown) => error instanceof RecruitingValidationError && /Missing: Postgres/.test(error.message),
    );
    assert.equal(await scorecardCount(), 0);
  });

  test("the AI screener is held to the same rule", async () => {
    await assert.rejects(score(screenerAuthor(), { ratings: [{ criterionId: "ts", rating: 3 }] }), RecruitingValidationError);
    assert.equal(await scorecardCount(), 0);
    assert.equal((await reloadApplication()).screenStatus, "none");
  });

  test("an id that is not one of the Opening's criteria is refused, not ignored", async () => {
    await assert.rejects(
      score(memberAuthor(), { ratings: [{ criterionId: "ts", rating: 3 }, { criterionId: "rust", rating: 3 }] }),
      (error: unknown) => error instanceof RecruitingValidationError && /"rust" is not one of this Opening's criteria/.test(error.message),
    );
    assert.equal(await scorecardCount(), 0);
  });

  test("rating one criterion twice is refused", async () => {
    await assert.rejects(
      score(memberAuthor(), { ratings: [{ criterionId: "ts", rating: 3 }, { criterionId: "ts", rating: 0 }] }),
      (error: unknown) => error instanceof RecruitingValidationError && /Rate "TypeScript" only once/.test(error.message),
    );
  });

  test("an Opening with no criteria has nothing to score against", async () => {
    const bare = await createOpening(company.id, { title: "Office Manager", description: DESCRIPTION }, member);
    const target = await applicationTo(bare);
    await assert.rejects(
      recordScorecard({
        application: target,
        opening: bare,
        author: memberAuthor(),
        input: { ratings: [{ criterionId: "ts", rating: 3 }] },
      }),
      /no criteria yet/,
    );
  });

  test("at most three quotes a criterion, and none longer than 300 characters", async () => {
    await assert.rejects(
      score(memberAuthor(), { ratings: [{ criterionId: "ts", rating: 3, evidence: ["a", "b", "c", "d"] }] }),
      RecruitingValidationError,
    );
    await assert.rejects(
      score(memberAuthor(), { ratings: [{ criterionId: "ts", rating: 3, evidence: ["x".repeat(301)] }] }),
      RecruitingValidationError,
    );
  });
});

describe("evidence quotes", () => {
  test("a quote copied from the application is found", async () => {
    assert.deepEqual(await verdicts(["Led the TypeScript migration at Acme"]), [true]);
  });

  test("capitals, punctuation, spacing and curly apostrophes do not matter", async () => {
    assert.deepEqual(
      await verdicts(["LED   THE typescript-migration, at ACME!!", "I’ve run Postgres in production"]),
      [true, true],
    );
  });

  test("a word found only inside another word is not found", async () => {
    // The cover letter says "JavaScript", never "Java".
    assert.deepEqual(await verdicts(["Java", "write Java daily"]), [false, false]);
  });

  test("a quote of four or more words may trim or add a word at either end", async () => {
    assert.deepEqual(
      await verdicts([
        "Led the TypeScript migration at Acme successfully",
        "Proudly led the TypeScript migration at Acme",
      ]),
      [true, true],
    );
  });

  test("a paraphrase is not a quote", async () => {
    assert.deepEqual(
      await verdicts([
        // The middle word changed: no run of five of its six words is in the text.
        "Led the JavaScript migration at Acme",
        // Four words need all four: three of them is less than four-fifths.
        "run Postgres in staging",
      ]),
      [false, false],
    );
    assert.deepEqual(await verdicts(["run Postgres in production"]), [true]);
  });

  test("a made-up quote is kept, marked unsupported and counted — never dropped", async () => {
    const scorecard = await score(memberAuthor(), {
      ratings: [
        { criterionId: "ts", rating: 3, evidence: ["Won the Turing Award in 2019", "Led the TypeScript migration"] },
        { criterionId: "pg", rating: 2, evidence: ["Ran a 40 TB Postgres cluster"] },
      ],
    });
    assert.equal(scorecard.unverifiedQuotes, 2);
    const dto = scorecardDto(scorecard, parseCriteria(opening.criteriaJson));
    assert.deepEqual(dto.ratings[0].evidence, [
      { quote: "Won the Turing Award in 2019", found: false },
      { quote: "Led the TypeScript migration", found: true },
    ]);
    assert.deepEqual(dto.ratings[1].evidence, [{ quote: "Ran a 40 TB Postgres cluster", found: false }]);
    assert.equal(dto.unverifiedQuotes, 2);
    const scored = (await listApplicationEvents(application.id)).find((event) => event.kind === "scored")!;
    assert.equal(scored.meta.unverifiedQuotes, 2);
  });

  test("quotes are looked up in the answers, cover letter, location and website as well as the resume", async () => {
    assert.deepEqual(await verdicts(["Years of experience: 7", "I write JavaScript daily"]), [true, true]);
    assert.deepEqual(await verdicts(["London", "ada.example.com"]), [true, true]);
  });

  test("the screener's quotes are checked against the blinded text it actually read", async () => {
    const blinded = "[Candidate] led the TypeScript migration at Acme; cut build times by half.";
    assert.deepEqual(
      await verdicts(["[Candidate] led the TypeScript migration", "Ada Lovelace led the TypeScript migration"], blinded),
      [true, false],
    );
  });

  test("normalizeForMatch folds case, compatibility forms and punctuation; an empty quote is never found", () => {
    assert.equal(normalizeForMatch("  Ünïcödé — ﬁne, ＡＢＣ!  "), "ünïcödé fine abc");
    const corpus = normalizeForMatch(RESUME);
    assert.equal(quoteFound("", corpus), false);
    assert.equal(quoteFound("?!…", corpus), false);
    assert.equal(quoteFound("acme", corpus), true);
    assert.equal(quoteFound("acm", corpus), false);
  });

  test("applicationCorpus joins what the candidate wrote, and nothing about who they are", () => {
    const corpus = applicationCorpus(application);
    for (const part of ["London", "https://ada.example.com/", "Years of experience: 7", COVER_LETTER, RESUME]) {
      assert.ok(corpus.includes(part), part);
    }
    assert.ok(!corpus.includes("ada@example.com"), "the email address is not something to quote");
  });
});

describe("criteria that change after scoring", () => {
  test("a Scorecard remembers the criteria it was written against and says when they changed", async () => {
    const before = await score(memberAuthor(), { ratings: rated(3, 2, 1) });
    assert.equal(scorecardDto(before, parseCriteria(opening.criteriaJson)).criteriaChanged, false);

    await updateOpening(
      company.id,
      opening.id,
      {
        criteria: [
          { id: "ts", name: "TypeScript", importance: "must_have" },
          { id: "pg", name: "PostgreSQL at scale", importance: "must_have" },
          { id: "oss", name: "Open source", importance: "nice_to_have" },
        ],
      },
      member,
    );
    const detail = await getApplicationDetail(company.id, application.id);
    const stale = detail.scorecards.find((card) => card.id === before.id)!;
    assert.equal(stale.criteriaChanged, true);
    assert.equal(stale.ratings[1].name, "Postgres", "the rating keeps the criterion as it was");
    assert.equal(stale.ratings[1].importance, "important");
    assert.equal(stale.score, 78, "the old score is not recomputed against the new bar");
  });

  test("a Scorecard written after the change reads as current", async () => {
    const updated = await updateOpening(
      company.id,
      opening.id,
      { criteria: [{ id: "ts", name: "TypeScript", importance: "must_have" }] },
      member,
    );
    const after = await recordScorecard({
      application,
      opening: updated,
      author: memberAuthor(),
      input: { ratings: [{ criterionId: "ts", rating: 2 }] },
    });
    assert.equal(after.score, 67);
    assert.equal(scorecardDto(after, parseCriteria(updated.criteriaJson)).criteriaChanged, false);
  });
});

describe("several Scorecards on one Application", () => {
  test("the Application mirrors the AI's reading; a person's Scorecard sits beside it", async () => {
    const ai = await score(employeeAuthor(), { ratings: rated(2, 2, 2) });
    let saved = await reloadApplication();
    assert.equal(saved.score, 67);
    assert.equal(saved.scoreLabel, "good");
    assert.equal(saved.latestScorecardId, ai.id);
    assert.ok(saved.scoredAt instanceof Date);

    await score(memberAuthor(), { ratings: rated(3, 3, 3) });
    saved = await reloadApplication();
    assert.equal(saved.score, 67, "a person's 100 does not replace the AI reading");
    assert.equal(saved.latestScorecardId, ai.id);
    assert.equal(await scorecardCount(), 2);
  });

  test("a re-score is a new Scorecard: the newest AI reading is the current one, the earlier stays on record", async () => {
    const first = await score(screenerAuthor(), { ratings: rated(3, 3, 3) });
    const second = await score(employeeAuthor(), { ratings: rated(0, 1, 0) });
    const saved = await reloadApplication();
    assert.equal(saved.latestScorecardId, second.id);
    assert.equal(saved.score, second.score);
    assert.equal(saved.scoreLabel, "weak");

    const detail = await getApplicationDetail(company.id, application.id);
    assert.equal(detail.latestScorecardId, second.id);
    assert.deepEqual(detail.scorecards.map((card) => card.id).sort(), [first.id, second.id].sort());
    // The Application page shows the first non-member card as the AI reading:
    // it must be the one the Application's score came from.
    const shown = detail.scorecards.find((card) => card.authorKind !== "member");
    assert.equal(shown?.id, saved.latestScorecardId);
    assert.equal(shown?.score, detail.score);
  });

  test("only the AI screener settles the screen; another AI Employee's Scorecard leaves its status alone", async () => {
    await AppDataSource.getRepository(RecruitingApplication).update(
      { id: application.id },
      { screenStatus: "running", screenStartedAt: new Date(), screenError: "Retrying" },
    );
    await score(employeeAuthor(), { ratings: rated(2, 2, 2) });
    let saved = await reloadApplication();
    assert.equal(saved.screenStatus, "running");

    await score(screenerAuthor(), { ratings: rated(2, 2, 2) });
    saved = await reloadApplication();
    assert.equal(saved.screenStatus, "scored");
    assert.equal(saved.screenError, "");
    assert.equal(saved.screenStartedAt, null);
  });

  test("the model that wrote a Scorecard is kept for the AI screener only", async () => {
    const byScreener = await score(screenerAuthor(), { ratings: rated(2, 2, 2) });
    const byEmployee = await score(employeeAuthor(), { ratings: rated(2, 2, 2) });
    const byMember = await score(memberAuthor(), { ratings: rated(2, 2, 2) });
    assert.equal(byScreener.modelLabel, "claude-sonnet-4-5");
    assert.equal(byScreener.authorKind, "screener");
    assert.equal(byScreener.authorEmployeeId, screener.id);
    assert.equal(byEmployee.modelLabel, "");
    assert.equal(byEmployee.authorEmployeeId, employee.id);
    assert.equal(byMember.modelLabel, "");
    assert.equal(byMember.authorUserId, owner.id);
    assert.equal(byMember.authorEmployeeId, null);
  });

  test("instructions aimed at the AI flag the Application, and a later clean reading keeps the flag", async () => {
    await score(employeeAuthor(), { ratings: rated(2, 2, 2), injectionDetected: true });
    assert.equal((await reloadApplication()).injectionFlag, true);
    await score(employeeAuthor(), { ratings: rated(2, 2, 2) }, { target: await reloadApplication() });
    assert.equal((await reloadApplication()).injectionFlag, true);
  });

  test("a flag raised while a screen was running survives that screen's clean result", async () => {
    // The screener holds the Application as it was when the screen began.
    const asTheScreenBegan = await reloadApplication();
    await addEmployeeScorecard({
      companyId: company.id,
      applicationId: application.id,
      input: { ratings: rated(2, 2, 2), injectionDetected: true },
      employee,
    });
    await score(screenerAuthor(), { ratings: rated(2, 2, 2) }, { target: asTheScreenBegan });
    assert.equal((await reloadApplication()).injectionFlag, true);
  });

  test("listScorecards is newest first, the same every time, and a tie never hides the current AI reading", async () => {
    // SQLite keeps `createdAt` to the second, so Scorecards written together tie.
    const instant = new Date("2026-10-01T09:00:00.000Z");
    const card = (authorKind: "member" | "employee", createdAt: Date) =>
      insert(RecruitingScorecard, {
        companyId: company.id,
        openingId: opening.id,
        applicationId: application.id,
        authorKind,
        authorName: authorKind,
        createdAt,
      });
    const tied = [await card("employee", instant), await card("employee", instant), await card("member", instant)];
    const newest = await card("member", new Date(instant.getTime() + 1_000));
    const tiedByIdDesc = tied.map((row) => row.id).sort().reverse();

    const plain = (await listScorecards(application.id)).map((row) => row.id);
    assert.deepEqual(plain, [newest.id, ...tiedByIdDesc]);
    assert.deepEqual((await listScorecards(application.id)).map((row) => row.id), plain, "the same order every time");

    // Whichever tied AI Scorecard is the Application's current reading leads
    // its tie; it is never moved ahead of a later Scorecard.
    for (const current of tied.slice(0, 2)) {
      assert.deepEqual(
        (await listScorecards(application.id, current.id)).map((row) => row.id),
        [newest.id, current.id, ...tiedByIdDesc.filter((id) => id !== current.id)],
      );
    }
  });

  test("listScorecards returns every Scorecard of one Application only", async () => {
    const other = await applicationTo(opening);
    await score(memberAuthor(), { ratings: rated(1, 1, 1) });
    await score(employeeAuthor(), { ratings: rated(1, 1, 1) }, { target: other });
    assert.equal((await listScorecards(application.id)).length, 1);
    assert.equal((await listScorecards(other.id)).length, 1);
  });
});

describe("the timeline", () => {
  test("a person's Scorecard is on the timeline as theirs, with its score and summary", async () => {
    const scorecard = await score(memberAuthor(), {
      ratings: rated(0, 2, 2),
      summary: "Strong on data, no TypeScript shown.",
      strengths: ["Postgres in production"],
      concerns: ["No TypeScript"],
      interviewQuestions: ["Walk me through a migration you led."],
    });
    const scored = (await listApplicationEvents(application.id)).find((event) => event.kind === "scored")!;
    assert.equal(scored.actorKind, "member");
    assert.equal(scored.actorUserId, owner.id);
    assert.equal(scored.actorName, "Olive Owner");
    assert.equal(scored.body, "Strong on data, no TypeScript shown.");
    assert.deepEqual(scored.meta, {
      scorecardId: scorecard.id,
      score: scorecard.score,
      label: "weak",
      authorKind: "member",
      missingMustHaves: ["TypeScript"],
      unverifiedQuotes: 0,
    });

    const dto = scorecardDto(scorecard, parseCriteria(opening.criteriaJson));
    assert.deepEqual(dto.strengths, ["Postgres in production"]);
    assert.deepEqual(dto.concerns, ["No TypeScript"]);
    assert.deepEqual(dto.interviewQuestions, ["Walk me through a migration you led."]);
  });

  test("an AI screen is on the timeline as the screener's", async () => {
    await score(screenerAuthor(), { ratings: rated(3, 3, 3) });
    const scored = (await listApplicationEvents(application.id)).find((event) => event.kind === "scored")!;
    assert.equal(scored.actorKind, "employee");
    assert.equal(scored.actorEmployeeId, screener.id);
    assert.equal(scored.actorName, "Sol");
    assert.equal(scored.meta.authorKind, "screener");
    assert.equal(scored.meta.label, "strong");
  });

  test("a refused Scorecard leaves no trace on the timeline", async () => {
    await assert.rejects(score(employeeAuthor(), { ratings: rated(3, null, 3) }));
    assert.equal((await listApplicationEvents(application.id)).length, 0);
  });
});

describe("company isolation", () => {
  test("neither a person nor an AI Employee can score another company's Application", async () => {
    const theirOpening = await openingWithCriteria(otherCompany.id, { kind: "member", userId: outsider.id });
    const theirs = await applicationTo(theirOpening);
    await assert.rejects(
      addMemberScorecard({
        companyId: company.id,
        applicationId: theirs.id,
        input: { ratings: rated(3, 3, 3) },
        userId: owner.id,
        userName: "Olive Owner",
      }),
      RecruitingNotFoundError,
    );
    await assert.rejects(
      addEmployeeScorecard({ companyId: company.id, applicationId: theirs.id, input: { ratings: rated(3, 3, 3) }, employee }),
      RecruitingNotFoundError,
    );
    assert.equal(await scorecardCount(), 0);
    const untouched = await AppDataSource.getRepository(RecruitingApplication).findOneByOrFail({ id: theirs.id });
    assert.equal(untouched.score, null);
  });

  test("hasScorecard answers for a person's or an AI's Scorecard, asked by the Application's own company only", async () => {
    assert.equal(await hasScorecard(company.id, application.id), false);
    await score(memberAuthor(), { ratings: [{ criterionId: "pg", rating: 1 }] });
    assert.equal(await hasScorecard(company.id, application.id), true);
    assert.equal(await hasScorecard(otherCompany.id, application.id), false);
  });

  test("a Scorecard is filed under the Application's own company and Opening", async () => {
    const scorecard = await addEmployeeScorecard({
      companyId: company.id,
      applicationId: application.id,
      input: { ratings: rated(2, 2, 2) },
      employee,
    });
    assert.equal(scorecard.companyId, company.id);
    assert.equal(scorecard.openingId, opening.id);
    assert.equal(scorecard.applicationId, application.id);
  });
});

describe("scorecardDto", () => {
  test("a row whose ratings no longer parse reads as unrated rather than failing", async () => {
    const scorecard = await score(memberAuthor(), { ratings: rated(1, 1, 1) });
    const dto = scorecardDto(Object.assign(scorecard, { ratingsJson: "{oops" }), parseCriteria(opening.criteriaJson));
    assert.deepEqual(dto.ratings, []);
    assert.deepEqual(dto.missingMustHaves, []);
    assert.equal(dto.score, scorecard.score);
  });
});
