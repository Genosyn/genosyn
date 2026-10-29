import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  KIND_MATCH_SCORE,
  type SearchKind,
  foldKindText,
  isKindToken,
  matchKindToken,
  searchKindsNamedByToken,
} from "../../shared/searchKinds.js";

describe("search kind words", () => {
  test("folds case, accents, punctuation, and runs of whitespace", () => {
    assert.equal(foldKindText("  Dashboards "), "dashboards");
    assert.equal(foldKindText("DASH-BOARD"), "dash board");
    assert.equal(foldKindText("Résumé"), "resume");
    assert.equal(foldKindText(""), "");
  });

  test("matches a kind by its singular, plural, and as-you-type prefix", () => {
    assert.equal(matchKindToken("dashboard", "dashboard"), KIND_MATCH_SCORE.exact);
    assert.equal(matchKindToken("dashboard", "dashboards"), KIND_MATCH_SCORE.exact);
    assert.equal(matchKindToken("dashboard", "dash"), KIND_MATCH_SCORE.prefix);
    assert.equal(matchKindToken("dashboard", "dashbo"), KIND_MATCH_SCORE.prefix);
    assert.equal(matchKindToken("chart", "chart"), KIND_MATCH_SCORE.exact);
    assert.equal(matchKindToken("chart", "charts"), KIND_MATCH_SCORE.exact);
    assert.equal(matchKindToken("chart", "char"), KIND_MATCH_SCORE.prefix);
    assert.equal(matchKindToken("project", "projects"), KIND_MATCH_SCORE.exact);
    assert.equal(matchKindToken("project", "proj"), KIND_MATCH_SCORE.prefix);
  });

  test("answers to the words people use for each kind", () => {
    const synonyms: Array<[SearchKind, string]> = [
      ["employee", "agent"],
      ["employee", "teammate"],
      ["employee", "worker"],
      ["employee", "ai"],
      ["skill", "playbook"],
      ["routine", "cron"],
      ["routine", "schedule"],
      ["channel", "chat"],
      ["todo", "task"],
      ["todo", "ticket"],
      ["base", "table"],
      ["base", "database"],
      ["base", "airtable"],
      ["base", "sheet"],
      ["note", "doc"],
      ["note", "document"],
      ["note", "page"],
      ["note", "wiki"],
      ["resource", "ebook"],
      ["resource", "library"],
      ["chart", "graph"],
      ["chart", "visualization"],
      ["repository", "repo"],
      ["pipeline", "workflow"],
      ["customer", "client"],
      ["opening", "job"],
      ["opening", "vacancy"],
      ["opening", "role"],
      ["applicant", "candidate"],
      ["applicant", "application"],
    ];
    for (const [kind, word] of synonyms) {
      assert.equal(
        matchKindToken(kind, word),
        KIND_MATCH_SCORE.exact,
        `${word} should name ${kind}`,
      );
    }
  });

  test("derives plurals instead of keeping a second table that can drift", () => {
    for (const [kind, word] of [
      ["base", "bases"],
      ["chart", "charts"],
      ["repository", "repositories"],
      ["opening", "vacancies"],
      ["applicant", "applications"],
      ["note", "documents"],
      ["resource", "libraries"],
      ["pipeline", "workflows"],
      ["employee", "teammates"],
    ] as const) {
      assert.equal(matchKindToken(kind, word), KIND_MATCH_SCORE.exact, `${word} → ${kind}`);
    }
  });

  test("refuses short prefixes that would select half the catalogue", () => {
    // "pro" is the start of Project, but also of Product area, Profile, and
    // progress; three letters are too few to make it a kind qualifier.
    for (const [kind, word] of [
      ["project", "pro"],
      ["dashboard", "das"],
      ["chart", "cha"],
      ["note", "not"],
      ["todo", "tas"],
      ["resource", "res"],
      ["repository", "rep"],
      ["applicant", "app"],
    ] as const) {
      assert.equal(matchKindToken(kind, word), null, `${word} must not name ${kind}`);
    }
  });

  test("never absorbs a word that means something else", () => {
    for (const word of ["revenue", "quarterly", "board", "report", "settings", "dashboardish"]) {
      assert.equal(matchKindToken("dashboard", word), null, word);
      assert.equal(matchKindToken("chart", word), null, word);
    }
  });

  test("leaves product areas and Finance products to their own names", () => {
    // Both are called "product" in different places. A qualifier that picked
    // one would make the other unreachable by its own name.
    for (const word of ["product", "products", "catalog", "item"]) {
      assert.equal(matchKindToken("product", word), null, word);
      assert.equal(matchKindToken("catalogProduct", word), null, word);
    }
  });

  test("lists every kind a token names, including ambiguous prefixes", () => {
    assert.deepEqual(searchKindsNamedByToken("dash"), ["dashboard"]);
    assert.deepEqual(searchKindsNamedByToken("dashboards"), ["dashboard"]);
    assert.deepEqual(searchKindsNamedByToken("chart"), ["chart"]);
    assert.deepEqual(searchKindsNamedByToken("task"), ["todo"]);
    assert.deepEqual(searchKindsNamedByToken("tasks"), ["todo"]);
    assert.deepEqual(searchKindsNamedByToken("doc"), ["note"]);
    assert.deepEqual(searchKindsNamedByToken("docs"), ["note"]);
    assert.deepEqual(searchKindsNamedByToken("jobs"), ["opening"]);
    // A prefix can legitimately name two kinds; the caller ORs them.
    assert.deepEqual(searchKindsNamedByToken("char"), ["chart"]);
    assert.deepEqual(searchKindsNamedByToken("note"), ["note", "notebook"]);
    assert.deepEqual(searchKindsNamedByToken("products"), []);
    assert.deepEqual(searchKindsNamedByToken("pro"), []);
    assert.deepEqual(searchKindsNamedByToken(""), []);
  });

  test("answers whether a token is any kind at all", () => {
    for (const word of ["dashboard", "agents", "repos", "jobs", "documents", "workflows"]) {
      assert.equal(isKindToken(word), true, word);
    }
    for (const word of ["revenue", "acme", "pro", "products", "quarterly"]) {
      assert.equal(isKindToken(word), false, word);
    }
  });

  test("every kind with a vocabulary is reachable by its own product noun", () => {
    const own: Array<[SearchKind, string]> = [
      ["employee", "employee"],
      ["skill", "skill"],
      ["routine", "routine"],
      ["channel", "channel"],
      ["project", "project"],
      ["todo", "todo"],
      ["base", "base"],
      ["notebook", "notebook"],
      ["note", "note"],
      ["resource", "resource"],
      ["chart", "chart"],
      ["dashboard", "dashboard"],
      ["repository", "repository"],
      ["pipeline", "pipeline"],
      ["customer", "customer"],
      ["account", "account"],
      ["opening", "opening"],
      ["applicant", "applicant"],
    ];
    for (const [kind, word] of own) {
      // "note" is also the start of Notebook, so an exact name leads the
      // list rather than being the only entry.
      assert.equal(searchKindsNamedByToken(word)[0], kind, word);
    }
  });
});
