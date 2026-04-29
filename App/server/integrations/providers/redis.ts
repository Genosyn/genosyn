import { createClient, type RedisClientType } from "redis";
import type { IntegrationProvider } from "../types.js";

/**
 * Redis — connection-URL integration via the official `redis` (node-redis)
 * SDK. Users paste a `redis://` or `rediss://` URL; we connect once on
 * create to validate and once per tool call after that.
 *
 * The exposed surface is intentionally narrow: discovery (KEYS/SCAN, TYPE,
 * TTL), basic strings (GET/SET/DEL), and INFO. Multi-key commands and
 * datatype-specific helpers (HASH/LIST/SET/ZSET) are deliberately out of
 * scope for the MVP — they can be layered on later without touching the
 * connection plumbing.
 *
 * Safety: we never use raw KEYS to enumerate; SCAN with a cursor + COUNT
 * cap is used instead, so an AI employee cannot wedge a production Redis
 * by listing millions of keys.
 */

type RedisConfig = {
  url: string;
  username?: string;
  password?: string;
  database?: number;
  serverVersion?: string;
};

type LooseClient = RedisClientType<Record<string, never>, Record<string, never>, Record<string, never>>;

const CONNECT_TIMEOUT_MS = 10_000;
const SCAN_MAX_KEYS = 5_000;
const SCAN_DEFAULT_KEYS = 1_000;

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

