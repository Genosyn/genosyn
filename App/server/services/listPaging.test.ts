import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  CURSOR_VERSION,
  dateRange,
  DateRangeError,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  finishPage,
  type KeysetColumn,
  keysetCondition,
  ListCursorError,
  pageLimit,
  pageNote,
  rowsWithinBudget,
  textPreview,
} from "./listPaging.js";

/**
 * The paging contract every list tool and its REST twin share. These are the
 * pure halves; the keyset queries themselves are exercised against a real
 * database by each list's own tests (`bankingQueue.test.ts`, …).
 */

describe("pageLimit", () => {
  const limits = { defaultLimit: 50, maxLimit: 200 };

  test("uses the list's default when no limit is asked for", () => {
    assert.equal(pageLimit(undefined, limits), 50);
  });

  test("cuts a larger limit to the maximum instead of refusing it", () => {
    assert.equal(pageLimit(500, limits), 200);
    assert.equal(pageLimit(10_000, limits), 200);
  });

  test("keeps at least one row and drops fractions", () => {
    assert.equal(pageLimit(0, limits), 1);
    assert.equal(pageLimit(-4, limits), 1);
    assert.equal(pageLimit(12.9, limits), 12);
    assert.equal(pageLimit(Number.NaN, limits), 50);
  });
});

describe("cursors", () => {
  const fingerprint = filterFingerprint("company-a", { status: "review" });

  test("round-trip the sort key they were issued for", () => {
    const cursor = encodeCursor("banking.transactions", fingerprint, [
      "2023-07-01 00:00:00.000",
      1,
      "id-9",
    ]);
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor("banking.transactions", fingerprint, cursor), [
      "2023-07-01 00:00:00.000",
      1,
      "id-9",
    ]);
  });

  test("are refused, with what to do, when garbled, cut short or hand-made", () => {
    const cursor = encodeCursor("banking.transactions", fingerprint, ["x", 0, "id"]);
    for (const bad of [
      "not a cursor!",
      cursor.slice(0, cursor.length - 6),
      Buffer.from("{}").toString("base64url"),
      Buffer.from(
        JSON.stringify({ v: CURSOR_VERSION, s: "banking.transactions", f: fingerprint, k: [] }),
      ).toString("base64url"),
      "a".repeat(5_000),
    ]) {
      assert.throws(
        () => decodeCursor("banking.transactions", fingerprint, bad),
        (err: unknown) =>
          err instanceof ListCursorError && err.message === CURSOR_INVALID && err.status === 400,
        bad.slice(0, 40),
      );
    }
  });

  test("from an older format are refused rather than misread", () => {
    const old = Buffer.from(
      JSON.stringify({
        v: CURSOR_VERSION - 1,
        s: "banking.transactions",
        f: fingerprint,
        k: ["x"],
      }),
    ).toString("base64url");
    assert.throws(() => decodeCursor("banking.transactions", fingerprint, old), {
      message: CURSOR_INVALID,
    });
  });

  test("only continue the list that issued them", () => {
    const cursor = encodeCursor("finance.transactions", fingerprint, ["x", "id"]);
    assert.throws(() => decodeCursor("banking.transactions", fingerprint, cursor), {
      message: CURSOR_OTHER_LIST,
    });
  });

  test("only continue the filters, and the company, that issued them", () => {
    const cursor = encodeCursor("banking.transactions", fingerprint, ["x", "id"]);
    assert.throws(
      () =>
        decodeCursor(
          "banking.transactions",
          filterFingerprint("company-a", { status: "done" }),
          cursor,
        ),
      { message: CURSOR_OTHER_FILTERS },
    );
    assert.throws(
      () =>
        decodeCursor(
          "banking.transactions",
          filterFingerprint("company-b", { status: "review" }),
          cursor,
        ),
      { message: CURSOR_OTHER_FILTERS },
    );
  });

  test("fingerprints ignore key order and unset filters, and see every set one", () => {
    assert.equal(
      filterFingerprint("c", { a: 1, b: "x", c: undefined }),
      filterFingerprint("c", { b: "x", a: 1 }),
    );
    assert.notEqual(filterFingerprint("c", { a: 1 }), filterFingerprint("c", { a: 2 }));
    assert.equal(
      filterFingerprint("c", { at: new Date("2023-01-01T00:00:00Z") }),
      filterFingerprint("c", { at: new Date("2023-01-01T00:00:00.000Z") }),
    );
  });
});

