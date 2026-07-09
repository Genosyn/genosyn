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
 * Google Search Console — standalone OAuth + Service Account integration.
 *
 * One `IntegrationConnection` covers a single Google identity with
 * **read-only** access to Search Console. AI employees can list verified
 * sites, query Search Analytics (clicks / impressions / CTR / position by
 * query, page, country, device, date), read sitemaps, and run URL
 * Inspection to check indexing status.
 *
 * Read-only by design: the only scope requested is `webmasters.readonly`,
 * which also covers the URL Inspection API. Two auth modes, same shapes and
 * token lifecycle as the other Google integrations (shared via
 * `google/auth.ts`):
 *
 *   • OAuth — bring your own OAuth client; works for any Google account that
 *     is an owner/user of the Search Console property.
 *   • Service account — upload a Cloud service-account JSON key, then add the
 *     SA's email as a user on the property (Settings → Users and permissions).
 *     No domain-wide delegation needed, so there is no impersonation field.
 */

const GSC_READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

const GSC_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "search",
    label: "Search Console (read-only)",
    description:
      "List verified sites, query Search Analytics, read sitemaps, and inspect URLs.",
    scopes: [GSC_READONLY_SCOPE],
    required: true,
  },
];

const WEBMASTERS_API = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE_API = "https://searchconsole.googleapis.com/v1";

const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];

const tools: IntegrationTool[] = [
  {
    name: "list_sites",
    description:
      "List the Search Console properties (sites) this connection can access, with each site's permission level. Use the returned `siteUrl` (e.g. \"https://example.com/\" or \"sc-domain:example.com\") with the other tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "query_search_analytics",
    description:
      "Query Search Analytics for a site (clicks, impressions, CTR, average position). Group by dimensions like [\"query\",\"page\",\"country\",\"device\",\"date\",\"searchAppearance\"], or omit dimensions for site-wide totals. Dates are YYYY-MM-DD and inclusive; Search Console data typically lags ~2-3 days.",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: {
          type: "string",
          description: "Property, e.g. \"https://example.com/\" or \"sc-domain:example.com\".",
        },
        startDate: { type: "string", description: "Start date, YYYY-MM-DD (inclusive)." },
        endDate: { type: "string", description: "End date, YYYY-MM-DD (inclusive)." },
        dimensions: {
          type: "array",
          items: {
            type: "string",
            enum: ["query", "page", "country", "device", "date", "searchAppearance"],
          },
          description: "Dimensions to group by. Omit for site-wide totals.",
        },
        type: {
          type: "string",
          enum: SEARCH_TYPES,
          description: "Search type (default \"web\").",
        },
        rowLimit: {
          type: "integer",
          minimum: 1,
          maximum: 25000,
          description: "Max rows to return (default 1000).",
        },
        startRow: {
          type: "integer",
          minimum: 0,
          description: "Row offset for pagination (default 0).",
        },
        dataState: {
          type: "string",
          enum: ["final", "all"],
          description: "\"final\" (default) excludes fresh, still-changing data; \"all\" includes it.",
        },
        dimensionFilterGroups: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description:
            "Advanced: Search Console dimensionFilterGroups (passed through verbatim) to filter by query/page/country/device.",
        },
      },
      required: ["siteUrl", "startDate", "endDate"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sitemaps",
    description: "List the sitemaps submitted for a site, with their processing status and warnings/errors.",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: {
          type: "string",
          description: "Property, e.g. \"https://example.com/\" or \"sc-domain:example.com\".",
        },
      },
      required: ["siteUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sitemap",
    description: "Fetch details for one submitted sitemap by its full URL (feedpath), including per-content-type counts.",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: {
          type: "string",
          description: "Property, e.g. \"https://example.com/\" or \"sc-domain:example.com\".",
        },
        feedpath: {
          type: "string",
          description: "The full sitemap URL, e.g. \"https://example.com/sitemap.xml\".",
        },
      },
      required: ["siteUrl", "feedpath"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_url",
    description:
      "Run URL Inspection for a single page: index status, last crawl, canonical, coverage state, mobile usability, and rich-results verdicts. The URL must belong to the given property.",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: {
          type: "string",
          description: "The Search Console property the URL belongs to, e.g. \"https://example.com/\" or \"sc-domain:example.com\".",
        },
        inspectionUrl: {
          type: "string",
          description: "The fully-qualified URL to inspect, e.g. \"https://example.com/pricing\".",
        },
        languageCode: {
          type: "string",
          description: "Optional BCP-47 language for the response, e.g. \"en-US\".",
        },
      },
      required: ["siteUrl", "inspectionUrl"],
      additionalProperties: false,
    },
  },
];

