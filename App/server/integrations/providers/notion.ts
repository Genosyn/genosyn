import type { IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Notion — API-key integration. Users paste an internal integration secret
 * (`secret_…` / `ntn_…`) created at notion.so/profile/integrations and shared
 * with the pages or databases they want AI employees to reach. We call
 * /v1/users/me on create to validate the token and capture the bot owner /
 * workspace name for the account hint.
 *
 * No SDK dependency — Notion's REST API is JSON over HTTPS and trivial to
 * hit with `fetch`. The bot only sees pages explicitly shared with it, so
 * permissioning is entirely on the user's side.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

type NotionConfig = {
  apiKey: string;
  botId?: string;
  botName?: string;
  workspaceName?: string;
  ownerType?: string;
};

type FetchInit = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

async function notionFetch(
  apiKey: string,
  path: string,
  init: FetchInit = {},
): Promise<unknown> {
  const qs = init.query
    ? "?" +
      Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join("&")
    : "";
  const url = `${NOTION_API}${path}${qs}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      (parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : null) ?? `Notion ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

export const notionProvider: IntegrationProvider = {
  catalog: {
    provider: "notion",
    name: "Notion",
    category: "Productivity",
    tagline: "Pages, databases, blocks, search.",
    description:
      "Connect a Notion workspace so AI employees can search pages, query databases, read content, and create or update pages. Uses an internal integration secret — create one at notion.so/profile/integrations, then share each page or database the integration should access from Notion's share menu.",
    icon: "BookOpen",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "Internal integration secret",
        type: "password",
        placeholder: "secret_… or ntn_…",
        required: true,
        hint: "Share each page or database with the integration in Notion's share menu so it shows up here.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "get_self",
      description:
        "Return the bot user this connection is authenticated as, including workspace name and bot owner.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "search",
      description:
        "Search pages and databases the integration has been shared with. Optional `query` filters by title.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Title substring to match." },
          filter: {
            type: "string",
            enum: ["page", "database"],
            description: "Restrict results to one object type.",
          },
          page_size: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max rows to return (1-100, default 20).",
          },
          start_cursor: {
            type: "string",
            description: "Cursor returned by a prior call's `next_cursor`.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "retrieve_page",
      description: "Fetch one page's properties (title, status, etc.) by id.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: {
            type: "string",
            description: "Notion page id (with or without dashes).",
          },
        },
        required: ["pageId"],
        additionalProperties: false,
      },
    },
    {
      name: "retrieve_database",
      description:
        "Fetch one database's schema (title, properties, parent) by id. Use `query_database` to read rows.",
      inputSchema: {
        type: "object",
        properties: {
          databaseId: {
            type: "string",
            description: "Notion database id (with or without dashes).",
          },
        },
        required: ["databaseId"],
        additionalProperties: false,
      },
    },
    {
      name: "query_database",
      description:
        "List rows in a database. `filter` and `sorts` are passed through verbatim — see Notion's filter object docs.",
      inputSchema: {
        type: "object",
        properties: {
          databaseId: { type: "string" },
          filter: {
            type: "object",
            description: "Notion filter object. Optional.",
            additionalProperties: true,
            properties: {},
          },
          sorts: {
            type: "array",
            description: "Notion sort objects. Optional.",
            items: { type: "object", additionalProperties: true, properties: {} },
          },
          page_size: { type: "integer", minimum: 1, maximum: 100 },
          start_cursor: { type: "string" },
        },
        required: ["databaseId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_block_children",
      description:
        "List the child blocks of a page or block — the readable content of a page.",
      inputSchema: {
        type: "object",
        properties: {
          blockId: {
            type: "string",
            description: "Page id or block id.",
          },
          page_size: { type: "integer", minimum: 1, maximum: 100 },
          start_cursor: { type: "string" },
        },
        required: ["blockId"],
        additionalProperties: false,
      },
    },
    {
      name: "append_block_children",
      description:
        "Append blocks (paragraphs, headings, todos, …) to a page or block. `children` follows Notion's block object schema.",
      inputSchema: {
        type: "object",
        properties: {
          blockId: { type: "string", description: "Parent page or block id." },
          children: {
            type: "array",
            description: "Array of Notion block objects.",
            items: { type: "object", additionalProperties: true, properties: {} },
          },
        },
        required: ["blockId", "children"],
        additionalProperties: false,
      },
    },
    {
      name: "create_page",
      description:
        "Create a new page. Pass `parent` ({ database_id } or { page_id }), `properties` (matching the parent's schema), and optional `children` blocks.",
      inputSchema: {
        type: "object",
        properties: {
          parent: {
            type: "object",
            description:
              "{ database_id: '…' } to create a row, { page_id: '…' } to create a sub-page.",
            additionalProperties: true,
            properties: {},
          },
          properties: {
            type: "object",
            description: "Notion properties object keyed by property name.",
            additionalProperties: true,
            properties: {},
          },
          children: {
            type: "array",
            description: "Optional initial block children.",
            items: { type: "object", additionalProperties: true, properties: {} },
          },
        },
        required: ["parent", "properties"],
        additionalProperties: false,
      },
    },
    {
      name: "update_page",
      description:
        "Update a page's properties or archive it. `properties` is keyed by property name.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string" },
          properties: {
            type: "object",
            additionalProperties: true,
            properties: {},
          },
          archived: { type: "boolean" },
        },
        required: ["pageId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_users",
      description: "List workspace members visible to the integration.",
      inputSchema: {
        type: "object",
        properties: {
          page_size: { type: "integer", minimum: 1, maximum: 100 },
          start_cursor: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("Integration secret is required");
    const me = (await notionFetch(apiKey, "/users/me")) as {
      id?: string;
      name?: string;
      bot?: {
        owner?: { type?: string };
        workspace_name?: string;
      };
    };
    if (!me?.id) {
      throw new Error("Notion returned no bot user — token may be invalid.");
    }
    const workspace = me.bot?.workspace_name;
    const botName = me.name ?? "Notion bot";
    const config: NotionConfig = {
      apiKey,
      botId: me.id,
      botName,
      workspaceName: workspace,
      ownerType: me.bot?.owner?.type,
    };
    const display = workspace ? `${workspace} · ${botName}` : botName;
    const accountHint = `${display} · ${maskSecret(apiKey)}`;
    return { config, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as NotionConfig;
    try {
      await notionFetch(cfg.apiKey, "/users/me");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as NotionConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_self":
        return notionFetch(cfg.apiKey, "/users/me");

      case "search": {
        const body: Record<string, unknown> = {
          page_size: clampInt(a.page_size, 1, 100, 20),
        };
        if (typeof a.query === "string" && a.query.trim()) body.query = a.query.trim();
        if (typeof a.start_cursor === "string" && a.start_cursor)
          body.start_cursor = a.start_cursor;
        if (a.filter === "page" || a.filter === "database") {
          body.filter = { property: "object", value: a.filter };
        }
        return notionFetch(cfg.apiKey, "/search", { method: "POST", body });
      }

      case "retrieve_page": {
        const pageId = requireString(a.pageId, "pageId");
        return notionFetch(cfg.apiKey, `/pages/${encodeURIComponent(pageId)}`);
      }

      case "retrieve_database": {
        const databaseId = requireString(a.databaseId, "databaseId");
        return notionFetch(
          cfg.apiKey,
          `/databases/${encodeURIComponent(databaseId)}`,
        );
      }

      case "query_database": {
        const databaseId = requireString(a.databaseId, "databaseId");
        const body: Record<string, unknown> = {
          page_size: clampInt(a.page_size, 1, 100, 20),
        };
        if (a.filter && typeof a.filter === "object") body.filter = a.filter;
        if (Array.isArray(a.sorts)) body.sorts = a.sorts;
        if (typeof a.start_cursor === "string" && a.start_cursor)
          body.start_cursor = a.start_cursor;
        return notionFetch(
          cfg.apiKey,
          `/databases/${encodeURIComponent(databaseId)}/query`,
          { method: "POST", body },
        );
      }

      case "list_block_children": {
        const blockId = requireString(a.blockId, "blockId");
        const query: Record<string, string | number> = {
          page_size: clampInt(a.page_size, 1, 100, 50),
        };
        if (typeof a.start_cursor === "string" && a.start_cursor)
          query.start_cursor = a.start_cursor;
        return notionFetch(
          cfg.apiKey,
          `/blocks/${encodeURIComponent(blockId)}/children`,
          { query },
        );
      }

      case "append_block_children": {
        const blockId = requireString(a.blockId, "blockId");
        if (!Array.isArray(a.children) || a.children.length === 0) {
          throw new Error("children must be a non-empty array of block objects");
        }
        return notionFetch(
          cfg.apiKey,
          `/blocks/${encodeURIComponent(blockId)}/children`,
          { method: "PATCH", body: { children: a.children } },
        );
      }

      case "create_page": {
        if (!a.parent || typeof a.parent !== "object") {
          throw new Error("parent is required");
        }
        if (!a.properties || typeof a.properties !== "object") {
          throw new Error("properties is required");
        }
        const body: Record<string, unknown> = {
          parent: a.parent,
          properties: a.properties,
        };
        if (Array.isArray(a.children)) body.children = a.children;
        return notionFetch(cfg.apiKey, "/pages", { method: "POST", body });
      }

      case "update_page": {
        const pageId = requireString(a.pageId, "pageId");
        const body: Record<string, unknown> = {};
        if (a.properties && typeof a.properties === "object")
          body.properties = a.properties;
        if (typeof a.archived === "boolean") body.archived = a.archived;
        if (Object.keys(body).length === 0) {
          throw new Error("Pass `properties` or `archived` to update_page");
        }
        return notionFetch(cfg.apiKey, `/pages/${encodeURIComponent(pageId)}`, {
          method: "PATCH",
          body,
        });
      }

      case "list_users": {
        const query: Record<string, string | number> = {
          page_size: clampInt(a.page_size, 1, 100, 50),
        };
        if (typeof a.start_cursor === "string" && a.start_cursor)
          query.start_cursor = a.start_cursor;
        return notionFetch(cfg.apiKey, "/users", { query });
      }

      default:
        throw new Error(`Unknown Notion tool: ${name}`);
    }
  },
};
