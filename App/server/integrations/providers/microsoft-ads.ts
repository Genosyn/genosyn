import unzipper from "unzipper";
import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationTool,
  OauthTokenSet,
} from "../types.js";
import { getPublicUrl } from "../../services/publicUrl.js";
import {
  ADS_SAFETY_FIELDS,
  adsClampInt,
  adsRequireNumber,
  adsRequireString,
  enforceAdsMutation,
  formatMinor,
  parseAdsSafetyFields,
  recordAdsMutation,
  type AdsSafetyConfig,
} from "./ads-shared.js";

/**
 * Microsoft Advertising (Bing Ads) — read-first campaign visibility plus the
 * same deliberately tiny, approval-gated mutation surface as google-ads
 * (pause / enable / budget change).
 *
 * Auth is the Microsoft identity platform (`login.microsoftonline.com`)
 * with the single `msads.manage` scope; each Connection brings its own
 * Entra app registration (clientId + clientSecret). Three Microsoft-Ads
 * specific credentials ride the connect form as OAuth extra fields:
 *
 *   • **Developer token** — issued per user at ads.microsoft.com →
 *     Settings → Dev Settings. Requires the Super Admin role; approval is
 *     instant for first-party (own-account) use.
 *   • **Customer id** — the parent customer (manager) id, sent as the
 *     `CustomerId` header on every call.
 *   • **Customer account id** — the ad account's ACCOUNT ID, sent as the
 *     `CustomerAccountId` header. The classic trap: this is the numeric id
 *     (`aid=` in the ads.microsoft.com URL), NOT the 8-character account
 *     NUMBER like "X0123456" shown in the UI.
 *
 * Transport is the Bing Ads REST interface (v13) with JSON — plain fetch,
 * no SDK, no SOAP (the SOAP surface sunsets January 2027). Campaign
 * Management endpoints are JSON POST/PUTs named after operations
 * (`Campaigns/QueryByAccountId`, …); Reporting is the async
 * Submit → Poll → download-ZIP flow. Every spend-increasing change
 * defaults to a human Approval (see `ads-shared.ts`).
 */

const MICROSOFT_AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/** Campaign Management REST base (verified: learn.microsoft.com/en-us/
 *  advertising/campaign-management-service/getcampaignsbyaccountid, REST
 *  pivot). Operations are POSTs to `/Campaigns/QueryByAccountId` etc.;
 *  UpdateCampaigns is a PUT to `/Campaigns`. */
const CAMPAIGN_API = "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13";
/** Reporting REST base — Submit/Poll live under `/GenerateReport/…`. */
const REPORTING_API = "https://reporting.api.bingads.microsoft.com/Reporting/v13";
/** Customer Management REST base — only used (best-effort) to read the
 *  account's currency code for the spend ledger. */
const CUSTOMER_API = "https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13";

/**
 * Baseline scopes cover everything — Microsoft Advertising has exactly one
 * API scope (`msads.manage`), so there are no optional scope bundles.
 * `offline_access` unlocks refresh tokens; `openid profile email` populate
 * the id_token claims we use for the account hint.
 */
const MICROSOFT_ADS_BASELINE_SCOPES = [
  "https://ads.microsoft.com/msads.manage",
  "offline_access",
  "openid",
  "profile",
  "email",
];

/**
 * QueryByAccountId/QueryByIds default to *Search campaigns only* when
 * CampaignType is omitted — an easy way to silently miss a runaway
 * Performance Max campaign. Always ask for every type (space-delimited
 * flags, per the v13 CampaignType docs).
 */
const ALL_CAMPAIGN_TYPES = "Search Shopping DynamicSearchAds Audience Hotel PerformanceMax App";

// ---------- Config shape ----------

export type MicrosoftOauthConfig = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch. Renewed on refresh. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  /** email / preferred_username from the id_token — the account hint. */
  username: string;
  /** Scope-group keys the user picked, persisted for reconnect prefill.
   *  Always empty for Microsoft Ads (no optional bundles) — kept for
   *  symmetry with the other OAuth providers. */
  scopeGroups?: string[];
};

