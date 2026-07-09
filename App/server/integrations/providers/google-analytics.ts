import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationScopeGroup,
  IntegrationTool,
} from "../types.js";
import {
  currentGoogleAccessToken,
  currentGoogleGrantedScope,
  ensureFreshGoogleToken,
  GOOGLE_OAUTH_IDENTITY_SCOPES,
  mintServiceAccountToken,
  parseServiceAccountKey,
  resolveScopeGroups,
  type GoogleOauthConfig,
  type GoogleServiceAccountConfig,
} from "./google/auth.js";
import { clampInt, googleJsonFetch } from "./google/util.js";

/**
 * Google Analytics 4 — standalone OAuth + Service Account integration.
 *
 * One `IntegrationConnection` covers a single Google identity (OAuth account
 * or service account) with **read-only** access to Google Analytics. AI
 * employees can discover accounts + properties (Admin API) and run reports
 * against the GA4 Data API — sessions, users, conversions, traffic sources,
 * realtime, and the dimension/metric catalog for a property.
 *
 * Read-only by design: the only scope this integration requests is
 * `analytics.readonly`. Two auth modes, same shapes/token lifecycle as the
 * Google Workspace integration (shared via `google/auth.ts`):
 *
 *   • OAuth — bring your own OAuth client; works for any Google account that
 *     has access to the Analytics property.
 *   • Service account — upload a Cloud service-account JSON key, then add
 *     the SA's email as a **Viewer** on the GA4 property (Admin → Property
 *     Access Management). No domain-wide delegation needed, so there is no
 *     impersonation field.
 */

const GA_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const GA_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "analytics",
    label: "Google Analytics (read-only)",
    description:
      "Read GA4 accounts and properties, and run reports (sessions, users, conversions, realtime).",
    scopes: [GA_READONLY_SCOPE],
    required: true,
  },
];

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

const tools: IntegrationTool[] = [
  {
    name: "list_accounts",
    description:
      "List the Google Analytics accounts this connection can access. Returns account resource names + display names.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_properties",
    description:
      "List GA4 properties grouped by account (Admin API accountSummaries). Use the returned `property` resource name (e.g. \"properties/123456789\") — or just its numeric id — with the report tools.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max account summaries to return (default 50).",
        },
        pageToken: {
          type: "string",
          description: "Token from a previous response's `nextPageToken`.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_property",
    description:
      "Fetch full metadata for one GA4 property (display name, time zone, currency, industry, create/update time).",
    inputSchema: {
      type: "object",
      properties: {
        property: {
          type: "string",
          description: "Property id or resource name, e.g. \"123456789\" or \"properties/123456789\".",
        },
      },
      required: ["property"],
      additionalProperties: false,
    },
  },
  {
    name: "run_report",
    description:
      "Run a GA4 report (Data API runReport). Provide the property and one or more metrics; dimensions and a date range are optional. Metric/dimension names are GA4 API names, e.g. metrics [\"activeUsers\",\"sessions\",\"conversions\"] and dimensions [\"date\",\"country\",\"sessionDefaultChannelGroup\"]. Dates accept YYYY-MM-DD or GA relative forms like \"7daysAgo\", \"yesterday\", \"today\". Defaults to the last 28 days when no range is given.",
    inputSchema: {
      type: "object",
      properties: {
        property: {
          type: "string",
          description: "Property id or resource name, e.g. \"123456789\" or \"properties/123456789\".",
        },
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "GA4 metric API names, e.g. [\"activeUsers\",\"sessions\"].",
        },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "GA4 dimension API names, e.g. [\"date\",\"country\"]. Omit for a totals-only report.",
        },
        startDate: {
          type: "string",
          description: "Range start (YYYY-MM-DD or \"NdaysAgo\"/\"yesterday\"/\"today\"). Defaults to \"28daysAgo\".",
        },
        endDate: {
          type: "string",
          description: "Range end (YYYY-MM-DD or relative). Defaults to \"yesterday\".",
        },
        dateRanges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startDate: { type: "string" },
              endDate: { type: "string" },
              name: { type: "string" },
            },
            required: ["startDate", "endDate"],
            additionalProperties: false,
          },
          description: "Advanced: multiple date ranges. Overrides startDate/endDate when provided.",
        },
        dimensionFilter: {
          type: "object",
          description: "Advanced: a GA4 FilterExpression applied to dimensions (passed through verbatim).",
          additionalProperties: true,
        },
        metricFilter: {
          type: "object",
          description: "Advanced: a GA4 FilterExpression applied to metrics (passed through verbatim).",
          additionalProperties: true,
        },
        orderBys: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Advanced: GA4 OrderBy array (e.g. [{\"metric\":{\"metricName\":\"sessions\"},\"desc\":true}]).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100000,
          description: "Max rows to return (default 100).",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Row offset for pagination (default 0).",
        },
        keepEmptyRows: {
          type: "boolean",
          description: "Include rows where every metric is 0 (default false).",
        },
      },
      required: ["property", "metrics"],
      additionalProperties: false,
    },
  },
  {
    name: "run_realtime_report",
    description:
      "Run a GA4 realtime report (Data API runRealtimeReport) over roughly the last 30 minutes of activity. Provide the property and metrics like [\"activeUsers\"]; dimensions like [\"unifiedScreenName\",\"country\",\"deviceCategory\"] are optional.",
    inputSchema: {
      type: "object",
      properties: {
        property: {
          type: "string",
          description: "Property id or resource name, e.g. \"123456789\" or \"properties/123456789\".",
        },
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "GA4 realtime metric API names, e.g. [\"activeUsers\"].",
        },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "GA4 realtime dimension API names, e.g. [\"country\",\"deviceCategory\"].",
        },
        dimensionFilter: {
          type: "object",
          description: "Advanced: a GA4 FilterExpression applied to dimensions (passed through verbatim).",
          additionalProperties: true,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100000,
          description: "Max rows to return (default 100).",
        },
      },
      required: ["property", "metrics"],
      additionalProperties: false,
    },
  },
  {
    name: "get_metadata",
    description:
      "List the dimensions and metrics available for a GA4 property (Data API metadata), including standard and any custom ones. Useful to discover valid names before calling run_report.",
    inputSchema: {
      type: "object",
      properties: {
        property: {
          type: "string",
          description: "Property id or resource name, e.g. \"123456789\" or \"properties/123456789\".",
        },
      },
      required: ["property"],
      additionalProperties: false,
    },
  },
];