describe("keysetCondition", () => {
  const keys: KeysetColumn[] = [
    { column: "t.date", direction: "DESC", type: "timestamp" },
    { column: "t.id", direction: "DESC", type: "string" },
  ];

  test("reads 'after this row' in a descending order", () => {
    assert.deepEqual(keysetCondition(keys, ["2023-07-01", "id-5"], "k"), {
      sql: "(t.date, t.id) < (:k0, :k1)",
      params: { k0: "2023-07-01", k1: "id-5" },
    });
  });

  test("reads 'after this row' in an ascending order", () => {
    const ascending: KeysetColumn[] = [
      { column: "b.dueDate", direction: "ASC", type: "timestamp" },
      { column: "b.id", direction: "ASC", type: "string" },
    ];
    assert.equal(
      keysetCondition(ascending, ["2023-07-01", "id-5"], "k")?.sql,
      "(b.dueDate, b.id) > (:k0, :k1)",
    );
  });

  test("decides a constant per-table rank before it reaches SQL", () => {
    const bank: KeysetColumn[] = [
      { column: "t.date", direction: "DESC", type: "timestamp" },
      { literal: 0, direction: "ASC" },
      { column: "t.id", direction: "DESC", type: "string" },
    ];
    const card: KeysetColumn[] = [
      { column: "t.postedAt", direction: "DESC", type: "timestamp" },
      { literal: 1, direction: "ASC" },
      { column: "t.id", direction: "DESC", type: "string" },
    ];
    // After a bank line: later bank lines that day, and every card purchase that day.
    assert.equal(
      keysetCondition(bank, ["d", 0, "id"], "k")?.sql,
      "(t.date, t.id) < (:k0, :k2)",
    );
    assert.equal(keysetCondition(card, ["d", 0, "id"], "k")?.sql, "t.postedAt <= :k0");
    // After a card purchase: no more bank lines that day.
    assert.equal(keysetCondition(bank, ["d", 1, "id"], "k")?.sql, "t.date < :k0");
    assert.equal(
      keysetCondition(card, ["d", 1, "id"], "k")?.sql,
      "(t.postedAt, t.id) < (:k0, :k2)",
    );
  });

  test("compares every column left as one row value, so an index starts at the cursor", () => {
    const three: KeysetColumn[] = [
      { column: "t.sortOrder", direction: "ASC", type: "number" },
      { column: "t.createdAt", direction: "ASC", type: "timestamp" },
      { column: "t.id", direction: "ASC", type: "string" },
    ];
    assert.deepEqual(keysetCondition(three, [2, "2026-01-01", "id-9"], "k"), {
      sql: "(t.sortOrder, t.createdAt, t.id) > (:k0, :k1, :k2)",
      params: { k0: 2, k1: "2026-01-01", k2: "id-9" },
    });
    // A constant column that differs from the cursor's lets rows equal on the
    // columns before it through.
    const ranked: KeysetColumn[] = [
      { column: "t.a", direction: "DESC", type: "timestamp" },
      { column: "t.b", direction: "DESC", type: "string" },
      { literal: 1, direction: "ASC" },
      { column: "t.id", direction: "DESC", type: "string" },
    ];
    assert.equal(keysetCondition(ranked, ["x", "y", 0, "z"], "k")?.sql, "(t.a, t.b) <= (:k0, :k1)");
    assert.equal(keysetCondition(ranked, ["x", "y", 2, "z"], "k")?.sql, "(t.a, t.b) < (:k0, :k1)");
    assert.equal(
      keysetCondition(ranked, ["x", "y", 1, "z"], "k")?.sql,
      "(t.a, t.b, t.id) < (:k0, :k1, :k3)",
    );
    // A leading constant decides everything: all rows, or none.
    const leading: KeysetColumn[] = [{ literal: 1, direction: "ASC" }, keys[1]];
    assert.equal(keysetCondition(leading, [0, "id"], "k"), null);
    assert.equal(keysetCondition(leading, [2, "id"], "k")?.sql, "1 = 0");
  });

  test("keeps the OR form when the columns sort different ways", () => {
    const mixed: KeysetColumn[] = [
      { column: "rank", direction: "ASC", type: "number" },
      { column: "t.createdAt", direction: "DESC", type: "timestamp" },
      { column: "t.id", direction: "DESC", type: "string" },
    ];
    assert.equal(
      keysetCondition(mixed, [1, "2026-01-01", "id-3"], "k")?.sql,
      "(rank > :k0 OR (rank = :k0 AND (t.createdAt < :k1 OR (t.createdAt = :k1 AND t.id < :k2))))",
    );
  });

  test("refuses a key of the wrong shape as an invalid cursor", () => {
    assert.throws(() => keysetCondition(keys, ["only one"], "k"), ListCursorError);
    assert.throws(() => keysetCondition(keys, [3, "id"], "k"), ListCursorError);
    assert.throws(
      () => keysetCondition([{ literal: 0, direction: "ASC" }, keys[1]], ["x", "id"], "k"),
      ListCursorError,
    );
  });
});