type MicrosoftAdsConfig = MicrosoftOauthConfig &
  AdsSafetyConfig & {
    developerToken: string;
    /** Parent customer (manager) id — `CustomerId` header, digits only. */
    customerId: string;
    /** Ad account id — `CustomerAccountId` header, digits only. */
    customerAccountId: string;
  };

// ---------- OAuth helpers (used by services/oauth.ts) ----------

export function microsoftRedirectUri(): string {
  const base = getPublicUrl();
  return `${base}/api/integrations/oauth/callback/microsoft`;
}

/**
 * Resolve scope-group keys → flat scope list. The baseline already covers
 * everything (there are no optional bundles), so this just returns it —
 * the signature exists for symmetry with resolveXScopes and friends.
 */
export function resolveMicrosoftScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  return Array.from(new Set(args.baseline));
}

export function buildMicrosoftAuthorizeUrl(args: {
  state: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
}): string {
  if (!args.clientId) throw new Error("clientId is required");
  const u = new URL(MICROSOFT_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("scope", args.scopes.join(" "));
  u.searchParams.set("state", args.state);
  // Force the consent screen so Microsoft always issues a refresh token,
  // even when the user consented on an earlier (since-disconnected) run.
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

export async function exchangeMicrosoftCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ tokens: OauthTokenSet; userInfo: Record<string, unknown> }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
  });
  const res = await fetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(tokenErrorMessage(parsed, `Token exchange failed: ${res.status}`));
  }
  const access = strField(parsed, "access_token");
  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const scope = typeof parsed.scope === "string" ? parsed.scope : "";

  // Identity comes from the id_token (we requested openid/profile/email).
  // Plain base64url decode, NO signature verification — the token arrived
  // directly from Microsoft's token endpoint over TLS in this very
  // response, so there is nothing to verify it against; we only read
  // display claims for the account hint.
  const userInfo =
    typeof parsed.id_token === "string" ? decodeIdTokenClaims(parsed.id_token) : {};

  return {
    tokens: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + expiresIn * 1000,
      scope,
      tokenType: "Bearer",
    },
    userInfo,
  };
}

/** Decode a JWT payload (middle segment) with base64url. Returns {} on any
 *  malformed input rather than failing the whole handshake — the claims
 *  are cosmetic (account hint only). */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  try {
    const payload = idToken.split(".")[1] ?? "";
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- Token lifecycle ----------

/**
 * Refresh the access token when it is within 5 minutes of expiry.
 * Microsoft rotates refresh tokens (sliding ~90-day expiry), so the new
 * refresh token MUST be persisted via `ctx.setConfig` — reusing the old
 * one eventually strands the Connection.
 */
async function ensureFreshMicrosoftToken(ctx: IntegrationRuntimeContext): Promise<void> {
  if (ctx.authMode !== "oauth2") {
    throw new Error(`Microsoft Ads connector does not support authMode "${ctx.authMode}"`);
  }
  const cfg = ctx.config as unknown as MicrosoftAdsConfig;
  if (cfg.expiresAt > Date.now() + 5 * 60_000) return;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Connection is missing OAuth client credentials — disconnect and reconnect.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const res = await fetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    if (parsed && parsed.error === "invalid_grant") {
      throw new Error(
        "Microsoft Ads: re-connect needed (refresh token expired — Microsoft invalidates them after ~90 days offline). Reconnect from Settings → Integrations.",
      );
    }
    throw new Error(
      tokenErrorMessage(parsed, `Microsoft token refresh failed: ${res.status}`),
    );
  }
  const access = strField(parsed, "access_token");
  // Microsoft rotates the refresh token on every refresh; fall back to the
  // stored one only if (unexpectedly) none came back.
  const refresh =
    typeof parsed.refresh_token === "string" && parsed.refresh_token
      ? parsed.refresh_token
      : cfg.refreshToken;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const scope = typeof parsed.scope === "string" ? parsed.scope : cfg.scope;
  const next: MicrosoftAdsConfig = {
    ...cfg,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

// ---------- Tool list ----------

const tools: IntegrationTool[] = [
  {
    name: "list_campaigns",
    description:
      "List campaigns in the connected ad account (all campaign types) with status, budget type, daily budget, and time zone. The account is pinned by the Connection's Customer account id.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Max campaigns to return (default 100).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_campaign",
    description:
      "Fetch one campaign's live state: status, campaign type, and daily budget. Read this before proposing any mutation.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string", description: "Numeric campaign id." },
      },
      required: ["campaign_id"],
      additionalProperties: false,
    },
  },
  {
    name: "spend_summary",
    description:
      "Per-campaign spend, impressions, clicks, and conversions for the last 7 days (Microsoft's report pipeline is asynchronous — if the report is still generating this returns {status:\"pending\"}; call again in a minute). `aggregation` \"Summary\" gives one row per campaign, \"Daily\" one row per campaign per day.",
    inputSchema: {
      type: "object",
      properties: {
        aggregation: {
          type: "string",
          enum: ["Summary", "Daily"],
          description: "Report aggregation (default Summary).",
        },
      },
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
        campaign_id: { type: "string" },
      },
      required: ["campaign_id"],
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
        campaign_id: { type: "string" },
      },
      required: ["campaign_id"],
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
        campaign_id: { type: "string" },
        new_daily_budget: {
          type: "number",
          exclusiveMinimum: 0,
          description: "New daily budget in currency units.",
        },
      },
      required: ["campaign_id", "new_daily_budget"],
      additionalProperties: false,
    },
  },
];

