import crypto from "node:crypto";
import { In } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import {
  DASHBOARD_LINK_PATH,
  DASHBOARD_LINK_TOKEN,
  dashboardLinkRefresh,
  type DashboardLinkRefreshSeconds,
  type SharedDashboard,
  type SharedDashboardCard,
  type SharedDashboardChart,
  type SharedDashboardChartResult,
  type SharedDashboardVizConfig,
} from "../../shared/dashboardLinks.js";
import { recordAudit } from "./audit.js";
import { parseVizConfig, type QueryResult } from "./explore.js";
import { runChart } from "./exploreCharts.js";
import { parseDashboardFormula } from "./exploreDashboardCards.js";
import type { ProjectActor } from "./projects.js";
import { getPublicUrl, isPublicUrlConfigured } from "./publicUrl.js";

/**
 * A Dashboard link: one unguessable URL that shows one Dashboard to whoever
 * holds it, with no account, made to be left open on a TV.
 *
 * - **Owners and admins share, from a browser.** Turning a link on, resetting
 *   it and turning it off are theirs alone (the routes in `routes/explore.ts`),
 *   and no API key, connected app or AI tool reads or writes one: the link is a
 *   bearer credential that publishes company data outside the company.
 * - **The token is the credential.** It is kept as a SHA-256 hash for lookup
 *   and encrypted to the company so an owner or admin can copy it again.
 *   Turning the link off keeps it, so turning it on again restores the same
 *   URL on every screen; only a reset replaces it, ending the old one for good.
 * - **It shows what its sharer may see.** The link answers as the owner or
 *   admin who turned it on or last reset it, read again on every view, and
 *   stops answering once they are no longer a Member of the company.
 * - **It shows the Dashboard and nothing else.** The layout answers each
 *   card's place, title and formula and each chart's visualization — never a
 *   query, a Connection, a Base, who made it or another Dashboard — and a
 *   chart's rows only for a Chart on this Dashboard, cut to the columns its
 *   visualization names. A chart that fails says so in fixed words, so a
 *   database's own error never reaches a stranger.
 * - **Many screens cost one query.** A chart's answer is kept for
 *   {@link RESULT_TTL_MS} and shared by every screen showing the link, so a
 *   wall of TVs, or anyone hammering the URL, reaches the company's database
 *   at most once per chart in that time.
 */

export class DashboardLinkNotFoundError extends Error {
  constructor() {
    super("This dashboard link is invalid or turned off.");
  }
}

/** A chart on a shared Dashboard that could not answer. Its words are fixed. */
export class SharedChartUnavailableError extends Error {
  constructor() {
    super("This chart could not be loaded.");
  }
}

export function generateDashboardLinkToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashDashboardLinkToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Owners and admins
// ---------------------------------------------------------------------------

/** What owners and admins see of a Dashboard's link. */
export type DashboardLinkState = {
  enabled: boolean;
  /** Off, but turning it on brings back the link it had, on every screen that kept it. */
  restorable: boolean;
  /** The link as the install's public URL writes it; null while it is off. */
  url: string | null;
  /** The same link without its origin, `/dashboards/<token>`; null while it is off. */
  path: string | null;
  publicUrlConfigured: boolean;
  enabledAt: string | null;
  /**
   * Who the link answers as. `member: false` means they have left the
   * company, so the link shows nothing until an owner or admin turns it on as
   * themselves.
   */
  enabledBy: { id: string; name: string; member: boolean } | null;
  refreshSeconds: DashboardLinkRefreshSeconds;
};

/** The stored token, or null when there is none or it no longer matches its hash. */
function readToken(dashboard: Dashboard): string | null {
  if (!dashboard.linkTokenEncrypted || !dashboard.linkTokenHash) return null;
  try {
    const token = decryptSecret(dashboard.linkTokenEncrypted);
    if (!DASHBOARD_LINK_TOKEN.test(token)) return null;
    return hashDashboardLinkToken(token) === dashboard.linkTokenHash ? token : null;
  } catch {
    // A damaged credential fails closed. Resetting the link repairs it.
    return null;
  }
}

function issueToken(dashboard: Dashboard): void {
  const token = generateDashboardLinkToken();
  dashboard.linkTokenHash = hashDashboardLinkToken(token);
  dashboard.linkTokenEncrypted = encryptSecret(token, `company:${dashboard.companyId}`);
}