export const googleAnalyticsProvider: IntegrationProvider = {
  catalog: {
    provider: "google-analytics",
    name: "Google Analytics",
    category: "Analytics",
    tagline: "Read GA4 reports — traffic, users, conversions, realtime.",
    description:
      "Connect Google Analytics 4 so AI employees can pull traffic and engagement reports: sessions, active users, conversions, channels, landing pages, realtime activity, and the full dimension/metric catalog. Read-only. Bring your own OAuth client, or upload a service-account JSON key and add its email as a Viewer on the GA4 property.",
    icon: "BarChart3",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: GOOGLE_OAUTH_IDENTITY_SCOPES,
      scopeGroups: GA_SCOPE_GROUPS,
      setupDocs:
        "https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries",
    },
    serviceAccount: {
      scopes: [],
      scopeGroups: GA_SCOPE_GROUPS,
      // GA4 service accounts don't need domain-wide delegation — you grant
      // the SA email Viewer access on the property directly.
      impersonation: false,
      setupDocs:
        "https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-service-account",
    },
    enabled: true,
  },

  tools,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
    const email = typeof userInfo.email === "string" ? userInfo.email : "";
    if (!tokens.refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Make sure the consent screen requested offline access and retry.",
      );
    }
    const cfg: GoogleOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      email,
      scopeGroups,
    };
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: email || "Google Analytics",
    };
  },

  async buildServiceAccountConfig({ keyJson, scopeGroups }) {
    const { clientEmail, privateKey, privateKeyId, projectId } =
      parseServiceAccountKey(keyJson);
    const resolvedScopes = resolveScopeGroups({
      keys: scopeGroups,
      groups: GA_SCOPE_GROUPS,
      baseline: [],
    });
    if (resolvedScopes.length === 0) {
      // The single scope group is required, so this only trips if the client
      // sent nothing — fall back to the read-only scope rather than error.
      resolvedScopes.push(GA_READONLY_SCOPE);
    }
    const cfg: GoogleServiceAccountConfig = {
      clientEmail,
      privateKey,
      privateKeyId,
      projectId,
      scopes: resolvedScopes,
      scopeGroups,
    };
    // Mint once eagerly so a bad key fails during connect, not on first use.
    const minted = await mintServiceAccountToken(cfg);
    cfg.accessToken = minted.accessToken;
    cfg.expiresAt = minted.expiresAt;
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: clientEmail,
    };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshGoogleToken(ctx);
      const accessToken = currentGoogleAccessToken(ctx);
      // Cheap read that only needs analytics.readonly.
      await googleJsonFetch({
        accessToken,
        baseUrl: ADMIN_API,
        path: "/accountSummaries",
        query: { pageSize: 1 },
        productLabel: "Analytics",
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
    await ensureFreshGoogleToken(ctx);
    assertAnalyticsScope(currentGoogleGrantedScope(ctx));
    const accessToken = currentGoogleAccessToken(ctx);
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_accounts":
        return googleJsonFetch({
          accessToken,
          baseUrl: ADMIN_API,
          path: "/accounts",
          productLabel: "Analytics",
        });

      case "list_properties":
        return googleJsonFetch({
          accessToken,
          baseUrl: ADMIN_API,
          path: "/accountSummaries",
          productLabel: "Analytics",
          query: {
            pageSize: clampInt(a.pageSize, 1, 200, 50),
            pageToken: optionalString(a.pageToken),
          },
        });

      case "get_property":
        return googleJsonFetch({
          accessToken,
          baseUrl: ADMIN_API,
          path: `/properties/${normalizePropertyId(a.property)}`,
          productLabel: "Analytics",
        });

      case "run_report":
        return googleJsonFetch({
          accessToken,
          baseUrl: DATA_API,
          path: `/properties/${normalizePropertyId(a.property)}:runReport`,
          method: "POST",
          productLabel: "Analytics",
          body: buildRunReportBody(a),
        });

      case "run_realtime_report":
        return googleJsonFetch({
          accessToken,
          baseUrl: DATA_API,
          path: `/properties/${normalizePropertyId(a.property)}:runRealtimeReport`,
          method: "POST",
          productLabel: "Analytics",
          body: buildRealtimeBody(a),
        });

      case "get_metadata":
        return googleJsonFetch({
          accessToken,
          baseUrl: DATA_API,
          path: `/properties/${normalizePropertyId(a.property)}/metadata`,
          productLabel: "Analytics",
        });

      default:
        throw new Error(`Unknown Google Analytics tool: ${name}`);
    }
  },
};