// ---------- Provider ----------

export const microsoftAdsProvider: IntegrationProvider = {
  catalog: {
    provider: "microsoft-ads",
    name: "Microsoft Advertising",
    category: "Analytics",
    tagline: "Bing Ads spend, pacing reports, and approval-gated budget levers.",
    description:
      "Connect Microsoft Advertising (Bing Ads) so AI employees can watch campaign spend and pacing, and — behind per-Connection caps and human approvals — pause/enable campaigns and change budgets. Needs your own Entra app registration (clientId + clientSecret), a developer token from Dev Settings, your parent customer id, and the ad account's ACCOUNT ID (not the account number). Uses the v13 REST interface only.",
    icon: "Megaphone",
    authMode: "oauth2",
    oauth: {
      app: "microsoft",
      scopes: MICROSOFT_ADS_BASELINE_SCOPES,
      extraFields: [
        {
          key: "developerToken",
          label: "Developer token",
          type: "password",
          placeholder: "from Dev Settings",
          required: true,
          hint: "ads.microsoft.com → Settings → Dev Settings. Requires the Super Admin role; approval is instant for first-party (own-account) use.",
        },
        {
          key: "customerId",
          label: "Customer id",
          type: "text",
          placeholder: "123456789",
          required: true,
          hint: "The parent customer (manager) id, digits only — the cid= value in the ads.microsoft.com URL.",
        },
        {
          key: "customerAccountId",
          label: "Customer account id",
          type: "text",
          placeholder: "987654321",
          required: true,
          hint: "The ad account's ACCOUNT ID, digits only (the aid= value in the URL) — NOT the 8-character account number like \"X0123456\" shown in the UI.",
        },
        ...ADS_SAFETY_FIELDS,
      ],
      setupDocs: "https://learn.microsoft.com/en-us/advertising/guides/get-started",
    },
    enabled: true,
  },

  tools,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups, extraFields }) {
    if (!tokens.refreshToken) {
      throw new Error(
        "Microsoft did not return a refresh token. Make sure 'offline_access' is among the requested scopes and retry the consent screen.",
      );
    }
    const developerToken = (extraFields?.developerToken ?? "").trim();
    if (!developerToken) {
      throw new Error("Developer token is required for Microsoft Advertising.");
    }
    const customerId = normalizeMsId(extraFields?.customerId ?? "", "Customer id");
    const customerAccountId = normalizeMsId(
      extraFields?.customerAccountId ?? "",
      "Customer account id",
    );
    const safety = parseAdsSafetyFields(extraFields ?? {});
    const email =
      typeof userInfo.email === "string" && userInfo.email
        ? userInfo.email
        : typeof userInfo.preferred_username === "string"
          ? userInfo.preferred_username
          : "";
    const name = typeof userInfo.name === "string" ? userInfo.name : "";
    const username = email || name;
    const cfg: MicrosoftAdsConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      username,
      scopeGroups,
      developerToken,
      customerId,
      customerAccountId,
      ...safety,
    };
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: username || "Microsoft Advertising",
    };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshMicrosoftToken(ctx);
      // Cheapest authenticated round-trip that also validates the
      // developer token and both id headers.
      await campaignFetch(ctx, "POST", "/Campaigns/QueryByAccountId", {
        AccountId: accountIdOf(ctx),
        CampaignType: ALL_CAMPAIGN_TYPES,
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
    await ensureFreshMicrosoftToken(ctx);
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_campaigns": {
        const limit = adsClampInt(a.limit, 1, 1000, 100);
        const res = (await campaignFetch(ctx, "POST", "/Campaigns/QueryByAccountId", {
          AccountId: accountIdOf(ctx),
          CampaignType: ALL_CAMPAIGN_TYPES,
        })) as { Campaigns?: Array<Record<string, unknown> | null> };
        const rows = (res.Campaigns ?? [])
          .filter((c): c is Record<string, unknown> => c != null)
          .slice(0, limit)
          .map((c) => ({
            id: String(c.Id ?? ""),
            name: String(c.Name ?? ""),
            status: String(c.Status ?? ""),
            campaignType: String(c.CampaignType ?? ""),
            budgetType: String(c.BudgetType ?? ""),
            dailyBudget: toNumber(c.DailyBudget),
            timeZone: String(c.TimeZone ?? ""),
          }));
        return { accountId: configOf(ctx).customerAccountId, campaigns: rows };
      }

      case "get_campaign": {
        const campaignId = requireDigits(a.campaign_id, "campaign_id");
        const info = await fetchCampaignInfo(ctx, campaignId);
        return {
          campaignId,
          name: info.name,
          status: info.status,
          campaignType: info.campaignType,
          budgetType: info.budgetType,
          dailyBudget: info.dailyBudget,
        };
      }

      case "spend_summary": {
        const aggregation = strEnum(a.aggregation, ["Summary", "Daily"], "Summary")!;
        return spendSummary(ctx, aggregation);
      }

      case "pause_campaign":
        return setCampaignStatus(ctx, a, "Paused");

      case "enable_campaign":
        return setCampaignStatus(ctx, a, "Active");

      case "update_campaign_budget": {
        const campaignId = requireDigits(a.campaign_id, "campaign_id");
        const newDaily = adsRequireNumber(a.new_daily_budget, "new_daily_budget");
        const info = await fetchCampaignInfo(ctx, campaignId);
        if (info.sharedBudgetId) {
          throw new Error(
            `Microsoft Ads: campaign "${info.name}" uses a shared budget (id ${info.sharedBudgetId}) — its DailyBudget cannot be set per-campaign. Change the shared budget in the Microsoft Advertising UI.`,
          );
        }
        // Microsoft's DailyBudget is already in currency units (a decimal),
        // unlike Google's micros — minor units are a plain ×100.
        const deltaMinor = Math.round((newDaily - info.dailyBudget) * 100);
        if (deltaMinor === 0) {
          return { ok: true, note: "Budget already at the requested amount." };
        }
        const currency = await getAccountCurrency(ctx);
        const kind = deltaMinor > 0 ? ("budget_increase" as const) : ("budget_decrease" as const);
        await enforceAdsMutation({
          cfg: safetyOf(ctx),
          ctx,
          platform: "microsoft-ads",
          platformLabel: "Microsoft Advertising",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency,
          description: `Change daily budget of "${info.name}" (${campaignId}) from ${formatMinor(Math.round(info.dailyBudget * 100), currency)} to ${formatMinor(Math.round(newDaily * 100), currency)}`,
          adAccountRef: configOf(ctx).customerAccountId,
          campaignRef: campaignId,
          beforeState: { status: info.status, dailyBudget: info.dailyBudget },
        });
        await updateCampaign(ctx, { Id: Number(campaignId), DailyBudget: newDaily });
        await recordAdsMutation(ctx, {
          toolName: "update_campaign_budget",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency,
          adAccountRef: configOf(ctx).customerAccountId,
          campaignRef: campaignId,
          summary: `Daily budget of "${info.name}" ${deltaMinor > 0 ? "raised" : "lowered"} to ${formatMinor(Math.round(newDaily * 100), currency)}`,
        });
        return {
          ok: true,
          campaignId,
          previousDailyBudget: info.dailyBudget,
          newDailyBudget: newDaily,
          currency,
        };
      }

      default:
        throw new Error(`Unknown Microsoft Advertising tool: ${name}`);
    }
  },
};

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