export const googleSearchConsoleProvider: IntegrationProvider = {
  catalog: {
    provider: "google-search-console",
    name: "Google Search Console",
    category: "Analytics",
    tagline: "Read search performance, sitemaps, and URL indexing.",
    description:
      "Connect Google Search Console so AI employees can monitor organic search: clicks, impressions, CTR, and average position by query, page, country, and device; read submitted sitemaps; and inspect individual URLs for indexing and coverage. Read-only. Bring your own OAuth client, or upload a service-account JSON key and add its email as a user on the property.",
    icon: "Search",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: GOOGLE_OAUTH_IDENTITY_SCOPES,
      scopeGroups: GSC_SCOPE_GROUPS,
      setupDocs:
        "https://developers.google.com/webmaster-tools/v1/how-tos/authorizing",
    },
    serviceAccount: {
      scopes: [],
      scopeGroups: GSC_SCOPE_GROUPS,
      // Search Console service accounts don't need domain-wide delegation —
      // you add the SA email as a user on the property directly.
      impersonation: false,
      setupDocs:
        "https://developers.google.com/webmaster-tools/v1/how-tos/authorizing",
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
      accountHint: email || "Search Console",
    };
  },

  async buildServiceAccountConfig({ keyJson, scopeGroups }) {
    const { clientEmail, privateKey, privateKeyId, projectId } =
      parseServiceAccountKey(keyJson);
    const resolvedScopes = resolveScopeGroups({
      keys: scopeGroups,
      groups: GSC_SCOPE_GROUPS,
      baseline: [],
    });
    if (resolvedScopes.length === 0) {
      resolvedScopes.push(GSC_READONLY_SCOPE);
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
      await googleJsonFetch({
        accessToken,
        baseUrl: WEBMASTERS_API,
        path: "/sites",
        productLabel: "Search Console",
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
    assertSearchConsoleScope(currentGoogleGrantedScope(ctx));
    const accessToken = currentGoogleAccessToken(ctx);
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_sites":
        return googleJsonFetch({
          accessToken,
          baseUrl: WEBMASTERS_API,
          path: "/sites",
          productLabel: "Search Console",
        });

      case "query_search_analytics":
        return googleJsonFetch({
          accessToken,
          baseUrl: WEBMASTERS_API,
          path: `/sites/${encodeURIComponent(requireSiteUrl(a.siteUrl))}/searchAnalytics/query`,
          method: "POST",
          productLabel: "Search Console",
          body: buildSearchAnalyticsBody(a),
        });

      case "list_sitemaps":
        return googleJsonFetch({
          accessToken,
          baseUrl: WEBMASTERS_API,
          path: `/sites/${encodeURIComponent(requireSiteUrl(a.siteUrl))}/sitemaps`,
          productLabel: "Search Console",
        });

      case "get_sitemap":
        return googleJsonFetch({
          accessToken,
          baseUrl: WEBMASTERS_API,
          path: `/sites/${encodeURIComponent(requireSiteUrl(a.siteUrl))}/sitemaps/${encodeURIComponent(requireString(a.feedpath, "feedpath"))}`,
          productLabel: "Search Console",
        });

      case "inspect_url":
        return googleJsonFetch({
          accessToken,
          baseUrl: SEARCHCONSOLE_API,
          path: "/urlInspection/index:inspect",
          method: "POST",
          productLabel: "Search Console",
          body: {
            siteUrl: requireSiteUrl(a.siteUrl),
            inspectionUrl: requireString(a.inspectionUrl, "inspectionUrl"),
            ...(optionalString(a.languageCode)
              ? { languageCode: optionalString(a.languageCode) }
              : {}),
          },
        });

      default:
        throw new Error(`Unknown Google Search Console tool: ${name}`);
    }
  },
};

function assertSearchConsoleScope(grantedScope: string): void {
  // Any webmasters scope (webmasters.readonly, webmasters) unlocks the read
  // tools. Guards against a connection whose consent was narrowed.
  if (!grantedScope.includes("auth/webmasters")) {
    throw new Error(
      "This connection is missing Search Console access. Reconnect and grant the Search Console scope.",
    );
  }
}

function requireSiteUrl(v: unknown): string {
  return requireString(v, "siteUrl");
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${field} is required`);
  }
  return v.trim();
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function buildSearchAnalyticsBody(a: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    startDate: requireString(a.startDate, "startDate"),
    endDate: requireString(a.endDate, "endDate"),
    rowLimit: clampInt(a.rowLimit, 1, 25000, 1000),
    startRow: clampInt(a.startRow, 0, 1_000_000, 0),
  };
  const dimensions = Array.isArray(a.dimensions)
    ? a.dimensions.filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];
  if (dimensions.length > 0) body.dimensions = dimensions;
  const type = optionalString(a.type);
  if (type && SEARCH_TYPES.includes(type)) body.type = type;
  const dataState = optionalString(a.dataState);
  if (dataState === "final" || dataState === "all") body.dataState = dataState;
  if (Array.isArray(a.dimensionFilterGroups) && a.dimensionFilterGroups.length > 0) {
    body.dimensionFilterGroups = a.dimensionFilterGroups;
  }
  return body;
}