export async function dashboardLinkState(dashboard: Dashboard): Promise<DashboardLinkState> {
  const enabled = dashboard.linkEnabledAt !== null;
  const token = enabled ? readToken(dashboard) : null;
  const path = token ? `${DASHBOARD_LINK_PATH}/${token}` : null;
  let enabledBy: DashboardLinkState["enabledBy"] = null;
  if (enabled && !dashboard.linkEnabledById) {
    // Their account was deleted, which takes them out of every company.
    enabledBy = { id: "", name: "A former Member", member: false };
  } else if (enabled && dashboard.linkEnabledById) {
    const [user, membership] = await Promise.all([
      AppDataSource.getRepository(User).findOneBy({ id: dashboard.linkEnabledById }),
      AppDataSource.getRepository(Membership).findOneBy({
        companyId: dashboard.companyId,
        userId: dashboard.linkEnabledById,
      }),
    ]);
    enabledBy = {
      id: dashboard.linkEnabledById,
      name: user?.name || user?.email || "A former Member",
      member: membership !== null,
    };
  }
  return {
    enabled,
    restorable: !enabled && readToken(dashboard) !== null,
    url: path ? `${getPublicUrl()}${path}` : null,
    path,
    publicUrlConfigured: isPublicUrlConfigured(),
    enabledAt: dashboard.linkEnabledAt?.toISOString() ?? null,
    enabledBy,
    refreshSeconds: dashboardLinkRefresh(dashboard.linkRefreshSeconds),
  };
}

type Actor = { userId: string };

async function saveDashboard(dashboard: Dashboard): Promise<void> {
  await AppDataSource.getRepository(Dashboard).save(dashboard);
}

/**
 * Turn the link on, answering as `actor` from now on. On an existing link
 * this keeps its URL, so it is also how an owner or admin keeps a screen
 * working after the person who shared it has left.
 */
export async function enableDashboardLink(
  dashboard: Dashboard,
  actor: Actor,
): Promise<DashboardLinkState> {
  const wasEnabled = dashboard.linkEnabledAt !== null;
  const previousSharer = dashboard.linkEnabledById;
  const tokenReadable = readToken(dashboard) !== null;
  if (wasEnabled && tokenReadable && previousSharer === actor.userId) {
    return dashboardLinkState(dashboard);
  }
  if (!tokenReadable) issueToken(dashboard);
  if (!wasEnabled) dashboard.linkEnabledAt = new Date();
  dashboard.linkEnabledById = actor.userId;
  await saveDashboard(dashboard);
  if (!wasEnabled || previousSharer !== actor.userId) {
    await recordAudit({
      companyId: dashboard.companyId,
      actorUserId: actor.userId,
      action: "dashboard.link.enable",
      targetType: "dashboard",
      targetId: dashboard.id,
      targetLabel: dashboard.title,
      metadata: {
        refreshSeconds: dashboardLinkRefresh(dashboard.linkRefreshSeconds),
        ...(wasEnabled ? { sharedAgain: true } : {}),
      },
    });
  }
  return dashboardLinkState(dashboard);
}

/** Replace the token: every screen on the old URL stops at once. */
export async function rotateDashboardLink(
  dashboard: Dashboard,
  actor: Actor,
): Promise<DashboardLinkState> {
  issueToken(dashboard);
  if (dashboard.linkEnabledAt) dashboard.linkEnabledById = actor.userId;
  await saveDashboard(dashboard);
  await recordAudit({
    companyId: dashboard.companyId,
    actorUserId: actor.userId,
    action: "dashboard.link.rotate",
    targetType: "dashboard",
    targetId: dashboard.id,
    targetLabel: dashboard.title,
  });
  return dashboardLinkState(dashboard);
}

/** Stop the link answering. The token stays, so turning it on restores the URL. */
export async function disableDashboardLink(
  dashboard: Dashboard,
  actor: Actor,
): Promise<DashboardLinkState> {
  if (dashboard.linkEnabledAt !== null) {
    dashboard.linkEnabledAt = null;
    dashboard.linkEnabledById = null;
    await saveDashboard(dashboard);
    await recordAudit({
      companyId: dashboard.companyId,
      actorUserId: actor.userId,
      action: "dashboard.link.disable",
      targetType: "dashboard",
      targetId: dashboard.id,
      targetLabel: dashboard.title,
    });
  }
  return dashboardLinkState(dashboard);
}

export async function setDashboardLinkRefresh(
  dashboard: Dashboard,
  refreshSeconds: DashboardLinkRefreshSeconds,
  actor: Actor,
): Promise<DashboardLinkState> {
  if (dashboard.linkRefreshSeconds !== refreshSeconds) {
    dashboard.linkRefreshSeconds = refreshSeconds;
    await saveDashboard(dashboard);
    await recordAudit({
      companyId: dashboard.companyId,
      actorUserId: actor.userId,
      action: "dashboard.link.update",
      targetType: "dashboard",
      targetId: dashboard.id,
      targetLabel: dashboard.title,
      metadata: { refreshSeconds },
    });
  }
  return dashboardLinkState(dashboard);
}

