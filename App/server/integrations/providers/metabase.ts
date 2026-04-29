import type { IntegrationProvider } from "../types.js";

/**
 * Metabase — API-key integration. Users paste their instance URL plus an
 * API key generated under Admin Settings → API Keys. We call `/api/user/current`
 * on create to validate and capture the user's display name.
 *
 * Metabase's REST API uses the `x-api-key` header for API key auth and
 * session tokens for the legacy username/password flow. We only support the
 * former — session tokens expire and refresh flows add operational weight.
 */

type MetabaseConfig = {
  baseUrl: string;
  apiKey: string;
  userName?: string;
  userEmail?: string;
};

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Instance URL is required");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Instance URL must start with http:// or https://");
  }
  return trimmed;
}

async function metabaseFetch(
  cfg: Pick<MetabaseConfig, "baseUrl" | "apiKey">,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = `${cfg.baseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "x-api-key": cfg.apiKey,
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
    const detail =
      (parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : null) ??
      (typeof parsed === "string" ? parsed : null) ??
      `Metabase ${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return parsed;
}

export const metabaseProvider: IntegrationProvider = {
  catalog: {
    provider: "metabase",
    name: "Metabase",
    category: "Analytics",
    tagline: "Dashboards, questions, query results.",
    description:
      "Give AI employees read access to your Metabase instance. Create an API key under Admin → API Keys (Metabase 0.49+) with a read-only group, then paste the instance URL and key below.",
    icon: "BarChart3",
    authMode: "apikey",
    fields: [
      {
        key: "baseUrl",
        label: "Instance URL",
        type: "url",
        placeholder: "https://metabase.mycompany.com",
        required: true,
      },
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "mb_…",
        required: true,
        hint: "Generate under Admin Settings → Authentication → API Keys.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_databases",
      description:
        "List the databases Metabase is connected to. Useful for discovering what schemas are available.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_questions",
      description:
        "List saved questions (aka Cards). Pass `collectionId` to scope to one collection.",
      inputSchema: {
        type: "object",
        properties: {
          collectionId: {
            type: "string",
            description: "Numeric collection id or 'root'.",
          },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "run_question",
      description:
        "Execute a saved question and return the result set as JSON. Pass `cardId` (numeric Metabase card id). Results are capped by Metabase at its instance limit.",
      inputSchema: {
        type: "object",
        properties: {
          cardId: {
            type: "integer",
            description: "Numeric Metabase card id.",
          },
        },
        required: ["cardId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_dashboards",
      description: "List dashboards the API key user can read.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "retrieve_dashboard",
      description:
        "Fetch a dashboard by numeric id, including its cards and parameters.",
      inputSchema: {
        type: "object",
        properties: {
          dashboardId: { type: "integer" },
        },
        required: ["dashboardId"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? "");
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("API key is required");
    const user = (await metabaseFetch({ baseUrl, apiKey }, "/api/user/current")) as {
      id?: number;
      email?: string;
      common_name?: string;
      first_name?: string;
      last_name?: string;
    };
    const name =
      user?.common_name ??
      [user?.first_name, user?.last_name].filter(Boolean).join(" ") ??
      user?.email ??
      "Metabase user";
    const config: MetabaseConfig = {
      baseUrl,
      apiKey,
      userName: name,
      userEmail: user?.email,
    };
    const host = safeHost(baseUrl);
    const hint = `${name} · ${host}`;
    return { config, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as MetabaseConfig;
    try {
      await metabaseFetch(cfg, "/api/user/current");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as MetabaseConfig;
    const a = (args as Record<string, unknown>) ?? {};
    switch (name) {
      case "list_databases":
        return metabaseFetch(cfg, "/api/database");
      case "list_questions": {
        const qs = new URLSearchParams();
        if (typeof a.collectionId === "string" && a.collectionId.trim()) {
          qs.set("collection", a.collectionId.trim());
        }
        qs.set("f", "all");
        const tail = qs.toString();
        return metabaseFetch(cfg, `/api/card${tail ? `?${tail}` : ""}`);
      }
      case "run_question": {
        const cardId = Number(a.cardId);
        if (!Number.isInteger(cardId) || cardId <= 0) {
          throw new Error("cardId must be a positive integer");
        }
        return metabaseFetch(cfg, `/api/card/${cardId}/query/json`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      }
      case "list_dashboards":
        return metabaseFetch(cfg, "/api/dashboard");
      case "retrieve_dashboard": {
        const dashId = Number(a.dashboardId);
        if (!Number.isInteger(dashId) || dashId <= 0) {
          throw new Error("dashboardId must be a positive integer");
        }
        return metabaseFetch(cfg, `/api/dashboard/${dashId}`);
      }
      default:
        throw new Error(`Unknown Metabase tool: ${name}`);
    }
  },
};

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
