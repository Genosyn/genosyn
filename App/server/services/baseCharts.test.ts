import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  emptyBaseChartQuery,
  normalizeBaseChartQuery,
  parseBaseChartQuery,
  type BaseChartQuery,
} from "../../shared/baseChartQuery.js";
import {
  answerBaseChartQuery,
  BaseChartError,
  baseChartQueryProblem,
  describeBaseChartQuery,
  type BaseChartLabels,
} from "./baseCharts.js";

/**
 * The Base chart engine answers a question from rows already in memory, so
 * every rule — grouping, date buckets, measures, sorting, the listed rows —
 * is checked here without a database. The routes' tests cover loading.
 */

const fields = [
  { id: "f-name", name: "Name", type: "text" },
  { id: "f-stage", name: "Stage", type: "select" },
  { id: "f-tags", name: "Tags", type: "multiselect" },
  { id: "f-amount", name: "Amount", type: "number" },
  { id: "f-closed", name: "Closed", type: "date" },
  { id: "f-at", name: "Logged at", type: "datetime" },
  { id: "f-done", name: "Done", type: "checkbox" },
  { id: "f-notes", name: "Notes", type: "longtext" },
  { id: "f-account", name: "Account", type: "link" },
];

const labels: BaseChartLabels = new Map([
  [
    "f-stage",
    {
      labels: new Map([
        ["o-lead", "Lead"],
        ["o-won", "Won"],
        ["o-lost", "Lost"],
      ]),
      order: new Map([
        ["o-lead", 0],
        ["o-won", 1],
        ["o-lost", 2],
      ]),
    },
  ],
  [
    "f-tags",
    {
      labels: new Map([
        ["t-urgent", "Urgent"],
        ["t-billing", "Billing"],
      ]),
      order: new Map([
        ["t-urgent", 0],
        ["t-billing", 1],
      ]),
    },
  ],
  ["f-account", { labels: new Map([["r-acme", "Acme Corp"]]) }],
]);

const records = [
  {
    sortOrder: 1000,
    data: {
      "f-name": "Acme",
      "f-stage": "o-won",
      "f-tags": ["t-urgent", "t-billing"],
      "f-amount": 100,
      "f-closed": "2026-01-15",
      "f-at": "2026-01-31T23:30:00Z",
      "f-done": true,
      "f-account": ["r-acme", "r-gone"],
    },
  },
  {
    sortOrder: 2000,
    data: {
      "f-name": "Globex",
      "f-stage": "o-lead",
      "f-tags": ["t-urgent"],
      "f-amount": 50.1,
      "f-closed": "2026-01-20",
      "f-at": "2026-02-01T10:00",
      "f-done": false,
    },
  },
  {
    sortOrder: 3000,
    data: {
      "f-name": "Initech",
      "f-stage": "o-won",
      "f-tags": [],
      "f-amount": 0.2,
      "f-closed": "2026-03-02",
    },
  },
  { sortOrder: 4000, data: { "f-name": "Hooli" } },
];

function query(patch: Partial<BaseChartQuery>): BaseChartQuery {
  return { ...emptyBaseChartQuery("table-1"), ...patch };
}

function answer(
  patch: Partial<BaseChartQuery>,
  extra: { timeZone?: string; maxRows?: number } = {},
) {
  return answerBaseChartQuery({
    query: query(patch),
    fields,
    records,
    labels,
    timeZone: extra.timeZone ?? "UTC",
    maxRows: extra.maxRows,
  });
}

const count = { aggregate: "count" as const, fieldId: null };

