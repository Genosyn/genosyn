import type { IntegrationProvider } from "../types.js";

/**
 * Airtable — Personal Access Token integration. Users mint a PAT at
 * airtable.com/create/tokens and grant it the scopes they want the AI to
 * have. We default to read+write on records and read on the schema.
 *
 * The legacy `keyXXXXX` API keys were deprecated in February 2024; only PATs
 * (`pat...`) and OAuth tokens are accepted now. We standardise on PATs since
 * the OAuth flow requires registering an integration in Airtable's portal —
 * a PAT is the lowest-friction path for a self-hosted install.
 *
 * No SDK dependency — Airtable's REST API is JSON over HTTPS and trivial to
 * call with `fetch`.
 */

const AIRTABLE_API = "https://api.airtable.com/v0";

type AirtableConfig = {
  apiKey: string;
  /** The first base the PAT can see — captured for the account hint. */
  firstBaseName?: string;
  baseCount?: number;
};

type FetchInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

async function airtableFetch(
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
  const url = `${AIRTABLE_API}${path}${qs}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
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
    const detail =
      (parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "object" &&
      (parsed as { error: { message?: unknown } }).error &&
      typeof (parsed as { error: { message?: unknown } }).error.message === "string"
        ? (parsed as { error: { message: string } }).error.message
        : null) ??
      (parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : null) ??
      `Airtable ${res.status} ${res.statusText}`;
    throw new Error(detail);
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

function mustStr(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

function mustObj(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${name} must be an object`);
  }
  return v as Record<string, unknown>;
}

