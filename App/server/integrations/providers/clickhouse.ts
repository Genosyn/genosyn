import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { IntegrationProvider } from "../types.js";

/**
 * ClickHouse — HTTP integration via the official `@clickhouse/client` SDK.
 *
 * Users supply a URL (HTTP/HTTPS) plus username/password and an optional
 * default database. We spin up a fresh client per tool call to avoid
 * holding connections across grants, and rely on the SDK's own keep-alive
 * pool inside that scope.
 *
 * Safety: each query is sent with `max_execution_time` and `max_result_rows`
 * settings so a runaway query is cut off server-side. Results larger than
 * the cap are truncated client-side as well — belt and braces.
 */

type ClickHouseConfig = {
  url: string;
  username?: string;
  password?: string;
  database?: string;
  serverVersion?: string;
};

const STATEMENT_TIMEOUT_S = 30;
const MAX_ROWS = 5_000;
const DEFAULT_ROWS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;

function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
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

function buildClient(cfg: ClickHouseConfig): ClickHouseClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
    request_timeout: REQUEST_TIMEOUT_MS,
    clickhouse_settings: {
      max_execution_time: STATEMENT_TIMEOUT_S,
      max_result_rows: String(MAX_ROWS),
    },
  });
}

async function withClient<T>(
  cfg: ClickHouseConfig,
  fn: (client: ClickHouseClient) => Promise<T>,
): Promise<T> {
  const client = buildClient(cfg);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export const clickhouseProvider: IntegrationProvider = {
  catalog: {
    provider: "clickhouse",
    name: "ClickHouse",
    tagline: "Columnar OLAP — databases, tables, queries.",
    description:
      "Connect a ClickHouse cluster so AI employees can list databases and tables, describe schemas, and run analytical queries. Works with self-hosted ClickHouse and ClickHouse Cloud. Use a read-only user for safety.",
    icon: "Layers",
    authMode: "apikey",
    fields: [
      {
        key: "url",
        label: "Server URL",
        type: "url",
        placeholder: "https://your-host.clickhouse.cloud:8443",
        required: true,
        hint: "HTTP or HTTPS endpoint. ClickHouse Cloud uses HTTPS on port 8443.",
      },
      {
        key: "username",
        label: "Username",
        type: "text",
        placeholder: "default",
        required: false,
        hint: "Defaults to 'default' if left blank.",
      },
      {
        key: "password",
        label: "Password",
        type: "password",
        placeholder: "••••••••",
        required: false,
      },
      {
        key: "database",
        label: "Default database",
        type: "text",
        placeholder: "default",
        required: false,
        hint: "Optional — used as the default `FROM` schema.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_databases",
      description: "List databases on the cluster (excludes the system database).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_tables",
      description:
        "List tables and views inside one database (default: the configured default database).",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string", description: "Database name." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "describe_table",
      description:
        "Describe one table — columns, types, default expressions, and codecs (DESCRIBE TABLE).",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string" },
          table: { type: "string", description: "Table name." },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "query",
      description:
        "Run a SELECT (or other read-style) statement and return rows as JSON. Use `query_params` for parameterised queries via the `{name:Type}` syntax. max_execution_time is 30s; result rows are capped at 5000.",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description:
              "The SQL statement. Most SELECT/SHOW/DESCRIBE statements work.",
          },
          query_params: {
            type: "object",
            description:
              "Map of parameter name → value, used by `{paramName:Type}` placeholders in the SQL.",
            additionalProperties: true,
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
    {
      name: "exec",
      description:
        "Run a non-SELECT statement (CREATE, ALTER, INSERT, OPTIMIZE, …). Returns query_id and elapsed time. Use this for DDL/DML; use `query` for SELECT.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "The DDL/DML statement." },
        },
        required: ["sql"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const url = (input.url ?? "").trim();
    if (!url) throw new Error("Server URL is required");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("Server URL must start with http:// or https://");
    }
    const cfg: ClickHouseConfig = {
      url,
      username: (input.username ?? "").trim() || undefined,
      password: input.password ?? undefined,
      database: (input.database ?? "").trim() || undefined,
    };
    const version = await withClient(cfg, async (client) => {
      const rs = await client.query({ query: "SELECT version() AS v", format: "JSON" });
      const j = (await rs.json()) as { data?: Array<{ v?: string }> };
      return j.data?.[0]?.v;
    });
    cfg.serverVersion = version;
    const host = safeHost(url);
    const user = cfg.username || "default";
    const hint = `${user}@${host}${version ? ` · v${version}` : ""}`;
    return { config: cfg, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as ClickHouseConfig;
    try {
      await withClient(cfg, async (client) => {
        const ok = await client.ping();
        if (!ok.success) {
          throw ok.error ?? new Error("ClickHouse ping failed");
        }
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
    const cfg = ctx.config as ClickHouseConfig;
    const a = (args as Record<string, unknown>) ?? {};

    return withClient(cfg, async (client) => {
      switch (name) {
        case "list_databases": {
          const rs = await client.query({
            query:
              "SELECT name, engine FROM system.databases WHERE name != 'system' ORDER BY name",
            format: "JSON",
          });
          const j = (await rs.json()) as { data: unknown[] };
          return { rows: j.data };
        }

        case "list_tables": {
          const database =
            (typeof a.database === "string" && a.database.trim()) || cfg.database;
          if (!database) {
            throw new Error(
              "No database name available — pass `database` or set a default on the connection.",
            );
          }
          const rs = await client.query({
            query:
              "SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {db:String} ORDER BY name",
            query_params: { db: database },
            format: "JSON",
          });
          const j = (await rs.json()) as { data: unknown[] };
          return { database, rows: j.data };
        }

        case "describe_table": {
          const database =
            (typeof a.database === "string" && a.database.trim()) || cfg.database;
          const table = mustStr(a.table, "table");
          const fqn = database
            ? `${escapeIdent(database)}.${escapeIdent(table)}`
            : escapeIdent(table);
          const rs = await client.query({
            query: `DESCRIBE TABLE ${fqn}`,
            format: "JSON",
          });
          const j = (await rs.json()) as { data: unknown[] };
          return { database: database ?? null, table, columns: j.data };
        }

        case "query": {
          const sql = mustStr(a.sql, "sql");
          const maxRows = clampInt(a.maxRows, 1, MAX_ROWS, DEFAULT_ROWS);
          const queryParams =
            a.query_params && typeof a.query_params === "object" && !Array.isArray(a.query_params)
              ? (a.query_params as Record<string, unknown>)
              : undefined;
          const rs = await client.query({
            query: sql,
            query_params: queryParams,
            format: "JSON",
            clickhouse_settings: {
              max_result_rows: String(maxRows),
            },
          });
          const j = (await rs.json()) as {
            data: unknown[];
            meta?: Array<{ name?: string; type?: string }>;
            rows?: number;
            statistics?: Record<string, unknown>;
          };
          const truncated = (j.rows ?? j.data.length) > maxRows;
          return {
            rowCount: j.rows ?? j.data.length,
            truncated,
            meta: j.meta ?? [],
            rows: truncated ? j.data.slice(0, maxRows) : j.data,
            statistics: j.statistics,
          };
        }

        case "exec": {
          const sql = mustStr(a.sql, "sql");
          const out = await client.command({ query: sql });
          return { query_id: out.query_id };
        }

        default:
          throw new Error(`Unknown ClickHouse tool: ${name}`);
      }
    });
  },
};

/** Quote a ClickHouse identifier with backticks, escaping any embedded
 * backticks. Used for `database.table` references. */
function escapeIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}
