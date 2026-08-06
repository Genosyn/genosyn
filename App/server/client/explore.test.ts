import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildTablePreviewSql,
  filterExploreTables,
  humanizeExploreName,
  qualifyExploreTable,
  quoteExploreIdentifier,
  suggestExploreVisualization,
  type ExploreSchemaTable,
  type QueryResult,
} from "../../client/lib/explore.js";

describe("Explore identifier and preview-query helpers", () => {
  test("quotes Postgres identifiers and escapes embedded quotes", () => {
    assert.equal(quoteExploreIdentifier("postgres", "order"), '"order"');
    assert.equal(quoteExploreIdentifier("postgres", 'say"hello'), '"say""hello"');
  });

  test("quotes MySQL and ClickHouse identifiers with escaped backticks", () => {
    assert.equal(quoteExploreIdentifier("mysql", "order"), "`order`");
    assert.equal(quoteExploreIdentifier("mysql", "tick`name"), "`tick``name`");
    assert.equal(quoteExploreIdentifier("clickhouse", "events"), "`events`");
  });

  test("qualifies schema and table without trusting either identifier", () => {
    assert.equal(
      qualifyExploreTable("postgres", { schema: "sales data", name: 'monthly"rollup' }),
      '"sales data"."monthly""rollup"',
    );
    assert.equal(
      qualifyExploreTable("mysql", { schema: "shop", name: "line_items" }),
      "`shop`.`line_items`",
    );
  });

  test("builds readable one-click starter queries", () => {
    assert.equal(
      buildTablePreviewSql("postgres", { schema: "public", name: "orders" }),
      'SELECT *\nFROM "public"."orders"\nLIMIT 100;',
    );
  });

  test("clamps preview limits to the Explore executor envelope", () => {
    const table = { schema: "public", name: "orders" };
    assert.match(buildTablePreviewSql("postgres", table, -5), /LIMIT 1;/);
    assert.match(buildTablePreviewSql("postgres", table, 42.9), /LIMIT 42;/);
    assert.match(buildTablePreviewSql("postgres", table, 99_999), /LIMIT 5000;/);
    assert.match(buildTablePreviewSql("postgres", table, Number.NaN), /LIMIT 100;/);
  });

  test("turns database names into useful default Chart titles", () => {
    assert.equal(humanizeExploreName("monthly_revenue"), "Monthly revenue");
    assert.equal(humanizeExploreName("customerOrders"), "Customer Orders");
    assert.equal(humanizeExploreName("daily-rollup"), "Daily rollup");
    assert.equal(humanizeExploreName("___"), "Untitled chart");
  });
});

describe("Explore data-browser filtering", () => {
  const tables: ExploreSchemaTable[] = [
    table("public", "users", [
      ["id", "uuid"],
      ["email", "character varying"],
    ]),
    table("sales", "orders", [
      ["placed_at", "timestamp with time zone"],
      ["amount_cents", "bigint"],
    ]),
    { ...table("reporting", "mrr_by_month", [["month", "date"]]), kind: "view" },
  ];

  test("returns the original list for blank search", () => {
    assert.equal(filterExploreTables(tables, ""), tables);
    assert.equal(filterExploreTables(tables, "   "), tables);
  });

  test("matches table and schema names case-insensitively", () => {
    assert.deepEqual(
      filterExploreTables(tables, "ORDERS").map((item) => item.name),
      ["orders"],
    );
    assert.deepEqual(
      filterExploreTables(tables, "reporting").map((item) => item.name),
      ["mrr_by_month"],
    );
  });

  test("finds tables through column names and data types", () => {
    assert.deepEqual(
      filterExploreTables(tables, "amount").map((item) => item.name),
      ["orders"],
    );
    assert.deepEqual(
      filterExploreTables(tables, "uuid").map((item) => item.name),
      ["users"],
    );
    assert.deepEqual(
      filterExploreTables(tables, "timestamp").map((item) => item.name),
      ["orders"],
    );
  });

  test("matches the table/view kind", () => {
    assert.deepEqual(
      filterExploreTables(tables, "view").map((item) => item.name),
      ["mrr_by_month"],
    );
  });

  test("returns an empty list when nothing matches", () => {
    assert.deepEqual(filterExploreTables(tables, "subscriptions"), []);
  });
});