export const airtableProvider: IntegrationProvider = {
  catalog: {
    provider: "airtable",
    name: "Airtable",
    tagline: "Bases, tables, records.",
    description:
      "Connect an Airtable workspace so AI employees can read and edit records. Create a Personal Access Token at airtable.com/create/tokens with the scopes data.records:read, data.records:write, and schema.bases:read, and grant access to the bases you want exposed.",
    icon: "Table2",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "Personal Access Token",
        type: "password",
        placeholder: "pat…",
        required: true,
        hint: "Create at airtable.com/create/tokens. Recommended scopes: data.records:read, data.records:write, schema.bases:read.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_bases",
      description:
        "List every base the PAT can see. Returned `id` (e.g. `appXXXX`) is the `baseId` for list_tables.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_tables",
      description:
        "List tables (and their fields/views) inside one base. Pass `baseId` (from list_bases). Returned `id` (e.g. `tblXXXX`) is the `tableId` for list_records.",
      inputSchema: {
        type: "object",
        properties: {
          baseId: {
            type: "string",
            description: "Base id from list_bases (appXXXX).",
          },
        },
        required: ["baseId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_records",
      description:
        "Read records from a table. Supports Airtable's standard query params for filtering, paging, and field selection.",
      inputSchema: {
        type: "object",
        properties: {
          baseId: { type: "string", description: "Base id (appXXXX)." },
          tableIdOrName: {
            type: "string",
            description: "Table id (tblXXXX) or table name.",
          },
          maxRecords: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Max rows to return (default 100).",
          },
          pageSize: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Page size (default 100).",
          },
          offset: {
            type: "string",
            description: "Pagination cursor returned by a previous call.",
          },
          view: {
            type: "string",
            description: "View name or id to scope to.",
          },
          filterByFormula: {
            type: "string",
            description:
              'Airtable formula filter, e.g. "{Status} = \'Open\'". Quote string field values with single quotes.',
          },
          fields: {
            type: "array",
            description: "Whitelist of field names to return.",
            items: { type: "string" },
          },
        },
        required: ["baseId", "tableIdOrName"],
        additionalProperties: false,
      },
    },
    {
      name: "retrieve_record",
      description: "Fetch one record by id from a table.",
      inputSchema: {
        type: "object",
        properties: {
          baseId: { type: "string" },
          tableIdOrName: { type: "string" },
          recordId: {
            type: "string",
            description: "Record id (recXXXX).",
          },
        },
        required: ["baseId", "tableIdOrName", "recordId"],
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
          baseId: { type: "string" },
          tableIdOrName: { type: "string" },
          fields: {
            type: "object",
            description: "Map of column name to value.",
            additionalProperties: true,
          },
        },
        required: ["baseId", "tableIdOrName", "fields"],
        additionalProperties: false,
      },
    },
    {
      name: "update_record",
      description:
        "Update an existing record. By default does a partial update (only the fields you pass). Pass `replaceAll: true` to clear unspecified fields.",
      inputSchema: {
        type: "object",
        properties: {
          baseId: { type: "string" },
          tableIdOrName: { type: "string" },
          recordId: { type: "string" },
          fields: {
            type: "object",
            description: "Map of column name to new value.",
            additionalProperties: true,
          },
          replaceAll: {
            type: "boolean",
            description:
              "If true, uses PUT (replaces all fields). Defaults to false (PATCH, partial update).",
          },
        },
        required: ["baseId", "tableIdOrName", "recordId", "fields"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_record",
      description: "Delete a record by id.",
      inputSchema: {
        type: "object",
        properties: {
          baseId: { type: "string" },
          tableIdOrName: { type: "string" },
          recordId: { type: "string" },
        },
        required: ["baseId", "tableIdOrName", "recordId"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("Personal Access Token is required");
    const raw = (await airtableFetch(apiKey, "/meta/bases")) as {
      bases?: Array<{ id?: string; name?: string }>;
    };
    const bases = Array.isArray(raw?.bases) ? raw.bases : [];
    const firstName =
      typeof bases[0]?.name === "string" ? bases[0].name : undefined;
    const config: AirtableConfig = {
      apiKey,
      firstBaseName: firstName,
      baseCount: bases.length,
    };
    const hint =
      bases.length === 0
        ? "no bases granted"
        : bases.length === 1 && firstName
          ? firstName
          : `${bases.length} bases`;
    return { config, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as AirtableConfig;
    try {
      await airtableFetch(cfg.apiKey, "/meta/bases");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as AirtableConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_bases":
        return airtableFetch(cfg.apiKey, "/meta/bases");

      case "list_tables": {
        const baseId = mustStr(a.baseId, "baseId");
        return airtableFetch(
          cfg.apiKey,
          `/meta/bases/${encodeURIComponent(baseId)}/tables`,
        );
      }

      case "list_records": {
        const baseId = mustStr(a.baseId, "baseId");
        const tableIdOrName = mustStr(a.tableIdOrName, "tableIdOrName");
        const query: Record<string, string | number> = {};
        query["maxRecords"] = clampInt(a.maxRecords, 1, 1000, 100);
        query["pageSize"] = clampInt(a.pageSize, 1, 100, 100);
        if (typeof a.offset === "string" && a.offset.trim()) {
          query["offset"] = a.offset.trim();
        }
        if (typeof a.view === "string" && a.view.trim()) {
          query["view"] = a.view.trim();
        }
        if (typeof a.filterByFormula === "string" && a.filterByFormula.trim()) {
          query["filterByFormula"] = a.filterByFormula.trim();
        }
        // Airtable wants `fields[]=Name&fields[]=Email`; serialise manually
        // because URLSearchParams will collapse to `fields=Name&fields=Email`
        // which Airtable also accepts but the bracket form is the documented
        // shape.
        const baseUrl = `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`;
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
        if (Array.isArray(a.fields)) {
          for (const f of a.fields) {
            if (typeof f === "string" && f.trim()) qs.append("fields[]", f);
          }
        }
        const tail = qs.toString();
        return airtableFetch(cfg.apiKey, `${baseUrl}${tail ? `?${tail}` : ""}`);
      }

      case "retrieve_record": {
        const baseId = mustStr(a.baseId, "baseId");
        const tableIdOrName = mustStr(a.tableIdOrName, "tableIdOrName");
        const recordId = mustStr(a.recordId, "recordId");
        return airtableFetch(
          cfg.apiKey,
          `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`,
        );
      }

      case "create_record": {
        const baseId = mustStr(a.baseId, "baseId");
        const tableIdOrName = mustStr(a.tableIdOrName, "tableIdOrName");
        const fields = mustObj(a.fields, "fields");
        return airtableFetch(
          cfg.apiKey,
          `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`,
          { method: "POST", body: { fields } },
        );
      }

      case "update_record": {
        const baseId = mustStr(a.baseId, "baseId");
        const tableIdOrName = mustStr(a.tableIdOrName, "tableIdOrName");
        const recordId = mustStr(a.recordId, "recordId");
        const fields = mustObj(a.fields, "fields");
        const method = a.replaceAll === true ? "PUT" : "PATCH";
        return airtableFetch(
          cfg.apiKey,
          `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`,
          { method, body: { fields } },
        );
      }

      case "delete_record": {
        const baseId = mustStr(a.baseId, "baseId");
        const tableIdOrName = mustStr(a.tableIdOrName, "tableIdOrName");
        const recordId = mustStr(a.recordId, "recordId");
        return airtableFetch(
          cfg.apiKey,
          `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`,
          { method: "DELETE" },
        );
      }

      default:
        throw new Error(`Unknown Airtable tool: ${name}`);
    }
  },
};