// ---------------------------------------------------------------------------
// Whoever holds the link
// ---------------------------------------------------------------------------

export type DashboardLinkContext = {
  dashboard: Dashboard;
  company: Company;
  /** The sharer, whose access decides what a Base chart's labels show. */
  viewer: ProjectActor;
};

/**
 * The Dashboard a token opens, or null for a token that never was, a link
 * that is off, and a sharer who has left — one answer for all three.
 */
export async function resolveDashboardLink(token: string): Promise<DashboardLinkContext | null> {
  if (!DASHBOARD_LINK_TOKEN.test(token)) return null;
  const dashboard = await AppDataSource.getRepository(Dashboard).findOneBy({
    linkTokenHash: hashDashboardLinkToken(token),
  });
  if (!dashboard?.linkEnabledAt || !dashboard.linkEnabledById) return null;
  const [company, membership] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: dashboard.companyId }),
    AppDataSource.getRepository(Membership).findOneBy({
      companyId: dashboard.companyId,
      userId: dashboard.linkEnabledById,
    }),
  ]);
  if (!company || !membership) return null;
  return {
    dashboard,
    company,
    viewer: { kind: "user", id: membership.userId, role: membership.role },
  };
}

/**
 * Whether a token belongs to any Dashboard, on or off, so a guess and a link
 * someone turned off can be told apart in the throttle without telling them
 * apart in the answer.
 */
export async function dashboardLinkTokenExists(token: string): Promise<boolean> {
  if (!DASHBOARD_LINK_TOKEN.test(token)) return false;
  return (
    (await AppDataSource.getRepository(Dashboard).countBy({
      linkTokenHash: hashDashboardLinkToken(token),
    })) > 0
  );
}

const VIZ_TYPES = new Set(["table", "scalar", "bar", "line", "area", "pie"]);
const MAX_VIZ_TEXT = 200;
const MAX_VIZ_COLUMNS = 64;

function vizText(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_VIZ_TEXT ? value : undefined;
}

function vizColumns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns = value.filter(
    (column): column is string => typeof column === "string" && column.length <= MAX_VIZ_TEXT,
  );
  return columns.slice(0, MAX_VIZ_COLUMNS);
}

/** The settings a chart draws with, field by field. Anything else stays home. */
export function sharedVizConfig(raw: string): SharedDashboardVizConfig {
  const stored = parseVizConfig(raw);
  const out: SharedDashboardVizConfig = {};
  const dimension = vizText(stored.dimension);
  const measure = vizText(stored.measure);
  const prefix = vizText(stored.prefix);
  const suffix = vizText(stored.suffix);
  const measures = vizColumns(stored.measures);
  const columns = vizColumns(stored.columns);
  if (dimension !== undefined) out.dimension = dimension;
  if (measure !== undefined) out.measure = measure;
  if (prefix !== undefined) out.prefix = prefix;
  if (suffix !== undefined) out.suffix = suffix;
  if (measures !== undefined) out.measures = measures;
  if (columns !== undefined) out.columns = columns;
  if (typeof stored.stacked === "boolean") out.stacked = stored.stacked;
  return out;
}

export async function sharedDashboardView(context: DashboardLinkContext): Promise<SharedDashboard> {
  const { dashboard, company } = context;
  const cards = await AppDataSource.getRepository(DashboardCard).find({
    where: { dashboardId: dashboard.id },
    order: { y: "ASC", x: "ASC" },
  });
  const chartIds = [...new Set(cards.flatMap((card) => (card.chartId ? [card.chartId] : [])))];
  const charts = chartIds.length
    ? await AppDataSource.getRepository(Chart).find({
        where: { id: In(chartIds), companyId: dashboard.companyId },
      })
    : [];
  const chartIdsHere = new Set(charts.map((chart) => chart.id));
  const sharedCards: SharedDashboardCard[] = [];
  for (const card of cards) {
    const formula = card.chartId ? null : parseDashboardFormula(card.formulaJson);
    if (card.chartId ? !chartIdsHere.has(card.chartId) : !formula) continue;
    sharedCards.push({
      id: card.id,
      chartId: card.chartId,
      formula,
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      titleOverride: card.titleOverride,
    });
  }
  const sharedCharts: SharedDashboardChart[] = charts.map((chart) => ({
    id: chart.id,
    title: chart.title,
    vizType: (VIZ_TYPES.has(chart.vizType) ? chart.vizType : "table") as SharedDashboardChart["vizType"],
    vizConfig: sharedVizConfig(chart.vizConfig),
  }));
  return {
    companyName: company.name,
    title: dashboard.title,
    description: dashboard.description,
    refreshSeconds: dashboardLinkRefresh(dashboard.linkRefreshSeconds),
    cards: sharedCards,
    charts: sharedCharts,
  };
}

