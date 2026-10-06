import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MATCH_SCORE,
  foldSearchText,
  isSubsequence,
  isWordAnchoredSubsequence,
  labelInitials,
  matchKeywords,
  matchLabelText,
  matchesInitials,
  queryTokens,
} from "./searchText.js";

describe("foldSearchText", () => {
  test("ignores case, accents, and runs of whitespace", () => {
    assert.equal(foldSearchText("  Récurring   Invoices "), "recurring invoices");
    assert.equal(foldSearchText("ÀÉÎÕÜ ñ Å ç"), "aeiou n a c");
    assert.equal(foldSearchText("Tab\tand\nnewline"), "tab and newline");
    assert.equal(foldSearchText("RECURRING"), "recurring");
  });

  test("decomposes compatibility characters and keeps punctuation", () => {
    assert.equal(foldSearchText("ﬁnance"), "finance");
    assert.equal(foldSearchText("Periods & exports"), "periods & exports");
    assert.equal(foldSearchText("Follow-ups"), "follow-ups");
  });

  test("treats a decomposed accent like a precomposed one", () => {
    // "é" typed as e + combining acute (U+0301) must fold the same way.
    assert.equal(foldSearchText("récurring"), foldSearchText("récurring"));
  });

  test("folds empty and blank input to nothing", () => {
    assert.equal(foldSearchText(""), "");
    assert.equal(foldSearchText("   \t "), "");
  });
});

describe("queryTokens", () => {
  test("splits a folded query into its words", () => {
    assert.deepEqual(queryTokens("finance recurring"), ["finance", "recurring"]);
    assert.deepEqual(queryTokens("one"), ["one"]);
    assert.deepEqual(queryTokens(""), []);
  });
});

describe("isSubsequence", () => {
  test("finds letters in order with gaps", () => {
    assert.equal(isSubsequence("ai employees", "aiemp"), true);
    assert.equal(isSubsequence("recurring", "rcrng"), true);
    assert.equal(isSubsequence("recurring", "gnir"), false);
    assert.equal(isSubsequence("abc", "abcd"), false);
    assert.equal(isSubsequence("anything", ""), true);
  });
});

describe("isWordAnchoredSubsequence", () => {
  test("allows typos that start where a word starts", () => {
    assert.equal(isWordAnchoredSubsequence("recurring invoices", "rcrng"), true);
    assert.equal(isWordAnchoredSubsequence("recurring invoices", "invcs"), true);
    assert.equal(isWordAnchoredSubsequence("transaction review", "rvw"), true);
    assert.equal(isWordAnchoredSubsequence("follow-ups", "ups"), true);
  });

  test("refuses letters scattered from the middle of words", () => {
    // i (transact-i-on), n, v (re-v-iew): a subsequence, but not anchored.
    assert.equal(isSubsequence("transaction review", "inv"), true);
    assert.equal(isWordAnchoredSubsequence("transaction review", "inv"), false);
    assert.equal(isWordAnchoredSubsequence("recurring invoices", "ecur"), false);
  });

  test("treats an empty needle as matching", () => {
    assert.equal(isWordAnchoredSubsequence("anything", ""), true);
  });
});

describe("matchLabelText", () => {
  test("ranks exact over prefix over word start over mid-word", () => {
    assert.deepEqual(matchLabelText("Invoices", "invoices"), {
      score: MATCH_SCORE.exact,
      hit: [0, 8],
    });
    assert.deepEqual(matchLabelText("Recurring invoices", "recur"), {
      score: MATCH_SCORE.prefix,
      hit: [0, 5],
    });
    assert.deepEqual(matchLabelText("Recurring invoices", "invoices"), {
      score: MATCH_SCORE.boundary,
      hit: [10, 18],
    });
    assert.deepEqual(matchLabelText("Gmail", "mail"), { score: MATCH_SCORE.infix, hit: [1, 5] });
    assert.ok(MATCH_SCORE.exact > MATCH_SCORE.prefix);
    assert.ok(MATCH_SCORE.prefix > MATCH_SCORE.boundary);
    assert.ok(MATCH_SCORE.boundary > MATCH_SCORE.infix);
  });

  test("counts punctuation as a word boundary", () => {
    assert.equal(matchLabelText("Follow-ups", "ups")?.score, MATCH_SCORE.boundary);
    assert.equal(matchLabelText("Periods & exports", "exports")?.score, MATCH_SCORE.boundary);
  });

  test("matches accented labels and keeps the highlight aligned", () => {
    assert.deepEqual(matchLabelText("Résumé", "resume"), {
      score: MATCH_SCORE.exact,
      hit: [0, 6],
    });
  });

  test("drops the highlight rather than draw it in the wrong place", () => {
    // "ﬁ" folds to two letters, so offsets in the folded text don't line up.
    const match = matchLabelText("ﬁnance", "finance");
    assert.equal(match?.score, MATCH_SCORE.exact);
    assert.equal(match?.hit, null);
  });

  test("returns nothing for a miss or an empty query", () => {
    assert.equal(matchLabelText("Invoices", "bills"), null);
    assert.equal(matchLabelText("Invoices", ""), null);
  });
});

describe("initials", () => {
  test("reads the first letter of every word", () => {
    assert.equal(labelInitials("Recurring invoices"), "ri");
    assert.equal(labelInitials("Periods & exports"), "pe");
    assert.equal(labelInitials("AI Employees"), "ae");
  });

  test("matches the start of multi-word initials only", () => {
    assert.equal(matchesInitials("Recurring invoices", "ri"), true);
    assert.equal(matchesInitials("Recurring invoices", "r"), true);
    assert.equal(matchesInitials("Recurring invoices", "ir"), false);
    // A one-word label has no initials worth matching.
    assert.equal(matchesInitials("Invoices", "i"), false);
  });
});

describe("matchKeywords", () => {
  test("prefers a keyword that starts with the query, wherever it sits", () => {
    assert.equal(matchKeywords(["bank feeds", "feed"], "fee"), MATCH_SCORE.keywordPrefix);
    assert.equal(matchKeywords(["bank feeds"], "feed"), MATCH_SCORE.keyword);
    assert.equal(matchKeywords(["Prix Fixe"], "fixe"), MATCH_SCORE.keyword);
  });

  test("folds keywords the same way as the query", () => {
    assert.equal(matchKeywords(["Écritures"], "ecrit"), MATCH_SCORE.keywordPrefix);
  });

  test("returns null when nothing matches", () => {
    assert.equal(matchKeywords(["vat", "gst"], "tax"), null);
    assert.equal(matchKeywords(undefined, "tax"), null);
    assert.equal(matchKeywords([], "tax"), null);
    assert.equal(matchKeywords(["vat"], ""), null);
  });
});
