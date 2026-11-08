import type {
  DashboardLinkRefreshSeconds,
  SharedDashboard,
  SharedDashboardChartResult,
} from "../../shared/dashboardLinks.js";
import type { DashboardCard, DashboardChart, DashboardRunState } from "./exploreDashboard.js";

export {
  DASHBOARD_LINK_REFRESH_CHOICES,
  describeDashboardLinkRefresh,
} from "../../shared/dashboardLinks.js";
export type {
  DashboardLinkRefreshSeconds,
  SharedDashboard,
  SharedDashboardChartResult,
} from "../../shared/dashboardLinks.js";

/**
 * The page a Dashboard link opens is meant to be left alone on a TV for weeks:
 * it fits the screen, reloads on a timer, rides out a dropped network without
 * blanking, and never needs a keyboard. These are its rules, kept apart from
 * the page so they can be tested.
 */

/** What owners and admins read of a Dashboard's link (`GET …/dashboards/:slug/link`). */
export type DashboardLinkState = {
  enabled: boolean;
  /** Off, but turning it on brings back the link it had. */
  restorable: boolean;
  url: string | null;
  path: string | null;
  publicUrlConfigured: boolean;
  enabledAt: string | null;
  enabledBy: { id: string; name: string; member: boolean } | null;
  refreshSeconds: DashboardLinkRefreshSeconds;
};

/**
 * The link to hand out. The install's public URL when an operator set one;
 * otherwise the address the person sharing is using right now, which is how
 * they reach the install and so, most likely, how the TV will too.
 */
export function dashboardLinkUrl(state: DashboardLinkState, currentOrigin: string): string | null {
  if (!state.enabled || !state.path) return null;
  if (state.publicUrlConfigured && state.url) return state.url;
  return `${currentOrigin.replace(/\/+$/, "")}${state.path}`;
}

/** Rows the TV grid needs so every card fits: the bottom edge of the lowest card. */
export function dashboardGridRows(cards: Pick<DashboardCard, "y" | "h">[]): number {
  let rows = 1;
  for (const card of cards) {
    const bottom = Math.max(0, Math.floor(card.y)) + Math.max(1, Math.floor(card.h));
    if (Number.isFinite(bottom)) rows = Math.max(rows, bottom);
  }
  return rows;
}

/** The first retry comes quickly; each after waits twice as long, never past the timer. */
export const FIRST_RETRY_MS = 15_000;

/** How long to wait before trying again after `failures` refreshes in a row went wrong. */
export function retryDelayMs(failures: number, refreshSeconds: number): number {
  const ceiling = Math.max(FIRST_RETRY_MS, refreshSeconds * 1000);
  const attempt = Math.max(1, Math.floor(failures));
  return Math.min(ceiling, FIRST_RETRY_MS * 2 ** Math.min(attempt - 1, 16));
}

/**
 * A page left open for days picks up the App's latest release by loading
 * itself again, once a day, and only straight after the server answered, so a
 * reload can never land a TV on a browser error page.
 */
export const RELOAD_AFTER_MS = 24 * 60 * 60 * 1000;

export function shouldReloadPage(openedAt: number, now: number): boolean {
  return now - openedAt >= RELOAD_AFTER_MS;
}

export type DashboardScreenTheme = "dark" | "light";

/** Dark unless the link asks for `?theme=light`: a TV is easier to read that way. */
export function dashboardScreenTheme(search: string): DashboardScreenTheme {
  return new URLSearchParams(search).get("theme") === "light" ? "light" : "dark";
}

/** One chart on the screen: what it last showed, and whether the latest refresh failed. */
export type ScreenChart = {
  state: DashboardRunState;
  /** When `state` last came back from the server. */
  updatedAt: number | null;
  /** The latest refresh failed; `state` is what the chart showed before it, if anything. */
  stale: boolean;
};

/**
 * Fold one chart's refresh into what the screen shows. A good answer replaces
 * whatever was there; a failure keeps the last good answer on screen, marked
 * stale, rather than blanking a card on a TV over one dropped request.
 */
export function foldChartRefresh(
  previous: ScreenChart | undefined,
  outcome: { ok: true; result: SharedDashboardChartResult } | { ok: false; message: string },
  now: number,
): ScreenChart {
  if (outcome.ok) {
    return { state: { kind: "ok", result: outcome.result }, updatedAt: now, stale: false };
  }
  if (previous?.state.kind === "ok") return { ...previous, stale: true };
  return { state: { kind: "error", message: outcome.message }, updatedAt: null, stale: true };
}

/** The charts the layout draws, each once, in the order its cards first name them. */
export function chartsToRun(view: Pick<SharedDashboard, "cards" | "charts">): string[] {
  const known = new Set(view.charts.map((chart) => chart.id));
  const ids: string[] = [];
  for (const card of view.cards) {
    if (card.chartId && known.has(card.chartId) && !ids.includes(card.chartId)) {
      ids.push(card.chartId);
    }
  }
  return ids;
}

/**
 * The shared layout in the shapes the App's own Dashboard rules take, so
 * formula cards are worked out exactly as they are in the App. A chart's id
 * stands in for the slug a shared chart does not carry.
 */
export function dashboardModel(
  view: Pick<SharedDashboard, "cards" | "charts">,
  screen: Record<string, ScreenChart>,
): {
  cards: DashboardCard[];
  charts: DashboardChart[];
  runs: Record<string, DashboardRunState>;
} {
  const runs: Record<string, DashboardRunState> = {};
  for (const [id, chart] of Object.entries(screen)) runs[id] = chart.state;
  return {
    cards: view.cards.map((card) => ({ ...card, dashboardId: "" })),
    charts: view.charts.map((chart) => ({ ...chart, slug: chart.id })),
    runs,
  };
}

/** Keep only the charts the layout still draws, so weeks of edits cannot pile up. */
export function pruneScreen(
  screen: Record<string, ScreenChart>,
  chartIds: string[],
): Record<string, ScreenChart> {
  const keep = new Set(chartIds);
  const next: Record<string, ScreenChart> = {};
  for (const [id, chart] of Object.entries(screen)) if (keep.has(id)) next[id] = chart;
  return next;
}

/** `10:42`, in the screen's own clock. */
export function formatClock(at: number | Date, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
