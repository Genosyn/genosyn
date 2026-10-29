import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { scoreExploreItem, searchExploreItems } from "./exploreSearch.js";

const CHARTS = [
  { title: "Revenue", slug: "revenue" },
  { title: "Churn by month", slug: "churn" },
  { title: "Dashboard history", slug: "history" },
];
const DASHBOARDS = [
  { title: "Revenue", slug: "revenue" },
  { title: "Pipeline", slug: "pipeline" },
  { title: "Board pack", slug: "board-pack" },
];

const titles = (items: { title: string }[]) => items.map((item) => item.title);

describe("Explore sidebar search", () => {
  test("finds the Dashboard called Revenue for 'revenue dashboard'", () => {
    // The bug: the phrase was matched literally against the title, so a
    // Dashboard named Revenue could not be reached by name + kind.
    assert.deepEqual(titles(searchExploreItems(DASHBOARDS, "dashboard", "revenue dashboard")), [
      "Revenue",
    ]);
  });

  test("does not let a dashboard query list the chart called Revenue", () => {
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "revenue dashboard")), []);
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "revenue chart")), ["Revenue"]);
  });

  test("keeps each kind word with its own list", () => {
    assert.deepEqual(titles(searchExploreItems(DASHBOARDS, "dashboard", "revenue chart")), []);
    assert.deepEqual(titles(searchExploreItems(DASHBOARDS, "dashboard", "revenue dashboards")), [
      "Revenue",
    ]);
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "revenue charts")), ["Revenue"]);
  });

  test("accepts the words in either order, singular or plural", () => {
    for (const query of [
      "revenue dashboard",
      "dashboard revenue",
      "dashboards revenue",
      "revenue dashboards",
      "dashboard: revenue",
    ]) {
      assert.deepEqual(
        titles(searchExploreItems(DASHBOARDS, "dashboard", query)),
        ["Revenue"],
        query,
      );
    }
  });

  test("works while the kind word is still being typed", () => {
    for (const query of ["revenue dash", "revenue dashb", "revenue dashbo"]) {
      assert.deepEqual(
        titles(searchExploreItems(DASHBOARDS, "dashboard", query)),
        ["Revenue"],
        query,
      );
    }
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "revenue char")), ["Revenue"]);
  });

  test("a kind word on its own lists that kind's rows", () => {
    assert.deepEqual(titles(searchExploreItems(DASHBOARDS, "dashboard", "dashboard")), [
      "Revenue",
      "Pipeline",
      "Board pack",
    ]);
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "charts")), [
      "Revenue",
      "Churn by month",
      "Dashboard history",
    ]);
  });

  test("a whole name still narrows the list", () => {
    assert.deepEqual(titles(searchExploreItems(DASHBOARDS, "dashboard", "board pack")), [
      "Board pack",
    ]);
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "churn")), ["Churn by month"]);
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "churn revenue")), []);
  });

  test("keeps a row whose title contains the other kind's word", () => {
    // "Dashboard history" is a Chart. Its title is the best evidence there is,
    // so a search for "dashboard" must still find it in the Charts list.
    assert.deepEqual(titles(searchExploreItems(CHARTS, "chart", "dashboard")), [
      "Dashboard history",
    ]);
  });

  test("ignores case, accents, and extra whitespace", () => {
    const plans = [{ title: "Résumé funnel" }];
    for (const query of ["  RESUME   FUNNEL ", "résumé funnel", "résumé    funnel"]) {
      assert.deepEqual(
        titles(searchExploreItems(plans, "dashboard", query)),
        ["Résumé funnel"],
        query,
      );
    }
  });

  test("returns every row, in its existing order, for a blank query", () => {
    for (const query of ["", " ", "\t\n"]) {
      assert.deepEqual(searchExploreItems(DASHBOARDS, "dashboard", query), [...DASHBOARDS]);
      assert.deepEqual(searchExploreItems(CHARTS, "chart", query), [...CHARTS]);
    }
  });

  test("does not mutate the list it filters", () => {
    const rows = [...DASHBOARDS];
    const result = searchExploreItems(rows, "dashboard", "revenue dashboard");
    assert.deepEqual(rows, DASHBOARDS);
    assert.notEqual(result, rows, "a filtered list is a new array");
  });

  test("returns nothing when a narrowing word lands nowhere", () => {
    for (const query of ["revenue zebra", "zebra", "revenue dashboard quarterly"]) {
      assert.deepEqual(searchExploreItems(DASHBOARDS, "dashboard", query), [], query);
    }
  });

  test("does not treat a short ambiguous prefix as a kind word", () => {
    // "pro" could be Project or Product elsewhere; here it is just text.
    assert.deepEqual(searchExploreItems(DASHBOARDS, "dashboard", "pro"), []);
    assert.deepEqual(searchExploreItems([{ title: "Progress" }], "dashboard", "pro"), [
      { title: "Progress" },
    ]);
  });

  test("scores an exact title above a kind-only phrase, and a phrase above separate words", () => {
    const exact = scoreExploreItem("Revenue", "dashboard", "revenue");
    const kindOnly = scoreExploreItem("Revenue", "dashboard", "dashboard");
    const phrase = scoreExploreItem("Revenue dashboard", "dashboard", "revenue dashboard");
    const separate = scoreExploreItem("Revenue dashboard", "dashboard", "dashboard revenue");
    assert.equal(exact, 100);
    assert.equal(kindOnly, 55);
    assert.equal(phrase, 100);
    assert.ok(separate !== null && phrase !== null && phrase >= separate);
    assert.equal(scoreExploreItem("Revenue", "dashboard", "zebra"), null);
    assert.equal(scoreExploreItem("Revenue", "dashboard", ""), 0);
  });
});