async function setCampaignStatus(
  ctx: IntegrationRuntimeContext,
  a: Record<string, unknown>,
  status: "Active" | "Paused",
): Promise<unknown> {
  const campaignId = requireDigits(a.campaign_id, "campaign_id");
  const info = await fetchCampaignInfo(ctx, campaignId);
  if (info.status === status) {
    return { ok: true, note: `Campaign is already ${status}.` };
  }
  const budgetMinor = Math.round(info.dailyBudget * 100);
  const currency = await getAccountCurrency(ctx);
  const kind = status === "Active" ? ("campaign_enable" as const) : ("campaign_pause" as const);
  await enforceAdsMutation({
    cfg: safetyOf(ctx),
    ctx,
    platform: "microsoft-ads",
    platformLabel: "Microsoft Advertising",
    mutationKind: kind,
    amountMinor: status === "Active" ? budgetMinor : -budgetMinor,
    currency,
    description: `${status === "Active" ? "Enable" : "Pause"} campaign "${info.name}" (${campaignId}) — daily budget ${formatMinor(budgetMinor, currency)}`,
    adAccountRef: configOf(ctx).customerAccountId,
    campaignRef: campaignId,
    beforeState: { status: info.status, dailyBudget: info.dailyBudget },
  });
  await updateCampaign(ctx, { Id: Number(campaignId), Status: status });
  await recordAdsMutation(ctx, {
    toolName: status === "Active" ? "enable_campaign" : "pause_campaign",
    mutationKind: kind,
    amountMinor: status === "Active" ? budgetMinor : -budgetMinor,
    currency,
    adAccountRef: configOf(ctx).customerAccountId,
    campaignRef: campaignId,
    summary: `Campaign "${info.name}" set to ${status}`,
  });
  return { ok: true, campaignId, previousStatus: info.status, newStatus: status };
}

