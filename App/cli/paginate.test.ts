import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OperationIndex } from "./operations.js";
import { collectPages, pageListKey, pageStyle } from "./paginate.js";
import { syntheticSpec } from "./test/support.js";

const index = new OperationIndex(syntheticSpec());

function pager(pages: Record<string, unknown>) {
  const asked: Array<Record<string, string>> = [];
  return {
    asked,
    fetchPage: async (query: Record<string, string>) => {
      asked.push(query);
      const key = query.cursor ?? query.offset;
      if (!(key in pages)) throw new Error(`unexpected page ${key}`);
      return pages[key];
    },
  };
}

describe("which lists page", () => {
  test("cursor and offset paging are read off the query parameters", () => {
    assert.deepEqual(pageStyle(index.find("listRevenueFollowUps")!), { kind: "cursor" });
    assert.deepEqual(pageStyle(index.find("listRevenueDeals")!), { kind: "offset" });
    assert.equal(pageStyle(index.find("listGoals")!), null);
  });

  test("the rows are the only list, or a familiar name among several", () => {
    assert.equal(pageListKey({ rows: [], total: 0 }), "rows");
    assert.equal(pageListKey({ items: [], tags: [] }), "items");
    assert.equal(pageListKey({ a: [], b: [] }), null);
    assert.equal(pageListKey([1, 2]), null);
    assert.equal(pageListKey(null), null);
  });
});

describe("keyset paging", () => {
  test("follows nextCursor and concatenates the rows", async () => {
    const { asked, fetchPage } = pager({
      c1: { items: [{ id: 3 }, { id: 4 }], nextCursor: "c2" },
      c2: { items: [{ id: 5 }], nextCursor: null },
    });
    const result = await collectPages({
      style: { kind: "cursor" },
      first: { items: [{ id: 1 }, { id: 2 }], nextCursor: "c1" },
      query: {},
      fetchPage,
      maxPages: 100,
    });
    assert.deepEqual(result.value, {
      items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      nextCursor: null,
    });
    assert.equal(result.pages, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(asked, [{ cursor: "c1" }, { cursor: "c2" }]);
  });

  test("stops at a cursor it has already followed", async () => {
    const { asked, fetchPage } = pager({ c1: { items: [{ id: 2 }], nextCursor: "c1" } });
    const result = await collectPages({
      style: { kind: "cursor" },
      first: { items: [{ id: 1 }], nextCursor: "c1" },
      query: {},
      fetchPage,
      maxPages: 100,
    });
    assert.equal(asked.length, 1);
    assert.equal((result.value as { items: unknown[] }).items.length, 2);
  });

  test("stops at --max-pages and keeps the cursor to resume from", async () => {
    const { fetchPage } = pager({
      c1: { items: [{ id: 2 }], nextCursor: "c2" },
      c2: { items: [{ id: 3 }], nextCursor: "c3" },
    });
    const result = await collectPages({
      style: { kind: "cursor" },
      first: { items: [{ id: 1 }], nextCursor: "c1" },
      query: {},
      fetchPage,
      maxPages: 2,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.pages, 2);
    assert.deepEqual(result.value, { items: [{ id: 1 }, { id: 2 }], nextCursor: "c2" });
  });
});

describe("offset paging", () => {
  test("pages by offset until the total is reached", async () => {
    const { asked, fetchPage } = pager({
      "2": { rows: [{ id: 3 }, { id: 4 }], total: 5 },
      "4": { rows: [{ id: 5 }], total: 5 },
    });
    const result = await collectPages({
      style: { kind: "offset" },
      first: { rows: [{ id: 1 }, { id: 2 }], total: 5 },
      query: { limit: "2" },
      fetchPage,
      maxPages: 100,
    });
    assert.deepEqual(asked, [{ offset: "2" }, { offset: "4" }]);
    assert.deepEqual((result.value as { rows: unknown[] }).rows.map((row) => (row as { id: number }).id), [1, 2, 3, 4, 5]);
    assert.equal((result.value as { total: number }).total, 5);
  });

  test("starts from the offset already asked for", async () => {
    const { asked, fetchPage } = pager({ "12": { rows: [{ id: 3 }], total: 13 } });
    await collectPages({
      style: { kind: "offset" },
      first: { rows: [{ id: 1 }, { id: 2 }], total: 13 },
      query: { offset: "10", limit: "2" },
      fetchPage,
      maxPages: 100,
    });
    assert.deepEqual(asked, [{ offset: "12" }]);
  });

  test("follows hasMore and nextOffset, and clears them in the result", async () => {
    const { asked, fetchPage } = pager({
      "7": { resources: [{ id: 2 }], hasMore: true, nextOffset: 9 },
      "9": { resources: [{ id: 3 }], hasMore: false, nextOffset: null },
    });
    const result = await collectPages({
      style: { kind: "offset" },
      first: { resources: [{ id: 1 }], hasMore: true, nextOffset: 7 },
      query: {},
      fetchPage,
      maxPages: 100,
    });
    assert.deepEqual(asked, [{ offset: "7" }, { offset: "9" }]);
    assert.deepEqual(result.value, {
      resources: [{ id: 1 }, { id: 2 }, { id: 3 }],
      hasMore: false,
      nextOffset: null,
    });
  });

  test("without totals, keeps going while pages come back full", async () => {
    const { asked, fetchPage } = pager({ "2": { rows: [{ id: 3 }] } });
    const result = await collectPages({
      style: { kind: "offset" },
      first: { rows: [{ id: 1 }, { id: 2 }] },
      query: { limit: "2" },
      fetchPage,
      maxPages: 100,
    });
    assert.deepEqual(asked, [{ offset: "2" }]);
    assert.equal((result.value as { rows: unknown[] }).rows.length, 3);
  });

  test("stops at an empty page", async () => {
    const { asked, fetchPage } = pager({ "1": { rows: [] } });
    const result = await collectPages({
      style: { kind: "offset" },
      first: { rows: [{ id: 1 }] },
      query: {},
      fetchPage,
      maxPages: 100,
    });
    assert.deepEqual(asked, [{ offset: "1" }]);
    assert.equal((result.value as { rows: unknown[] }).rows.length, 1);
  });

  test("stops at --max-pages", async () => {
    const { fetchPage } = pager({ "1": { rows: [{ id: 2 }], total: 10 }, "2": { rows: [{ id: 3 }], total: 10 } });
    const result = await collectPages({
      style: { kind: "offset" },
      first: { rows: [{ id: 1 }], total: 10 },
      query: {},
      fetchPage,
      maxPages: 2,
    });
    assert.equal(result.truncated, true);
    assert.equal((result.value as { rows: unknown[] }).rows.length, 2);
  });
});

describe("lists that don't page", () => {
  test("answer once, as they came", async () => {
    const first = [{ id: 1 }];
    const result = await collectPages({
      style: null,
      first,
      query: {},
      fetchPage: async () => {
        throw new Error("never");
      },
      maxPages: 100,
    });
    assert.equal(result.value, first);
    assert.equal(result.pages, 1);
    const bare = await collectPages({
      style: { kind: "cursor" },
      first: [{ id: 1 }],
      query: {},
      fetchPage: async () => ({}),
      maxPages: 100,
    });
    assert.equal(bare.pages, 1);
  });
});
