import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
  IntegrationTool,
} from "../types.js";
import {
  currentGoogleAccessToken,
  currentGoogleGrantedScope,
  ensureFreshGoogleToken,
  GOOGLE_OAUTH_IDENTITY_SCOPES,
  type GoogleOauthConfig,
} from "./google/auth.js";
import {
  ADS_SAFETY_FIELDS,
  adsClampInt,
  adsOptionalString,
  adsRequireNumber,
  adsRequireString,
  enforceAdsMutation,
  formatMinor,
  minorFromMicros,
  parseAdsSafetyFields,
  recordAdsMutation,
  type AdsSafetyConfig,
} from "./ads-shared.js";

/**
 * Google Ads — read-first campaign visibility plus a deliberately tiny,
 * approval-gated mutation surface (pause / enable / budget change).
 *
 * Rides the shared `google` OAuth app with the single `adwords` scope, the
 * same way Google Analytics and Search Console do. Two Google Ads-specific
 * credentials ride the connect form as OAuth extra fields:
 *
 *   • **Developer token** — issued per Google Ads MANAGER (MCC) account in
 *     its API Center. The auto-granted Explorer tier works on production
 *     accounts with no human review (2,880 ops/day); Basic (15,000/day)
 *     takes a short application.
 *   • **Login customer id** — the MCC's customer id, sent as the
 *     `login-customer-id` header when accessing linked client accounts.
 *
 * Transport is the REST interface with JSON — plain fetch, no gRPC
 * toolchain, no SDK. Reporting is GAQL via `googleAds:search`. Mutations
 * go through per-resource `:mutate` endpoints and every spend-increasing
 * change defaults to a human Approval (see `ads-shared.ts`).
 */

/**
 * Google Ads ships ~4 major API versions a year and each lives ~12 months;
 * the version string rides every REST URL. Keeping it a single constant
 * makes the periodic bump a one-line change. checkStatus surfaces a
 * version-sunset 404 with an "upgrade Genosyn" hint.
 */
const GOOGLE_ADS_API_VERSION = "v24";
const ADS_API = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";

const ADS_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "ads",
    label: "Google Ads",
    description:
      "Read campaigns and reports, pause/enable campaigns, and change budgets (mutations are approval-gated).",
    scopes: [ADWORDS_SCOPE],
    required: true,
  },
];

type GoogleAdsConfig = GoogleOauthConfig &
  AdsSafetyConfig & {
    developerToken: string;
    /** MCC customer id (digits only) for the login-customer-id header. */
    loginCustomerId?: string;
  };