/** PUT /Campaigns = UpdateCampaigns (partial update: Id + changed fields).
 *  A 200 can still carry per-item PartialErrors — surface the first one. */
async function updateCampaign(
  ctx: IntegrationRuntimeContext,
  campaign: Record<string, unknown>,
): Promise<void> {
  const res = (await campaignFetch(ctx, "PUT", "/Campaigns", {
    AccountId: accountIdOf(ctx),
    Campaigns: [campaign],
  })) as { PartialErrors?: Array<Record<string, unknown> | null> };
  const err = (res.PartialErrors ?? []).find((e) => e != null);
  if (err) {
    const msg = typeof err.Message === "string" ? err.Message : JSON.stringify(err);
    throw new Error(`Microsoft Ads: ${msg}`);
  }
}

type CampaignInfo = {
  name: string;
  status: string;
  campaignType: string;
  budgetType: string;
  dailyBudget: number;
  /** Set when the campaign uses a shared budget — DailyBudget is then
   *  read-only at the campaign level. */
  sharedBudgetId: string;
};

async function fetchCampaignInfo(
  ctx: IntegrationRuntimeContext,
  campaignId: string,
): Promise<CampaignInfo> {
  const res = (await campaignFetch(ctx, "POST", "/Campaigns/QueryByIds", {
    AccountId: accountIdOf(ctx),
    CampaignIds: [Number(campaignId)],
    CampaignType: ALL_CAMPAIGN_TYPES,
  })) as {
    Campaigns?: Array<Record<string, unknown> | null>;
    PartialErrors?: Array<Record<string, unknown> | null>;
  };
  const c = res.Campaigns?.find((x) => x != null);
  if (!c) {
    const err = (res.PartialErrors ?? []).find((e) => e != null);
    const detail = err && typeof err.Message === "string" ? ` (${err.Message})` : "";
    throw new Error(
      `Campaign ${campaignId} not found in account ${configOf(ctx).customerAccountId}.${detail}`,
    );
  }
  return {
    name: String(c.Name ?? campaignId),
    status: String(c.Status ?? "Unknown"),
    campaignType: String(c.CampaignType ?? ""),
    budgetType: String(c.BudgetType ?? ""),
    dailyBudget: toNumber(c.DailyBudget),
    sharedBudgetId: c.BudgetId != null ? String(c.BudgetId) : "",
  };
}

