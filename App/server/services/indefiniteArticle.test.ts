import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { indefiniteArticle, withIndefiniteArticle } from "../../shared/indefiniteArticle.js";
import { EMPLOYEE_TEMPLATES } from "./templates.js";

/**
 * The one rule for "a" and "an" (`shared/indefiniteArticle.ts`). Every case
 * here is a claim the module's comments make, so a change to the rule has to
 * change a line in this file too.
 */

function expectAll(article: "a" | "an", phrases: readonly string[]): void {
  for (const phrase of phrases) {
    assert.equal(indefiniteArticle(phrase), article, phrase);
    assert.equal(withIndefiniteArticle(phrase), `${article} ${phrase}`, phrase);
  }
}

describe("the ordinary rule", () => {
  test("a vowel letter takes an", () => {
    expectAll("an", [
      "account",
      "email",
      "email instruction",
      "estimate",
      "employee",
      "invoice",
      "initiative",
      "item",
      "order",
      "automatic email step",
      "ai employee",
    ]);
  });

  test("a consonant letter takes a", () => {
    expectAll("a", [
      "step",
      "question",
      "decision",
      "routine",
      "connection",
      "mail message",
      "record",
      "todo",
      "deal stage",
      "tldr",
    ]);
  });

  test("capitals at the start of a word do not change it", () => {
    expectAll("an", [
      "Account Executive",
      "Executive Assistant",
      "Operations Coordinator",
      "Email",
    ]);
    expectAll("a", ["Software Engineer", "Data Analyst", "Routine", "Decision"]);
  });
});

describe("a vowel letter said with a consonant", () => {
  test("words said with a 'you'", () => {
    expectAll("a", [
      "user",
      "users",
      "username",
      "use case",
      "useful note",
      "usage record",
      "usable draft",
      "usual reply",
      "unit",
      "union",
      "unique link",
      "universal rule",
      "university",
      "uniform",
      "unified inbox",
      "unicorn",
      "unicode string",
      "utility bill",
      "utensil",
      "utopia",
      "uranium",
      "urine test",
      "url",
      "urology clinic",
      "ubiquitous tool",
      "ukulele",
      "uk company",
      "euro payment",
      "European customer",
      "eulogy",
      "ewe",
    ]);
  });

  test("words said with a 'w'", () => {
    expectAll("a", ["one", "one-off", "one-time link", "one time link", "One", "once-over"]);
  });

  test("'un-' before anything else keeps its vowel", () => {
    expectAll("an", [
      "update",
      "unread email",
      "unknown sender",
      "unsubscribe",
      "undo",
      "uninstall",
      "unimportant thread",
      "unindexed folder",
      "unidentified caller",
      "unarchived thread",
      "unpaid invoice",
    ]);
  });

  test("other 'u' words keep their vowel", () => {
    expectAll("an", [
      "urgent reply",
      "urban office",
      "urn",
      "utter mess",
      "usher",
      "umbrella",
      "upload",
    ]);
  });

  test("a word that only starts like 'one' keeps its vowel", () => {
    expectAll("an", ["onerous request", "online form", "only child"]);
  });
});

describe("a consonant letter said with a vowel", () => {
  test("a silent h takes an", () => {
    expectAll("an", [
      "hour",
      "hours",
      "hourly rate",
      "honest answer",
      "honesty",
      "honor",
      "honorary title",
      "honour",
      "heir",
      "heirloom",
      "Hour",
    ]);
  });

  test("a sounded h takes a", () => {
    expectAll("a", ["house", "human", "hotel", "handover", "help request", "history"]);
  });
});

describe("capitals said letter by letter", () => {
  test("letters whose names start with a vowel take an", () => {
    expectAll("an", [
      "AI Employee",
      "API key",
      "EU customer",
      "FAQ",
      "HR lead",
      "HTML page",
      "ID",
      "IT team",
      "LLM",
      "MCP server",
      "NDA",
      "OKR",
      "RSS feed",
      "SDR",
      "SMS",
      "SMTP server",
      "SSO connection",
      "X account",
    ]);
  });

  test("letters whose names start with a consonant take a", () => {
    expectAll("a", [
      "URL",
      "UI",
      "UX review",
      "CEO",
      "PDF",
      "CSV export",
      "B2B deal",
      "VP",
      "GIF",
      "US company",
    ]);
  });

  test("a longer word in capitals with vowels is said as a word", () => {
    expectAll("a", ["NASA grant", "STEP", "JSON file", "USER", "UNIT"]);
    expectAll("an", ["EMAIL", "IMAP folder", "INVOICE", "HOUR"]);
  });

  test("mixed-case names are said as words", () => {
    expectAll("an", ["OAuth app", "iOS device", "eBay listing"]);
    expectAll("a", ["RevOps Analyst", "SaaS plan", "MySQL database", "GitHub issue"]);
  });
});