const tools: IntegrationTool[] = [
  {
    name: "list_accessible_customers",
    description:
      "List the Google Ads customer accounts the connected identity can access directly. Returns resource names like \"customers/1234567890\" — use the numeric id with every other tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_campaigns",
    description:
      "List campaigns in one customer account with status, channel type, and daily budget. Removed campaigns are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Customer id, digits only or with dashes (e.g. \"123-456-7890\").",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Max campaigns to return (default 100).",
        },
      },
      required: ["customer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_campaign",
    description:
      "Fetch one campaign's live state: status, channel type, daily budget, and the budget's resource name. Read this before proposing any mutation.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        campaign_id: { type: "string" },
      },
      required: ["customer_id", "campaign_id"],
      additionalProperties: false,
    },
  },
  {
    name: "run_gaql",
    description:
      "Run a GAQL query (Google Ads Query Language) via googleAds:search — the full reporting surface: campaign/ad_group/keyword_view/search_term_view/asset_group resources, metrics, and segments. Add a LIMIT clause to bound rows; pass page_token to continue a paged result. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        query: {
          type: "string",
          description:
            "GAQL, e.g. \"SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 100\".",
        },
        page_token: { type: "string" },
      },
      required: ["customer_id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "spend_summary",
    description:
      "Per-campaign spend, impressions, clicks, and conversions for a date range. Costs are returned in the account's currency units (converted from micros). Use for daily pacing checks.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        date_range: {
          type: "string",
          enum: [
            "TODAY",
            "YESTERDAY",
            "LAST_7_DAYS",
            "LAST_14_DAYS",
            "LAST_30_DAYS",
            "THIS_MONTH",
            "LAST_MONTH",
          ],
          description: "GAQL preset range (default LAST_7_DAYS).",
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["customer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "pause_campaign",
    description:
      "Pause a campaign. Spend-DECREASING, so it never waits for approval — this is the emergency lever for a runaway campaign. Records the freed daily budget to the spend ledger.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        campaign_id: { type: "string" },
      },
      required: ["customer_id", "campaign_id"],
      additionalProperties: false,
    },
  },
  {
    name: "enable_campaign",
    description:
      "Enable (un-pause) a campaign. Spend-INCREASING: authorizes spend at the campaign's current daily budget, so it goes through the Connection's caps and (by default) a human Approval.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        campaign_id: { type: "string" },
      },
      required: ["customer_id", "campaign_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_campaign_budget",
    description:
      "Change a campaign's daily budget. `new_daily_budget` is in the account's currency units (e.g. 45.50). Increases go through the Connection's caps and (by default) a human Approval; decreases apply immediately. Both are recorded to the spend ledger.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        campaign_id: { type: "string" },
        new_daily_budget: {
          type: "number",
          exclusiveMinimum: 0,
          description: "New daily budget in currency units.",
        },
      },
      required: ["customer_id", "campaign_id", "new_daily_budget"],
      additionalProperties: false,
    },
  },
];

