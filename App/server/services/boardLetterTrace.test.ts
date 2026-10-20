import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readNumbers, traceLetter, type TraceFigure } from "./boardLetterTrace.js";

const FIGURES: TraceFigure[] = [
  { key: "money.revenue", kind: "money", value: 4_812_345.67 },
  { key: "money.expenses", kind: "money", value: 12_400 },
  { key: "money.netIncome", kind: "money", value: -1_250.5 },
  { key: "money.revenueGrowth", kind: "percent", value: 41.36 },
  { key: "work.runs", kind: "count", value: 214 },
  { key: "work.runsFailed", kind: "count", value: 3 },
  { key: "work.runsLarge", kind: "count", value: 6_480 },
  { key: "goal.customers.current", kind: "number", value: 38 },
];

function untracedTexts(body: string, figures = FIGURES, options = {}): string[] {
  return traceLetter(body, figures, options).untraced.map((token) => token.text);
}

function tracedKeys(body: string, figures = FIGURES, options = {}): string[] {
  return traceLetter(body, figures, options).traced.map((token) => token.figureKey);
}

describe("reading numbers out of prose", () => {
  test("reads currency, separators, decimals, magnitude and percent", () => {
    const tokens = readNumbers(
      "Revenue was $4,812,345.67, or $4.8M, up 41% on 214 Runs; costs were 12.4k and €3 million, 7 USD.",
    );
    assert.deepEqual(
      tokens.map(({ text, kind, value }) => ({ text, kind, value })),
      [
        { text: "$4,812,345.67", kind: "money", value: 4_812_345.67 },
        { text: "$4.8M", kind: "money", value: 4_800_000 },
        { text: "41%", kind: "percent", value: 41 },
        { text: "214", kind: "plain", value: 214 },
        { text: "12.4k", kind: "plain", value: 12_400 },
        { text: "€3 million", kind: "money", value: 3_000_000 },
        { text: "7 USD", kind: "money", value: 7 },
      ],
    );
  });

  test("records where each number sits in the text", () => {
    const body = "We paid $480 to 2 electricians.";
    const [money, count] = readNumbers(body);
    assert.equal(body.slice(money.start, money.end), "$480");
    assert.equal(body.slice(count.start, count.end), "2");
  });

  test("keeps a sign written in front of a number", () => {
    const [loss] = readNumbers("Net income was -$1,250.50 this month.");
    assert.equal(loss.value, -1_250.5);
    assert.equal(loss.kind, "money");
    const [minus] = readNumbers("Cash moved by −4 percent.");
    assert.equal(minus.value, -4);
    assert.equal(minus.kind, "percent");
  });

  test("reads lakh grouping and currency prefixes with letters", () => {
    const tokens = readNumbers("We banked ₹1,23,456 and CA$2,500.");
    assert.deepEqual(
      tokens.map(({ value, kind }) => ({ value, kind })),
      [
        { value: 123_456, kind: "money" },
        { value: 2_500, kind: "money" },
      ],
    );
  });

  test("reads lower-case m and b as millions only after a currency sign", () => {
    assert.equal(readNumbers("We raised $4.8m.")[0].value, 4_800_000);
    // "5m" alone could be minutes or metres, so it is not read as a number.
    assert.deepEqual(readNumbers("The job took 5m."), []);
  });

  test("leaves identifiers, ordinals, ranges, times and versions alone", () => {
    const tokens = readNumbers(
      "Q3 closed; INV-0004 and B2B deals; the 3rd week; 12:30; release 1.2.3; 4xx errors; 21st.",
    );
    assert.deepEqual(tokens, []);
  });

  test("ignores numbers inside URLs and ISO dates", () => {
    const tokens = readNumbers(
      "See https://example.com/report/2026/09?page=12 and 2026-09-30T06:00:00Z for 3 notes.",
    );
    assert.deepEqual(
      tokens.map((token) => token.text),
      ["3"],
    );
  });
});

