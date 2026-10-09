import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  MAX_WAITING_DECISIONS_PER_EMPLOYEE,
  SAME_QUESTION_SIMILARITY,
  SAME_SUBJECT_SIMILARITY,
  checkWaitingDecisions,
  differentSubjects,
  findDuplicateDecision,
  questionSimilarity,
  questionWords,
  subjectWords,
  waitingDecisionsOf,
  type WaitingDecision,
} from "./decisionDuplicates.js";

/**
 * One employee's questions stay few and distinct: never the same question
 * twice — the same words, the same piece of work, or the same thing from the
 * same Routine — and never more than a few waiting at once. Matching by words
 * is conservative on purpose: two questions naming different things are
 * never the same question.
 */

const T0 = new Date("2026-10-09T08:00:00.000Z");

function waiting(title: string, changes: Partial<WaitingDecision> = {}): WaitingDecision {
  return {
    id: `id-${title.length}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    routineId: null,
    runId: null,
    mailThreadId: null,
    conversationId: null,
    createdAt: T0,
    ...changes,
  };
}

describe("the limits", () => {
  test("are a few questions, and a stricter bar from anywhere than from one Routine", () => {
    assert.equal(MAX_WAITING_DECISIONS_PER_EMPLOYEE, 3);
    assert.ok(SAME_QUESTION_SIMILARITY > SAME_SUBJECT_SIMILARITY);
  });
});

describe("questionWords", () => {
  test("keeps what a question is about, without framing words, plurals or dates", () => {
    assert.deepEqual(
      [...questionWords("Should we decide Acme's contract terms by Oct 8 15:00?")].sort(),
      ["acme", "contract", "oct", "term"],
    );
    assert.deepEqual([...questionWords("Decide which choice to pick")], []);
    assert.deepEqual([...questionWords("Pass the class")].sort(), ["class", "pass"]);
  });
});

describe("subjectWords", () => {
  test("reads names and references, not the first word or bare numbers", () => {
    assert.deepEqual([...subjectWords("Decide UTA RFP UTA27 response by Oct 8 15:00 CT")].sort(), [
      "ct",
      "oct",
      "rfp",
      "uta",
      "uta27",
    ]);
    assert.deepEqual([...subjectWords("Approve Acme's Q3 discount")].sort(), ["acme", "q3"]);
    assert.deepEqual([...subjectWords("raise prices this quarter")], []);
  });
});

describe("questionSimilarity", () => {
  test("is shared words over all words", () => {
    assert.equal(
      questionSimilarity("Choose Acme's contract terms", "Choose contract terms for Acme"),
      1,
    );
    assert.equal(questionSimilarity("Renew the Acme contract", "Approve a hiring plan"), 0);
    assert.equal(questionSimilarity("", "Anything"), 0);
    const half = questionSimilarity("Renew Acme contract", "Renew Acme pricing deal");
    assert.ok(half > 0 && half < 1, String(half));
  });
});

describe("differentSubjects", () => {
  test("only when each names something the other does not", () => {
    assert.equal(
      differentSubjects("Choose Q3 pricing for Acme", "Choose Q3 pricing for Globex"),
      true,
    );
    assert.equal(
      differentSubjects("Bid on UTA RFP UTA27?", "Decide UTA RFP UTA27 response by Oct 8"),
      false,
    );
    assert.equal(differentSubjects("raise prices", "cut prices"), false);
  });
});

describe("findDuplicateDecision", () => {
  test("the same question in other words, from anywhere", () => {
    const existing = waiting("Choose Acme's contract terms");
    assert.deepEqual(
      findDuplicateDecision({ title: "Choose contract terms for Acme?" }, [existing]),
      {
        decision: existing,
        match: "same_question",
      },
    );
    assert.deepEqual(findDuplicateDecision({ title: "choose ACME's CONTRACT terms" }, [existing]), {
      decision: existing,
      match: "same_question",
    });
  });

  test("the same question with filler words added or reordered", () => {
    const existing = waiting("Approve the renewal discount for Acme");
    assert.equal(
      findDuplicateDecision({ title: "Please approve Acme's renewal discount now?" }, [existing])
        ?.match,
      "same_question",
    );
    const long = waiting("Approve the three year renewal discount for Acme and Globex");
    assert.equal(
      findDuplicateDecision({ title: "Approve the three year renewal discount for Acme, Globex" }, [
        long,
      ])?.match,
      "same_question",
    );
  });

  test("one changed word in a short question is a new question from anywhere, but not from its Routine", () => {
    const existing = waiting("Approve the annual renewal discount for Acme", { routineId: "r1" });
    const asked = { title: "Approve the yearly renewal discount for Acme" };
    assert.equal(findDuplicateDecision(asked, [existing]), null);
    assert.equal(
      findDuplicateDecision({ ...asked, routineId: "r1" }, [existing])?.match,
      "same_subject",
    );
  });

  test("never the same question when they name different things", () => {
    const acme = waiting("Choose Q3 pricing for Acme", { routineId: "r1" });
    assert.equal(
      findDuplicateDecision({ title: "Choose Q3 pricing for Globex", routineId: "r1" }, [acme]),
      null,
    );
    assert.equal(
      findDuplicateDecision({ title: "Approve invoice INV-1042" }, [
        waiting("Approve invoice INV-1043"),
      ]),
      null,
    );
  });

  test("different questions are let through", () => {
    const existing = waiting("Offer Acme a 20% discount?");
    for (const title of [
      "Extend Acme's contract to three years?",
      "Hire a second support engineer?",
      "Raise list prices next quarter?",
    ]) {
      assert.equal(findDuplicateDecision({ title }, [existing]), null, title);
    }
    assert.equal(findDuplicateDecision({ title: "Anything" }, []), null);
  });

  test("one combined question per piece of work: the same Run, email thread or chat", () => {
    const run = waiting("Bid on the UTA tender?", { runId: "run-1", routineId: "r1" });
    assert.deepEqual(
      findDuplicateDecision({ title: "Hire a contractor for the bid?", runId: "run-1" }, [run]),
      {
        decision: run,
        match: "same_work",
      },
    );
    const thread = waiting("Refund Priya's order?", { mailThreadId: "thread-1" });
    assert.equal(
      findDuplicateDecision({ title: "Offer Priya a coupon?", mailThreadId: "thread-1" }, [thread])
        ?.match,
      "same_work",
    );
    const chat = waiting("Pick the launch date?", { conversationId: "chat-1" });
    assert.equal(
      findDuplicateDecision({ title: "Pick the launch venue?", conversationId: "chat-1" }, [chat])
        ?.match,
      "same_work",
    );
    // Another Run, thread or chat is another piece of work.
    assert.equal(
      findDuplicateDecision({ title: "Hire a contractor for the bid?", runId: "run-2" }, [run]),
      null,
    );
    assert.equal(
      findDuplicateDecision({ title: "Offer Priya a coupon?", mailThreadId: "thread-2" }, [thread]),
      null,
    );
  });

  test("a Routine does not re-ask on its next Run about the same thing", () => {
    const monday = waiting("Decide UTA RFP UTA27 response by Oct 8 15:00 CT", {
      routineId: "crm",
      runId: "mon",
    });
    assert.deepEqual(
      findDuplicateDecision(
        { title: "Should we bid on UTA RFP UTA27?", routineId: "crm", runId: "tue" },
        [monday],
      ),
      { decision: monday, match: "same_subject" },
    );
    // The same Routine about something else is a new question.
    assert.equal(
      findDuplicateDecision(
        { title: "Renew Initech's support plan?", routineId: "crm", runId: "tue" },
        [monday],
      ),
      null,
    );
    // The same subject from a different Routine needs the stricter wording match.
    assert.equal(
      findDuplicateDecision({ title: "Should we bid on UTA RFP UTA27?", routineId: "other" }, [
        monday,
      ]),
      null,
    );
    // Without names, a Routine's question needs most of the same words.
    const prices = waiting("raise prices for the starter plan", { routineId: "crm" });
    assert.equal(
      findDuplicateDecision({ title: "raise starter plan prices again", routineId: "crm" }, [
        prices,
      ])?.match,
      "same_question",
    );
    assert.equal(
      findDuplicateDecision({ title: "cut the ad budget", routineId: "crm" }, [prices]),
      null,
    );
  });

  test("the most specific match wins, the oldest on a tie", () => {
    const older = waiting("Choose Acme's contract terms", {
      createdAt: new Date(T0.getTime() - 60_000),
    });
    const newer = waiting("Choose Acme's contract terms", { createdAt: T0 });
    assert.equal(
      findDuplicateDecision({ title: "Choose Acme's contract terms" }, [newer, older])?.decision,
      older,
    );
    const sameWork = waiting("Bid on the tender?", {
      runId: "run-1",
      createdAt: new Date(T0.getTime() - 120_000),
    });
    const sameWords = waiting("Choose Acme's contract terms", { createdAt: T0 });
    assert.deepEqual(
      findDuplicateDecision({ title: "Choose the contract terms for Acme", runId: "run-1" }, [
        sameWork,
        sameWords,
      ]),
      { decision: sameWords, match: "same_question" },
    );
  });
});

describe("waitingDecisionsOf and checkWaitingDecisions", () => {
  let company: Company;
  let other: Company;
  let employee: AIEmployee;
  let colleague: AIEmployee;

  before(initTestDb);
  after(closeTestDb);
  beforeEach(async () => {
    await resetTestDb();
    const owner = await insert(User, { email: "o@example.test", name: "Owner", passwordHash: "x" });
    company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
    other = await insert(Company, { name: "Globex", slug: "globex", ownerId: owner.id });
    employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Rey",
      slug: "rey",
      role: "Ops",
      soulBody: "",
    });
    colleague = await insert(AIEmployee, {
      companyId: company.id,
      name: "Kai",
      slug: "kai",
      role: "Ops",
      soulBody: "",
    });
  });

  async function ask(
    title: string,
    changes: Partial<Decision> = {},
    who: AIEmployee = employee,
  ): Promise<Decision> {
    return insert(Decision, {
      companyId: who.companyId,
      employeeId: who.id,
      title,
      body: "x".repeat(10_000),
      optionsJson: "[]",
      status: "pending",
      ...changes,
    });
  }

  test("lists only this employee's waiting questions in this company, oldest first, without bodies", async () => {
    const first = await ask("First question", { createdAt: new Date(T0.getTime() - 2_000) });
    const second = await ask("Second question", {
      createdAt: new Date(T0.getTime() - 1_000),
      snoozedUntil: new Date(T0.getTime() + 86_400_000),
    });
    await ask("Answered", { status: "decided" });
    await ask("Dismissed", { status: "cancelled" });
    await ask("A colleague's", {}, colleague);
    const outsider = await insert(AIEmployee, {
      companyId: other.id,
      name: "Rey",
      slug: "rey",
      role: "Ops",
      soulBody: "",
    });
    await ask("Another company's", {}, outsider);
    const rows = await waitingDecisionsOf(company.id, employee.id);
    assert.deepEqual(
      rows.map((row) => row.id),
      [first.id, second.id],
      "a snoozed question is still waiting",
    );
    assert.equal((rows[0] as Partial<Decision>).body, undefined, "the body is never read");
    assert.deepEqual(await waitingDecisionsOf(other.id, employee.id), []);
  });

  test("a repeat is reported, pointing at the question already waiting", async () => {
    const existing = await ask("Choose Acme's contract terms");
    const check = await checkWaitingDecisions({
      companyId: company.id,
      employeeId: employee.id,
      asked: { title: "Choose the contract terms for Acme" },
    });
    assert.equal(check.outcome, "already_waiting");
    assert.equal(check.outcome === "already_waiting" && check.existing.id, existing.id);
  });

  test("a fourth waiting question is refused, a third is not", async () => {
    await ask("Renew the Initech plan");
    await ask("Hire a support engineer");
    assert.deepEqual(
      await checkWaitingDecisions({
        companyId: company.id,
        employeeId: employee.id,
        asked: { title: "Book the trade show booth" },
      }),
      { outcome: "clear" },
    );
    await ask("Book the trade show booth");
    const check = await checkWaitingDecisions({
      companyId: company.id,
      employeeId: employee.id,
      asked: { title: "Choose the Q4 webinar date" },
    });
    assert.equal(check.outcome, "too_many_waiting");
    assert.equal(
      check.outcome === "too_many_waiting" && check.limit,
      MAX_WAITING_DECISIONS_PER_EMPLOYEE,
    );
    assert.equal(check.outcome === "too_many_waiting" && check.waiting.length, 3);
  });

  test("a repeat is named before the limit, and answered or dismissed questions do not count", async () => {
    await ask("Renew the Initech plan");
    await ask("Hire a support engineer");
    await ask("Book the trade show booth");
    assert.equal(
      (
        await checkWaitingDecisions({
          companyId: company.id,
          employeeId: employee.id,
          asked: { title: "Book the booth at the trade show" },
        })
      ).outcome,
      "already_waiting",
    );
    await AppDataSource.getRepository(Decision).update(
      { title: "Renew the Initech plan" },
      { status: "decided" },
    );
    assert.deepEqual(
      await checkWaitingDecisions({
        companyId: company.id,
        employeeId: employee.id,
        asked: { title: "Choose the Q4 webinar date" },
      }),
      { outcome: "clear" },
    );
  });

  test("other employees' and other companies' questions never count", async () => {
    for (const title of ["One", "Two", "Three"])
      await ask(`${title} question for Kai`, {}, colleague);
    assert.deepEqual(
      await checkWaitingDecisions({
        companyId: company.id,
        employeeId: employee.id,
        asked: { title: "One question for Kai" },
      }),
      { outcome: "clear" },
    );
  });
});