export const googleAdsProvider: IntegrationProvider = {
  catalog: {
    provider: "google-ads",
    name: "Google Ads",
    category: "Analytics",
    tagline: "Campaign spend, pacing reports, and approval-gated budget levers.",
    description:
      "Connect Google Ads so AI employees can watch campaign spend and pacing (GAQL reports), and — behind per-Connection caps and human approvals — pause/enable campaigns and change budgets. Needs your own OAuth client, a developer token from your Manager (MCC) account's API Center, and the MCC's customer id. The auto-granted Explorer token tier works on production accounts with no review.",
    icon: "Megaphone",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: GOOGLE_OAUTH_IDENTITY_SCOPES,
      scopeGroups: ADS_SCOPE_GROUPS,
      extraFields: [
        {
          key: "developerToken",
          label: "Developer token",
          type: "password",
          placeholder: "from your MCC's API Center",
          required: true,
          hint: "Google Ads → (Manager account) → Admin → API Center. Explorer tier is auto-granted and works on production accounts.",
        },
        {
          key: "loginCustomerId",
          label: "Login customer id (MCC)",
          type: "text",
          placeholder: "123-456-7890",
          required: false,
          hint: "Your Manager account's customer id. Required when the developer token lives on an MCC and you access linked client accounts.",
        },
        ...ADS_SAFETY_FIELDS,
      ],
      setupDocs: "https://developers.google.com/google-ads/api/docs/get-started/introduction",
    },
    enabled: true,
  },

  tools,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups, extraFields }) {
    const email = typeof userInfo.email === "string" ? userInfo.email : "";
    if (!tokens.refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Make sure the consent screen requested offline access and retry. If your OAuth app is in Testing status, refresh tokens also expire every 7 days — publish it to Production (or mark it Internal on Workspace).",
      );
    }
    const developerToken = (extraFields?.developerToken ?? "").trim();
    if (!developerToken) {
      throw new Error("Developer token is required for Google Ads.");
    }
    const loginCustomerId = normalizeCustomerId(extraFields?.loginCustomerId ?? "", {
      optional: true,
    });
    const safety = parseAdsSafetyFields(extraFields ?? {});
    const cfg: GoogleAdsConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      email,
      scopeGroups,
      developerToken,
      ...(loginCustomerId ? { loginCustomerId } : {}),
      ...safety,
    };
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: email || "Google Ads",
    };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshGoogleToken(ctx);
      await adsFetch(ctx, "/customers:listAccessibleCustomers", { method: "GET" });
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
    assertAdsScope(currentGoogleGrantedScope(ctx));
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_accessible_customers":
        return adsFetch(ctx, "/customers:listAccessibleCustomers", { method: "GET" });

      case "list_campaigns": {
        const customerId = normalizeCustomerId(adsRequireString(a.customer_id, "customer_id"));
        const limit = adsClampInt(a.limit, 1, 1000, 100);
        return searchGaql(
          ctx,
          customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, customer.currency_code FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT ${limit}`,
        );
      }

      case "get_campaign": {
        const customerId = normalizeCustomerId(adsRequireString(a.customer_id, "customer_id"));
        const campaignId = requireDigits(a.campaign_id, "campaign_id");
        const info = await fetchCampaignInfo(ctx, customerId, campaignId);
        return {
          campaignId,
          name: info.name,
          status: info.status,
          channelType: info.channelType,
          dailyBudget: info.amountMicros / 1_000_000,
          currency: info.currency,
          budgetResourceName: info.budgetResourceName,
        };
      }

      case "run_gaql": {
        const customerId = normalizeCustomerId(adsRequireString(a.customer_id, "customer_id"));
        const query = adsRequireString(a.query, "query");
        assertReadOnlyGaql(query);
        return searchGaql(ctx, customerId, query, adsOptionalString(a.page_token));
      }

      case "spend_summary": {
        const customerId = normalizeCustomerId(adsRequireString(a.customer_id, "customer_id"));
        const range = adsOptionalString(a.date_range) ?? "LAST_7_DAYS";
        const limit = adsClampInt(a.limit, 1, 1000, 200);
        const res = (await searchGaql(
          ctx,
          customerId,
          `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code FROM campaign WHERE segments.date DURING ${range} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`,
        )) as { results?: Array<Record<string, unknown>> };
        const rows = (res.results ?? []).map((r) => {
          const campaign = (r.campaign ?? {}) as Record<string, unknown>;
          const metrics = (r.metrics ?? {}) as Record<string, unknown>;
          const customer = (r.customer ?? {}) as Record<string, unknown>;
          return {
            campaignId: String(campaign.id ?? ""),
            name: campaign.name ?? "",
            status: campaign.status ?? "",
            cost: toInt64(metrics.costMicros) / 1_000_000,
            impressions: toInt64(metrics.impressions),
            clicks: toInt64(metrics.clicks),
            conversions: Number(metrics.conversions ?? 0),
            currency: customer.currencyCode ?? "",
          };
        });
        return { dateRange: range, campaigns: rows };
      }

      case "pause_campaign":
        return setCampaignStatus(ctx, a, "PAUSED");

      case "enable_campaign":
        return setCampaignStatus(ctx, a, "ENABLED");

      case "update_campaign_budget": {
        const customerId = normalizeCustomerId(adsRequireString(a.customer_id, "customer_id"));
        const campaignId = requireDigits(a.campaign_id, "campaign_id");
        const newDaily = adsRequireNumber(a.new_daily_budget, "new_daily_budget");
        const info = await fetchCampaignInfo(ctx, customerId, campaignId);
        const newMicros = Math.round(newDaily * 1_000_000);
        const deltaMinor = minorFromMicros(newMicros - info.amountMicros);
        if (deltaMinor === 0) {
          return { ok: true, note: "Budget already at the requested amount." };
        }
        const kind = deltaMinor > 0 ? ("budget_increase" as const) : ("budget_decrease" as const);
        await enforceAdsMutation({
          cfg: safetyOf(ctx),
          ctx,
          platform: "google-ads",
          platformLabel: "Google Ads",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency: info.currency,
          description: `Change daily budget of "${info.name}" (${campaignId}) from ${formatMinor(minorFromMicros(info.amountMicros), info.currency)} to ${formatMinor(minorFromMicros(newMicros), info.currency)}`,
          adAccountRef: customerId,
          campaignRef: campaignId,
          beforeState: { status: info.status, amountMicros: info.amountMicros },
        });
        await adsFetch(ctx, `/customers/${customerId}/campaignBudgets:mutate`, {
          method: "POST",
          body: {
            operations: [
              {
                updateMask: "amountMicros",
                update: {
                  resourceName: info.budgetResourceName,
                  amountMicros: String(newMicros),
                },
              },
            ],
          },
        });
        await recordAdsMutation(ctx, {
          toolName: "update_campaign_budget",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency: info.currency,
          adAccountRef: customerId,
          campaignRef: campaignId,
          summary: `Daily budget of "${info.name}" ${deltaMinor > 0 ? "raised" : "lowered"} to ${formatMinor(minorFromMicros(newMicros), info.currency)}`,
        });
        return {
          ok: true,
          campaignId,
          previousDailyBudget: info.amountMicros / 1_000_000,
          newDailyBudget: newMicros / 1_000_000,
          currency: info.currency,
        };
      }

      default:
        throw new Error(`Unknown Google Ads tool: ${name}`);
    }
  },
};

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

async function setCampaignStatus(
  ctx: IntegrationRuntimeContext,
  a: Record<string, unknown>,
  status: "ENABLED" | "PAUSED",
): Promise<unknown> {
  const customerId = normalizeCustomerId(adsRequireString(a.customer_id, "customer_id"));
  const campaignId = requireDigits(a.campaign_id, "campaign_id");
  const info = await fetchCampaignInfo(ctx, customerId, campaignId);
  if (info.status === status) {
    return { ok: true, note: `Campaign is already ${status}.` };
  }
  const budgetMinor = minorFromMicros(info.amountMicros);
  const kind = status === "ENABLED" ? ("campaign_enable" as const) : ("campaign_pause" as const);
  await enforceAdsMutation({
    cfg: safetyOf(ctx),
    ctx,
    platform: "google-ads",
    platformLabel: "Google Ads",
    mutationKind: kind,
    amountMinor: status === "ENABLED" ? budgetMinor : -budgetMinor,
    currency: info.currency,
    description: `${status === "ENABLED" ? "Enable" : "Pause"} campaign "${info.name}" (${campaignId}) — daily budget ${formatMinor(budgetMinor, info.currency)}`,
    adAccountRef: customerId,
    campaignRef: campaignId,
    beforeState: { status: info.status, amountMicros: info.amountMicros },
  });
  await adsFetch(ctx, `/customers/${customerId}/campaigns:mutate`, {
    method: "POST",
    body: {
      operations: [
        {
          updateMask: "status",
          update: {
            resourceName: `customers/${customerId}/campaigns/${campaignId}`,
            status,
          },
        },
      ],
    },
  });
  await recordAdsMutation(ctx, {
    toolName: status === "ENABLED" ? "enable_campaign" : "pause_campaign",
    mutationKind: kind,
    amountMinor: status === "ENABLED" ? budgetMinor : -budgetMinor,
    currency: info.currency,
    adAccountRef: customerId,
    campaignRef: campaignId,
    summary: `Campaign "${info.name}" set to ${status}`,
  });
  return { ok: true, campaignId, previousStatus: info.status, newStatus: status };
}

type CampaignInfo = {
  name: string;
  status: string;
  channelType: string;
  budgetResourceName: string;
  amountMicros: number;
  currency: string;
};

async function fetchCampaignInfo(
  ctx: IntegrationRuntimeContext,
  customerId: string,
  campaignId: string,
): Promise<CampaignInfo> {
  const res = (await searchGaql(
    ctx,
    customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.amount_micros, customer.currency_code FROM campaign WHERE campaign.id = ${campaignId}`,
  )) as { results?: Array<Record<string, unknown>> };
  const row = res.results?.[0];
  if (!row) {
    throw new Error(`Campaign ${campaignId} not found in customer ${customerId}.`);
  }
  const campaign = (row.campaign ?? {}) as Record<string, unknown>;
  const budget = (row.campaignBudget ?? {}) as Record<string, unknown>;
  const customer = (row.customer ?? {}) as Record<string, unknown>;
  return {
    name: String(campaign.name ?? campaignId),
    status: String(campaign.status ?? "UNKNOWN"),
    channelType: String(campaign.advertisingChannelType ?? ""),
    budgetResourceName: String(budget.resourceName ?? ""),
    amountMicros: toInt64(budget.amountMicros),
    currency: String(customer.currencyCode ?? ""),
  };
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