describe("grouping", () => {
  test("counts rows per choice in the field's own option order, empty last", () => {
    const result = answer({ groupBy: { fieldId: "f-stage", bucket: null }, metrics: [count] });
    assert.deepEqual(
      result.fields.map((field) => field.name),
      ["Stage", "Count"],
    );
    assert.deepEqual(result.rows, [
      { Stage: "Lead", Count: 1 },
      { Stage: "Won", Count: 2 },
      { Stage: "(empty)", Count: 1 },
    ]);
  });

  test("counts grouped rows when no measure is chosen", () => {
    const result = answer({ groupBy: { fieldId: "f-done", bucket: null } });
    assert.deepEqual(result.rows, [
      { Done: "Yes", Count: 1 },
      { Done: "No", Count: 3 },
    ]);
  });

  test("puts a row in each of its multiple-select values, once each", () => {
    const result = answer({ groupBy: { fieldId: "f-tags", bucket: null }, metrics: [count] });
    assert.deepEqual(result.rows, [
      { Tags: "Urgent", Count: 2 },
      { Tags: "Billing", Count: 1 },
      { Tags: "(empty)", Count: 2 },
    ]);
  });

  test("labels a link it cannot resolve as unknown instead of dropping the row", () => {
    const result = answer({ groupBy: { fieldId: "f-account", bucket: null }, metrics: [count] });
    assert.deepEqual(result.rows, [
      { Account: "Acme Corp", Count: 1 },
      { Account: "(empty)", Count: 3 },
      { Account: "(unknown)", Count: 1 },
    ]);
  });

  test("buckets dates by day, Monday-started week, month, quarter, and year", () => {
    const labelsFor = (bucket: "day" | "week" | "month" | "quarter" | "year") =>
      answer({ groupBy: { fieldId: "f-closed", bucket }, metrics: [count] }).rows.map((row) => [
        row.Closed,
        row.Count,
      ]);
    assert.deepEqual(labelsFor("day"), [
      ["2026-01-15", 1],
      ["2026-01-20", 1],
      ["2026-03-02", 1],
      ["(empty)", 1],
    ]);
    assert.deepEqual(labelsFor("week"), [
      ["2026-01-12", 1],
      ["2026-01-19", 1],
      ["2026-03-02", 1],
      ["(empty)", 1],
    ]);
    assert.deepEqual(labelsFor("month"), [
      ["2026-01", 2],
      ["2026-03", 1],
      ["(empty)", 1],
    ]);
    assert.deepEqual(labelsFor("quarter"), [
      ["2026-Q1", 3],
      ["(empty)", 1],
    ]);
    assert.deepEqual(labelsFor("year"), [
      ["2026", 3],
      ["(empty)", 1],
    ]);
  });

  test("dates a stamped instant on the company's calendar and a typed time as typed", () => {
    const days = (timeZone: string) =>
      answer({ groupBy: { fieldId: "f-at", bucket: "day" }, metrics: [count] }, { timeZone })
        .rows.filter((row) => row["Logged at"] !== "(empty)")
        .map((row) => [row["Logged at"], row.Count]);
    // 23:30 UTC on 31 January is still the 31st in New York but the 1st in Tokyo.
    assert.deepEqual(days("America/New_York"), [
      ["2026-01-31", 1],
      ["2026-02-01", 1],
    ]);
    assert.deepEqual(days("Asia/Tokyo"), [["2026-02-01", 2]]);
  });
});

describe("measuring", () => {
  test("sums, averages, and bounds a number field per group without float noise", () => {
    const result = answer({
      groupBy: { fieldId: "f-stage", bucket: null },
      metrics: [
        { aggregate: "sum", fieldId: "f-amount" },
        { aggregate: "avg", fieldId: "f-amount" },
        { aggregate: "min", fieldId: "f-amount" },
        { aggregate: "max", fieldId: "f-amount" },
      ],
    });
    assert.deepEqual(
      result.fields.map((field) => field.name),
      ["Stage", "Sum of Amount", "Average of Amount", "Min of Amount", "Max of Amount"],
    );
    assert.deepEqual(result.rows, [
      {
        Stage: "Lead",
        "Sum of Amount": 50.1,
        "Average of Amount": 50.1,
        "Min of Amount": 50.1,
        "Max of Amount": 50.1,
      },
      {
        Stage: "Won",
        "Sum of Amount": 100.2,
        "Average of Amount": 50.1,
        "Min of Amount": 0.2,
        "Max of Amount": 100,
      },
      {
        Stage: "(empty)",
        "Sum of Amount": 0,
        "Average of Amount": null,
        "Min of Amount": null,
        "Max of Amount": null,
      },
    ]);
  });

  test("totals every matching row in one row, even when nothing matches", () => {
    const totals = answer({ metrics: [count, { aggregate: "sum", fieldId: "f-amount" }] });
    assert.deepEqual(totals.rows, [{ Count: 4, "Sum of Amount": 150.3 }]);

    const none = answer({
      filters: [{ id: "r1", fieldId: "f-stage", operator: "is", value: "o-lost" }],
      metrics: [count, { aggregate: "avg", fieldId: "f-amount" }],
    });
    assert.deepEqual(none.rows, [{ Count: 0, "Average of Amount": null }]);
    assert.equal(none.rowCount, 1);
  });

  test("filters with the same rules a Base view uses", () => {
    const result = answer({
      filters: [
        { id: "r1", fieldId: "f-stage", operator: "is", value: "o-won" },
        { id: "r2", fieldId: "f-amount", operator: "greaterThan", value: "1" },
      ],
      metrics: [count],
    });
    assert.deepEqual(result.rows, [{ Count: 1 }]);
  });
});