describe("Explore visualization suggestions", () => {
  test("returns no suggestion for empty or columnless results", () => {
    assert.equal(suggestExploreVisualization(result([], [])), null);
    assert.equal(suggestExploreVisualization(result([{}], [])), null);
  });

  test("suggests a scalar for a one-row numeric result", () => {
    assert.deepEqual(suggestExploreVisualization(result([{ mrr: 12500 }], ["mrr"])), {
      vizType: "scalar",
      vizConfig: { measure: "mrr" },
      label: "Number",
      reason: "One row with a numeric mrr column",
    });
  });

  test("recognizes database numeric strings as measures", () => {
    const suggestion = suggestExploreVisualization(
      result([{ label: "Active", total: "1200.50" }], ["label", "total"]),
    );
    assert.equal(suggestion?.vizType, "scalar");
    assert.deepEqual(suggestion?.vizConfig, { measure: "total" });
  });

  test("suggests a line for an ISO date series", () => {
    const suggestion = suggestExploreVisualization(
      result(
        [
          { day: "2026-08-01", signups: 8 },
          { day: "2026-08-02", signups: 12 },
        ],
        ["day", "signups"],
      ),
    );
    assert.equal(suggestion?.vizType, "line");
    assert.deepEqual(suggestion?.vizConfig, { dimension: "day", measures: ["signups"] });
  });

  test("suggests a line when a timestamp-named field contains full timestamps", () => {
    const suggestion = suggestExploreVisualization(
      result(
        [
          { created_at: "Thu, 06 Aug 2026 09:00:00 GMT", events: 4 },
          { created_at: "Fri, 07 Aug 2026 09:00:00 GMT", events: 5 },
        ],
        ["created_at", "events"],
      ),
    );
    assert.equal(suggestion?.vizType, "line");
  });

  test("suggests bars for categories plus measures", () => {
    const suggestion = suggestExploreVisualization(
      result(
        [
          { plan: "Free", customers: 200 },
          { plan: "Pro", customers: 75 },
        ],
        ["plan", "customers"],
      ),
    );
    assert.equal(suggestion?.vizType, "bar");
    assert.deepEqual(suggestion?.vizConfig, { dimension: "plan", measures: ["customers"] });
  });

  test("keeps up to three measures so a chart stays readable", () => {
    const suggestion = suggestExploreVisualization(
      result(
        [
          { region: "UK", a: 1, b: 2, c: 3, d: 4 },
          { region: "US", a: 5, b: 6, c: 7, d: 8 },
        ],
        ["region", "a", "b", "c", "d"],
      ),
    );
    assert.deepEqual(suggestion?.vizConfig, {
      dimension: "region",
      measures: ["a", "b", "c"],
    });
  });

  test("falls back to a table for text-only rows", () => {
    assert.deepEqual(
      suggestExploreVisualization(
        result(
          [
            { name: "Ada", email: "ada@example.com" },
            { name: "Grace", email: "grace@example.com" },
          ],
          ["name", "email"],
        ),
      ),
      {
        vizType: "table",
        vizConfig: {},
        label: "Table",
        reason: "The result is easiest to inspect as rows",
      },
    );
  });

  test("does not treat mixed strings as a numeric column", () => {
    const suggestion = suggestExploreVisualization(
      result(
        [
          { category: "A", value: "10" },
          { category: "B", value: "unknown" },
        ],
        ["category", "value"],
      ),
    );
    assert.equal(suggestion?.vizType, "table");
  });
});

function table(schema: string, name: string, columns: Array<[string, string]>): ExploreSchemaTable {
  return {
    schema,
    name,
    kind: "table",
    columns: columns.map(([columnName, dataType], index) => ({
      name: columnName,
      dataType,
      nullable: false,
      position: index + 1,
    })),
  };
}

function result(rows: Record<string, unknown>[], fields: string[]): QueryResult {
  return {
    fields: fields.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
    truncated: false,
    elapsedMs: 5,
  };
}
