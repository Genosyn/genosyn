import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CompanyTag, EmployeeSummary, RoutineFolder } from "./api";
import {
  filterRoutinesBySearch,
  matchesSearchTerms,
  routineSearchText,
  searchTerms,
  type SearchableRoutine,
} from "./routineSearch";

function tag(name: string, id = name.toLowerCase()): CompanyTag {
  return {
    id,
    companyId: "co",
    name,
    normalizedName: name.toLowerCase(),
    color: "slate",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function folder(id: string, path: string): RoutineFolder {
  const name = path.split("/").pop()!;
  return {
    id,
    companyId: "co",
    name,
    slug: name.toLowerCase(),
    parentId: null,
    sortOrder: 0,
    path,
    depth: path.split("/").length,
    routineCount: 0,
    totalRoutineCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function employee(name: string, slug = name.toLowerCase().replace(/\s+/g, "-")): EmployeeSummary {
  return { id: slug, name, slug, role: "Analyst", avatarKey: null };
}

function routine(overrides: Partial<SearchableRoutine> = {}): SearchableRoutine {
  return {
    name: "Morning digest",
    slug: "morning-digest",
    cronExpr: "0 9 * * *",
    folderId: null,
    employee: employee("Ada Lovelace"),
    tags: [],
    ...overrides,
  };
}

describe("searchTerms", () => {
  test("a blank query has no terms, so callers can read it as 'not searching'", () => {
    assert.deepEqual(searchTerms(""), []);
    assert.deepEqual(searchTerms("   "), []);
    assert.deepEqual(searchTerms("\t\n "), []);
  });

  test("terms are lowercased", () => {
    assert.deepEqual(searchTerms("Finance"), ["finance"]);
    assert.deepEqual(searchTerms("MONTH-END"), ["month-end"]);
  });

  test("whitespace separates terms and runs of it collapse", () => {
    assert.deepEqual(searchTerms("finance   digest"), ["finance", "digest"]);
    assert.deepEqual(searchTerms("  finance digest  "), ["finance", "digest"]);
  });

  test("a repeated term is only asked once", () => {
    assert.deepEqual(searchTerms("digest digest DIGEST"), ["digest"]);
  });

  test("accents are folded, so an unaccented keyboard still finds the name", () => {
    assert.deepEqual(searchTerms("José"), ["jose"]);
    assert.deepEqual(searchTerms("Renée Dupré"), ["renee", "dupre"]);
  });

  test("punctuation inside a term is kept — a folder path is one term", () => {
    assert.deepEqual(searchTerms("Finance/Month-end"), ["finance/month-end"]);
    assert.deepEqual(searchTerms("*/15"), ["*/15"]);
  });
});

describe("routineSearchText", () => {
  test("carries every field the row displays", () => {
    const text = routineSearchText(
      routine({
        name: "Month-end close",
        slug: "month-end-close",
        employee: employee("Grace Hopper"),
        tags: [tag("quarterly"), tag("urgent")],
      }),
      "Finance/Month-end",
    );
    for (const needle of [
      "month-end close",
      "month-end-close",
      "grace hopper",
      "grace-hopper",
      "finance/month-end",
      "quarterly",
      "urgent",
    ]) {
      assert.ok(text.includes(needle), `expected the haystack to include ${needle}`);
    }
  });

  test("carries the schedule in every dialect a person might type", () => {
    const text = routineSearchText(routine({ cronExpr: "0 9 * * 1-5" }), null);
    assert.ok(text.includes("0 9 * * 1-5"), "raw expression");
    assert.ok(text.includes("weekday"), "the words the row on screen uses");
    assert.ok(text.includes("monday"), "the days the schedule actually names");
  });

  test("an unreadable cron expression still contributes itself rather than throwing", () => {
    const text = routineSearchText(routine({ cronExpr: "not a cron" }), null);
    assert.ok(text.includes("not a cron"));
  });

  test("is folded, so it can be compared against folded terms", () => {
    const text = routineSearchText(
      routine({ name: "Résumé sweep", employee: employee("José Díaz") }),
      null,
    );
    assert.ok(text.includes("resume sweep"));
    assert.ok(text.includes("jose diaz"));
  });

  test("an unassigned routine, no tags, and no folder are all fine", () => {
    const text = routineSearchText(
      { name: "Orphan", slug: "orphan", cronExpr: "0 9 * * *", folderId: null } as SearchableRoutine,
      null,
    );
    assert.ok(text.includes("orphan"));
    assert.ok(!text.includes("undefined"), "a missing field must not leak into the haystack");
    assert.ok(!text.includes("null"));
  });
});

describe("matchesSearchTerms", () => {
  const r = routine({
    name: "Month-end close",
    employee: employee("Grace Hopper"),
    tags: [tag("quarterly")],
  });

  test("no terms matches everything, so a blank box hides nothing", () => {
    assert.equal(matchesSearchTerms(r, [], null), true);
  });

  test("a term may match any one field", () => {
    assert.equal(matchesSearchTerms(r, ["close"], null), true);
    assert.equal(matchesSearchTerms(r, ["grace"], null), true);
    assert.equal(matchesSearchTerms(r, ["quarterly"], null), true);
    assert.equal(matchesSearchTerms(r, ["finance"], "Finance/Month-end"), true);
  });

  test("every term must match, and they may land in different fields", () => {
    assert.equal(matchesSearchTerms(r, ["close", "grace"], null), true);
    assert.equal(matchesSearchTerms(r, ["close", "ada"], null), false);
  });

  test("matching is on substrings, so partial words find the row mid-typing", () => {
    assert.equal(matchesSearchTerms(r, ["mont"], null), true);
    assert.equal(matchesSearchTerms(r, ["hopp"], null), true);
  });

  test("a term nothing carries fails the whole match", () => {
    assert.equal(matchesSearchTerms(r, ["invoices"], null), false);
  });

  test("the folder is only searchable when its path is supplied", () => {
    assert.equal(matchesSearchTerms(r, ["finance"], null), false);
  });
});

describe("filterRoutinesBySearch", () => {
  const finance = folder("f-finance", "Finance");
  const monthEnd = folder("f-month-end", "Finance/Month-end");
  const folders = [finance, monthEnd];

  const digest = routine({ name: "Morning digest", slug: "morning-digest" });
  const close = routine({
    name: "Month-end close",
    slug: "month-end-close",
    folderId: monthEnd.id,
    employee: employee("Grace Hopper"),
    tags: [tag("quarterly")],
    cronExpr: "0 9 * * 1-5",
  });
  const sweep = routine({
    name: "Inbox sweep",
    slug: "inbox-sweep",
    folderId: finance.id,
    cronExpr: "*/15 * * * *",
    tags: [tag("urgent")],
  });
  const all = [digest, close, sweep];

  const names = (rows: SearchableRoutine[]) => rows.map((r) => r.name);

  test("a blank query returns everything", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "", folders)), names(all));
    assert.deepEqual(names(filterRoutinesBySearch(all, "   ", folders)), names(all));
  });

  test("a blank query returns a copy, not the caller's array", () => {
    const out = filterRoutinesBySearch(all, "", folders);
    assert.notEqual(out, all);
    assert.deepEqual(out, all);
  });

  test("input order is preserved — a list must not reshuffle as you type", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "e", folders)), [
      "Morning digest",
      "Month-end close",
      "Inbox sweep",
    ]);
  });

  test("matches on the routine name", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "digest", folders)), ["Morning digest"]);
  });

  test("matches on the slug, so a pasted link still finds a renamed routine", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "inbox-sweep", folders)), ["Inbox sweep"]);
  });

  test("matches on the assigned employee", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "hopper", folders)), ["Month-end close"]);
  });

  test("matches on the folder the routine is filed in", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "month-end", folders)), ["Month-end close"]);
  });

  test("a parent folder's name matches everything filed beneath it", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "finance", folders)), [
      "Month-end close",
      "Inbox sweep",
    ]);
  });

  test("matches on a tag name", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "urgent", folders)), ["Inbox sweep"]);
  });

  test("matches on the raw cron expression", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "*/15", folders)), ["Inbox sweep"]);
  });

  test("matches on the plain-English schedule the row actually displays", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "friday", folders)), ["Month-end close"]);
    // The row says "Every weekday at 9:00 AM" now, so that has to match too.
    assert.deepEqual(names(filterRoutinesBySearch(all, "weekday", folders)), ["Month-end close"]);
    assert.deepEqual(names(filterRoutinesBySearch(all, "15 minutes", folders)), ["Inbox sweep"]);
  });

  test("terms are ANDed across different fields", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "finance urgent", folders)), ["Inbox sweep"]);
    assert.deepEqual(names(filterRoutinesBySearch(all, "finance nonsense", folders)), []);
  });

  test("case and accents do not matter", () => {
    const accented = routine({ name: "Résumé sweep", slug: "resume-sweep" });
    assert.deepEqual(names(filterRoutinesBySearch([accented], "RESUME", folders)), [
      "Résumé sweep",
    ]);
    assert.deepEqual(names(filterRoutinesBySearch([accented], "résumé", folders)), [
      "Résumé sweep",
    ]);
  });

  test("nothing matching yields an empty list rather than the whole one", () => {
    assert.deepEqual(filterRoutinesBySearch(all, "payroll", folders), []);
  });

  test("an unfiled routine is searchable by everything except a folder", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "morning", folders)), ["Morning digest"]);
    assert.deepEqual(names(filterRoutinesBySearch([digest], "finance", folders)), []);
  });

  test("a folderId with no matching folder row is treated as unfiled, not a crash", () => {
    const stranded = routine({ name: "Stranded", slug: "stranded", folderId: "gone" });
    assert.deepEqual(names(filterRoutinesBySearch([stranded], "stranded", folders)), ["Stranded"]);
    assert.deepEqual(names(filterRoutinesBySearch([stranded], "finance", folders)), []);
  });

  test("an empty folder list is fine — the folder axis just goes quiet", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "close", [])), ["Month-end close"]);
    assert.deepEqual(names(filterRoutinesBySearch(all, "finance", [])), []);
  });

  test("one routine's folder never lends its path to another's match", () => {
    assert.deepEqual(names(filterRoutinesBySearch(all, "finance digest", folders)), []);
  });
});
