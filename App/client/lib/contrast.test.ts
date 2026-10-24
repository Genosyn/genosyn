import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AA_LARGE,
  AA_NORMAL,
  aaMinimum,
  composite,
  contrastOf,
  contrastRatio,
  flatten,
  formatRatio,
  isLargeText,
  parseColor,
  relativeLuminance,
} from "./contrast.js";

const close = (actual: number, expected: number, places = 2) =>
  assert.ok(
    Math.abs(actual - expected) < 10 ** -places,
    `expected ${actual} to be within ${10 ** -places} of ${expected}`,
  );

describe("parseColor", () => {
  test("reads every hex length", () => {
    assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor("#0f172a"), { r: 15, g: 23, b: 42, a: 1 });
    assert.deepEqual(parseColor("#0F172A"), { r: 15, g: 23, b: 42, a: 1 });
    const short = parseColor("#0008");
    assert.ok(short);
    close(short.a, 136 / 255);
    const long = parseColor("#4f46e580");
    assert.ok(long);
    assert.equal(long.r, 79);
    close(long.a, 128 / 255);
  });

  test("reads comma and space rgb syntax, with and without alpha", () => {
    assert.deepEqual(parseColor("rgb(15, 23, 42)"), { r: 15, g: 23, b: 42, a: 1 });
    assert.deepEqual(parseColor("rgba(15, 23, 42, 0.5)"), { r: 15, g: 23, b: 42, a: 0.5 });
    assert.deepEqual(parseColor("rgb(15 23 42)"), { r: 15, g: 23, b: 42, a: 1 });
    assert.deepEqual(parseColor("rgb(15 23 42 / 0.25)"), { r: 15, g: 23, b: 42, a: 0.25 });
    assert.deepEqual(parseColor("rgb(15 23 42 / 40%)"), { r: 15, g: 23, b: 42, a: 0.4 });
    assert.deepEqual(parseColor("rgb(100%, 0%, 50%)"), { r: 255, g: 0, b: 127.5, a: 1 });
  });

  test("clamps channels and alpha into range", () => {
    assert.deepEqual(parseColor("rgba(300, -4, 12, 2)"), { r: 255, g: 0, b: 12, a: 1 });
  });

  test("treats transparent as clear black", () => {
    assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  });

  test("refuses what it cannot judge rather than guessing", () => {
    for (const value of [
      "currentcolor",
      "linear-gradient(red, blue)",
      "oklch(0.7 0.1 200)",
      "#12345",
      "rgb(1, 2)",
      "rgb(a, b, c)",
      "",
    ]) {
      assert.equal(parseColor(value), null, value);
    }
  });
});

describe("relativeLuminance", () => {
  test("is 0 for black and 1 for white", () => {
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
    close(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }), 1, 6);
  });

  test("matches the WCAG formula for a mid grey", () => {
    // #777777 → 0.1845 (published reference value).
    close(relativeLuminance({ r: 119, g: 119, b: 119, a: 1 }), 0.1845, 3);
  });
});

describe("contrastRatio", () => {
  test("spans 1:1 to 21:1", () => {
    close(contrastOf("#000", "#fff"), 21);
    close(contrastOf("#fff", "#fff"), 1);
  });

  test("is symmetric", () => {
    close(contrastOf("#64748b", "#ffffff"), contrastOf("#ffffff", "#64748b"), 6);
  });

  test("agrees with published Tailwind slate pairs", () => {
    // slate-500 on white passes AA; slate-400 on white does not.
    close(contrastOf("#64748b", "#ffffff"), 4.76);
    close(contrastOf("#94a3b8", "#ffffff"), 2.56);
    // slate-400 on slate-900 is comfortable in dark mode.
    close(contrastOf("#94a3b8", "#0f172a"), 6.96);
  });

  test("lays a translucent foreground over the background first", () => {
    const half = contrastRatio({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    // Half-black on white paints rgb(127.5, 127.5, 127.5): luminance ≈ 0.2140.
    close(half, 3.98);
  });

  test("lays a translucent background over white", () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 0 });
    close(ratio, 21);
  });
});

describe("composite and flatten", () => {
  test("an opaque top layer wins", () => {
    assert.deepEqual(
      composite({ r: 10, g: 20, b: 30, a: 1 }, { r: 200, g: 200, b: 200, a: 1 }),
      { r: 10, g: 20, b: 30, a: 1 },
    );
  });

  test("a translucent layer mixes with what is below", () => {
    const mixed = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    close(mixed.r, 127.5);
    close(mixed.a, 1);
  });

  test("two clear layers stay clear", () => {
    assert.deepEqual(
      composite({ r: 1, g: 2, b: 3, a: 0 }, { r: 4, g: 5, b: 6, a: 0 }),
      { r: 0, g: 0, b: 0, a: 0 },
    );
  });

  test("flatten paints nearest-first layers over an opaque fallback", () => {
    // A 10% indigo tint over a white card over the slate page.
    const tint = { r: 99, g: 102, b: 241, a: 0.1 };
    const card = { r: 255, g: 255, b: 255, a: 1 };
    const page = { r: 248, g: 250, b: 252, a: 1 };
    const result = flatten([tint, card, page]);
    close(result.a, 1);
    close(result.r, 255 * 0.9 + 99 * 0.1);
    // With nothing to paint, the fallback shows through.
    assert.deepEqual(flatten([]), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(flatten([], page), page);
  });
});

describe("large text and the AA minimum", () => {
  test("24px and up is large at any weight", () => {
    assert.equal(isLargeText(24, 400), true);
    assert.equal(isLargeText(23.9, 400), false);
  });

  test("18.66px and up is large when bold", () => {
    assert.equal(isLargeText(18.66, 700), true);
    assert.equal(isLargeText(18.66, 600), false);
    assert.equal(isLargeText(18, 700), false);
  });

  test("the minimum follows the size", () => {
    assert.equal(aaMinimum(14, 400), AA_NORMAL);
    assert.equal(aaMinimum(30, 600), AA_LARGE);
    assert.equal(AA_NORMAL, 4.5);
    assert.equal(AA_LARGE, 3);
  });
});

describe("formatRatio", () => {
  test("rounds down, so a near miss never reads as a pass", () => {
    assert.equal(formatRatio(4.499), "4.49:1");
    assert.equal(formatRatio(4.5), "4.50:1");
    assert.equal(formatRatio(21), "21.00:1");
  });
});

describe("contrastOf", () => {
  test("throws on a colour it cannot read", () => {
    assert.throws(() => contrastOf("currentColor", "#fff"), /Cannot compare/);
  });
});