// --------------------------------------------------------------------------
// Reporting (Submit → Poll → download ZIP → parse CSV)
// --------------------------------------------------------------------------

async function spendSummary(
  ctx: IntegrationRuntimeContext,
  aggregation: "Summary" | "Daily",
): Promise<unknown> {
  const accountId = accountIdOf(ctx);
  // TimePeriod only exists as a column when the aggregation is time-based.
  const columns = [
    ...(aggregation === "Daily" ? ["TimePeriod"] : []),
    "CampaignId",
    "CampaignName",
    "Spend",
    "Impressions",
    "Clicks",
    "Conversions",
  ];
  const submit = (await reportingFetch(ctx, "/GenerateReport/Submit", {
    ReportRequest: {
      Type: "CampaignPerformanceReportRequest",
      Format: "Csv",
      FormatVersion: "2.0",
      ReportName: "Genosyn spend summary",
      ReturnOnlyCompleteData: false,
      ExcludeReportHeader: true,
      ExcludeReportFooter: true,
      ExcludeColumnHeaders: false,
      Aggregation: aggregation,
      Columns: columns,
      Scope: { AccountIds: [accountId] },
      Time: { PredefinedTime: "LastSevenDays" },
    },
  })) as { ReportRequestId?: unknown };
  const requestId = String(submit.ReportRequestId ?? "");
  if (!requestId) {
    throw new Error("Microsoft Ads: SubmitGenerateReport returned no ReportRequestId.");
  }

  // Bounded poll: reports usually complete within a few seconds, but the
  // pipeline can lag. 6 polls × 2.5 s keeps the tool call under ~15 s; on
  // timeout the caller is told to simply call the tool again.
  let downloadUrl = "";
  let completed = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2500);
    const poll = (await reportingFetch(ctx, "/GenerateReport/Poll", {
      ReportRequestId: requestId,
    })) as { ReportRequestStatus?: { Status?: unknown; ReportDownloadUrl?: unknown } };
    const status = String(poll.ReportRequestStatus?.Status ?? "");
    if (status === "Success") {
      completed = true;
      downloadUrl = typeof poll.ReportRequestStatus?.ReportDownloadUrl === "string"
        ? poll.ReportRequestStatus.ReportDownloadUrl
        : "";
      break;
    }
    if (status === "Error") {
      throw new Error("Microsoft Ads: report generation failed — try spend_summary again.");
    }
    // status "Pending" (or blank) — keep polling.
  }
  if (!completed) {
    return {
      status: "pending",
      note: "Report still generating — call spend_summary again in a minute.",
    };
  }
  // Success with no URL means the account simply has no data in the range.
  if (!downloadUrl) {
    return { aggregation, period: "LAST_7_DAYS", campaigns: [], note: "No data for the last 7 days." };
  }

  // The download URL is pre-signed (no auth headers) and serves a ZIP
  // containing a single CSV.
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) {
    throw new Error(`Microsoft Ads: report download failed (HTTP ${dlRes.status}).`);
  }
  const zipBuf = Buffer.from(await dlRes.arrayBuffer());
  const dir = await unzipper.Open.buffer(zipBuf);
  const entry = dir.files.find((f) => /\.csv$/i.test(f.path)) ?? dir.files[0];
  if (!entry) {
    throw new Error("Microsoft Ads: report ZIP contained no files.");
  }
  const csv = (await entry.buffer()).toString("utf8");
  const currency = await getAccountCurrency(ctx);
  return {
    aggregation,
    period: "LAST_7_DAYS",
    currency,
    campaigns: parseSpendCsv(csv, aggregation === "Daily"),
  };
}