async function searchGaql(
  ctx: IntegrationRuntimeContext,
  customerId: string,
  query: string,
  pageToken?: string,
): Promise<unknown> {
  return adsFetch(ctx, `/customers/${customerId}/googleAds:search`, {
    method: "POST",
    body: { query, ...(pageToken ? { pageToken } : {}) },
  });
}

async function adsFetch(
  ctx: IntegrationRuntimeContext,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const cfg = ctx.config as unknown as GoogleAdsConfig;
  if (!cfg.developerToken) {
    throw new Error(
      "This connection has no Google Ads developer token — reconnect and fill it in.",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${currentGoogleAccessToken(ctx)}`,
    "developer-token": cfg.developerToken,
    accept: "application/json",
  };
  if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId;
  const reqInit: RequestInit = { method: init.method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await fetch(`${ADS_API}${path}`, reqInit);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body — fall through to the status check
  }
  if (!res.ok) {
    throw new Error(googleAdsErrorMessage(res.status, parsed, text));
  }
  return parsed ?? {};
}

function googleAdsErrorMessage(status: number, parsed: unknown, raw: string): string {
  let msg = "";
  if (parsed && typeof parsed === "object") {
    const err = (parsed as { error?: { message?: string; details?: unknown[] } }).error;
    if (err?.message) msg = err.message;
    // Google Ads failures carry per-operation errors in details.
    const details = Array.isArray(err?.details) ? err.details : [];
    for (const d of details) {
      const errors = (d as { errors?: Array<{ message?: string }> }).errors;
      if (Array.isArray(errors) && errors[0]?.message) {
        msg = `${msg ? msg + " — " : ""}${errors[0].message}`;
        break;
      }
    }
  }
  if (!msg) msg = raw.slice(0, 300) || `HTTP ${status}`;
  if (status === 404) {
    msg += ` (Google Ads API ${GOOGLE_ADS_API_VERSION} may have been sunset — check for a Genosyn upgrade.)`;
  }
  return `Google Ads: ${msg}`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function safetyOf(ctx: IntegrationRuntimeContext): AdsSafetyConfig {
  return ctx.config as unknown as GoogleAdsConfig;
}

function assertAdsScope(grantedScope: string): void {
  if (!grantedScope.includes("auth/adwords")) {
    throw new Error(
      "This connection is missing the Google Ads scope. Reconnect and grant Google Ads access.",
    );
  }
}

/** GAQL is read-only by design, but reject anything that isn't a SELECT so
 *  a prompt-injected "query" can't smuggle another verb. */
function assertReadOnlyGaql(query: string): void {
  if (!/^\s*SELECT\s/i.test(query)) {
    throw new Error("run_gaql only accepts SELECT queries.");
  }
}

function normalizeCustomerId(v: string, opts: { optional?: boolean } = {}): string {
  const digits = v.replace(/-/g, "").trim();
  if (!digits && opts.optional) return "";
  if (!/^\d{6,12}$/.test(digits)) {
    throw new Error(
      `Invalid customer id "${v}" — expected digits, e.g. "1234567890" or "123-456-7890".`,
    );
  }
  return digits;
}

function requireDigits(v: unknown, name: string): string {
  const s = adsRequireString(v, name);
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be numeric.`);
  return s;
}

/** REST JSON serializes int64 as strings; metrics come back that way. */
function toInt64(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
