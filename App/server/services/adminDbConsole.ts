import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";

/**
 * Admin → Database. A raw query console over Genosyn's *own* application
 * database — the same `AppDataSource` the app runs on — for master admins who
 * need to inspect or repair the install directly. Distinct from Explore, which
 * runs SQL against a company's external `IntegrationConnection` data sources.
 *
 * Cross-driver: introspection + execution both branch on `config.db.driver`
 * ("sqlite" via better-sqlite3, or "postgres"). Placeholder syntax differs per
 * driver, so every statement here inlines safely-quoted identifiers rather than
 * binding parameters.
 *
 * Safety: this is gated to master admins by the router, and defaults to
 * read-only. A statement that isn't clearly a read is refused unless the caller
 * passes `allowWrite`, so a stray `DROP TABLE` can't run without the operator
 * flipping the "Allow writes" switch first.
 */

const DEFAULT_ROWS = 1_000;
const MAX_ROWS = 5_000;

export type DbDriver = "sqlite" | "postgres";

export type DbColumn = {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
};

export type DbTable = {
  name: string;
  columns: DbColumn[];
  /** Best-effort exact row count; null if the count query failed. */
  rowCount: number | null;
};

export type DbSchema = {
  driver: DbDriver;
  tables: DbTable[];
};

export type AdminQueryResult = {
  /** Whether the statement was classified as a read or a data-modifying write. */
  kind: "read" | "write";
  columns: string[];
  rows: Record<string, unknown>[];
  /** Total rows the statement produced (before the display cap). */
  rowCount: number;
  /** Rows changed, when the driver reports it for a write; null otherwise. */
  affectedRows: number | null;
  /** True when more rows existed than the display cap and `rows` was sliced. */
  truncated: boolean;
  /** Wall-clock milliseconds spent inside the driver. */
  elapsedMs: number;
};

/** A user-facing error (bad SQL, blocked write) the route maps to 400. */
export class AdminQueryError extends Error {
  code: string;
  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "AdminQueryError";
    this.code = code;
  }
}

function driver(): DbDriver {
  return config.db.driver === "postgres" ? "postgres" : "sqlite";
}

/** Double-quote an identifier, escaping any embedded quotes. Works for both
 *  SQLite and Postgres, and neutralises odd names / reserved words. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function clampRows(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_ROWS;
  const i = Math.floor(v);
  if (i < 1) return 1;
  if (i > MAX_ROWS) return MAX_ROWS;
  return i;
}

// ───────────────────────────── value normalization ──────────────────────────

/**
 * Coerce a driver value into something `JSON.stringify` won't choke on:
 * bigint → string, Date → ISO, Buffer → base64. Mirrors the Explore executor
 * so the client renders one consistent JSON shape regardless of driver.
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

// ─────────────────────────── statement classification ───────────────────────

/** Statement leaders that only ever read. Anything else is treated as a write
 *  and requires `allowWrite`. */
const READ_LEADERS = new Set([
  "select",
  "with",
  "pragma",
  "explain",
  "show",
  "values",
  "table",
  "describe",
  "desc",
]);

/** Strip leading `--` line comments and `/* *\/` block comments so the first
 *  real keyword can be read. */
function stripLeadingComments(sql: string): string {
  let s = sql.trim();
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      if (nl === -1) return "";
      s = s.slice(nl + 1).trim();
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end === -1) return "";
      s = s.slice(end + 2).trim();
      continue;
    }
    return s;
  }
}

export function classifyStatement(sql: string): "read" | "write" {
  const s = stripLeadingComments(sql).toLowerCase();
  const m = s.match(/^[a-z]+/);
  if (!m) return "write";
  const kw = m[0];
  if (!READ_LEADERS.has(kw)) return "write";
  // A `WITH` CTE can wrap a data-modifying statement on Postgres
  // (`WITH x AS (...) DELETE ...`). Be conservative and treat any such
  // statement as a write.
  if (kw === "with" && /\b(insert|update|delete|merge)\b/.test(s)) return "write";
  return "read";
}

