import pg from "pg";
import type { IntegrationProvider } from "../types.js";

/**
 * Postgres — connection-string integration. Users paste a libpq URI; we
 * connect once on create to validate, and once per tool call after that
 * (TypeORM owns the long-lived app pool, but per-Connection user keys live
 * here and are short-lived so we keep things simple).
 *
 * Safety: tool calls run with `statement_timeout = 30s` and result rows are
 * capped at the caller-specified limit (max 5000). For destructive work,
 * users should connect with a least-privileged role — the integration does
 * not enforce read-only.
 */

const { Client } = pg;

type PostgresConfig = {
  connectionString: string;
  /** Captured on validate so the UI can show a useful hint without keeping
   * the password around. */
  serverVersion?: string;
  databaseName?: string;
};

/** Wall-clock cap per tool call. Postgres `statement_timeout` is in ms. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Hard ceiling on rows returned to the caller. */
const MAX_ROWS = 5_000;
const DEFAULT_ROWS = 1_000;

function parseDatabaseFromUri(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    const path = u.pathname.replace(/^\/+/, "");
    return path || undefined;
  } catch {
    return undefined;
  }
}

function safeHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || uri;
  } catch {
    return uri;
  }
}

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function mustStr(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

export const postgresProvider: IntegrationProvider = {
  catalog: {
    provider: "postgres",
    name: "Postgres",
    category: "Databases",
    tagline: "Schemas, tables, queries.",
    description:
      "Connect a PostgreSQL database so AI employees can list schemas and tables, describe columns, and run queries. Use a read-only role unless you explicitly want write access — the integration does not enforce one.",
    icon: "Database",
    authMode: "apikey",
    fields: [
      {
        key: "connectionString",
        label: "Connection string",
        type: "password",
        placeholder: "postgres://user:pass@host:5432/db",
        required: true,
        hint: "Standard libpq URI. Append ?sslmode=require for managed databases (Neon, Supabase, RDS).",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_schemas",
      description:
        "List user schemas (excludes pg_catalog, pg_toast, information_schema).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_tables",
      description:
        "List tables and views in one schema (default: 'public'). Returns table_name, table_type, and approximate row count.",
      inputSchema: {
        type: "object",
        properties: {
          schema: {
            type: "string",
            description: "Schema name. Defaults to 'public'.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "describe_table",
      description:
        "Describe one table — columns, types, nullability, defaults — plus any primary key columns.",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string", description: "Schema. Defaults to 'public'." },
          table: { type: "string", description: "Table name." },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "query",
      description:
        "Run an arbitrary SQL statement and return rows (for SELECT) or rowCount (for INSERT/UPDATE/DELETE). Supports parameterised queries via $1, $2 placeholders. Statement timeout is 30s; result rows are capped at 5000.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "The SQL statement." },
          params: {
            type: "array",
            description: "Parameter values for $1, $2, … placeholders.",
            items: {},
          },
          maxRows: {
            type: "integer",
            minimum: 1,
            maximum: MAX_ROWS,
            description: `Cap on rows returned (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).`,
          },
        },
        required: ["sql"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const connectionString = (input.connectionString ?? "").trim();
    if (!connectionString) throw new Error("Connection string is required");
    if (!/^postgres(ql)?:\/\//i.test(connectionString)) {
      throw new Error("Connection string must start with postgres:// or postgresql://");
    }
    const { version, db } = await withClient(connectionString, async (c) => {
      const r = await c.query("SELECT version() AS version, current_database() AS db");
      const row = r.rows[0] as { version?: string; db?: string };
      return { version: row?.version, db: row?.db };
    });
    const config: PostgresConfig = {
      connectionString,
      serverVersion: version ? shortVersion(version) : undefined,
      databaseName: db ?? parseDatabaseFromUri(connectionString),
    };
    const host = safeHost(connectionString);
    const dbName = config.databaseName ?? "?";
    const hint = `${host} · ${dbName}${config.serverVersion ? ` · ${config.serverVersion}` : ""}`;
    return { config, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as PostgresConfig;
    try {
      await withClient(cfg.connectionString, async (c) => {
        await c.query("SELECT 1");
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as PostgresConfig;
    const a = (args as Record<string, unknown>) ?? {};

    return withClient(cfg.connectionString, async (client) => {
      switch (name) {
        case "list_schemas": {
          const r = await client.query(
            `SELECT schema_name
               FROM information_schema.schemata
              WHERE schema_name NOT IN ('pg_catalog','pg_toast','information_schema')
                AND schema_name NOT LIKE 'pg_temp_%'
                AND schema_name NOT LIKE 'pg_toast_temp_%'
              ORDER BY schema_name`,
          );
          return { rows: r.rows };
        }

        case "list_tables": {
          const schema = typeof a.schema === "string" && a.schema.trim() ? a.schema.trim() : "public";
          const r = await client.query(
            `SELECT c.relname AS name,
                    CASE c.relkind
                      WHEN 'r' THEN 'table'
                      WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'materialized_view'
                      WHEN 'p' THEN 'partitioned_table'
                      WHEN 'f' THEN 'foreign_table'
                      ELSE c.relkind::text
                    END AS kind,
                    c.reltuples::bigint AS approx_rows
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1
                AND c.relkind IN ('r','v','m','p','f')
              ORDER BY c.relname`,
            [schema],
          );
          return { schema, rows: r.rows };
        }

        case "describe_table": {
          const schema = typeof a.schema === "string" && a.schema.trim() ? a.schema : "public";
          return describePostgresTable(client, schema, mustStr(a.table, "table"));
        }

        case "query": {
          const sql = mustStr(a.sql, "sql");
          const params = Array.isArray(a.params) ? a.params : [];
          const maxRows = clampInt(a.maxRows, 1, MAX_ROWS, DEFAULT_ROWS);
          const r = await client.query(sql, params);
          const truncated = r.rows.length > maxRows;
          return {
            rowCount: r.rowCount,
            truncated,
            fields: r.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
            rows: truncated ? r.rows.slice(0, maxRows) : r.rows,
          };
        }

        default:
          throw new Error(`Unknown Postgres tool: ${name}`);
      }
    });
  },
};

type PostgresQueryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
};

/**
 * Accept a name the way people and models write it: a bare `Project`, a
 * quoted `"Project"`, or a case-folded `project` for a table really named
 * `Project`. Only the first two are exact; the last is a fallback when it
 * identifies exactly one table.
 */
function unquoteIdentifier(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"')
    : trimmed;
}

/**
 * Describe one table's columns and primary key.
 *
 * Names are matched as data, never parsed as SQL identifiers: a
 * `'public.Project'::regclass` cast folds unquoted text to lower case, so it
 * resolved `public.project` and failed for every mixed-case table even after
 * the column lookup had found it.
 */
export async function describePostgresTable(
  client: PostgresQueryable,
  schemaInput: string,
  tableInput: string,
): Promise<{
  schema: string;
  table: string;
  columns: unknown[];
  primaryKey: string[];
}> {
  const requestedSchema = unquoteIdentifier(schemaInput) || "public";
  const requestedTable = unquoteIdentifier(tableInput);
  if (!requestedTable) throw new Error("table is required");
  const candidates = await client.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE lower(table_schema) = lower($1) AND lower(table_name) = lower($2)
      ORDER BY table_schema, table_name`,
    [requestedSchema, requestedTable],
  );
  const matches = candidates.rows as Array<{ table_schema: string; table_name: string }>;
  const exact = matches.find(
    (row) => row.table_schema === requestedSchema && row.table_name === requestedTable,
  );
  if (!exact && matches.length > 1) {
    throw new Error(
      `Table name ${requestedSchema}.${requestedTable} matches several tables that differ only by case: ${matches
        .map((row) => `${row.table_schema}."${row.table_name}"`)
        .join(", ")}. Pass the exact name.`,
    );
  }
  const resolved = exact ?? matches[0];
  if (!resolved) {
    throw new Error(
      `Table ${requestedSchema}.${requestedTable} not found or not visible to this role. Call list_tables to see the exact names.`,
    );
  }
  const schema = resolved.table_schema;
  const table = resolved.table_name;
  const cols = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  const pk = await client.query(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [schema, table],
  );
  return {
    schema,
    table,
    columns: cols.rows,
    primaryKey: (pk.rows as Array<{ column_name: string }>).map((r) => r.column_name),
  };
}

function shortVersion(versionString: string): string {
  // version() returns "PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by ..."
  const m = /PostgreSQL\s+(\S+)/i.exec(versionString);
  return m ? `pg ${m[1]}` : versionString.slice(0, 60);
}