/**
 * Parse the report CSV. With header/footer excluded the first row is the
 * column header row, everything after is data. Report CSVs are simple, but
 * campaign names can contain commas, so fields are split with quote
 * awareness rather than a bare `split(",")`.
 */
function parseSpendCsv(
  csv: string,
  daily: boolean,
): Array<Record<string, unknown>> {
  const lines = csv
    .replace(/^\uFEFF/, "") // strip the UTF-8 BOM the report writer emits
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idx = {
    time: col("TimePeriod"),
    id: col("CampaignId"),
    name: col("CampaignName"),
    spend: col("Spend"),
    impressions: col("Impressions"),
    clicks: col("Clicks"),
    conversions: col("Conversions"),
  };
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const at = (j: number) => (j >= 0 && j < cells.length ? cells[j].trim() : "");
    rows.push({
      ...(daily && idx.time >= 0 ? { date: at(idx.time) } : {}),
      campaignId: at(idx.id),
      name: at(idx.name),
      spend: csvNumber(at(idx.spend)),
      impressions: csvNumber(at(idx.impressions)),
      clicks: csvNumber(at(idx.clicks)),
      conversions: csvNumber(at(idx.conversions)),
    });
  }
  return rows;
}

/** Split one CSV line, honoring double-quoted fields ("" = escaped quote). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvNumber(v: string): number {
  const n = Number(v.replace(/[",%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// --------------------------------------------------------------------------
// Account currency (best-effort)
// --------------------------------------------------------------------------

/** Currency never changes on an ad account — cache per account so the
 *  mutation path costs one extra call ever, not one per call. */
const currencyCache = new Map<string, string>();

/**
 * Customer Management GetAccount (REST): POST {CUSTOMER_API}/Account/Query
 * with {AccountId} → {Account: {..., CurrencyCode}}. This service only
 * documents Authorization + DeveloperToken as REST headers. Best-effort:
 * the spend ledger and cap messages degrade gracefully to a bare number
 * (formatMinor handles an empty currency) if this call fails.
 */
