import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { drawnColumns, sharedChartResult, sharedVizConfig } from "./dashboardLinks.js";

/**
 * A shared card sends a stranger only what its chart draws: the settings it
 * draws with, and — when those settings name every column — only those
 * columns of its rows. A chart that leaves the choice to the renderer gets
 * every column, exactly as it would in the App, so nothing renders differently.
 */

const all = ["day", "signups", "revenue", "email"];

describe("the columns a shared chart sends", () => {
  test("a table that picks its columns sends only those", () => {
    assert.deepEqual(drawnColumns("table", { columns: ["day", "missing", "revenue"] }, all), [
      "day",
      "revenue",
    ]);
    assert.equal(drawnColumns("table", {}, all), null);
    assert.equal(drawnColumns("table", { columns: ["missing"] }, all), null);
  });

  test("a number sends its measure", () => {
    assert.deepEqual(drawnColumns("scalar", { measure: "revenue" }, all), ["revenue"]);
    assert.equal(drawnColumns("scalar", {}, all), null);
  });

  test("a bar, line or pie sends its dimension and measures once both are named", () => {
    assert.deepEqual(
      drawnColumns("bar", { dimension: "day", measures: ["signups", "revenue"] }, all),
      ["day", "signups", "revenue"],
    );
    assert.deepEqual(drawnColumns("pie", { dimension: "day", measure: "revenue" }, all), [
      "day",
      "revenue",
    ]);
    assert.equal(drawnColumns("line", { measures: ["signups"] }, all), null);
    assert.equal(drawnColumns("area", { dimension: "day" }, all), null);
  });

  test("rows keep only the columns drawn, and nothing about how long the query took", () => {
    const shared = sharedChartResult(
      "table",
      { columns: ["day", "revenue"] },
      {
        fields: all.map((name) => ({ name })),
        rows: [{ day: "Mon", signups: 3, revenue: 40, email: "a@example.com" }],
        rowCount: 1,
        truncated: false,
        elapsedMs: 12,
      },
    );
    assert.deepEqual(shared, {
      fields: [{ name: "day" }, { name: "revenue" }],
      rows: [{ day: "Mon", revenue: 40 }],
      rowCount: 1,
      truncated: false,
    });
  });
});

describe("the settings a shared chart sends", () => {
  test("are the ones it draws with, and nothing else stored beside them", () => {
    assert.deepEqual(
      sharedVizConfig(
        JSON.stringify({
          dimension: "day",
          measures: ["signups", 7],
          stacked: true,
          prefix: "$",
          notes: "for the board only",
          sql: "select * from secrets",
        }),
      ),
      { dimension: "day", measures: ["signups"], stacked: true, prefix: "$" },
    );
    assert.deepEqual(sharedVizConfig("not json"), {});
    assert.deepEqual(sharedVizConfig(JSON.stringify({ measure: "x".repeat(500) })), {});
  });
});
