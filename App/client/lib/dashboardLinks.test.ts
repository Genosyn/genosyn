import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FIRST_RETRY_MS,
  RELOAD_AFTER_MS,
  chartsToRun,
  dashboardGridRows,
  dashboardLinkUrl,
  dashboardModel,
  dashboardScreenTheme,
  foldChartRefresh,
  pruneScreen,
  retryDelayMs,
  shouldReloadPage,
  type DashboardLinkState,
  type ScreenChart,
  type SharedDashboard,
} from "./dashboardLinks.js";
import { dashboardCardStates } from "./exploreDashboard.js";

const state = (values: Partial<DashboardLinkState> = {}): DashboardLinkState => ({
  enabled: true,
  restorable: false,
  url: "https://genosyn.example.com/dashboards/abc",
  path: "/dashboards/abc",
  publicUrlConfigured: true,
  enabledAt: "2026-11-08T12:00:00.000Z",
  enabledBy: { id: "u1", name: "Olive", member: true },
  refreshSeconds: 300,
  ...values,
});

const result = (value: number) => ({
  fields: [{ name: "total" }],
  rows: [{ total: value }],
  rowCount: 1,
  truncated: false,
});

const view: Pick<SharedDashboard, "cards" | "charts"> = {
  charts: [
    { id: "c-revenue", title: "Revenue", vizType: "scalar", vizConfig: { measure: "total" } },
    { id: "c-deals", title: "Deals", vizType: "table", vizConfig: {} },
  ],
  cards: [
    { id: "k1", chartId: "c-revenue", formula: null, x: 0, y: 0, w: 6, h: 3, titleOverride: "" },
    { id: "k2", chartId: "c-deals", formula: null, x: 6, y: 0, w: 6, h: 8, titleOverride: "" },
    { id: "k3", chartId: "c-revenue", formula: null, x: 0, y: 3, w: 3, h: 2, titleOverride: "Again" },
    {
      id: "k4",
      chartId: null,
      formula: { expression: "A * 2", inputs: [{ name: "A", cardId: "k1" }] },
      x: 3,
      y: 3,
      w: 3,
      h: 2,
      titleOverride: "Doubled",
    },
    { id: "k5", chartId: "c-gone", formula: null, x: 0, y: 5, w: 6, h: 3, titleOverride: "" },
  ],
};

describe("the link to hand out", () => {
  test("is the install's public URL once an operator set one", () => {
    assert.equal(
      dashboardLinkUrl(state(), "http://localhost:8471"),
      "https://genosyn.example.com/dashboards/abc",
    );
  });

  test("is the address the person sharing is using when no public URL is set", () => {
    assert.equal(
      dashboardLinkUrl(state({ publicUrlConfigured: false, url: "http://localhost:8471/x" }), "https://acme.example/"),
      "https://acme.example/dashboards/abc",
    );
  });

  test("is nothing while the link is off", () => {
    assert.equal(dashboardLinkUrl(state({ enabled: false, path: null, url: null }), "https://a"), null);
  });
});

describe("the TV grid", () => {
  test("has as many rows as the lowest card reaches", () => {
    assert.equal(dashboardGridRows(view.cards), 8);
    assert.equal(dashboardGridRows([]), 1);
    assert.equal(dashboardGridRows([{ y: 10, h: 4 }]), 14);
  });

  test("runs each chart once, skipping charts the layout no longer has", () => {
    assert.deepEqual(chartsToRun(view), ["c-revenue", "c-deals"]);
  });

  test("works out formula cards from the charts' answers as the App does", () => {
    const screen: Record<string, ScreenChart> = {
      "c-revenue": { state: { kind: "ok", result: result(21) }, updatedAt: 1, stale: false },
      "c-deals": { state: { kind: "running" }, updatedAt: null, stale: false },
    };
    const model = dashboardModel(view, screen);
    const states = dashboardCardStates(model.cards, model.charts, model.runs);
    const doubled = states.get("k4");
    assert.equal(doubled?.kind, "ok");
    assert.deepEqual(doubled?.kind === "ok" ? doubled.result.rows : null, [{ value: 42 }]);
    assert.equal(states.get("k2")?.kind, "running");
    assert.equal(states.get("k5")?.kind, "error");
  });
});

describe("refreshing a screen nobody watches", () => {
  test("keeps the last good answer, marked stale, when a refresh fails", () => {
    const good = foldChartRefresh(undefined, { ok: true, result: result(5) }, 1_000);
    assert.deepEqual(good, { state: { kind: "ok", result: result(5) }, updatedAt: 1_000, stale: false });
    const failed = foldChartRefresh(good, { ok: false, message: "down" }, 2_000);
    assert.deepEqual(failed, { ...good, stale: true });
    const recovered = foldChartRefresh(failed, { ok: true, result: result(6) }, 3_000);
    assert.equal(recovered.stale, false);
    assert.equal(recovered.updatedAt, 3_000);
  });

  test("says why when a chart never answered", () => {
    const failed = foldChartRefresh(undefined, { ok: false, message: "This chart could not be loaded." }, 1);
    assert.deepEqual(failed.state, { kind: "error", message: "This chart could not be loaded." });
  });

  test("retries soon, then backs off, never waiting past the refresh timer", () => {
    assert.equal(retryDelayMs(1, 300), FIRST_RETRY_MS);
    assert.equal(retryDelayMs(2, 300), FIRST_RETRY_MS * 2);
    assert.equal(retryDelayMs(3, 300), FIRST_RETRY_MS * 4);
    assert.equal(retryDelayMs(50, 300), 300_000);
    assert.equal(retryDelayMs(50, 60), 60_000);
    assert.equal(retryDelayMs(0, 60), FIRST_RETRY_MS);
  });

  test("reloads itself once a day, to pick up a new release", () => {
    assert.equal(shouldReloadPage(0, RELOAD_AFTER_MS - 1), false);
    assert.equal(shouldReloadPage(0, RELOAD_AFTER_MS), true);
  });

  test("forgets charts taken off the dashboard", () => {
    const kept = pruneScreen(
      {
        a: { state: { kind: "idle" }, updatedAt: null, stale: false },
        b: { state: { kind: "idle" }, updatedAt: null, stale: false },
      },
      ["b"],
    );
    assert.deepEqual(Object.keys(kept), ["b"]);
  });

  test("is dark unless the link asks for light", () => {
    assert.equal(dashboardScreenTheme(""), "dark");
    assert.equal(dashboardScreenTheme("?theme=light"), "light");
    assert.equal(dashboardScreenTheme("?theme=neon"), "dark");
  });
});