// ─────────────────────────────── introspection ──────────────────────────────

type SqlitePragmaColumn = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

async function getSqliteSchema(): Promise<DbSchema> {
  const tableRows = (await AppDataSource.query(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )) as { name: string }[];

  const tables: DbTable[] = [];
  for (const { name } of tableRows) {
    const ident = quoteIdent(name);
    const cols = (await AppDataSource.query(
      `PRAGMA table_info(${ident})`,
    )) as SqlitePragmaColumn[];
    const columns: DbColumn[] = cols.map((c) => ({
      name: c.name,
      type: (c.type || "").toLowerCase(),
      nullable: c.notnull === 0,
      pk: c.pk > 0,
    }));
    tables.push({ name, columns, rowCount: await countRows(ident) });
  }
  return { driver: "sqlite", tables };
}

async function getPostgresSchema(): Promise<DbSchema> {
  const tableRows = (await AppDataSource.query(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  )) as { name: string }[];

  const colRows = (await AppDataSource.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`,
  )) as {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }[];

  const pkRows = (await AppDataSource.query(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`,
  )) as { table_name: string; column_name: string }[];

  const pkSet = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`));
  const byTable = new Map<string, DbColumn[]>();
  for (const c of colRows) {
    const arr = byTable.get(c.table_name) ?? [];
    arr.push({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === "YES",
      pk: pkSet.has(`${c.table_name}.${c.column_name}`),
    });
    byTable.set(c.table_name, arr);
  }

  const tables: DbTable[] = [];
  for (const { name } of tableRows) {
    tables.push({
      name,
      columns: byTable.get(name) ?? [],
      rowCount: await countRows(quoteIdent(name)),
    });
  }
  return { driver: "postgres", tables };
}

async function countRows(quotedIdent: string): Promise<number | null> {
  try {
    const r = (await AppDataSource.query(
      `SELECT COUNT(*) AS c FROM ${quotedIdent}`,
    )) as { c: number | string | bigint }[];
    const raw = r[0]?.c ?? 0;
    return Number(raw);
  } catch {
    return null;
  }
}

export async function getDbSchema(): Promise<DbSchema> {
  return driver() === "postgres" ? getPostgresSchema() : getSqliteSchema();
}

// ──────────────────────────────── execution ─────────────────────────────────

export async function runAdminQuery(
  sql: string,
  opts: { allowWrite?: boolean; maxRows?: number } = {},
): Promise<AdminQueryResult> {
  const trimmed = sql.trim();
  if (!trimmed) throw new AdminQueryError("SQL is required.");

  const kind = classifyStatement(trimmed);
  if (kind === "write" && !opts.allowWrite) {
    throw new AdminQueryError(
      'This looks like a statement that modifies data. Turn on "Allow writes" to run it.',
      "write_blocked",
    );
  }

  const cap = clampRows(opts.maxRows);
  const started = Date.now();
  const raw = await AppDataSource.query(trimmed);
  const elapsedMs = Date.now() - started;

  // SELECT-shape results come back as an array of row objects. Non-query
  // statements return a driver-specific summary (better-sqlite3:
  // `{ changes, lastInsertRowid }`; Postgres: `[]`).
  let rows: Record<string, unknown>[] = [];
  let affectedRows: number | null = null;
  if (Array.isArray(raw)) {
    rows = raw.map((r) =>
      r && typeof r === "object" && !Array.isArray(r)
        ? normalizeRow(r as Record<string, unknown>)
        : { value: normalize(r) },
    );
  } else if (raw && typeof raw === "object" && "changes" in raw) {
    const n = (raw as { changes?: unknown }).changes;
    affectedRows = typeof n === "number" ? n : null;
  }

  const truncated = rows.length > cap;
  const capped = truncated ? rows.slice(0, cap) : rows;
  const columns = capped.length > 0 ? Object.keys(capped[0]) : [];

  return {
    kind,
    columns,
    rows: capped,
    rowCount: rows.length,
    affectedRows,
    truncated,
    elapsedMs,
  };
}
