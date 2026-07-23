import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canonicalizeRow,
  dedupeKeyFor,
  selectNewEvents,
  truncatePayload,
} from "./signalDedupe.js";

/** Deterministic LCG — a failing property test must be reproducible. */
function lcg(seed: number): () => number {
  let state = seed & 0x7fffffff;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const isHashKey = (key: string) => /^row:[0-9a-f]{32}$/.test(key);

// ───────────────────────── canonicalizeRow ─────────────────────────

describe("canonicalizeRow", () => {
  test("sorts keys, so driver column order cannot change the encoding", () => {
    assert.equal(canonicalizeRow({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalizeRow({ a: 2, b: 1 }), canonicalizeRow({ b: 1, a: 2 }));
  });

  test("sorts nested object keys too", () => {
    const one = canonicalizeRow({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const two = canonicalizeRow({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    assert.equal(one, two);
    assert.equal(one, '{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  test("preserves array order — order is meaning inside an array", () => {
    assert.equal(canonicalizeRow({ a: [3, 1, 2] }), '{"a":[3,1,2]}');
    assert.notEqual(canonicalizeRow({ a: [1, 2] }), canonicalizeRow({ a: [2, 1] }));
  });

  test("encodes Dates as ISO strings", () => {
    assert.equal(
      canonicalizeRow({ at: new Date("2026-07-23T12:00:00.000Z") }),
      '{"at":"2026-07-23T12:00:00.000Z"}',
    );
  });

  test("an invalid Date encodes rather than throwing", () => {
    assert.equal(canonicalizeRow({ at: new Date("nonsense") }), '{"at":"Invalid Date"}');
  });

  test("omits undefined values from objects but keeps array positions", () => {
    assert.equal(canonicalizeRow({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalizeRow({ a: [1, undefined, 3] }), '{"a":[1,null,3]}');
  });

  test("omits functions and symbols from objects", () => {
    const row = { a: 1, fn: () => 0, sym: Symbol("s") };
    assert.equal(canonicalizeRow(row), '{"a":1}');
  });

  test("keeps null, which is a real column value", () => {
    assert.equal(canonicalizeRow({ a: null }), '{"a":null}');
    assert.notEqual(canonicalizeRow({ a: null }), canonicalizeRow({}));
  });

  test("non-finite numbers become null, matching JSON.stringify", () => {
    assert.equal(
      canonicalizeRow({ a: Number.NaN, b: Infinity, c: -Infinity }),
      '{"a":null,"b":null,"c":null}',
    );
  });

  test("BigInt encodes as its decimal string instead of throwing", () => {
    assert.equal(canonicalizeRow({ id: 9_007_199_254_740_993n }), '{"id":"9007199254740993"}');
  });

  test("booleans and strings encode as JSON", () => {
    assert.equal(canonicalizeRow({ t: true, f: false, s: 'he said "hi"' }), '{"f":false,"s":"he said \\"hi\\"","t":true}');
  });

  test("a circular reference encodes as a marker instead of throwing", () => {
    const row: Record<string, unknown> = { a: 1 };
    row.self = row;
    assert.equal(canonicalizeRow(row), '{"a":1,"self":"[Circular]"}');
  });

  test("a cycle through an array is also caught", () => {
    const inner: unknown[] = [1];
    inner.push(inner);
    assert.equal(canonicalizeRow({ a: inner }), '{"a":[1,"[Circular]"]}');
  });

  test("a value shared by two siblings is not mistaken for a cycle", () => {
    const shared = { x: 1 };
    assert.equal(canonicalizeRow({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });

  test("an empty row encodes as an empty object", () => {
    assert.equal(canonicalizeRow({}), "{}");
  });

  test("deeply nested mixed structures encode stably", () => {
    const row = { z: [{ b: 1, a: [{ d: 4, c: 3 }] }], y: { n: null } };
    assert.equal(canonicalizeRow(row), '{"y":{"n":null},"z":[{"a":[{"c":3,"d":4}],"b":1}]}');
  });
});

// ───────────────────────── dedupeKeyFor ─────────────────────────

describe("dedupeKeyFor", () => {
  test("uses the named column verbatim when it has a value", () => {
    assert.equal(dedupeKeyFor({ id: "cus_123", name: "Ada" }, "id"), "cus_123");
  });

  test("trims surrounding whitespace, which a CSV import always brings", () => {
    assert.equal(dedupeKeyFor({ id: "  cus_123\n" }, "id"), "cus_123");
    assert.equal(dedupeKeyFor({ id: "cus_123" }, "id"), dedupeKeyFor({ id: " cus_123 " }, "id"));
  });

  test("numeric and string values coerce to the same key", () => {
    assert.equal(dedupeKeyFor({ id: 42 }, "id"), "42");
    assert.equal(dedupeKeyFor({ id: 42 }, "id"), dedupeKeyFor({ id: "42" }, "id"));
  });

  test("false and zero are values, not absences", () => {
    assert.equal(dedupeKeyFor({ flag: false }, "flag"), "false");
    assert.equal(dedupeKeyFor({ n: 0 }, "n"), "0");
    assert.equal(dedupeKeyFor({ id: 0n }, "id"), "0");
  });

  test("truncates a very long value to 200 characters", () => {
    const key = dedupeKeyFor({ id: "x".repeat(5_000) }, "id");
    assert.equal(key.length, 200);
    assert.equal(key, "x".repeat(200));
  });

  test("truncation happens after trimming, so padding cannot eat the key", () => {
    const key = dedupeKeyFor({ id: `${" ".repeat(300)}abc` }, "id");
    assert.equal(key, "abc");
  });

  test("falls back to a row hash when the column is missing", () => {
    const key = dedupeKeyFor({ name: "Ada" }, "id");
    assert.ok(isHashKey(key), key);
  });

  test("falls back for null and undefined column values", () => {
    assert.ok(isHashKey(dedupeKeyFor({ id: null }, "id")));
    assert.ok(isHashKey(dedupeKeyFor({ id: undefined }, "id")));
  });

  test("falls back for a whitespace-only value", () => {
    for (const blank of ["", " ", "\t\n  ", " "]) {
      assert.ok(isHashKey(dedupeKeyFor({ id: blank }, "id")), JSON.stringify(blank));
    }
  });

  test("falls back for an empty or whitespace column name", () => {
    assert.ok(isHashKey(dedupeKeyFor({ id: "cus_1" }, "")));
    assert.ok(isHashKey(dedupeKeyFor({ id: "cus_1" }, "   ")));
  });

  test("falls back rather than throwing when the value cannot be stringified", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.x = 1;
    assert.ok(isHashKey(dedupeKeyFor({ id: hostile }, "id")));

    const thrower = {
      toString() {
        throw new Error("boom");
      },
    };
    assert.ok(isHashKey(dedupeKeyFor({ id: thrower }, "id")));
  });

  test("the row hash is stable across differing key ORDER in the same row", () => {
    const a = { id: null, email: "ada@example.com", plan: "pro", seats: 3 };
    const b = { seats: 3, plan: "pro", email: "ada@example.com", id: null };
    assert.equal(dedupeKeyFor(a, "id"), dedupeKeyFor(b, "id"));
  });

  test("the row hash changes when any value changes — fire once per distinct row", () => {
    const a = dedupeKeyFor({ email: "ada@example.com", seats: 3 }, "id");
    const b = dedupeKeyFor({ email: "ada@example.com", seats: 4 }, "id");
    assert.notEqual(a, b);
  });

  test("the row hash handles nested objects, arrays and Dates", () => {
    const at = new Date("2026-07-23T00:00:00.000Z");
    const one = dedupeKeyFor({ meta: { b: [1, { d: 2, c: 3 }], a: at } }, "missing");
    const two = dedupeKeyFor({ meta: { a: at, b: [1, { c: 3, d: 2 }] } }, "missing");
    assert.equal(one, two);
    assert.ok(isHashKey(one));
  });

  test("the row hash never throws on a circular row", () => {
    const row: Record<string, unknown> = { name: "Ada" };
    row.self = row;
    assert.ok(isHashKey(dedupeKeyFor(row, "id")));
  });

  test("an empty row still produces a non-empty key", () => {
    assert.ok(isHashKey(dedupeKeyFor({}, "id")));
  });

  test("survives a null row rather than taking down the tick", () => {
    assert.ok(isHashKey(dedupeKeyFor(null as unknown as Record<string, unknown>, "id")));
  });

  test("survives a non-string column name", () => {
    assert.ok(isHashKey(dedupeKeyFor({ id: "cus_1" }, null as unknown as string)));
  });

  test("never returns an empty string, over every shape we can think of", () => {
    const rows: Array<Record<string, unknown>> = [
      {},
      { id: "" },
      { id: "   " },
      { id: null },
      { id: undefined },
      { id: 0 },
      { id: false },
      { id: [] },
      { id: {} },
      { id: "x".repeat(1_000) },
    ];
    for (const row of rows) {
      for (const column of ["id", "", "missing"]) {
        const key = dedupeKeyFor(row, column);
        assert.ok(key.length > 0, `empty key for ${JSON.stringify(row)} / ${column}`);
      }
    }
  });

  test("a hashed key is visibly distinguishable from a customer id", () => {
    assert.ok(dedupeKeyFor({}, "id").startsWith("row:"));
    assert.ok(!dedupeKeyFor({ id: "cus_1" }, "id").startsWith("row:"));
  });
});

// ───────────────────────── selectNewEvents ─────────────────────────

describe("selectNewEvents", () => {
  test("passes through rows nobody has seen, in input order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const r = selectNewEvents(rows, "id", new Set());
    assert.deepEqual(r.fresh.map((f) => f.key), ["a", "b", "c"]);
    assert.equal(r.fresh[0].row, rows[0]);
    assert.equal(r.duplicateInBatch, 0);
    assert.equal(r.alreadySeen, 0);
  });

  test("skips keys stored on an earlier tick", () => {
    const r = selectNewEvents([{ id: "a" }, { id: "b" }], "id", new Set(["a"]));
    assert.deepEqual(r.fresh.map((f) => f.key), ["b"]);
    assert.equal(r.alreadySeen, 1);
    assert.equal(r.duplicateInBatch, 0);
  });

  test("collapses in-batch duplicates to the FIRST occurrence", () => {
    const rows = [
      { id: "a", seq: 1 },
      { id: "a", seq: 2 },
      { id: "a", seq: 3 },
    ];
    const r = selectNewEvents(rows, "id", new Set());
    assert.equal(r.fresh.length, 1);
    assert.equal(r.fresh[0].row.seq, 1);
    assert.equal(r.duplicateInBatch, 2);
  });

  test("existingKeys wins over in-batch dedupe, so both copies count as alreadySeen", () => {
    const r = selectNewEvents([{ id: "a" }, { id: "a" }], "id", new Set(["a"]));
    assert.equal(r.fresh.length, 0);
    assert.equal(r.alreadySeen, 2);
    assert.equal(r.duplicateInBatch, 0);
  });

  test("an empty batch is all zeros, never undefined", () => {
    const r = selectNewEvents([], "id", new Set());
    assert.deepEqual(r.fresh, []);
    assert.equal(r.duplicateInBatch, 0);
    assert.equal(r.alreadySeen, 0);
  });

  test("everything already seen yields nothing fresh", () => {
    const r = selectNewEvents([{ id: "a" }, { id: "b" }], "id", new Set(["a", "b"]));
    assert.deepEqual(r.fresh, []);
    assert.equal(r.alreadySeen, 2);
  });

  test("rows differing only in key ORDER dedupe against each other", () => {
    const rows = [
      { email: "ada@example.com", plan: "pro" },
      { plan: "pro", email: "ada@example.com" },
    ];
    const r = selectNewEvents(rows, "missing-column", new Set());
    assert.equal(r.fresh.length, 1);
    assert.equal(r.duplicateInBatch, 1);
  });

  test("numeric and string ids collapse together", () => {
    const r = selectNewEvents([{ id: 7 }, { id: "7" }, { id: " 7 " }], "id", new Set());
    assert.equal(r.fresh.length, 1);
    assert.equal(r.duplicateInBatch, 2);
  });

  test("unkeyed rows do not all collapse into one event", () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const r = selectNewEvents(rows, "id", new Set());
    assert.equal(r.fresh.length, 3);
    assert.equal(r.duplicateInBatch, 0);
  });

  test("the returned row is the original object, not a copy", () => {
    const row = { id: "a", nested: { x: 1 } };
    const r = selectNewEvents([row], "id", new Set());
    assert.equal(r.fresh[0].row, row);
  });

  test("survives a null rows array", () => {
    const r = selectNewEvents(null as unknown as Array<Record<string, unknown>>, "id", new Set());
    assert.deepEqual(r.fresh, []);
  });

  test("INVARIANT: fresh + duplicateInBatch + alreadySeen === rows.length", () => {
    const rows = [
      { id: "a" },
      { id: "a" },
      { id: "b" },
      { id: null },
      { id: "  " },
      { id: "c" },
      { id: "c" },
    ];
    const r = selectNewEvents(rows, "id", new Set(["b"]));
    assert.equal(r.fresh.length + r.duplicateInBatch + r.alreadySeen, rows.length);
  });

  test("INVARIANT: fresh never contains two entries with the same key (500 seeded batches)", () => {
    const rand = lcg(0x5117a1);
    const pickValue = (): unknown => {
      const r = rand();
      if (r < 0.15) return null;
      if (r < 0.25) return undefined;
      if (r < 0.35) return "   ";
      if (r < 0.5) return Math.floor(rand() * 5); // number, collides with string form
      if (r < 0.7) return String(Math.floor(rand() * 5));
      if (r < 0.8) return ` ${Math.floor(rand() * 5)} `;
      if (r < 0.9) return { nested: Math.floor(rand() * 3) };
      return "x".repeat(150 + Math.floor(rand() * 200)); // straddles the 200-char cap
    };

    for (let round = 0; round < 500; round += 1) {
      const rows: Array<Record<string, unknown>> = [];
      const size = Math.floor(rand() * 12);
      for (let i = 0; i < size; i += 1) {
        // Shuffle key insertion order so the hash fallback is exercised on
        // logically-identical rows written two different ways.
        const payload = { tag: Math.floor(rand() * 4), id: pickValue() };
        const flipped = { id: payload.id, tag: payload.tag };
        rows.push(rand() < 0.5 ? payload : flipped);
      }
      const existing = new Set(rand() < 0.3 ? ["0", "1", "row:nope"] : []);
      const result = selectNewEvents(rows, "id", existing);

      const keys = new Set(result.fresh.map((f) => f.key));
      assert.equal(keys.size, result.fresh.length, `round ${round}: duplicate key in fresh`);
      assert.equal(
        result.fresh.length + result.duplicateInBatch + result.alreadySeen,
        rows.length,
        `round ${round}: counts do not add up`,
      );
      for (const entry of result.fresh) {
        assert.ok(entry.key.length > 0, `round ${round}: empty key`);
        assert.ok(entry.key.length <= 200, `round ${round}: key over 200 chars`);
        assert.ok(!existing.has(entry.key), `round ${round}: returned an already-seen key`);
      }
    }
  });
});

// ───────────────────────── truncatePayload ─────────────────────────

describe("truncatePayload", () => {
  test("returns plain JSON when the row fits", () => {
    assert.equal(truncatePayload({ a: 1, b: "x" }), '{"a":1,"b":"x"}');
  });

  test("an empty row is valid JSON", () => {
    assert.equal(truncatePayload({}), "{}");
  });

  test("wraps an oversized row in a truncation envelope", () => {
    const row = { blob: "x".repeat(10_000) };
    const out = truncatePayload(row);
    const parsed = JSON.parse(out) as { _truncated: boolean; _bytes: number; preview: string };
    assert.equal(parsed._truncated, true);
    assert.equal(parsed._bytes, Buffer.byteLength(JSON.stringify(row), "utf8"));
    assert.ok(parsed.preview.length > 0);
    assert.ok(JSON.stringify(row).startsWith(parsed.preview));
  });

  test("the envelope itself fits inside the cap", () => {
    for (const cap of [80, 100, 512, 4_000]) {
      const out = truncatePayload({ blob: "x".repeat(50_000) }, cap);
      assert.ok(out.length <= cap, `cap ${cap} produced ${out.length} chars`);
      assert.doesNotThrow(() => JSON.parse(out));
    }
  });

  test("a row exactly at the cap is not truncated", () => {
    const exact = { a: "y".repeat(10) };
    const size = JSON.stringify(exact).length;
    assert.equal(truncatePayload(exact, size), JSON.stringify(exact));
    assert.notEqual(truncatePayload(exact, size - 1), JSON.stringify(exact));
  });

  test("an absurdly small cap still returns parseable JSON", () => {
    const out = truncatePayload({ blob: "x".repeat(1_000) }, 1);
    const parsed = JSON.parse(out) as { _truncated: boolean; preview: string };
    assert.equal(parsed._truncated, true);
    assert.equal(parsed.preview, "");
  });

  test("escaping does not push the envelope over the cap", () => {
    // Quotes and backslashes double in length once encoded.
    const out = truncatePayload({ blob: '"\\'.repeat(2_000) }, 200);
    assert.ok(out.length <= 200, `got ${out.length}`);
    assert.doesNotThrow(() => JSON.parse(out));
  });

  test("_bytes counts UTF-8 bytes, not characters", () => {
    const row = { blob: "é".repeat(5_000) };
    const parsed = JSON.parse(truncatePayload(row)) as { _bytes: number };
    const json = JSON.stringify(row);
    assert.equal(parsed._bytes, Buffer.byteLength(json, "utf8"));
    assert.ok(parsed._bytes > json.length);
  });

  test("never throws on a circular row — returns a safe marker", () => {
    const row: Record<string, unknown> = { a: 1 };
    row.self = row;
    const out = truncatePayload(row);
    const parsed = JSON.parse(out) as { _truncated: boolean; preview: string };
    assert.equal(parsed._truncated, true);
    assert.equal(parsed.preview, "[unserializable]");
  });

  test("never throws on BigInt or a throwing toJSON", () => {
    assert.doesNotThrow(() => truncatePayload({ id: 1n }));
    assert.doesNotThrow(() =>
      truncatePayload({
        bad: {
          toJSON() {
            throw new Error("boom");
          },
        },
      }),
    );
    assert.equal(JSON.parse(truncatePayload({ id: 1n }))._truncated, true);
  });

  test("a row whose toJSON returns undefined is not stored as the string undefined", () => {
    // JSON.stringify returns undefined here, which is not storable JSON.
    const row = { toJSON: () => undefined } as unknown as Record<string, unknown>;
    const out = truncatePayload(row);
    assert.notEqual(out, "undefined");
    const parsed = JSON.parse(out) as { _truncated: boolean; preview: string };
    assert.equal(parsed._truncated, true);
    assert.equal(parsed.preview, "[unserializable]");
  });

  test("multi-byte content near the boundary stays parseable", () => {
    // A slice can land mid-surrogate-pair; the output must still be JSON.
    const row = { blob: "😀".repeat(4_000) };
    for (const cap of [70, 71, 72, 73, 120, 501]) {
      const out = truncatePayload(row, cap);
      assert.doesNotThrow(() => JSON.parse(out), `cap ${cap}`);
      assert.ok(out.length <= cap, `cap ${cap} produced ${out.length}`);
    }
  });

  test("INVARIANT: output is always parseable JSON over 300 seeded rows", () => {
    const rand = lcg(0x9e3779b);
    const alphabet = ['"', "\\", "\n", "é", "😀", "a", " ", " "];
    for (let round = 0; round < 300; round += 1) {
      const length = Math.floor(rand() * 400);
      let blob = "";
      for (let i = 0; i < length; i += 1) {
        blob += alphabet[Math.floor(rand() * alphabet.length)];
      }
      const cap = 60 + Math.floor(rand() * 400);
      const out = truncatePayload({ blob, n: Math.floor(rand() * 1_000) }, cap);
      assert.doesNotThrow(() => JSON.parse(out), `round ${round}`);
      // Only the minimal-envelope escape hatch is allowed to exceed the cap.
      assert.ok(
        out.length <= cap || (JSON.parse(out) as { preview: string }).preview === "",
        `round ${round}: ${out.length} chars overflowed a cap of ${cap} with a non-empty preview`,
      );
    }
  });
});
