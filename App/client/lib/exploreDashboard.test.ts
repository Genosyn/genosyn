import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dashboardCardStates,
  formulaChartSlugs,
  type DashboardCard,
  type DashboardChart,
  type DashboardRunState,
} from "./exploreDashboard.js";

const charts: DashboardChart[] = [
  {
    id: "revenue",
    slug: "revenue",
    title: "Revenue",
    vizType: "scalar",
    vizConfig: { measure: "amount", prefix: "$" },
  },
  { id: "costs", slug: "costs", title: "Costs", vizType: "scalar", vizConfig: {} },
];

function card(id: string, formula: DashboardCard["formula"] = null): DashboardCard {
  return {
    id,
    chartId: formula ? null : id,
    formula,
    dashboardId: "board",
    titleOverride: "",
    x: 0,
    y: 0,
    w: 6,
    h: 3,
  };
}
const cards = [
  card("revenue"),
  card("costs"),
  card("profit", {
    expression: "A - B",
    inputs: [
      { name: "A", cardId: "revenue" },
      { name: "B", cardId: "costs" },
    ],
  }),
  card("margin", {
    expression: "A / B * 100",
    inputs: [
      { name: "A", cardId: "profit" },
      { name: "B", cardId: "revenue" },
    ],
    suffix: "%",
  }),
];
function ok(row: Record<string, unknown>): DashboardRunState {
  return {
    kind: "ok",
    result: {
      fields: Object.keys(row).map((name) => ({ name })),
      rows: [row],
      rowCount: 1,
      truncated: false,
    },
  };
}
function value(states: Map<string, DashboardRunState>, id: string): unknown {
  const state = states.get(id);
  assert.equal(state?.kind, "ok");
  return state?.kind === "ok" ? state.result.rows[0]?.value : undefined;
}

test("formulas use the Number card's selected raw measure and numeric string fallback", () => {
  const states = dashboardCardStates(cards, charts, {
    revenue: ok({ wrong: 99, amount: "1200.25" }),
    costs: ok({ label: "Costs", total: "300.25" }),
  });
  assert.equal(value(states, "profit"), 900);
  assert.equal(value(states, "margin"), (900 / 1200.25) * 100);
});

test("nested formulas wait during refresh and use the newly fetched input values", () => {
  const refreshing = dashboardCardStates(cards, charts, {
    revenue: { kind: "running" },
    costs: ok({ total: 300 }),
  });
  assert.equal(refreshing.get("profit")?.kind, "running");
  assert.equal(refreshing.get("margin")?.kind, "running");
  const states = dashboardCardStates(cards, charts, {
    revenue: ok({ amount: 1500 }),
    costs: ok({ total: 300 }),
  });
  assert.equal(value(states, "profit"), 1200);
  assert.equal(value(states, "margin"), 80);
  assert.deepEqual(formulaChartSlugs("margin", cards, charts), ["revenue", "costs"]);
});

test("null, blank, booleans, missing rows, failed queries and removed cards never become zero", () => {
  for (const raw of [null, "", "  ", false, undefined, "n/a", Infinity]) {
    const states = dashboardCardStates(cards, charts, {
      revenue: ok({ amount: raw }),
      costs: ok({ total: 3 }),
    });
    const state = states.get("profit");
    assert.equal(state?.kind, "error", String(raw));
    if (state?.kind === "error") assert.match(state.message, /no numeric value/);
  }
  const empty: DashboardRunState = {
    kind: "ok",
    result: { fields: [], rows: [], rowCount: 0, truncated: false },
  };
  assert.equal(
    dashboardCardStates(cards, charts, { revenue: empty, costs: ok({ total: 3 }) }).get("profit")
      ?.kind,
    "error",
  );
  const failed = dashboardCardStates(cards, charts, {
    revenue: { kind: "error", message: "Database offline" },
    costs: ok({ total: 3 }),
  }).get("profit");
  assert.equal(failed?.kind, "error");
  if (failed?.kind === "error") assert.match(failed.message, /Revenue: Database offline/);
  assert.equal(
    dashboardCardStates(
      cards.filter((c) => c.id !== "revenue"),
      charts,
      {},
    ).get("profit")?.kind,
    "error",
  );
});

test("zero is a valid input but dividing by it shows an error; charts must remain Number cards", () => {
  const states = dashboardCardStates(cards, charts, {
    revenue: ok({ amount: 0 }),
    costs: ok({ total: 3 }),
  });
  assert.equal(value(states, "profit"), -3);
  const margin = states.get("margin");
  assert.equal(margin?.kind, "error");
  if (margin?.kind === "error") assert.match(margin.message, /divide by zero/);
  const changedCharts = charts.map((chart) => ({ ...chart, vizType: "table" as const }));
  assert.equal(dashboardCardStates(cards, changedCharts, {}).get("profit")?.kind, "error");
});

test("cyclic formulas and invalid syntax show errors without crashing the dashboard", () => {
  const cycle = [
    card("a", { expression: "B", inputs: [{ name: "B", cardId: "b" }] }),
    card("b", { expression: "A", inputs: [{ name: "A", cardId: "a" }] }),
  ];
  assert.equal(dashboardCardStates(cycle, [], {}).get("a")?.kind, "error");
  assert.equal(dashboardCardStates(cycle, [], {}).get("b")?.kind, "error");
  assert.deepEqual(formulaChartSlugs("a", cycle, []), []);
  const invalid = [card("bad", { expression: "A +", inputs: [{ name: "A", cardId: "a" }] })];
  assert.equal(dashboardCardStates(invalid, [], {}).get("bad")?.kind, "error");
  assert.equal(
    value(
      dashboardCardStates([card("constant", { expression: "(10 + 5) * 2", inputs: [] })], [], {}),
      "constant",
    ),
    30,
  );
});

test("long chains fail only beyond the depth limit regardless of dashboard card order", () => {
  const chain = [card("revenue")];
  for (let index = 1; index <= 40; index += 1) {
    chain.push(
      card(`formula${index}`, {
        expression: "A",
        inputs: [{ name: "A", cardId: index === 1 ? "revenue" : `formula${index - 1}` }],
      }),
    );
  }
  for (const ordered of [chain, [...chain].reverse()]) {
    const states = dashboardCardStates(ordered, charts, { revenue: ok({ amount: 42 }) });
    for (let index = 1; index <= 40; index += 1) {
      if (index < 32) assert.equal(value(states, `formula${index}`), 42);
      else {
        const state = states.get(`formula${index}`);
        assert.equal(state?.kind, "error");
        if (state?.kind === "error") assert.match(state.message, /too many nested inputs/);
      }
    }
  }
});

test("shared duplicate bindings count as one graph edge and cycles isolate unrelated values", () => {
  const graph = [
    card("double", {
      expression: "A + B",
      inputs: [
        { name: "A", cardId: "revenue" },
        { name: "B", cardId: "revenue" },
      ],
    }),
    card("revenue"),
    card("cycle", {
      expression: "A",
      inputs: [{ name: "A", cardId: "cycle" }],
    }),
    card("dependent", {
      expression: "A",
      inputs: [{ name: "A", cardId: "cycle" }],
    }),
  ];
  const states = dashboardCardStates(graph, charts, { revenue: ok({ amount: 5 }) });
  assert.equal(value(states, "double"), 10);
  assert.equal(states.get("cycle")?.kind, "error");
  assert.equal(states.get("dependent")?.kind, "error");
});
