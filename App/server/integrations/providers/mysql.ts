import mysql from "mysql2/promise";
import type { IntegrationProvider } from "../types.js";

/**
 * MySQL — connection-string integration. Users paste a `mysql://` URI; we
 * connect once on create to validate, and once per tool call after that.
 *
 * Safety: each call sets `max_execution_time` (MySQL 5.7+) so a runaway
 * query is killed server-side, and rows are capped at the caller-specified
 * limit (max 5000). Use a least-privileged DB user — the integration does
 * not enforce read-only.
 *
 * Works with MySQL 5.7+ and MariaDB 10.x. We deliberately use the promise
 * surface from `mysql2/promise` to avoid callback bookkeeping.
 */

type MysqlConfig = {
  connectionString: string;
  serverVersion?: string;
  databaseName?: string;
};

const STATEMENT_TIMEOUT_MS = 30_000;
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

async function withConnection<T>(
  connectionString: string,
  fn: (conn: mysql.Connection) => Promise<T>,
): Promise<T> {
  const conn = await mysql.createConnection({
    uri: connectionString,
    connectTimeout: 10_000,
    // Force JS Date objects to ISO strings so JSON serialisation is stable
    // when the result is shipped back to the AI employee.
    dateStrings: true,
  });
  try {
    // MariaDB ignores this setting silently; on MySQL 5.7+ it kills runaway
    // SELECTs. The hint syntax (`/*+ MAX_EXECUTION_TIME(...) */`) only works
    // inline, so we use the session variable instead.
    await conn
      .query("SET SESSION MAX_EXECUTION_TIME = ?", [STATEMENT_TIMEOUT_MS])
      .catch(() => undefined);
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
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

export const mysqlProvider: IntegrationProvider = {
  catalog: {
    provider: "mysql",
    name: "MySQL",
    category: "Databases",
    tagline: "Databases, tables, queries.",
    description:
      "Connect a MySQL or MariaDB database so AI employees can list databases and tables, describe columns, and run queries. Works with MySQL 5.7+ and MariaDB 10.x. Use a read-only role unless you explicitly want write access.",
    icon: "Server",
    authMode: "apikey",
    fields: [
      {
        key: "connectionString",
        label: "Connection string",
        type: "password",
        placeholder: "mysql://user:pass@host:3306/db",
        required: true,
        hint: "Standard mysql:// URI. Use ?ssl={\"rejectUnauthorized\":true} or sslmode for managed databases.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_databases",
      description:
        "List databases visible to the connecting user (excludes system schemas).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_tables",
      description:
        "List tables and views inside one database (default: the database in the connection string).",
      inputSchema: {
        type: "object",
        properties: {
          database: {
            type: "string",
            description: "Database name. Defaults to the one in the connection string.",
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
          database: {
            type: "string",
            description: "Database. Defaults to the one in the connection string.",
          },
          table: { type: "string", description: "Table name." },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "query",
      description:
        "Run an arbitrary SQL statement. Supports parameterised queries via `?` placeholders. MAX_EXECUTION_TIME is set to 30s; result rows are capped at 5000.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "The SQL statement." },
          params: {
            type: "array",
            description: "Parameter values for `?` placeholders.",
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
    if (!/^mysql:\/\//i.test(connectionString)) {
      throw new Error("Connection string must start with mysql://");
    }
    const { version, db } = await withConnection(connectionString, async (c) => {
      const [rows] = (await c.query("SELECT VERSION() AS version, DATABASE() AS db")) as [
        Array<{ version?: string; db?: string }>,
        unknown,
      ];
      const row = rows?.[0] ?? {};
      return { version: row.version, db: row.db };
    });
    const config: MysqlConfig = {
      connectionString,
      serverVersion: version,
      databaseName: db ?? parseDatabaseFromUri(connectionString),
    };
    const host = safeHost(connectionString);
    const dbName = config.databaseName ?? "?";
    const hint = `${host} · ${dbName}${version ? ` · ${version}` : ""}`;
    return { config, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as MysqlConfig;
    try {
      await withConnection(cfg.connectionString, async (c) => {
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
    const cfg = ctx.config as MysqlConfig;
    const a = (args as Record<string, unknown>) ?? {};

    return withConnection(cfg.connectionString, async (conn) => {
      switch (name) {
        case "list_databases": {
          const [rows] = (await conn.query(
            `SELECT schema_name AS name, default_character_set_name AS charset
               FROM information_schema.schemata
              WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys')
              ORDER BY schema_name`,
          )) as [Array<Record<string, unknown>>, unknown];
          return { rows };
        }

        case "list_tables": {
          const database =
            (typeof a.database === "string" && a.database.trim()) ||
            cfg.databaseName ||
            parseDatabaseFromUri(cfg.connectionString);
          if (!database) {
            throw new Error(
              "No database name available — pass `database` or include one in the connection string.",
            );
          }
          const [rows] = (await conn.query(
            `SELECT table_name AS name,
                    LOWER(table_type) AS kind,
                    table_rows AS approx_rows
               FROM information_schema.tables
              WHERE table_schema = ?
              ORDER BY table_name`,
            [database],
          )) as [Array<Record<string, unknown>>, unknown];
          return { database, rows };
        }

        case "describe_table": {
          const database =
            (typeof a.database === "string" && a.database.trim()) ||
            cfg.databaseName ||
            parseDatabaseFromUri(cfg.connectionString);
          if (!database) {
            throw new Error(
              "No database name available — pass `database` or include one in the connection string.",
            );
          }
          const table = mustStr(a.table, "table");
          const [cols] = (await conn.query(
            `SELECT column_name, column_type, is_nullable, column_default, column_key, extra
               FROM information_schema.columns
              WHERE table_schema = ? AND table_name = ?
              ORDER BY ordinal_position`,
            [database, table],
          )) as [Array<Record<string, unknown>>, unknown];
          if (!cols.length) {
            throw new Error(`Table ${database}.${table} not found or not visible to this user`);
          }
          const pk = cols
            .filter((c) => String(c.column_key ?? "").toUpperCase() === "PRI")
            .map((c) => String(c.column_name));
          return { database, table, columns: cols, primaryKey: pk };
        }

        case "query": {
          const sql = mustStr(a.sql, "sql");
          const params = Array.isArray(a.params) ? a.params : [];
          const maxRows = clampInt(a.maxRows, 1, MAX_ROWS, DEFAULT_ROWS);
          const [result, fields] = await conn.query(sql, params);
          // SELECTs return Array<Record>; INSERT/UPDATE/DELETE return ResultSetHeader.
          if (Array.isArray(result)) {
            const truncated = result.length > maxRows;
            const rows = truncated ? result.slice(0, maxRows) : result;
            return {
              kind: "select",
              rowCount: result.length,
              truncated,
              fields: Array.isArray(fields)
                ? fields.map((f) => ({ name: (f as { name?: string }).name }))
                : [],
              rows,
            };
          }
          // ResultSetHeader shape (`affectedRows`, `insertId`, ...).
          return { kind: "exec", ...(result as unknown as Record<string, unknown>) };
        }

        default:
          throw new Error(`Unknown MySQL tool: ${name}`);
      }
    });
  },
};