/**
 * The columns a chart draws, when its settings name every one of them;
 * otherwise null, and the chart picks from all of them as it does in the App.
 */
export function drawnColumns(
  vizType: string,
  config: SharedDashboardVizConfig,
  available: string[],
): string[] | null {
  const has = (name: string | undefined): name is string =>
    typeof name === "string" && available.includes(name);
  const named = (list: string[] | undefined) => (list ?? []).filter(has);
  if (vizType === "table") {
    const columns = named(config.columns);
    return columns.length > 0 ? columns : null;
  }
  if (vizType === "scalar") return has(config.measure) ? [config.measure] : null;
  if (!has(config.dimension)) return null;
  const measures =
    config.measures && config.measures.length > 0
      ? named(config.measures)
      : has(config.measure)
        ? [config.measure]
        : [];
  if (measures.length === 0) return null;
  return [...new Set([config.dimension, ...measures])];
}

export function sharedChartResult(
  vizType: string,
  config: SharedDashboardVizConfig,
  result: QueryResult,
): SharedDashboardChartResult {
  const available = result.fields.map((field) => field.name);
  const keep = drawnColumns(vizType, config, available);
  if (!keep) {
    return {
      fields: result.fields.map((field) => ({ name: field.name })),
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
    };
  }
  return {
    fields: keep.map((name) => ({ name })),
    rows: result.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const name of keep) if (Object.hasOwn(row, name)) out[name] = row[name];
      return out;
    }),
    rowCount: result.rowCount,
    truncated: result.truncated,
  };
}

/** How long one chart's answer serves every screen showing the link. */
export const RESULT_TTL_MS = 30_000;
const RESULT_CACHE_CAP = 1_000;

type Outcome = { ok: true; result: SharedDashboardChartResult } | { ok: false };
type CacheEntry = { promise: Promise<Outcome>; settledAt: number | null };
const results = new Map<string, CacheEntry>();

/** Isolate tests from answers kept by an earlier one. */
export function resetSharedChartCacheForTests(): void {
  results.clear();
}

function fresh(entry: CacheEntry, now: number): boolean {
  return entry.settledAt === null || now - entry.settledAt < RESULT_TTL_MS;
}

function keep(key: string, entry: CacheEntry): void {
  const now = Date.now();
  if (results.size >= RESULT_CACHE_CAP) {
    for (const [candidate, kept] of results) {
      if (!fresh(kept, now)) results.delete(candidate);
    }
    // Still full of answers in use: let the oldest go rather than grow.
    if (results.size >= RESULT_CACHE_CAP) {
      const oldest = results.keys().next().value as string | undefined;
      if (oldest) results.delete(oldest);
    }
  }
  results.set(key, entry);
}

/**
 * One chart's rows for a screen showing the link. Only a Chart on this
 * Dashboard answers; any other id is the same not-found as a bad token.
 */
export async function sharedDashboardChart(
  context: DashboardLinkContext,
  chartId: string,
): Promise<SharedDashboardChartResult> {
  const { dashboard, viewer } = context;
  const onDashboard = await AppDataSource.getRepository(DashboardCard).existsBy({
    dashboardId: dashboard.id,
    chartId,
  });
  if (!onDashboard) throw new DashboardLinkNotFoundError();
  const chart = await AppDataSource.getRepository(Chart).findOneBy({
    id: chartId,
    companyId: dashboard.companyId,
  });
  if (!chart) throw new DashboardLinkNotFoundError();

  // An edit to the Chart, or a different sharer, is a different answer.
  const key = `${chart.id}:${chart.updatedAt.getTime()}:${viewer.kind}:${viewer.id}`;
  const now = Date.now();
  let entry = results.get(key);
  if (!entry || !fresh(entry, now)) {
    const created: CacheEntry = { settledAt: null, promise: Promise.resolve({ ok: false }) };
    created.promise = runChart(chart, { viewer })
      .then(
        (result): Outcome => ({
          ok: true,
          result: sharedChartResult(chart.vizType, sharedVizConfig(chart.vizConfig), result),
        }),
        (): Outcome => ({ ok: false }),
      )
      .finally(() => {
        created.settledAt = Date.now();
      });
    entry = created;
    keep(key, entry);
  }
  const outcome = await entry.promise;
  if (!outcome.ok) throw new SharedChartUnavailableError();
  return outcome.result;
}
