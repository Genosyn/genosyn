import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatAxisMoney,
  monthHeading,
  monthStride,
  monthTicks,
  niceScale,
  periodFigure,
} from "./financialTrendScale";

/**
 * The finance trend chart's axis once read "-$21k, $13k, $47k, $81k, $115k":
 * five evenly spaced numbers nobody would pick, with zero nowhere on them. Its
 * month labels crowded together at the right edge. These pin the replacements.
 */

/** Calendar months from `year`-`month` (1-based), each running its full length. */
function months(year: number, month: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const from = new Date(Date.UTC(year, month - 1 + i, 1));
    const to = new Date(Date.UTC(year, month + i, 0, 23, 59, 59, 999));
    return { from: from.toISOString(), to: to.toISOString() };
  });
}

describe("niceScale", () => {
  test("puts a year with a losing month on round steps through zero", () => {
    // -$17,000 in the worst month, $105,924 in the best.
    const scale = niceScale([-1_700_000, 0, 1_250_000, 10_592_400]);
    assert.deepEqual(
      scale.ticks,
      [-2_500_000, 0, 2_500_000, 5_000_000, 7_500_000, 10_000_000, 12_500_000],
    );
    assert.equal(scale.step, 2_500_000);
  });

  test("starts at zero when nothing is negative", () => {
    assert.deepEqual(
      niceScale([400_000, 10_000_000]).ticks,
      [0, 2_500_000, 5_000_000, 7_500_000, 10_000_000],
    );
  });

  test("ends at zero when nothing is positive", () => {
    const scale = niceScale([-300_000, -100_000]);
    assert.equal(scale.max, 0);
    assert.deepEqual(scale.ticks, [-300_000, -200_000, -100_000, 0]);
  });

  test("always covers every value, on three to six intervals", () => {
    for (const values of [
      [1],
      [99],
      [12_345],
      [-7, 3],
      [-98_765_432, 1_234_567],
      [5_000_000, 5_000_001],
    ]) {
      const scale = niceScale(values);
      assert.ok(scale.min <= Math.min(0, ...values), `min for ${values}`);
      assert.ok(scale.max >= Math.max(0, ...values), `max for ${values}`);
      assert.ok(scale.ticks.includes(0), `zero for ${values}`);
      const intervals = scale.ticks.length - 1;
      assert.ok(intervals >= 3 && intervals <= 6, `${intervals} intervals for ${values}`);
    }
  });

  test("still draws an axis when every value is zero", () => {
    const scale = niceScale([0, 0, 0]);
    assert.equal(scale.min, 0);
    assert.ok(scale.max > 0);
  });
});

describe("formatAxisMoney", () => {
  test("is compact, in the home currency, without trailing zeros", () => {
    assert.equal(formatAxisMoney(2_500_000, "USD"), "$25K");
    assert.equal(formatAxisMoney(-2_500_000, "USD"), "-$25K");
    assert.equal(formatAxisMoney(125_000_000, "USD"), "$1.25M");
    assert.equal(formatAxisMoney(0, "USD"), "$0");
    assert.equal(formatAxisMoney(2_500_000, "EUR"), "€25K");
  });

  test("falls back to the code for a currency Intl rejects", () => {
    assert.equal(formatAxisMoney(2_500_000, "X"), "25000 X");
  });
});

describe("monthTicks", () => {
  test("names the year once, then just the months", () => {
    assert.deepEqual(
      monthTicks(months(2026, 1, 4), 1).map((tick) => tick.label),
      ["Jan 2026", "Feb", "Mar", "Apr"],
    );
  });

  test("names the year again where it changes", () => {
    assert.deepEqual(
      monthTicks(months(2025, 11, 4), 1).map((tick) => tick.label),
      ["Nov 2025", "Dec", "Jan 2026", "Feb"],
    );
  });

  test("thins out from the latest month, so it is always labelled", () => {
    assert.deepEqual(
      monthTicks(months(2026, 1, 10), 3).map((tick) => [tick.index, tick.label]),
      [
        [0, "Jan 2026"],
        [3, "Apr"],
        [6, "Jul"],
        [9, "Oct"],
      ],
    );
    assert.deepEqual(
      monthTicks(months(2026, 1, 10), 2).map((tick) => tick.index),
      [1, 3, 5, 7, 9],
    );
  });
});

describe("monthStride", () => {
  // Seven pixels a character: "Jan 2026" is 56px wide, "Feb" 21px.
  const measure = (text: string) => text.length * 7;

  test("labels every month when there is room", () => {
    assert.equal(monthStride(months(2026, 1, 10), 100, measure), 1);
  });

  test("skips months rather than letting labels touch", () => {
    // One month is 30px: "Jan 2026" and "Feb" need 50.5px between centres.
    assert.equal(monthStride(months(2026, 1, 10), 30, measure), 2);
  });

  test("labels a single month", () => {
    assert.equal(monthStride(months(2026, 10, 1), 10, measure), 1);
  });
});

describe("monthHeading", () => {
  test("names a whole month", () => {
    const [october] = months(2026, 10, 1);
    assert.equal(monthHeading(october), "October 2026");
  });

  test("gives the days of a month the period cuts short", () => {
    assert.equal(
      monthHeading({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-22T23:59:59.999Z" }),
      "Oct 1 – 22, 2026",
    );
    assert.equal(
      monthHeading({ from: "2026-03-15T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" }),
      "Mar 15 – 31, 2026",
    );
    assert.equal(
      monthHeading({ from: "2026-10-22T00:00:00.000Z", to: "2026-10-22T23:59:59.999Z" }),
      "Oct 22, 2026",
    );
  });
});

describe("periodFigure", () => {
  test("adds up a flow and reads a balance at the end", () => {
    assert.equal(periodFigure([100, -40, 250], "sum"), 310);
    assert.equal(periodFigure([100, -40, 250], "last"), 250);
  });

  test("has nothing to say about no months", () => {
    assert.equal(periodFigure([], "sum"), null);
  });
});