describe("tracing a letter to its figures", () => {
  test("traces figures written exactly", () => {
    const body =
      "Revenue reached $4,812,345.67 against costs of $12,400. We finished 214 Runs, and 3 of them failed.";
    assert.deepEqual(untracedTexts(body), []);
    assert.deepEqual(tracedKeys(body), [
      "money.revenue",
      "money.expenses",
      "work.runs",
      "work.runsFailed",
    ]);
  });

  test("accepts an honest rounding at the precision it was written", () => {
    const body = "Revenue was $4.8M ($4,812,346), growth was 41% (41.4%), and we ran 6.5k Runs.";
    assert.deepEqual(untracedTexts(body), []);
    assert.deepEqual(tracedKeys(body), [
      "money.revenue",
      "money.revenue",
      "money.revenueGrowth",
      "money.revenueGrowth",
      "work.runsLarge",
    ]);
  });

  test("refuses a rounding that drops most of the precision", () => {
    // $5M is within half a million of $4.6M, but 8.7% off it: refused. Against
    // $4.81M it is 4% off, which a reader would call a fair rounding.
    const figures: TraceFigure[] = [{ key: "money.revenue", kind: "money", value: 4_600_000 }];
    assert.deepEqual(untracedTexts("Revenue was $5M.", figures), ["$5M"]);
    assert.deepEqual(untracedTexts("Revenue was $4.6M.", figures), []);
    const closer: TraceFigure[] = [{ key: "money.revenue", kind: "money", value: 4_810_000 }];
    assert.deepEqual(untracedTexts("Revenue was $5M.", closer), []);
  });

  test("flags a number the figures do not contain", () => {
    const body = "We finished 215 Runs and spent $12,500 on 9 suppliers.";
    assert.deepEqual(untracedTexts(body), ["215", "$12,500", "9"]);
  });

  test("does not let rounding stand in for a different count", () => {
    assert.deepEqual(untracedTexts("About 200 Runs finished."), ["200"]);
  });

  test("reads the sign from the words, so a loss is quoted without a minus", () => {
    assert.deepEqual(untracedTexts("We lost $1,250.50 this month."), []);
    assert.deepEqual(untracedTexts("Net income was -$1,250.50."), []);
  });

  test("matches a percent only to a percent, and an amount only to an amount", () => {
    // 3% is not the count 3, and $214 is not 214 Runs.
    assert.deepEqual(untracedTexts("Failures rose 3% and cost $214."), ["3%", "$214"]);
  });

  test("lets a plain number quote an amount written without its sign", () => {
    assert.deepEqual(untracedTexts("Costs came to 12,400 dollars."), []);
  });

  test("traces Goal values as plain numbers", () => {
    assert.deepEqual(tracedKeys("We have 38 paying customers."), ["goal.customers.current"]);
  });

  test("when figures share a number, picks the one whose words stand beside it", () => {
    const same: TraceFigure[] = [
      { key: "work.runsCompleted", kind: "count", value: 1, label: "Runs that completed" },
      { key: "work.runsFailed", kind: "count", value: 1, label: "Runs that failed" },
      { key: "decisions.waiting", kind: "count", value: 1, label: "Decisions still waiting" },
    ];
    assert.deepEqual(
      tracedKeys("We finished 2 Runs and 1 failed. 1 Decision is still waiting for you.", same),
      ["work.runsFailed", "decisions.waiting"],
    );
    // With nothing to go on, the first figure listed is the one quoted.
    assert.deepEqual(tracedKeys("There was 1.", same), ["work.runsCompleted"]);
  });

  test("reads a rounded number by its words first, and by closeness only after", () => {
    const close: TraceFigure[] = [
      { key: "money.revenue", kind: "money", value: 4_812_345, label: "Revenue this month" },
      { key: "money.cash", kind: "money", value: 4_800_000, label: "Cash at the end of the month" },
    ];
    // Both are honest at "$4.8M"; the sentence says which one it is.
    assert.deepEqual(tracedKeys("Revenue was $4.8M.", close), ["money.revenue"]);
    assert.deepEqual(tracedKeys("We closed with $4.8M of cash.", close), ["money.cash"]);
    // A sentence that names neither leaves it to the closer figure.
    assert.deepEqual(tracedKeys("That came to $4.8M.", close), ["money.cash"]);
  });
});

describe("numbers a letter needs that are not figures", () => {
  test("leaves years near the letter's own alone", () => {
    const body = "Since 2019 we have grown; in 2026 revenue rose; 1999 was long ago.";
    assert.deepEqual(untracedTexts(body, FIGURES, { year: 2026 }), ["1999"]);
  });

  test("treats a year as a number when no year is given", () => {
    assert.deepEqual(untracedTexts("In 2026 we grew."), ["2026"]);
  });

  test("leaves days of the month beside a month's name alone", () => {
    const body = "On September 30 and 1 October, and Sept. 14, and 2 of November, we shipped.";
    assert.deepEqual(untracedTexts(body), []);
  });

  test("still traces a small number that is not beside a month", () => {
    assert.deepEqual(untracedTexts("We hired 30 people."), ["30"]);
  });

  test("leaves the letter's own number alone, and only its own", () => {
    assert.deepEqual(untracedTexts("This is Letter No. 4.", FIGURES, { letterNumber: 4 }), []);
    assert.deepEqual(untracedTexts("As Letter No. 2 said.", FIGURES, { letterNumber: 4 }), ["2"]);
  });

  test("does not read numbers written as words", () => {
    assert.deepEqual(untracedTexts("Three suppliers and a dozen installers."), []);
  });

  test("an empty letter traces to nothing", () => {
    assert.deepEqual(traceLetter("", FIGURES), { traced: [], untraced: [] });
  });
});
