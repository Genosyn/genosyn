import type { ExploreFormula } from "./exploreFormula.js";

/**
 * A Dashboard link shows one Dashboard to anyone who holds it, made for a TV:
 * `/dashboards/<token>` opens full screen and reloads its cards on its own.
 * The server (`services/dashboardLinks.ts`) and the page share these shapes so
 * the two cannot drift.
 */

/** The page a link opens. The token follows it. */
export const DASHBOARD_LINK_PATH = "/dashboards";

/** 32 random bytes, base64url: the only credential a link carries. */
export const DASHBOARD_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** How often a screen showing a link reloads its cards, in seconds. */
export const DASHBOARD_LINK_REFRESH_CHOICES = [60, 300, 900, 3600] as const;
export type DashboardLinkRefreshSeconds = (typeof DASHBOARD_LINK_REFRESH_CHOICES)[number];
export const DEFAULT_DASHBOARD_LINK_REFRESH_SECONDS: DashboardLinkRefreshSeconds = 300;

export function isDashboardLinkRefresh(value: unknown): value is DashboardLinkRefreshSeconds {
  return (DASHBOARD_LINK_REFRESH_CHOICES as readonly unknown[]).includes(value);
}

/** A stored interval read back as one of the choices, whatever the row holds. */
export function dashboardLinkRefresh(value: unknown): DashboardLinkRefreshSeconds {
  return isDashboardLinkRefresh(value) ? value : DEFAULT_DASHBOARD_LINK_REFRESH_SECONDS;
}

/** "every minute", "every 5 minutes", "every hour". */
export function describeDashboardLinkRefresh(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

export type SharedDashboardVizType = "table" | "scalar" | "bar" | "line" | "area" | "pie";

/** Only the settings a chart draws with; anything else stored on a Chart stays home. */
export type SharedDashboardVizConfig = {
  dimension?: string;
  measures?: string[];
  measure?: string;
  stacked?: boolean;
  prefix?: string;
  suffix?: string;
  columns?: string[];
};

export type SharedDashboardChart = {
  id: string;
  title: string;
  vizType: SharedDashboardVizType;
  vizConfig: SharedDashboardVizConfig;
};

export type SharedDashboardCard = {
  id: string;
  chartId: string | null;
  formula: ExploreFormula | null;
  x: number;
  y: number;
  w: number;
  h: number;
  titleOverride: string;
};

/** What `GET /api/dashboards/<token>` answers: the layout, never a query. */
export type SharedDashboard = {
  companyName: string;
  title: string;
  description: string;
  refreshSeconds: DashboardLinkRefreshSeconds;
  cards: SharedDashboardCard[];
  charts: SharedDashboardChart[];
};

/** One chart's rows, as `GET /api/dashboards/<token>/charts/<chartId>/result` answers them. */
export type SharedDashboardChartResult = {
  fields: { name: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
};
