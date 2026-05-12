import pg from "pg";
import mysql from "mysql2/promise";
import { createClient as createClickhouseClient } from "@clickhouse/client";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Chart } from "../db/entities/Chart.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import {
  EmployeeChartGrant,
  CHART_ACCESS_RANK,
  type ChartAccessLevel,
} from "../db/entities/EmployeeChartGrant.js";
import {
  EmployeeDashboardGrant,
  type DashboardAccessLevel,
} from "../db/entities/EmployeeDashboardGrant.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { ChartVizType } from "../db/entities/Chart.js";
import { decryptSecret } from "../lib/secret.js";
import { toSlug } from "../lib/slug.js";

/**
 * Explore — Metabase-style analytics. Re-uses the company's existing
 * `IntegrationConnection` rows of provider `postgres` / `mysql` /
 * `clickhouse` as the data sources, so a Chart needs no separate auth.
 *
 * Single executor entry point is {@link runSqlAgainstConnection}; it
 * picks a driver based on the connection's provider, decrypts the
 * config, opens a fresh client, runs one statement, then closes the
 * client (same shape as the integration tool surface — no long-lived
 * pool, no app-wide credential cache). Hard caps mirror the integration
 * envelope: 30s wall clock, 5,000 rows.
 */

export const EXPLORE_PROVIDERS = ["postgres", "mysql", "clickhouse"] as const;
export type ExploreProvider = (typeof EXPLORE_PROVIDERS)[number];

const STATEMENT_TIMEOUT_MS = 30_000;
const MAX_ROWS = 5_000;
const DEFAULT_ROWS = 1_000;

export type QueryField = { name: string };
export type QueryResult = {
  fields: QueryField[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  /** Wall-clock milliseconds the executor spent in the driver. */
  elapsedMs: number;
};

export function isExploreProvider(p: string): p is ExploreProvider {
  return (EXPLORE_PROVIDERS as readonly string[]).includes(p);
}

function clampRows(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_ROWS;
  const i = Math.floor(v);
  if (i < 1) return 1;
  if (i > MAX_ROWS) return MAX_ROWS;
  return i;
}

function decryptConfig<T>(c: IntegrationConnection): T {
  return JSON.parse(decryptSecret(c.encryptedConfig)) as T;
}

/**
 * Coerce a row value into something `JSON.stringify` won't choke on. The
 * three drivers each return weird primitives — pg returns `Date`,
 * `bigint`, `Buffer`; mysql2 returns `Date` (or strings, with our flag),
 * and Buffers; ClickHouse returns native bigints for UInt64. JSON the
 * client renders is much simpler if we normalize once at the executor
 * boundary.
 */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalize(v);
  return out;
}