function assertAnalyticsScope(grantedScope: string): void {
  // Any analytics scope (analytics.readonly, analytics, …) unlocks the
  // read tools. Guards against a connection whose consent was narrowed.
  if (!grantedScope.includes("auth/analytics")) {
    throw new Error(
      "This connection is missing Google Analytics access. Reconnect and grant the Analytics scope.",
    );
  }
}

/** Accept "123456789" or "properties/123456789"; return the bare numeric id. */
function normalizePropertyId(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  const id = s.replace(/^properties\//, "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `Invalid property "${s}". Pass a numeric GA4 property id (e.g. "123456789") or "properties/123456789".`,
    );
  }
  return id;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function buildRunReportBody(a: Record<string, unknown>): Record<string, unknown> {
  const metrics = stringArray(a.metrics);
  if (metrics.length === 0) throw new Error("run_report requires at least one metric.");
  const dimensions = stringArray(a.dimensions);

  let dateRanges: Array<Record<string, unknown>>;
  if (Array.isArray(a.dateRanges) && a.dateRanges.length > 0) {
    dateRanges = a.dateRanges as Array<Record<string, unknown>>;
  } else {
    const startDate = optionalString(a.startDate) ?? "28daysAgo";
    const endDate = optionalString(a.endDate) ?? "yesterday";
    dateRanges = [{ startDate, endDate }];
  }

  const body: Record<string, unknown> = {
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    dateRanges,
    limit: clampInt(a.limit, 1, 100000, 100),
    offset: clampInt(a.offset, 0, 1_000_000_000, 0),
  };
  if (a.dimensionFilter && typeof a.dimensionFilter === "object") {
    body.dimensionFilter = a.dimensionFilter;
  }
  if (a.metricFilter && typeof a.metricFilter === "object") {
    body.metricFilter = a.metricFilter;
  }
  if (Array.isArray(a.orderBys) && a.orderBys.length > 0) {
    body.orderBys = a.orderBys;
  }
  if (a.keepEmptyRows === true) body.keepEmptyRows = true;
  return body;
}

function buildRealtimeBody(a: Record<string, unknown>): Record<string, unknown> {
  const metrics = stringArray(a.metrics);
  if (metrics.length === 0) {
    throw new Error("run_realtime_report requires at least one metric.");
  }
  const dimensions = stringArray(a.dimensions);
  const body: Record<string, unknown> = {
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit: clampInt(a.limit, 1, 100000, 100),
  };
  if (a.dimensionFilter && typeof a.dimensionFilter === "object") {
    body.dimensionFilter = a.dimensionFilter;
  }
  return body;
}