async function withClient<T>(
  cfg: RedisConfig,
  fn: (client: LooseClient) => Promise<T>,
): Promise<T> {
  const client = createClient({
    url: cfg.url,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    database: typeof cfg.database === "number" ? cfg.database : undefined,
    socket: { connectTimeout: CONNECT_TIMEOUT_MS },
  }) as LooseClient;
  // Default error event emits unhandled-error warnings; capture and rethrow
  // through the caller's promise instead.
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

/** Parse the version line from `INFO server`. */
function parseRedisVersion(info: string): string | undefined {
  const m = /^redis_version:(\S+)/m.exec(info);
  return m?.[1];
}

export const redisProvider: IntegrationProvider = {
  catalog: {
    provider: "redis",
    name: "Redis",
    tagline: "Keys, values, INFO.",
    description:
      "Connect a Redis instance so AI employees can scan keys, fetch values, and inspect server health. Works with redis:// (TCP) and rediss:// (TLS) URLs. Use a least-privileged ACL user — the integration does not enforce read-only.",
    icon: "Zap",
    authMode: "apikey",
    fields: [
      {
        key: "url",
        label: "Connection URL",
        type: "password",
        placeholder: "rediss://default:password@host:6380/0",
        required: true,
        hint: "Standard redis:// or rediss:// URL. Username/password go inline; database number after the trailing slash.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "info",
      description:
        "Run INFO and return parsed server metadata (version, mode, uptime, used memory, connected clients).",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              "Optional INFO section: server, clients, memory, persistence, stats, replication, cpu, commandstats, keyspace.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "scan_keys",
      description:
        "Iterate keys matching a pattern using SCAN (non-blocking). Returns up to `count` keys plus a cursor to continue from. Default count 1000, max 5000.",
      inputSchema: {
        type: "object",
        properties: {
          match: {
            type: "string",
            description: "Glob pattern, e.g. 'session:*'. Defaults to '*'.",
          },
          cursor: {
            type: "string",
            description: "Cursor returned by a previous call. Defaults to '0' (start).",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: SCAN_MAX_KEYS,
            description: `Max keys to return (default ${SCAN_DEFAULT_KEYS}, max ${SCAN_MAX_KEYS}).`,
          },
          type: {
            type: "string",
            description: "Filter by datatype: string, list, set, zset, hash, stream.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "type",
      description: "Get the datatype of a key (string/list/set/zset/hash/stream/none).",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    {
      name: "ttl",
      description:
        "Get remaining time-to-live (seconds) of a key. -1 = no expiry, -2 = key does not exist.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    {
      name: "get",
      description: "GET a string value. Returns null if the key is missing.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    {
      name: "set",
      description:
        "SET a string value, optionally with an expiry in seconds. Returns 'OK' on success.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
          ttlSeconds: {
            type: "integer",
            minimum: 1,
            description: "Expire after this many seconds.",
          },
          nx: {
            type: "boolean",
            description: "Only set if the key does not already exist.",
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
    {
      name: "del",
      description: "Delete one key. Returns 1 if removed, 0 if it didn't exist.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const url = (input.url ?? "").trim();
    if (!url) throw new Error("Connection URL is required");
    if (!/^rediss?:\/\//i.test(url)) {
      throw new Error("Connection URL must start with redis:// or rediss://");
    }
    const cfg: RedisConfig = { url };
    const info = await withClient(cfg, async (c) => {
      return (await c.info("server")) as string;
    });
    cfg.serverVersion = parseRedisVersion(info);
    const host = safeHost(url);
    const hint = `${host}${cfg.serverVersion ? ` · v${cfg.serverVersion}` : ""}`;
    return { config: cfg, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as RedisConfig;
    try {
      await withClient(cfg, async (c) => {
        const pong = await c.ping();
        if (pong !== "PONG") {
          throw new Error(`Redis returned ${pong} instead of PONG`);
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
    const cfg = ctx.config as RedisConfig;
    const a = (args as Record<string, unknown>) ?? {};

    return withClient(cfg, async (client) => {
      switch (name) {
        case "info": {
          const section = typeof a.section === "string" && a.section.trim() ? a.section.trim() : undefined;
          const raw = (section ? await client.info(section) : await client.info()) as string;
          return parseInfoBlock(raw);
        }

        case "scan_keys": {
          const match = typeof a.match === "string" && a.match.trim() ? a.match.trim() : "*";
          const startCursor = typeof a.cursor === "string" && a.cursor.trim() ? a.cursor.trim() : "0";
          const count = clampInt(a.count, 1, SCAN_MAX_KEYS, SCAN_DEFAULT_KEYS);
          const type = typeof a.type === "string" && a.type.trim() ? a.type.trim() : undefined;
          const collected: string[] = [];
          let cursor: string = startCursor;
          let safety = 0;
          // node-redis v5 returns SCAN as { cursor: string, keys: string[] }.
          while (safety++ < 50) {
            const out = (await client.scan(cursor, {
              MATCH: match,
              COUNT: count,
              TYPE: type,
            })) as { cursor: string; keys: string[] };
            for (const k of out.keys) {
              collected.push(k);
              if (collected.length >= count) break;
            }
            cursor = out.cursor;
            if (cursor === "0" || collected.length >= count) break;
          }
          return { cursor, count: collected.length, keys: collected };
        }

        case "type": {
          const key = mustStr(a.key, "key");
          const t = await client.type(key);
          return { key, type: t };
        }

        case "ttl": {
          const key = mustStr(a.key, "key");
          const t = await client.ttl(key);
          return { key, ttl: t };
        }

        case "get": {
          const key = mustStr(a.key, "key");
          const value = await client.get(key);
          return { key, value };
        }

        case "set": {
          const key = mustStr(a.key, "key");
          const value = mustStr(a.value, "value");
          const opts: { EX?: number; NX?: true } = {};
          if (typeof a.ttlSeconds === "number" && a.ttlSeconds > 0) {
            opts.EX = Math.floor(a.ttlSeconds);
          }
          if (a.nx === true) opts.NX = true;
          const result = await client.set(key, value, opts);
          return { key, ok: result === "OK", result };
        }

        case "del": {
          const key = mustStr(a.key, "key");
          const removed = await client.del(key);
          return { key, removed };
        }

        default:
          throw new Error(`Unknown Redis tool: ${name}`);
      }
    });
  },
};

/**
 * Parse the `INFO` text response into a `{ section: { key: value, ... } }`
 * object. The format is:
 *
 *   # Server
 *   redis_version:7.2.4
 *   ...
 *
 *   # Clients
 *   connected_clients:5
 *   ...
 */
function parseInfoBlock(raw: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let current = "_";
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      current = line.replace(/^#\s*/, "").toLowerCase();
      out[current] = out[current] ?? {};
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 1);
    out[current] = out[current] ?? {};
    out[current][k] = v;
  }
  return out;
}