describe("pages", () => {
  const fetched = Array.from({ length: 6 }, (_, index) => ({
    row: { id: `r${index}`, text: "x".repeat(100) },
    key: [`k${index}`, `r${index}`],
  }));
  const base = {
    total: 40,
    noun: "transactions",
    scope: "test.list",
    fingerprint: "fp",
    present: (row: { id: string }) => row,
  };

  test("keep limit rows, and continue after the last one kept", () => {
    const page = finishPage({ ...base, fetched, limit: 5 });
    assert.equal(page.rows.length, 5);
    assert.equal(page.hasMore, true);
    assert.deepEqual(decodeCursor("test.list", "fp", page.nextCursor!), ["k4", "r4"]);
    assert.match(page.note!, /holds 5 of the 40 matching transactions/);
    assert.deepEqual(Object.keys(page).slice(0, 4), ["total", "hasMore", "nextCursor", "note"]);
  });

  test("end on the last page with no cursor and no note", () => {
    const page = finishPage({ ...base, fetched: fetched.slice(0, 3), limit: 5 });
    assert.equal(page.rows.length, 3);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.equal("note" in page, false);
  });

  test("end early when the rows would overflow a tool result, losing none", () => {
    const page = finishPage({ ...base, fetched, limit: 5, budgetChars: 400 });
    assert.ok(page.rows.length >= 1 && page.rows.length < 5, `${page.rows.length} rows`);
    assert.equal(page.hasMore, true);
    const last = page.rows[page.rows.length - 1] as { id: string };
    assert.deepEqual(decodeCursor("test.list", "fp", page.nextCursor!), [
      `k${last.id.slice(1)}`,
      last.id,
    ]);
  });

  test("always keep one row, however long", () => {
    assert.equal(rowsWithinBudget([{ text: "x".repeat(10_000) }, { a: 1 }], 100), 1);
    assert.equal(rowsWithinBudget([], 100), 0);
  });

  test("count numbers the way a person reads them", () => {
    assert.match(
      pageNote({ shown: 50, total: 1_069, noun: "transactions", hasMore: true })!,
      /50 of the 1,069 matching transactions/,
    );
    assert.equal(
      pageNote({ shown: 50, total: 50, noun: "transactions", hasMore: false }),
      undefined,
    );
  });
});

describe("dateRange", () => {
  test("reads a bare date as a whole UTC day, both ends inclusive", () => {
    const range = dateRange("2023-07-01", "2023-07-31");
    assert.equal(range.gte?.toISOString(), "2023-07-01T00:00:00.000Z");
    assert.equal(range.lt?.toISOString(), "2023-08-01T00:00:00.000Z");
    assert.equal(range.lte, undefined);
  });

  test("reads a timestamp as that instant, honouring its offset", () => {
    const range = dateRange("2023-07-01T09:30:00+02:00", "2023-07-01T18:00:00-07:00");
    assert.equal(range.gte?.toISOString(), "2023-07-01T07:30:00.000Z");
    assert.equal(range.lte?.toISOString(), "2023-07-02T01:00:00.000Z");
    assert.equal(range.lt, undefined);
  });

  test("allows a single day, and either end alone", () => {
    assert.doesNotThrow(() => dateRange("2023-07-01", "2023-07-01"));
    assert.deepEqual(Object.keys(dateRange("2023-07-01", undefined)), ["gte"]);
    assert.deepEqual(Object.keys(dateRange(undefined, "2023-07-01")), ["lt"]);
    assert.deepEqual(dateRange(undefined, undefined), {});
  });

  test("refuses what is not a date, an impossible day, and a range ending before it starts", () => {
    for (const [from, to] of [
      ["July", undefined],
      ["2023-02-30", undefined],
      [undefined, "2023-13-01"],
      ["2023-08-01", "2023-07-31"],
      ["2023-08-01T00:00:01Z", "2023-08-01T00:00:00Z"],
    ]) {
      assert.throws(() => dateRange(from, to), DateRangeError, `${from} → ${to}`);
    }
  });
});

describe("textPreview", () => {
  test("keeps a short text whole and says a long one was cut", () => {
    assert.deepEqual(textPreview("Rent for May", 300), { preview: "Rent for May", truncated: false });
    assert.deepEqual(textPreview("abcdef", 6), { preview: "abcdef", truncated: false });
    assert.deepEqual(textPreview("abcdefg", 6), { preview: "abcdef", truncated: true });
    assert.deepEqual(textPreview("", 6), { preview: "", truncated: false });
  });
});