async function getAccountCurrency(ctx: IntegrationRuntimeContext): Promise<string> {
  const cfg = configOf(ctx);
  const key = `${cfg.customerId}:${cfg.customerAccountId}`;
  const cached = currencyCache.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(`${CUSTOMER_API}/Account/Query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        DeveloperToken: cfg.developerToken,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ AccountId: Number(cfg.customerAccountId) }),
    });
    if (!res.ok) return "";
    const parsed = (await safeJson(res)) as { Account?: { CurrencyCode?: unknown } } | null;
    const currency =
      typeof parsed?.Account?.CurrencyCode === "string" ? parsed.Account.CurrencyCode : "";
    if (currency) currencyCache.set(key, currency);
    return currency;
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

async function campaignFetch(
  ctx: IntegrationRuntimeContext,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<unknown> {
  return msAdsFetch(ctx, `${CAMPAIGN_API}${path}`, method, body);
}

async function reportingFetch(
  ctx: IntegrationRuntimeContext,
  path: string,
  body: unknown,
): Promise<unknown> {
  return msAdsFetch(ctx, `${REPORTING_API}${path}`, "POST", body);
}

/** Every Campaign Management / Reporting REST call carries the same four
 *  auth headers: Bearer token, DeveloperToken, CustomerId (manager),
 *  CustomerAccountId (ad account). */
async function msAdsFetch(
  ctx: IntegrationRuntimeContext,
  url: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<unknown> {
  const cfg = configOf(ctx);
  if (!cfg.developerToken || !cfg.customerId || !cfg.customerAccountId) {
    throw new Error(
      "This connection is missing its Microsoft Advertising developer token or ids — reconnect and fill them in.",
    );
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      DeveloperToken: cfg.developerToken,
      CustomerId: cfg.customerId,
      CustomerAccountId: cfg.customerAccountId,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body — fall through to the status check
  }
  if (!res.ok) {
    throw new Error(microsoftAdsErrorMessage(res.status, parsed, text));
  }
  return parsed ?? {};
}

/**
 * REST failures come back as an ApiFaultDetail-shaped JSON body carrying
 * `OperationErrors` and/or `BatchErrors` arrays ({Code, ErrorCode,
 * Message, …}); mutation 200s can additionally carry `PartialErrors`.
 * Extract the first message and decorate the two classic traps.
 */
function microsoftAdsErrorMessage(status: number, parsed: unknown, raw: string): string {
  let msg = "";
  let errorCode = "";
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const key of ["OperationErrors", "BatchErrors", "PartialErrors", "Errors"]) {
      const arr = o[key];
      if (!Array.isArray(arr)) continue;
      const first = arr.find((e) => e != null) as Record<string, unknown> | undefined;
      if (!first) continue;
      if (typeof first.Message === "string" && first.Message) msg = first.Message;
      if (typeof first.ErrorCode === "string") errorCode = first.ErrorCode;
      if (msg) break;
    }
    // OAuth-style bodies ({error, error_description}) can also surface here
    // when a gateway rejects the token before the service sees it.
    if (!msg && typeof o.error_description === "string") msg = o.error_description;
    if (!msg && typeof o.Message === "string") msg = o.Message;
  }
  if (!msg) msg = raw.slice(0, 300) || `HTTP ${status}`;
  if (status === 401) {
    msg +=
      " (Access token was rejected — the refresh may have failed; retry, or reconnect from Settings → Integrations.)";
  }
  if (errorCode === "InvalidCustomerAccountId" || /InvalidCustomerAccountId/i.test(msg)) {
    msg +=
      " (CustomerAccountId must be the numeric ACCOUNT ID — not the 8-character account number like \"X0123456\" shown in the UI.)";
  }
  return `Microsoft Ads: ${msg}`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function configOf(ctx: IntegrationRuntimeContext): MicrosoftAdsConfig {
  return ctx.config as unknown as MicrosoftAdsConfig;
}

function safetyOf(ctx: IntegrationRuntimeContext): AdsSafetyConfig {
  return ctx.config as unknown as MicrosoftAdsConfig;
}

/** AccountId body element as a number — Bing account ids are well below
 *  2^53, so Number is lossless here. */
function accountIdOf(ctx: IntegrationRuntimeContext): number {
  return Number(configOf(ctx).customerAccountId);
}

function normalizeMsId(v: string, label: string): string {
  const digits = v.replace(/[\s-]/g, "").trim();
  if (!/^\d{4,12}$/.test(digits)) {
    throw new Error(
      `${label} must be a numeric id (digits only), e.g. "123456789". Account NUMBERS like "X0123456" are not accepted.`,
    );
  }
  return digits;
}

function requireDigits(v: unknown, name: string): string {
  const s = adsRequireString(v, name);
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be numeric.`);
  return s;
}

/** REST JSON may serialize longs as strings or numbers depending on the
 *  field — normalize either into a plain number. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function strEnum<T extends string>(
  v: unknown,
  options: readonly T[],
  fallback?: T,
): T | undefined {
  if (typeof v === "string" && (options as readonly string[]).includes(v)) {
    return v as T;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`Microsoft response is missing "${key}".`);
  }
  return v;
}

function tokenErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  // Microsoft identity platform errors: { error, error_description }.
  const desc = (parsed as { error_description?: unknown }).error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string" && err) return err;
  return fallback;
}
