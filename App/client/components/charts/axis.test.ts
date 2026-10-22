import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { columnPath, crisp, fitText, formatAxisNumber, labelStride, niceAxis } from "./axis";

/**
 * Explore's charts once split their y-axis into four equal parts of whatever
 * range the data had ("0, 18.3K, 36.5K, 54.8K, 73.0K") and cut category
 * labels to a character count that ignored how wide the chart was. These pin
 * the axis and labels that replaced them, which the finance reports' chart
 * shares.
 */

describe("niceAxis", () => {
  test("steps through round numbers from zero", () => {
    assert.deepEqual(niceAxis([0, 41_000, 73_000]).ticks, [0, 25_000, 50_000, 75_000]);
  });

  test("steps through fractions without floating-point dust", () => {
    assert.deepEqual(niceAxis([0.12, 0.37]).ticks, [0, 0.1, 0.2, 0.3, 0.4]);
    assert.deepEqual(niceAxis([0.3]).ticks, [0, 0.1, 0.2, 0.3]);
  });

  test("fits as few intervals as a short chart has room for", () => {
    assert.deepEqual(niceAxis([0, 73_000], { intervals: [2, 2] }).ticks, [0, 50_000, 100_000]);
  });

  test("crosses zero on a labelled tick", () => {
    const axis = niceAxis([-5, 12]);
    assert.ok(axis.ticks.includes(0));
    assert.ok(axis.min <= -5 && axis.max >= 12);
  });

  test("ends at zero when nothing is positive", () => {
    assert.deepEqual(niceAxis([-300, -100]).ticks, [-300, -200, -100, 0]);
  });

  test("still draws an axis when every value is zero", () => {
    assert.deepEqual(niceAxis([0, 0]).ticks, [0, 0.25, 0.5, 0.75, 1]);
  });

  test("always covers every value, with zero on it", () => {
    for (const values of [[1], [99], [0.004], [-7, 3], [12_345], [-98_765_432, 1_234_567]]) {
      const axis = niceAxis(values);
      assert.ok(axis.min <= Math.min(0, ...values), `min for ${values}`);
      assert.ok(axis.max >= Math.max(0, ...values), `max for ${values}`);
      assert.ok(axis.ticks.includes(0), `zero for ${values}`);
      assert.equal(axis.ticks.length, Math.round((axis.max - axis.min) / axis.step) + 1);
    }
  });
});

describe("formatAxisNumber", () => {
  test("is compact from a thousand, without trailing zeros", () => {
    assert.equal(formatAxisNumber(25_000, 25_000), "25K");
    assert.equal(formatAxisNumber(1_250_000, 250_000), "1.25M");
    assert.equal(formatAxisNumber(-5_000, 5_000), "-5K");
    assert.equal(formatAxisNumber(250, 50), "250");
    assert.equal(formatAxisNumber(0, 25_000), "0");
  });

  test("gives a fractional step the decimals it needs", () => {
    assert.equal(formatAxisNumber(0.25, 0.25), "0.25");
    assert.equal(formatAxisNumber(0.5, 0.25), "0.5");
    assert.equal(formatAxisNumber(0.3, 0.1), "0.3");
  });
});

describe("labelStride", () => {
  test("names every category when there is room", () => {
    assert.equal(labelStride([40, 40, 40, 40], 60), 1);
  });

  test("skips categories rather than letting labels touch", () => {
    assert.equal(labelStride([40, 40, 40, 40], 30), 2);
  });

  test("only measures the labels it would show", () => {
    // Index 1 is long, but at a stride of 2 it is never drawn.
    assert.equal(labelStride([40, 200, 40, 40], 60), 2);
  });

  test("names a single category", () => {
    assert.equal(labelStride([300], 10), 1);
  });
});

describe("fitText", () => {
  // Seven pixels a character.
  const measure = (text: string) => text.length * 7;

  test("leaves a label that fits alone", () => {
    assert.equal(fitText("Revenue", 100, measure), "Revenue");
  });

  test("shortens a long label to the room it has", () => {
    assert.equal(fitText("A very long category name", 70, measure), "A very lo…");
  });

  test("keeps at least one character", () => {
    assert.equal(fitText("Revenue", 3, measure), "R…");
  });
});

describe("columnPath", () => {
  test("rounds a rising column at its top", () => {
    assert.match(columnPath(0, 100, 50, 10), /^M0,100V54A4,4 0 0 1 4,50/);
  });

  test("rounds a falling column at its bottom", () => {
    assert.match(columnPath(0, 100, 150, 10), /^M0,100V146A4,4 0 0 0 4,150/);
  });

  test("draws a square segment when the radius is zero", () => {
    assert.equal(columnPath(0, 100, 50, 10, 0), "M0,100V50H10V100Z");
  });
});

describe("crisp", () => {
  test("puts a hairline on a pixel row", () => {
    assert.equal(crisp(10.2), 10.5);
    assert.equal(crisp(10.7), 11.5);
  });
});