async function runPostgres(
  cfg: { connectionString?: string },
  sql: string,
  maxRows: number,
): Promise<QueryResult> {
  if (!cfg.connectionString) {
    throw new Error("Postgres connection missing connectionString in config");
  }
  const started = Date.now();
  const client = new pg.Client({
    connectionString: cfg.connectionString,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const r = await client.query(sql);
    const rows = (r.rows ?? []).map(normalizeRow);
    const truncated = rows.length > maxRows;
    return {
      fields: (r.fields ?? []).map((f) => ({ name: f.name })),
      rows: truncated ? rows.slice(0, maxRows) : rows,
      rowCount: r.rowCount ?? rows.length,
      truncated,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runMysql(
  cfg: { connectionString?: string },
  sql: string,
  maxRows: number,
): Promise<QueryResult> {
  if (!cfg.connectionString) {
    throw new Error("MySQL connection missing connectionString in config");
  }
  const started = Date.now();
  const conn = await mysql.createConnection({
    uri: cfg.connectionString,
    connectTimeout: 10_000,
    dateStrings: true,
  });
  try {
    await conn
      .query("SET SESSION MAX_EXECUTION_TIME = ?", [STATEMENT_TIMEOUT_MS])
      .catch(() => undefined);
    const [rowsRaw, fieldsRaw] = await conn.query(sql);
    if (Array.isArray(rowsRaw) && !Array.isArray(rowsRaw[0]) && fieldsRaw) {
      // SELECT-shape result
      const rows = (rowsRaw as Record<string, unknown>[]).map(normalizeRow);
      const fields = Array.isArray(fieldsRaw)
        ? fieldsRaw.map((f) => ({ name: (f as { name: string }).name }))
        : [];
      const truncated = rows.length > maxRows;
      return {
        fields,
        rows: truncated ? rows.slice(0, maxRows) : rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Date.now() - started,
      };
    }
    // DDL / DML — no row payload, fall back to OK-packet shape.
    const ok = rowsRaw as { affectedRows?: number };
    return {
      fields: [],
      rows: [],
      rowCount: ok?.affectedRows ?? 0,
      truncated: false,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function runClickhouse(
  cfg: {
    url?: string;
    username?: string;
    password?: string;
    database?: string;
  },
  sql: string,
  maxRows: number,
): Promise<QueryResult> {
  if (!cfg.url) {
    throw new Error("ClickHouse connection missing url in config");
  }
  const started = Date.now();
  const client = createClickhouseClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
    request_timeout: 60_000,
    clickhouse_settings: {
      max_execution_time: Math.ceil(STATEMENT_TIMEOUT_MS / 1000),
      max_result_rows: String(MAX_ROWS),
    },
  });
  try {
    const result = await client.query({ query: sql, format: "JSONEachRow" });
    type ClickhouseJsonField = { name: string; type?: string };
    type ClickhouseJsonRow = Record<string, unknown>;
    type ClickhouseJsonResponse = {
      data?: ClickhouseJsonRow[];
      meta?: ClickhouseJsonField[];
    };
    let rowsRaw: ClickhouseJsonRow[] = [];
    let meta: ClickhouseJsonField[] | undefined;
    try {
      const j = (await result.json()) as
        | ClickhouseJsonRow[]
        | ClickhouseJsonResponse;
      if (Array.isArray(j)) {
        rowsRaw = j;
      } else if (j && typeof j === "object") {
        rowsRaw = Array.isArray(j.data) ? j.data : [];
        meta = j.meta;
      }
    } catch {
      rowsRaw = [];
    }
    const rows = rowsRaw.map(normalizeRow);
    const truncated = rows.length > maxRows;
    const fields: QueryField[] =
      meta && meta.length > 0
        ? meta.map((m) => ({ name: m.name }))
        : rows.length > 0
          ? Object.keys(rows[0]).map((k) => ({ name: k }))
          : [];
    return {
      fields,
      rows: truncated ? rows.slice(0, maxRows) : rows,
      rowCount: rows.length,
      truncated,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Run one SQL statement against an explore-eligible IntegrationConnection.
 * `connection.companyId` is trusted as a security boundary — callers must
 * ensure they fetched the connection by `{ id, companyId }` first.
 */
export async function runSqlAgainstConnection(
  connection: IntegrationConnection,
  sql: string,
  opts: { maxRows?: number } = {},
): Promise<QueryResult> {
  if (!isExploreProvider(connection.provider)) {
    throw new Error(
      `Connection provider "${connection.provider}" is not supported by Explore`,
    );
  }
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("SQL is required");
  const maxRows = clampRows(opts.maxRows);

  switch (connection.provider) {
    case "postgres":
      return runPostgres(decryptConfig(connection), trimmed, maxRows);
    case "mysql":
      return runMysql(decryptConfig(connection), trimmed, maxRows);
    case "clickhouse":
      return runClickhouse(decryptConfig(connection), trimmed, maxRows);
    default:
      throw new Error(`Unsupported provider: ${connection.provider}`);
  }
}

// ----- Slug helpers -----

export async function uniqueChartSlug(
  companyId: string,
  base: string,
): Promise<string> {
  const repo = AppDataSource.getRepository(Chart);
  const root = toSlug(base) || "chart";
  let candidate = root;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const existing = await repo.findOneBy({ companyId, slug: candidate });
    if (!existing) return candidate;
    candidate = `${root}-${n++}`;
  }
}

export async function uniqueDashboardSlug(
  companyId: string,
  base: string,
): Promise<string> {
  const repo = AppDataSource.getRepository(Dashboard);
  const root = toSlug(base) || "dashboard";
  let candidate = root;
  let n = 2;
  for (;;) {
    const existing = await repo.findOneBy({ companyId, slug: candidate });
    if (!existing) return candidate;
    candidate = `${root}-${n++}`;
  }
}

// ----- Viz config -----

/**
 * Parse a Chart's `vizConfig` text column. Bad JSON or non-object payloads
 * silently fall back to `{}` so a corrupted row still renders as a table
 * instead of crashing the UI.
 */
export function parseVizConfig(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const VIZ_TYPES: ChartVizType[] = [
  "table",
  "scalar",
  "bar",
  "line",
  "area",
  "pie",
];

// ----- Serialization -----

export type ChartDTO = {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  description: string;
  connectionId: string;
  sql: string;
  vizType: ChartVizType;
  vizConfig: Record<string, unknown>;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeChart(c: Chart): ChartDTO {
  return {
    id: c.id,
    companyId: c.companyId,
    slug: c.slug,
    title: c.title,
    description: c.description,
    connectionId: c.connectionId,
    sql: c.sql,
    vizType: c.vizType,
    vizConfig: parseVizConfig(c.vizConfig),
    createdById: c.createdById,
    createdByEmployeeId: c.createdByEmployeeId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export type DashboardCardDTO = {
  id: string;
  dashboardId: string;
  chartId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  titleOverride: string;
};

export function serializeCard(c: DashboardCard): DashboardCardDTO {
  return {
    id: c.id,
    dashboardId: c.dashboardId,
    chartId: c.chartId,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    titleOverride: c.titleOverride,
  };
}

export type DashboardDTO = {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  description: string;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeDashboard(d: Dashboard): DashboardDTO {
  return {
    id: d.id,
    companyId: d.companyId,
    slug: d.slug,
    title: d.title,
    description: d.description,
    createdById: d.createdById,
    createdByEmployeeId: d.createdByEmployeeId,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ---------- Grant helpers ----------
//
// Charts and Dashboards each have a per-employee grant table that
// governs the MCP surface. Humans bypass these tables — they only
// gate what AI employees can see and do through `tools/...` calls.
//
// The two grant kinds have identical shapes, so the helpers are
// structurally parallel. They're kept separate (rather than parameterised
// over a union) because the entity name is what TypeORM uses to pick the
// table, and a thin wrapper is clearer than a generic over Repository.

export async function upsertChartGrant(
  employeeId: string,
  chartId: string,
  accessLevel: ChartAccessLevel,
): Promise<EmployeeChartGrant> {
  const repo = AppDataSource.getRepository(EmployeeChartGrant);
  const existing = await repo.findOneBy({ employeeId, chartId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  return repo.save(repo.create({ employeeId, chartId, accessLevel }));
}

export async function listDirectChartGrants(
  chartId: string,
): Promise<EmployeeChartGrant[]> {
  return AppDataSource.getRepository(EmployeeChartGrant).find({
    where: { chartId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForChart(chartId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeChartGrant).delete({ chartId });
}

export async function listAccessibleChartIds(
  employeeId: string,
): Promise<Set<string>> {
  const grants = await AppDataSource.getRepository(EmployeeChartGrant).find({
    where: { employeeId },
  });
  return new Set(grants.map((g) => g.chartId));
}

export async function hasChartAccess(
  employeeId: string,
  chartId: string,
  required: ChartAccessLevel,
): Promise<boolean> {
  const grant = await AppDataSource.getRepository(EmployeeChartGrant).findOneBy({
    employeeId,
    chartId,
  });
  if (!grant) return false;
  return CHART_ACCESS_RANK[grant.accessLevel] >= CHART_ACCESS_RANK[required];
}

/**
 * Grant `read` to every employee in the company on a freshly-created
 * Chart. Mirrors `grantResourceToAllEmployees` — without this a new
 * Chart would land invisible to every AI employee until a human walked
 * into the share modal. Idempotent (uses upsert) but does not retro-fit
 * employees hired after creation; humans re-share if they want a new
 * hire to see existing charts.
 */
export async function grantChartToAllEmployees(
  companyId: string,
  chartId: string,
): Promise<number> {
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: ["id"],
  });
  for (const e of emps) {
    await upsertChartGrant(e.id, chartId, "read");
  }
  return emps.length;
}

export async function upsertDashboardGrant(
  employeeId: string,
  dashboardId: string,
  accessLevel: DashboardAccessLevel,
): Promise<EmployeeDashboardGrant> {
  const repo = AppDataSource.getRepository(EmployeeDashboardGrant);
  const existing = await repo.findOneBy({ employeeId, dashboardId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  return repo.save(repo.create({ employeeId, dashboardId, accessLevel }));
}

export async function listDirectDashboardGrants(
  dashboardId: string,
): Promise<EmployeeDashboardGrant[]> {
  return AppDataSource.getRepository(EmployeeDashboardGrant).find({
    where: { dashboardId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForDashboard(dashboardId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeDashboardGrant).delete({
    dashboardId,
  });
}

export async function listAccessibleDashboardIds(
  employeeId: string,
): Promise<Set<string>> {
  const grants = await AppDataSource.getRepository(EmployeeDashboardGrant).find({
    where: { employeeId },
  });
  return new Set(grants.map((g) => g.dashboardId));
}

export async function hasDashboardAccess(
  employeeId: string,
  dashboardId: string,
  required: DashboardAccessLevel,
): Promise<boolean> {
  const grant = await AppDataSource.getRepository(EmployeeDashboardGrant).findOneBy({
    employeeId,
    dashboardId,
  });
  if (!grant) return false;
  return CHART_ACCESS_RANK[grant.accessLevel] >= CHART_ACCESS_RANK[required];
}

export async function grantDashboardToAllEmployees(
  companyId: string,
  dashboardId: string,
): Promise<number> {
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: ["id"],
  });
  for (const e of emps) {
    await upsertDashboardGrant(e.id, dashboardId, "read");
  }
  return emps.length;
}
