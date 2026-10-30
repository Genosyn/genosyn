import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CONTACT_PAGE_SIZE, type ContactPageResponse, contactPageUrl } from "./contactPages.js";
import {
  type CursorPages,
  cursorPageRange,
  firstCursorPage,
  nextCursorPage,
  openPageCursor,
  previousCursorPage,
} from "./cursorPages.js";

/**
 * Previous / Next over a list the server pages by cursor, as Revenue →
 * Contacts does. The page used to step by offset; these pin that walking the
 * list with the server's cursor reaches every contact once even while
 * contacts are archived or move to the top between pages, and that Previous
 * returns to where each page started.
 */

describe("cursor pages", () => {
  test("Next follows the open page's cursor and Previous goes back to where a page started", () => {
    let pages = firstCursorPage();
    assert.equal(openPageCursor(pages), null);
    pages = nextCursorPage(pages, "c1");
    pages = nextCursorPage(pages, "c2");
    assert.deepEqual(pages, { starts: [null, "c1", "c2"], index: 2 });
    assert.equal(openPageCursor(pages), "c2");
    pages = previousCursorPage(pages);
    assert.equal(openPageCursor(pages), "c1");
    pages = previousCursorPage(previousCursorPage(previousCursorPage(pages)));
    assert.deepEqual(pages, firstCursorPage(), "the first page stays put");
  });

  test("a page with nothing after it has no Next, and going forward again forgets the old way", () => {
    const pages = nextCursorPage(firstCursorPage(), "c1");
    assert.equal(nextCursorPage(pages, null), pages, "no cursor, no next page");
    const back = previousCursorPage(nextCursorPage(pages, "c2"));
    const forward = nextCursorPage(back, "c2-fresh");
    assert.deepEqual(forward.starts, [null, "c1", "c2-fresh"], "read from the newer cursor");
  });

  test("the range reads like the old footer, and never claims fewer than it showed", () => {
    const third: CursorPages = { starts: [null, "a", "b"], index: 2 };
    assert.deepEqual(cursorPageRange(firstCursorPage(), 25, 25, 120), { start: 1, end: 25, of: 120 });
    assert.deepEqual(cursorPageRange(third, 25, 20, 70), { start: 51, end: 70, of: 70 });
    assert.deepEqual(cursorPageRange(firstCursorPage(), 25, 0, 0), { start: 0, end: 0, of: 0 });
    // Contacts on earlier pages were archived since; the total shrank.
    assert.deepEqual(cursorPageRange(third, 25, 10, 55), { start: 51, end: 60, of: 60 });
  });
});

describe("contactPageUrl", () => {
  test("asks for a page, with the cursor after the first and every filter that applies", () => {
    const first = new URL(
      contactPageUrl("co", { query: "  ada  ", stage: "lead", showArchived: true }, null),
      "http://x",
    );
    assert.equal(first.pathname, "/api/companies/co/revenue/contacts");
    assert.equal(first.searchParams.get("limit"), String(CONTACT_PAGE_SIZE));
    assert.equal(first.searchParams.get("cursor"), null);
    assert.equal(first.searchParams.get("offset"), null, "never an offset");
    assert.equal(first.searchParams.get("q"), "ada");
    assert.equal(first.searchParams.get("lifecycleStage"), "lead");
    assert.equal(first.searchParams.get("includeArchived"), "true");
    const later = new URL(
      contactPageUrl("co", { query: "", stage: "", showArchived: false }, "eyJ2+/="),
      "http://x",
    );
    assert.equal(later.searchParams.get("cursor"), "eyJ2+/=");
    for (const name of ["q", "lifecycleStage", "includeArchived"]) {
      assert.equal(later.searchParams.get(name), null, name);
    }
  });
});

// ───────────────── walking a keyset list as the Contacts page does ─────────────────

type Person = { id: string; touchedAt: number | null; archived: boolean };

/** A keyset contact list: most recently touched first, never-touched last, ties by id. */
function contactServer(people: Person[]) {
  const sorted = () =>
    people
      .filter((person) => !person.archived)
      .sort((a, b) => {
        const at = (person: Person) => person.touchedAt ?? -Infinity;
        return at(b) - at(a) || (a.id < b.id ? 1 : -1);
      });
  const keyOf = (person: Person) => `${person.touchedAt ?? -Infinity}|${person.id}`;
  const after = (person: Person, key: string) => {
    const [at, id] = key.split("|");
    const touched = person.touchedAt ?? -Infinity;
    return touched < Number(at) || (touched === Number(at) && person.id < id);
  };
  return async (url: string): Promise<ContactPageResponse<Person>> => {
    const params = new URL(url, "http://x").searchParams;
    const limit = Number(params.get("limit"));
    const cursor = params.get("cursor");
    const all = sorted();
    const rest = cursor ? all.filter((person) => after(person, cursor)) : all;
    const rows = rest.slice(0, limit);
    const hasMore = rest.length > limit;
    return {
      total: all.length,
      hasMore,
      nextCursor: hasMore ? keyOf(rows[rows.length - 1]) : null,
      rows,
    };
  };
}

describe("walking Revenue → Contacts by cursor", () => {
  test("reaches every contact once while some are archived and others touched between pages", async () => {
    const people: Person[] = Array.from({ length: 120 }, (_, i) => ({
      id: `p-${String(i).padStart(3, "0")}`,
      // Forty share one instant; thirty were never touched.
      touchedAt: i < 40 ? 1_000 : i < 90 ? 900 - i : null,
      archived: false,
    }));
    const read = contactServer(people);
    const filters = { query: "", stage: "", showArchived: false };
    let pages = firstCursorPage();
    const seen: string[] = [];
    const moved = new Set<string>();
    for (let guard = 0; guard < 20; guard++) {
      const page = await read(contactPageUrl("co", filters, openPageCursor(pages)));
      seen.push(...page.rows.map((row) => row.id));
      if (pages.index === 1) {
        // Working through the second page: archive two of it, and log a call
        // with a third — which moves it to the top, before every cursor.
        page.rows[0].archived = true;
        page.rows[1].archived = true;
        page.rows[2].touchedAt = 5_000;
        moved.add(page.rows[2].id);
      }
      if (!page.hasMore) break;
      pages = nextCursorPage(pages, page.nextCursor);
    }
    assert.equal(new Set(seen).size, seen.length, "no contact twice");
    assert.deepEqual(
      new Set(seen),
      new Set(people.map((person) => person.id)),
      "every contact once, those worked on included",
    );

    // Previous back to the second page re-reads it from where it started, as
    // it is now: the archived contacts are gone, the one touched moved to the
    // top, and the page is full again from the contacts after them.
    let second = pages;
    while (second.index > 1) second = previousCursorPage(second);
    assert.equal(second.index, 1);
    const again = await read(contactPageUrl("co", filters, openPageCursor(second)));
    assert.equal(again.rows.length, CONTACT_PAGE_SIZE);
    assert.ok(again.rows.every((row) => !row.archived && !moved.has(row.id)));
  });
});
