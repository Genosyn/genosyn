import type { IntegrationProvider } from "../types.js";

/**
 * NocoDB — API-token integration. Works with both cloud (app.nocodb.com) and
 * self-hosted instances. Users generate a personal API token in their
 * profile and paste it along with the instance base URL.
 *
 * All calls go through the v2 REST API (`/api/v2/...`) which NocoDB has
 * stabilized from 0.200+. The token is sent as the `xc-token` header.
 *
 * The MVP toolset covers the common data-hand work:
 *   list_bases → list_tables → list_records → (create|update)_record
 * which is enough for an AI employee to answer "what's in our CRM base"
 * type questions and update records on request. More exotic surfaces
 * (views, hooks, attachments) are deliberately out of scope for V1.
 */

type NocoDbConfig = {
  baseUrl: string;
  apiToken: string;
  /** First base the token can see — stored so the UI can surface something human. */
  firstBaseTitle?: string;
};

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Instance URL is required");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Instance URL must start with http:// or https://");
  }
  return trimmed;
}

async function nocoFetch(
  cfg: Pick<NocoDbConfig, "baseUrl" | "apiToken">,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = `${cfg.baseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "xc-token": cfg.apiToken,
      accept: "application/json",
    },
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
      (parsed && typeof parsed === "object" && "msg" in parsed
        ? String((parsed as { msg: unknown }).msg)
        : null) ??
      (parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : null) ??
      (typeof parsed === "string" ? parsed : null) ??
      `NocoDB ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

/**
 * Extract an array of bases from NocoDB's /api/v2/meta/bases response.
 * The shape is `{ list: [...], pageInfo: {...} }` on v2, but older 0.200
 * betas returned the array directly. Handle both defensively.
 */
function extractBases(raw: unknown): Array<{ id?: string; title?: string }> {
  if (Array.isArray(raw)) {
    return raw as Array<{ id?: string; title?: string }>;
  }
  if (raw && typeof raw === "object" && "list" in raw) {
    const list = (raw as { list?: unknown }).list;
    if (Array.isArray(list)) {
      return list as Array<{ id?: string; title?: string }>;
    }
  }
  return [];
}

export const nocodbProvider: IntegrationProvider = {
  catalog: {
    provider: "nocodb",
    name: "NocoDB",
    tagline: "Bases, tables, records.",
    description:
      "Connect a NocoDB instance so AI employees can read and edit records in your no-code databases. Works with cloud (app.nocodb.com) or self-hosted. Create an API token in Profile → Tokens, then paste the instance URL and token below.",
    icon: "Database",
    authMode: "apikey",
    fields: [
      {
        key: "baseUrl",
        label: "Instance URL",
        type: "url",
        placeholder: "https://nocodb.mycompany.com",
        required: true,
        hint: "Your NocoDB instance's root URL — no trailing slash.",
      },
      {
        key: "apiToken",
        label: "API token",
        type: "password",
        placeholder: "xc-db-…",
        required: true,
        hint: "Generate under your NocoDB profile → Tokens. Requires NocoDB 0.200+ for the v2 REST API.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_bases",
      description:
        "List every base (aka project) the API token can see. Use the returned `id` as `baseId` for list_tables.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_tables",
      description:
        "List tables inside one base. Pass `baseId` (from list_bases). Returned `id` is the `tableId` for list_records.",
      inputSchema: {
        type: "object",
        properties: {
          baseId: {
            type: "string",
            description: "Base id returned by list_bases.",
          },
        },
        required: ["baseId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_records",
      description:
        "Read records from a table. Supports NocoDB's query params for filtering and paging.",
      inputSchema: {
        type: "object",
        properties: {
          tableId: {
            type: "string",
            description: "Table id from list_tables.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Max rows to return (default 25).",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Rows to skip for paging.",
          },
          where: {
            type: "string",
            description:
              'NocoDB filter expression, e.g. "(Status,eq,Open)~and(Priority,eq,High)".',
          },
          fields: {
            type: "string",
            description: 'Comma-separated list of fields to return, e.g. "Name,Email".',
          },
          sort: {
            type: "string",
            description: 'Field to sort by; prefix with "-" for descending.',
          },
        },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
    {
      name: "create_record",
      description:
        "Create a new record in a table. Pass `fields` as a JSON object of column-name → value.",
      inputSchema: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          fields: {
            type: "object",
            description: "Map of column name to value.",
            additionalProperties: true,
          },
        },
        required: ["tableId", "fields"],
        additionalProperties: false,
      },
    },
    {
      name: "update_record",
      description:
        "Update an existing record by id. Pass `fields` as a JSON object of column-name → new value.",
      inputSchema: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          recordId: {
            type: "string",
            description: "Record id (the `Id` field returned by list_records).",
          },
          fields: {
            type: "object",
            description: "Map of column name to new value.",
            additionalProperties: true,
          },
        },
        required: ["tableId", "recordId", "fields"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? "");
    const apiToken = (input.apiToken ?? "").trim();
    if (!apiToken) throw new Error("API token is required");
    const raw = await nocoFetch({ baseUrl, apiToken }, "/api/v2/meta/bases");
    const bases = extractBases(raw);
    const firstTitle =
      bases[0]?.title && typeof bases[0].title === "string"
        ? bases[0].title
        : undefined;
    const host = safeHost(baseUrl);
    const hint =
      bases.length === 0
        ? `${host} · no bases yet`
        : bases.length === 1 && firstTitle
          ? `${host} · ${firstTitle}`
          : `${host} · ${bases.length} bases`;
    const config: NocoDbConfig = {
      baseUrl,
      apiToken,
      firstBaseTitle: firstTitle,
    };
    return { config, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as NocoDbConfig;
    try {
      await nocoFetch(cfg, "/api/v2/meta/bases");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as NocoDbConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_bases":
        return nocoFetch(cfg, "/api/v2/meta/bases");

      case "list_tables": {
        const baseId = mustStr(a.baseId, "baseId");
        return nocoFetch(cfg, `/api/v2/meta/bases/${encodeURIComponent(baseId)}/tables`);
      }

      case "list_records": {
        const tableId = mustStr(a.tableId, "tableId");
        const qs = new URLSearchParams();
        qs.set("limit", String(clampInt(a.limit, 1, 1000, 25)));
        const offset = Number(a.offset);
        if (Number.isInteger(offset) && offset >= 0) {
          qs.set("offset", String(offset));
        }
        if (typeof a.where === "string" && a.where.trim()) qs.set("where", a.where);
        if (typeof a.fields === "string" && a.fields.trim()) qs.set("fields", a.fields);
        if (typeof a.sort === "string" && a.sort.trim()) qs.set("sort", a.sort);
        return nocoFetch(
          cfg,
          `/api/v2/tables/${encodeURIComponent(tableId)}/records?${qs.toString()}`,
        );
      }

      case "create_record": {
        const tableId = mustStr(a.tableId, "tableId");
        const fields = mustObj(a.fields, "fields");
        return nocoFetch(cfg, `/api/v2/tables/${encodeURIComponent(tableId)}/records`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fields),
        });
      }

      case "update_record": {
        const tableId = mustStr(a.tableId, "tableId");
        const recordId = mustStr(a.recordId, "recordId");
        const fields = mustObj(a.fields, "fields");
        // NocoDB v2 uses a single PATCH at the collection URL; Id must be
        // included in the body for the row being updated.
        return nocoFetch(cfg, `/api/v2/tables/${encodeURIComponent(tableId)}/records`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ Id: recordId, ...fields }),
        });
      }

      default:
        throw new Error(`Unknown NocoDB tool: ${name}`);
    }
  },
};

function mustStr(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v;
}

function mustObj(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${name} must be an object`);
  }
  return v as Record<string, unknown>;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
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