describe("ordering and limits", () => {
  test("sorts groups by their first measure and keeps the largest", () => {
    const result = answer({
      groupBy: { fieldId: "f-stage", bucket: null },
      metrics: [count],
      sort: { by: "metric", fieldId: null, direction: "desc" },
      limit: 1,
    });
    assert.deepEqual(result.rows, [{ Stage: "Won", Count: 2 }]);
    assert.equal(result.rowCount, 1);
  });

  test("reverses the group order but leaves empty groups last", () => {
    const result = answer({
      groupBy: { fieldId: "f-closed", bucket: "month" },
      metrics: [count],
      sort: { by: "group", fieldId: null, direction: "desc" },
    });
    assert.deepEqual(
      result.rows.map((row) => row.Closed),
      ["2026-03", "2026-01", "(empty)"],
    );
  });

  test("caps what it returns at maxRows and says so", () => {
    const result = answer({}, { maxRows: 2 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rowCount, 4);
    assert.equal(result.truncated, true);
  });
});

describe("listing rows", () => {
  test("shows each cell as the grid shows it, in grid order", () => {
    const result = answer({});
    assert.deepEqual(
      result.fields.map((field) => field.name),
      fields.map((field) => field.name),
    );
    assert.deepEqual(result.rows[0], {
      Name: "Acme",
      Stage: "Won",
      Tags: "Urgent, Billing",
      Amount: 100,
      Closed: "2026-01-15",
      "Logged at": "2026-01-31T23:30:00Z",
      Done: "Yes",
      Notes: null,
      Account: "Acme Corp, (unknown)",
    });
    assert.equal(result.rows[3].Done, "No");
    assert.equal(result.rows[3].Stage, null);
  });

  test("sorts listed rows by a field with empty cells last either way", () => {
    const names = (direction: "asc" | "desc") =>
      answer({ sort: { by: "field", fieldId: "f-amount", direction }, limit: 3 }).rows.map(
        (row) => row.Name,
      );
    assert.deepEqual(names("desc"), ["Acme", "Globex", "Initech"]);
    assert.deepEqual(names("asc"), ["Initech", "Globex", "Acme"]);
  });

  test("never repeats a column name", () => {
    const result = answerBaseChartQuery({
      query: query({ groupBy: { fieldId: "f-count", bucket: null }, metrics: [count] }),
      fields: [{ id: "f-count", name: "Count", type: "number" }],
      records: [{ sortOrder: 1, data: { "f-count": 3 } }],
      labels: new Map(),
      timeZone: "UTC",
    });
    assert.deepEqual(
      result.fields.map((field) => field.name),
      ["Count", "Count (2)"],
    );
    assert.deepEqual(result.rows, [{ Count: "3", "Count (2)": 1 }]);
  });
});

describe("questions the engine refuses", () => {
  const problem = (patch: Partial<BaseChartQuery>) => baseChartQueryProblem(query(patch), fields);

  test("names the reason for each unanswerable query", () => {
    assert.equal(problem({}), null);
    assert.match(
      problem({ groupBy: { fieldId: "f-missing", bucket: null } }) ?? "",
      /groups by a field this table no longer has/,
    );
    assert.match(
      problem({ filters: [{ id: "r", fieldId: "f-missing", operator: "isEmpty" }] }) ?? "",
      /filter uses a field/,
    );
    assert.equal(
      problem({ metrics: [{ aggregate: "sum", fieldId: "f-name" }] }),
      'Sum needs a number field, and "Name" is a text field.',
    );
    assert.match(
      problem({ groupBy: { fieldId: "f-stage", bucket: "month" } }) ?? "",
      /Only a date field can be grouped by month/,
    );
    assert.match(problem({ groupBy: { fieldId: "f-notes", bucket: null } }) ?? "", /is long text/);
    assert.match(
      problem({ metrics: [count], sort: { by: "field", fieldId: "f-name", direction: "asc" } }) ??
        "",
      /applies only when the chart lists rows/,
    );
    assert.match(
      problem({ sort: { by: "metric", fieldId: null, direction: "desc" } }) ?? "",
      /sort by a field/,
    );
  });

  test("throws the reason instead of answering", () => {
    assert.throws(
      () => answer({ metrics: [{ aggregate: "avg", fieldId: "f-gone" }] }),
      (error: unknown) =>
        error instanceof BaseChartError && /no longer has/.test((error as Error).message),
    );
  });
});

describe("stored queries", () => {
  test("reads a stored query back and drops what it cannot read", () => {
    assert.equal(parseBaseChartQuery("not json"), null);
    assert.equal(normalizeBaseChartQuery({ filters: [] }), null);
    assert.deepEqual(
      normalizeBaseChartQuery({
        tableId: "t1",
        filters: [
          { id: "a", fieldId: "f1", operator: "is", value: "x" },
          { id: "b", fieldId: "f2", operator: "explode" },
        ],
        groupBy: { fieldId: "f3", bucket: "fortnight" },
        metrics: [{ aggregate: "count", fieldId: "f9" }, { aggregate: "median" }],
        sort: { by: "metric", direction: "sideways" },
        limit: 99999,
      }),
      {
        tableId: "t1",
        filters: [{ id: "a", fieldId: "f1", operator: "is", value: "x" }],
        groupBy: { fieldId: "f3", bucket: null },
        metrics: [{ aggregate: "count", fieldId: null }],
        sort: null,
        limit: 5000,
      },
    );
  });

  test("describes a query in words for an AI Employee", () => {
    assert.equal(
      describeBaseChartQuery(
        query({
          filters: [{ id: "r", fieldId: "f-stage", operator: "isNotEmpty" }],
          groupBy: { fieldId: "f-closed", bucket: "month" },
          metrics: [{ aggregate: "sum", fieldId: "f-amount" }],
          sort: { by: "metric", fieldId: null, direction: "desc" },
          limit: 10,
        }),
        fields,
      ),
      "Sum of Amount by Closed (month), filtered on Stage, largest first, first 10",
    );
    assert.equal(describeBaseChartQuery(query({}), fields), "Every row");
  });
});