describe("what counts as the first word", () => {
  test("leading space and punctuation are skipped", () => {
    assert.equal(indefiniteArticle("  email"), "an");
    assert.equal(indefiniteArticle("“urgent” reply"), "an");
    assert.equal(indefiniteArticle("(optional) note"), "an");
    assert.equal(indefiniteArticle("— user"), "a");
  });

  test("only the first word decides", () => {
    assert.equal(indefiniteArticle("customer email"), "a");
    assert.equal(indefiniteArticle("email customer"), "an");
    assert.equal(indefiniteArticle("user invoice"), "a");
  });

  test("a phrase with no word in it takes a", () => {
    for (const phrase of ["", "   ", "—", "“”"])
      assert.equal(indefiniteArticle(phrase), "a", phrase);
  });
});

describe("words the product puts an article in front of", () => {
  test("every AI Employee template role, as the new-employee form asks about it", () => {
    // The form asked what an employee decides "as a Account Executive".
    const takesAn = new Set(["Account Executive", "Executive Assistant", "Operations Coordinator"]);
    assert.ok(EMPLOYEE_TEMPLATES.length > 0);
    for (const { role } of EMPLOYEE_TEMPLATES) {
      assert.equal(withIndefiniteArticle(role), `${takesAn.has(role) ? "an" : "a"} ${role}`, role);
    }
    for (const role of takesAn) {
      assert.ok(
        EMPLOYEE_TEMPLATES.some((template) => template.role === role),
        `${role} is still a template role`,
      );
    }
  });

  test("every account type a ledger line can sit on", () => {
    for (const [type, named] of [
      ["asset", "an asset"],
      ["liability", "a liability"],
      ["equity", "an equity"],
      ["revenue", "a revenue"],
      ["expense", "an expense"],
    ] as const) {
      assert.equal(withIndefiniteArticle(type), named);
    }
  });

  test("every status a work review can already have", () => {
    for (const [status, named] of [
      ["pending", "a pending"],
      ["approved", "an approved"],
      ["rejected", "a rejected"],
      ["executing", "an executing"],
      ["execution_failed", "an execution_failed"],
      ["expired", "an expired"],
    ] as const) {
      assert.equal(withIndefiniteArticle(status), named);
    }
  });

  test("every platform a browser user agent can claim", () => {
    for (const [platform, named] of [
      ["macos", "a macos"],
      ["windows", "a windows"],
      ["linux", "a linux"],
      ["unknown", "an unknown"],
    ] as const) {
      assert.equal(withIndefiniteArticle(platform), named);
    }
  });
});

describe("the phrase is used as given", () => {
  test("the article goes in front and nothing else changes", () => {
    assert.equal(withIndefiniteArticle("email instruction"), "an email instruction");
    assert.equal(withIndefiniteArticle("AI Employee"), "an AI Employee");
    assert.equal(withIndefiniteArticle("Account Executive"), "an Account Executive");
    assert.equal(withIndefiniteArticle("user"), "a user");
  });

  test("capitalized starts a sentence and changes only the article", () => {
    for (const [phrase, sentence] of [
      ["Experiment", "An Experiment"],
      ["Campaign", "A Campaign"],
      ["AI Employee", "An AI Employee"],
      ["employee", "An employee"],
      ["routine", "A routine"],
      ["expense", "An expense"],
      ["user", "A user"],
      ["hour", "An hour"],
    ] as const) {
      assert.equal(withIndefiniteArticle(phrase, { capitalized: true }), sentence);
      assert.equal(
        withIndefiniteArticle(phrase, { capitalized: false }),
        withIndefiniteArticle(phrase),
      );
    }
  });

  test("it is a pure function of the phrase", () => {
    for (const phrase of ["email", "user", "hour", "SMS", "step"]) {
      assert.equal(withIndefiniteArticle(phrase), withIndefiniteArticle(phrase));
      assert.equal(indefiniteArticle(phrase), indefiniteArticle(phrase));
    }
  });
});
