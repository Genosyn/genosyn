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

export type ExploreSchemaColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  position: number;
};

export type ExploreSchemaTable = {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: ExploreSchemaColumn[];
};

export type ExploreSchema = {
  provider: ExploreProvider;
  tables: ExploreSchemaTable[];
  truncated: boolean;
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
      const j = (await result.json()) as ClickhouseJsonRow[] | ClickhouseJsonResponse;
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
    throw new Error(`Connection provider "${connection.provider}" is not supported by Explore`);
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

// ----- Data browser -----

/**
 * One metadata statement per supported database. Aliases deliberately share
 * the same lowercase shape so the rows can flow through one normalizer.
 * Explore only exposes schemas visible to the Connection's database role.
 */
export function schemaSqlForProvider(provider: ExploreProvider): string {
  switch (provider) {
    case "postgres":
      return `SELECT
  c.table_schema AS schema_name,
  c.table_name AS table_name,
  t.table_type AS table_kind,
  c.column_name AS column_name,
  c.data_type AS data_type,
  c.is_nullable AS is_nullable,
  c.ordinal_position AS ordinal_position
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
  AND c.table_schema NOT LIKE 'pg_temp_%'
  AND c.table_schema NOT LIKE 'pg_toast_temp_%'
ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
    case "mysql":
      return `SELECT
  c.table_schema AS schema_name,
  c.table_name AS table_name,
  t.table_type AS table_kind,
  c.column_name AS column_name,
  c.column_type AS data_type,
  c.is_nullable AS is_nullable,
  c.ordinal_position AS ordinal_position
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = DATABASE()
ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
    case "clickhouse":
      return `SELECT
  c.database AS schema_name,
  c.table AS table_name,
  t.engine AS table_kind,
  c.name AS column_name,
  c.type AS data_type,
  startsWith(c.type, 'Nullable(') AS is_nullable,
  c.position AS ordinal_position
FROM system.columns c
LEFT JOIN system.tables t
  ON t.database = c.database AND t.name = c.table
WHERE c.database = currentDatabase()
ORDER BY c.database, c.table, c.position`;
  }
}

function schemaText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function schemaKind(raw: string): "table" | "view" {
  return /view/i.test(raw) ? "view" : "table";
}

function schemaNullable(raw: unknown): boolean {
  if (raw === true || raw === 1 || raw === "1") return true;
  return typeof raw === "string" && raw.toUpperCase() === "YES";
}

/**
 * Turn driver-normalized metadata rows into the compact tree consumed by the
 * editor. Malformed rows are ignored so one unusual system object cannot make
 * the whole data browser disappear.
 */
export function buildExploreSchema(
  provider: ExploreProvider,
  rows: Record<string, unknown>[],
  truncated = false,
): ExploreSchema {
  const tables = new Map<string, ExploreSchemaTable>();

  for (const row of rows) {
    const schema = schemaText(row, "schema_name");
    const name = schemaText(row, "table_name");
    const columnName = schemaText(row, "column_name");
    if (!schema || !name || !columnName) continue;

    const key = `${schema}\u0000${name}`;
    let table = tables.get(key);
    if (!table) {
      table = {
        schema,
        name,
        kind: schemaKind(schemaText(row, "table_kind")),
        columns: [],
      };
      tables.set(key, table);
    }

    const rawPosition = Number(row.ordinal_position);
    table.columns.push({
      name: columnName,
      dataType: schemaText(row, "data_type") || "unknown",
      nullable: schemaNullable(row.is_nullable),
      position:
        Number.isFinite(rawPosition) && rawPosition > 0 ? rawPosition : table.columns.length + 1,
    });
  }

  const ordered = [...tables.values()].sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
  );
  for (const table of ordered) {
    table.columns.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  return { provider, tables: ordered, truncated };
}

export async function loadExploreSchema(connection: IntegrationConnection): Promise<ExploreSchema> {
  if (!isExploreProvider(connection.provider)) {
    throw new Error(`Connection provider "${connection.provider}" is not supported by Explore`);
  }
  const result = await runSqlAgainstConnection(
    connection,
    schemaSqlForProvider(connection.provider),
    { maxRows: MAX_ROWS },
  );
  return buildExploreSchema(connection.provider, result.rows, result.truncated);
}

// ----- Slug helpers -----

export async function uniqueChartSlug(companyId: string, base: string): Promise<string> {
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

export async function uniqueDashboardSlug(companyId: string, base: string): Promise<string> {
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

export const VIZ_TYPES: ChartVizType[] = ["table", "scalar", "bar", "line", "area", "pie"];

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

export async function listDirectChartGrants(chartId: string): Promise<EmployeeChartGrant[]> {
  return AppDataSource.getRepository(EmployeeChartGrant).find({
    where: { chartId },
    order: { createdAt: "ASC" },
  });
}

export async function deleteGrantsForChart(chartId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeChartGrant).delete({ chartId });
}

export async function listAccessibleChartIds(employeeId: string): Promise<Set<string>> {
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
 * into the share modal. Idempotent (uses upsert). Its hire-time mirror is
 * `grantExploreToEmployee` below, added in M62 alongside the Resources one:
 * a company that built its dashboards before hiring used to give the new
 * employee nothing, and there was no symptom to notice.
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

export async function listAccessibleDashboardIds(employeeId: string): Promise<Set<string>> {
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

/**
 * Hand a newly-hired employee the company's existing Charts and Dashboards.
 *
 * The mirror of `grantChartToAllEmployees` / `grantDashboardToAllEmployees`,
 * and the sibling of `grantAllResourcesToEmployee`. It exists here rather than
 * only for Resources because the hire route fanning out one grant family and
 * not the two adjacent ones is exactly how the two paths drift apart again.
 *
 * Batched: a company with a real Explore section and a growing roster would
 * otherwise pay two queries per chart per hire.
 */
export async function grantExploreToEmployee(
  companyId: string,
  employeeId: string,
): Promise<{ charts: number; dashboards: number }> {
  const chartRepo = AppDataSource.getRepository(EmployeeChartGrant);
  const dashRepo = AppDataSource.getRepository(EmployeeDashboardGrant);

  const [charts, dashboards, heldCharts, heldDashboards] = await Promise.all([
    AppDataSource.getRepository(Chart).find({ where: { companyId }, select: ["id"] }),
    AppDataSource.getRepository(Dashboard).find({ where: { companyId }, select: ["id"] }),
    chartRepo.find({ where: { employeeId }, select: ["chartId"] }),
    dashRepo.find({ where: { employeeId }, select: ["dashboardId"] }),
  ]);

  const haveChart = new Set(heldCharts.map((g) => g.chartId));
  const haveDash = new Set(heldDashboards.map((g) => g.dashboardId));
  const missingCharts = charts.filter((c) => !haveChart.has(c.id));
  const missingDashboards = dashboards.filter((d) => !haveDash.has(d.id));

  if (missingCharts.length > 0) {
    await chartRepo.save(
      missingCharts.map((c) =>
        chartRepo.create({ employeeId, chartId: c.id, accessLevel: "read" }),
      ),
    );
  }
  if (missingDashboards.length > 0) {
    await dashRepo.save(
      missingDashboards.map((d) =>
        dashRepo.create({ employeeId, dashboardId: d.id, accessLevel: "read" }),
      ),
    );
  }
  return { charts: missingCharts.length, dashboards: missingDashboards.length };
}

/** Drop every Chart and Dashboard grant an employee holds. Called when it is
 *  fired, for the same reason the Resource grants are. */
export async function deleteExploreGrantsForEmployee(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeChartGrant).delete({ employeeId });
  await AppDataSource.getRepository(EmployeeDashboardGrant).delete({ employeeId });
}
