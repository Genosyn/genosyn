import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
  IntegrationTool,
} from "../types.js";
import type { RedditOauthConfig } from "./reddit.js";
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
 * Reddit Ads — read-first campaign visibility plus a deliberately tiny,
 * approval-gated mutation surface (pause / enable / ad-group budget change).
 *
 * Rides the shared `reddit` OAuth app the same way Google Ads rides the
 * `google` one: the user's own "web app" client from reddit.com/prefs/apps
 * authorizes both the organic Reddit integration and this one — each
 * Connection just asks for a different scope bundle. Reddit's Ads API
 * (https://ads-api.reddit.com/api/v3) takes the very same bearer token.
 *
 * Platform facts this module is built around:
 *
 *   • **Money is microcurrency.** `goal_value`, `spend_cap`, `bid_value`,
 *     and report SPEND/CPC/ECPM are all 1,000,000 per currency unit.
 *     Everything crossing the tool boundary is converted to currency units;
 *     everything crossing the spend-ledger boundary uses `ads-shared`'s
 *     minor-unit helpers.
 *   • **Budgets live on AD GROUPS** (`goal_type` DAILY_SPEND/LIFETIME_SPEND
 *     + `goal_value`), except CBO campaigns, which hold the budget at the
 *     campaign level. There is no separate budget resource to mutate.
 *   • **Reporting is a synchronous POST** to `/ad_accounts/{id}/reports`
 *     with `starts_at`/`ends_at` that MUST be hour-aligned RFC3339
 *     (`YYYY-MM-DDTHH:00:00Z`) — anything else is a 400.
 *   • **Pagination is cursor-based**: `page.size` (max 100) and a
 *     `pagination.next_url` to follow until absent.
 *   • **Rate limiting is a 429** with `X-RateLimit-*` headers and no
 *     `Retry-After`. We surface a "retry shortly" error instead of
 *     sleep-looping inside a tool call.
 *
 * Campaign/ad-group CREATION is deliberately absent: as of July 13 2026
 * Reddit requires a `conversion_pixel_id` on every new ad group and CBO
 * campaign, which means standing up a Reddit Pixel before the first object
 * can even be created — plus creatives need a profile post. That whole flow
 * belongs in the Ads Manager UI, not behind an AI employee. The tools here
 * only steer objects a human already built.
 */

const ADS_API = "https://ads-api.reddit.com/api/v3";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
/** Reddit blocks default fetch user agents; identify like the organic provider. */
const REDDIT_USER_AGENT = "genosyn/1.0 (by /u/genosyn-app)";

/** Hard ceiling on `pagination.next_url` follows per tool call. */
const MAX_PAGES = 10;

/** Goal types whose `goal_value` is monetary (microcurrency). */
const MONETARY_GOAL_TYPES = new Set(["DAILY_SPEND", "LIFETIME_SPEND"]);

/** Baseline scopes: `identity` powers /api/v1/me for the account hint, and
 *  `read` is part of Reddit's documented full-Ads-API scope recipe. */
const REDDIT_ADS_BASELINE_SCOPES = ["identity", "read"];

/**
 * The Ads API scopes: `adsread` covers every GET (accounts, campaigns, ad
 * groups, reports), `adsedit` covers POST/PATCH/DELETE, and `history` rides
 * along because Reddit's docs fold it into the full read recipe
 * ("adsread,history"). `adsconversions` (the Conversions API) is deliberately
 * NOT requested — no conversions tools ship here, so the token shouldn't be
 * able to touch pixels or server-side events.
 */
const REDDIT_ADS_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "ads",
    label: "Reddit Ads",
    description:
      "Read campaigns, ad groups, and spend reports; pause/enable campaigns and change ad-group budgets (mutations are approval-gated).",
    scopes: ["adsread", "adsedit", "history"],
    required: true,
  },
];

type RedditAdsConfig = RedditOauthConfig & AdsSafetyConfig;

const RANGE_PRESETS = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;

const tools: IntegrationTool[] = [
  {
    name: "list_ad_accounts",
    description:
      "List the Reddit Ads accounts the connected identity can access, with id, name, and currency. Use the id with every other tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_campaigns",
    description:
      "List campaigns in one ad account with objective, configured/effective status, lifetime spend cap, and — for CBO campaigns — the campaign-level budget. Money fields are in the account's currency units (converted from Reddit's microcurrency).",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Max campaigns to return (default 100).",
        },
      },
      required: ["ad_account_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_ad_groups",
    description:
      "List ad groups in one ad account, optionally filtered to one campaign. Budgets live on ad groups in Reddit's model: goal_type DAILY_SPEND/LIFETIME_SPEND with goal_value in the account's currency units (converted from microcurrency). Read this before proposing a budget change.",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        campaign_id: {
          type: "string",
          description: "Restrict to one campaign's ad groups.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Max ad groups to return (default 100).",
        },
      },
      required: ["ad_account_id"],
      additionalProperties: false,
    },
  },
  {
    name: "spend_summary",
    description:
      "Per-campaign spend, impressions, clicks, CPC, and CTR for a date range via the reporting endpoint. Costs are returned in the account's currency units (converted from microcurrency). Use for daily pacing checks.",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        date_range: {
          type: "string",
          enum: [...RANGE_PRESETS],
          description: "Preset range in UTC (default LAST_7_DAYS).",
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["ad_account_id"],
      additionalProperties: false,
    },
  },
  {
    name: "pause_campaign",
    description:
      "Pause a campaign (configured_status → PAUSED). Spend-DECREASING, so it never waits for approval — this is the emergency lever for a runaway campaign. Records the freed daily budget to the spend ledger.",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        campaign_id: { type: "string" },
      },
      required: ["ad_account_id", "campaign_id"],
      additionalProperties: false,
    },
  },
  {
    name: "enable_campaign",
    description:
      "Enable (un-pause) a campaign (configured_status → ACTIVE). Spend-INCREASING: authorizes spend at the campaign's current daily budget (its active ad groups' daily goals, or the campaign goal for CBO), so it goes through the Connection's caps and (by default) a human Approval.",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        campaign_id: { type: "string" },
      },
      required: ["ad_account_id", "campaign_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_ad_group_budget",
    description:
      "Change an ad group's daily budget (goal_value). `new_daily_budget` is in the account's currency units (e.g. 45.50). Only valid for ad groups with goal_type DAILY_SPEND — CBO campaigns hold the budget at the campaign level and are refused. Increases go through the Connection's caps and (by default) a human Approval; decreases apply immediately. Both are recorded to the spend ledger.",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        ad_group_id: { type: "string" },
        new_daily_budget: {
          type: "number",
          exclusiveMinimum: 0,
          description: "New daily budget in currency units.",
        },
      },
      required: ["ad_account_id", "ad_group_id", "new_daily_budget"],
      additionalProperties: false,
    },
  },
];

export const redditAdsProvider: IntegrationProvider = {
  catalog: {
    provider: "reddit-ads",
    name: "Reddit Ads",
    category: "Analytics",
    tagline: "Reddit campaign spend, pacing reports, and approval-gated budget levers.",
    description:
      "Connect Reddit Ads so AI employees can watch campaign spend and pacing, and — behind per-Connection caps and human approvals — pause/enable campaigns and change ad-group budgets. Uses the same per-Connection OAuth client as the organic Reddit integration (reddit.com/prefs/apps → 'web app'), just with the Ads API scopes. Reddit gates campaign management behind an Ads API allow-list for some accounts; reporting generally works for any advertiser account.",
    icon: "Megaphone",
    authMode: "oauth2",
    oauth: {
      app: "reddit",
      scopes: REDDIT_ADS_BASELINE_SCOPES,
      scopeGroups: REDDIT_ADS_SCOPE_GROUPS,
      extraFields: [...ADS_SAFETY_FIELDS],
      setupDocs: "https://ads-api.reddit.com/docs/v3/",
    },
    enabled: true,
  },

  tools,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups, extraFields }) {
    if (!tokens.refreshToken) {
      throw new Error(
        "Reddit did not return a refresh token. Make sure the OAuth client is type 'web app' and that `duration=permanent` was sent (Genosyn does this automatically).",
      );
    }
    const username = typeof userInfo.name === "string" ? userInfo.name : "";
    const userId = typeof userInfo.id === "string" ? userInfo.id : "";
    if (!username) {
      throw new Error("Reddit did not return user identity on /api/v1/me.");
    }
    const safety = parseAdsSafetyFields(extraFields ?? {});
    const cfg: RedditAdsConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      username,
      userId,
      scopeGroups,
      ...safety,
    };
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: `u/${username}`,
    };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshRedditAdsToken(ctx);
      await adsFetch(ctx, withQuery("/me/ad_accounts", { "page.size": 1 }), { method: "GET" });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    await ensureFreshRedditAdsToken(ctx);
    assertScope(ctx, "adsread");
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_ad_accounts": {
        const rows = await listPaged(ctx, "/me/ad_accounts", {}, 300);
        return {
          adAccounts: rows.map((r) => ({
            id: asStr(r.id),
            name: asStr(r.name),
            currency: asStr(r.currency),
          })),
        };
      }

      case "list_campaigns": {
        const accountId = adsRequireString(a.ad_account_id, "ad_account_id");
        const limit = adsClampInt(a.limit, 1, 500, 100);
        const account = await fetchAdAccount(ctx, accountId);
        const rows = await listPaged(
          ctx,
          `/ad_accounts/${encodeURIComponent(accountId)}/campaigns`,
          {},
          limit,
        );
        return {
          adAccountId: accountId,
          currency: account.currency,
          campaigns: rows.map((r) => ({
            campaignId: asStr(r.id),
            name: asStr(r.name),
            objective: asStr(r.objective),
            configuredStatus: asStr(r.configured_status),
            effectiveStatus: asStr(r.effective_status),
            // Lifetime cap in currency units; null when unset.
            spendCap: r.spend_cap == null ? null : asNum(r.spend_cap) / 1_000_000,
            // Set only on CBO campaigns — the budget lives here instead of
            // on the ad groups.
            goalType: r.goal_type == null ? null : asStr(r.goal_type),
            goalValue: r.goal_value == null ? null : asNum(r.goal_value) / 1_000_000,
          })),
        };
      }

      case "list_ad_groups": {
        const accountId = adsRequireString(a.ad_account_id, "ad_account_id");
        const campaignId = adsOptionalString(a.campaign_id);
        const limit = adsClampInt(a.limit, 1, 500, 100);
        const account = await fetchAdAccount(ctx, accountId);
        const rows = await listPaged(
          ctx,
          `/ad_accounts/${encodeURIComponent(accountId)}/ad_groups`,
          campaignId ? { campaign_id: campaignId } : {},
          limit,
        );
        return {
          adAccountId: accountId,
          currency: account.currency,
          adGroups: rows.map((r) => {
            const goalType = asStr(r.goal_type);
            return {
              adGroupId: asStr(r.id),
              name: asStr(r.name),
              campaignId: asStr(r.campaign_id),
              configuredStatus: asStr(r.configured_status),
              effectiveStatus: asStr(r.effective_status),
              goalType,
              // Monetary goals are microcurrency; other goal types (if any)
              // pass through unconverted.
              goalValue:
                r.goal_value == null
                  ? null
                  : MONETARY_GOAL_TYPES.has(goalType)
                    ? asNum(r.goal_value) / 1_000_000
                    : asNum(r.goal_value),
            };
          }),
        };
      }

      case "spend_summary": {
        const accountId = adsRequireString(a.ad_account_id, "ad_account_id");
        const range = adsOptionalString(a.date_range) ?? "LAST_7_DAYS";
        if (!(RANGE_PRESETS as readonly string[]).includes(range)) {
          throw new Error(`date_range must be one of ${RANGE_PRESETS.join(", ")}.`);
        }
        const limit = adsClampInt(a.limit, 1, 500, 200);
        const account = await fetchAdAccount(ctx, accountId);
        const { startsAt, endsAt } = presetRange(range);
        const rows = await runCampaignReport(ctx, accountId, startsAt, endsAt, limit);
        // The report keys rows by campaign_id only — join names from the
        // campaign list so the summary reads without a second tool call.
        const names = await campaignNameMap(ctx, accountId);
        return {
          dateRange: range,
          startsAt,
          endsAt,
          currency: account.currency,
          campaigns: rows.map((r) => {
            const campaignId = asStr(r.campaign_id ?? r.CAMPAIGN_ID);
            return {
              campaignId,
              name: names.get(campaignId) ?? "",
              spend: asNum(r.spend ?? r.SPEND) / 1_000_000,
              impressions: asNum(r.impressions ?? r.IMPRESSIONS),
              clicks: asNum(r.clicks ?? r.CLICKS),
              cpc: asNum(r.cpc ?? r.CPC) / 1_000_000,
              ctr: asNum(r.ctr ?? r.CTR),
              conversions: asNum(r.conversions ?? r.CONVERSIONS),
            };
          }),
        };
      }

      case "pause_campaign":
        return setCampaignStatus(ctx, a, "PAUSED");

      case "enable_campaign":
        return setCampaignStatus(ctx, a, "ACTIVE");

      case "update_ad_group_budget": {
        assertScope(ctx, "adsedit");
        const accountId = adsRequireString(a.ad_account_id, "ad_account_id");
        const adGroupId = adsRequireString(a.ad_group_id, "ad_group_id");
        const newDaily = adsRequireNumber(a.new_daily_budget, "new_daily_budget");
        const account = await fetchAdAccount(ctx, accountId);
        const info = await fetchAdGroupInfo(ctx, adGroupId);
        if (info.goalType !== "DAILY_SPEND") {
          throw new Error(
            info.isCbo
              ? `Ad group ${adGroupId} belongs to a CBO campaign — its budget lives at the campaign level, which this integration does not mutate. Change it in Reddit Ads Manager.`
              : `Ad group ${adGroupId} has goal_type ${info.goalType || "(none)"}, not DAILY_SPEND — update_ad_group_budget only edits daily-spend goals.`,
          );
        }
        const newMicros = Math.round(newDaily * 1_000_000);
        const deltaMinor = minorFromMicros(newMicros - info.goalValueMicro);
        if (deltaMinor === 0) {
          return { ok: true, note: "Budget already at the requested amount." };
        }
        const kind = deltaMinor > 0 ? ("budget_increase" as const) : ("budget_decrease" as const);
        await enforceAdsMutation({
          cfg: safetyOf(ctx),
          ctx,
          platform: "reddit-ads",
          platformLabel: "Reddit Ads",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency: account.currency,
          description: `Change daily budget of ad group "${info.name}" (${adGroupId}) from ${formatMinor(minorFromMicros(info.goalValueMicro), account.currency)} to ${formatMinor(minorFromMicros(newMicros), account.currency)}`,
          adAccountRef: accountId,
          campaignRef: info.campaignId,
          beforeState: { configuredStatus: info.configuredStatus, goalValueMicro: info.goalValueMicro },
        });
        await adsFetch(ctx, `/ad_groups/${encodeURIComponent(adGroupId)}`, {
          method: "PATCH",
          body: { data: { goal_value: newMicros } },
        });
        await recordAdsMutation(ctx, {
          toolName: "update_ad_group_budget",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency: account.currency,
          adAccountRef: accountId,
          campaignRef: info.campaignId,
          summary: `Daily budget of ad group "${info.name}" ${deltaMinor > 0 ? "raised" : "lowered"} to ${formatMinor(minorFromMicros(newMicros), account.currency)}`,
        });
        return {
          ok: true,
          adGroupId,
          previousDailyBudget: info.goalValueMicro / 1_000_000,
          newDailyBudget: newMicros / 1_000_000,
          currency: account.currency,
        };
      }

      default:
        throw new Error(`Unknown Reddit Ads tool: ${name}`);
    }
  },
};

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

async function setCampaignStatus(
  ctx: IntegrationRuntimeContext,
  a: Record<string, unknown>,
  status: "ACTIVE" | "PAUSED",
): Promise<unknown> {
  assertScope(ctx, "adsedit");
  const accountId = adsRequireString(a.ad_account_id, "ad_account_id");
  const campaignId = adsRequireString(a.campaign_id, "campaign_id");
  const account = await fetchAdAccount(ctx, accountId);
  const info = await fetchCampaignInfo(ctx, campaignId);
  if (info.configuredStatus === status) {
    return { ok: true, note: `Campaign is already ${status}.` };
  }
  // What an enable authorizes / a pause frees: the campaign's daily budget.
  // CBO campaigns hold it at the campaign level; otherwise it's the sum of
  // the ACTIVE ad groups' DAILY_SPEND goals. 0 still runs the gate — the
  // kill switch and approval default apply even to budget-less campaigns.
  const dailyMicro = await campaignDailySpendMicro(ctx, accountId, campaignId, info);
  const budgetMinor = minorFromMicros(dailyMicro);
  const kind = status === "ACTIVE" ? ("campaign_enable" as const) : ("campaign_pause" as const);
  await enforceAdsMutation({
    cfg: safetyOf(ctx),
    ctx,
    platform: "reddit-ads",
    platformLabel: "Reddit Ads",
    mutationKind: kind,
    amountMinor: status === "ACTIVE" ? budgetMinor : -budgetMinor,
    currency: account.currency,
    description: `${status === "ACTIVE" ? "Enable" : "Pause"} campaign "${info.name}" (${campaignId}) — daily budget ${formatMinor(budgetMinor, account.currency)}`,
    adAccountRef: accountId,
    campaignRef: campaignId,
    beforeState: { configuredStatus: info.configuredStatus, dailySpendMinor: budgetMinor },
  });
  await adsFetch(ctx, `/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "PATCH",
    body: { data: { configured_status: status } },
  });
  await recordAdsMutation(ctx, {
    toolName: status === "ACTIVE" ? "enable_campaign" : "pause_campaign",
    mutationKind: kind,
    amountMinor: status === "ACTIVE" ? budgetMinor : -budgetMinor,
    currency: account.currency,
    adAccountRef: accountId,
    campaignRef: campaignId,
    summary: `Campaign "${info.name}" set to ${status}`,
  });
  return { ok: true, campaignId, previousStatus: info.configuredStatus, newStatus: status };
}

// --------------------------------------------------------------------------
// Entity reads
// --------------------------------------------------------------------------

type AdAccountInfo = { id: string; name: string; currency: string };

async function fetchAdAccount(
  ctx: IntegrationRuntimeContext,
  accountId: string,
): Promise<AdAccountInfo> {
  const res = (await adsFetch(ctx, `/ad_accounts/${encodeURIComponent(accountId)}`, {
    method: "GET",
  })) as { data?: Record<string, unknown> };
  const d = res.data ?? {};
  const id = asStr(d.id);
  if (!id) throw new Error(`Ad account ${accountId} not found or not accessible.`);
  return { id, name: asStr(d.name), currency: asStr(d.currency) };
}

type CampaignInfo = {
  name: string;
  configuredStatus: string;
  effectiveStatus: string;
  objective: string;
  goalType: string;
  goalValueMicro: number;
};

async function fetchCampaignInfo(
  ctx: IntegrationRuntimeContext,
  campaignId: string,
): Promise<CampaignInfo> {
  const res = (await adsFetch(ctx, `/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "GET",
  })) as { data?: Record<string, unknown> };
  const d = res.data ?? {};
  if (!asStr(d.id)) throw new Error(`Campaign ${campaignId} not found or not accessible.`);
  return {
    name: asStr(d.name) || campaignId,
    configuredStatus: asStr(d.configured_status) || "UNKNOWN",
    effectiveStatus: asStr(d.effective_status),
    objective: asStr(d.objective),
    goalType: asStr(d.goal_type),
    goalValueMicro: asNum(d.goal_value),
  };
}

type AdGroupInfo = {
  name: string;
  campaignId: string;
  configuredStatus: string;
  goalType: string;
  goalValueMicro: number;
  isCbo: boolean;
};

async function fetchAdGroupInfo(
  ctx: IntegrationRuntimeContext,
  adGroupId: string,
): Promise<AdGroupInfo> {
  const res = (await adsFetch(ctx, `/ad_groups/${encodeURIComponent(adGroupId)}`, {
    method: "GET",
  })) as { data?: Record<string, unknown> };
  const d = res.data ?? {};
  if (!asStr(d.id)) throw new Error(`Ad group ${adGroupId} not found or not accessible.`);
  return {
    name: asStr(d.name) || adGroupId,
    campaignId: asStr(d.campaign_id),
    configuredStatus: asStr(d.configured_status) || "UNKNOWN",
    goalType: asStr(d.goal_type),
    goalValueMicro: asNum(d.goal_value),
    isCbo: d.is_campaign_budget_optimization === true,
  };
}

/**
 * The daily spend a campaign authorizes while ACTIVE, in microcurrency.
 * CBO campaigns carry a campaign-level DAILY_SPEND goal; everything else
 * sums the campaign's ACTIVE ad groups' DAILY_SPEND goals. LIFETIME_SPEND
 * goals are deliberately excluded — they're not a daily rate.
 */
async function campaignDailySpendMicro(
  ctx: IntegrationRuntimeContext,
  accountId: string,
  campaignId: string,
  info: CampaignInfo,
): Promise<number> {
  if (info.goalType === "DAILY_SPEND" && info.goalValueMicro > 0) {
    return info.goalValueMicro;
  }
  const groups = await listPaged(
    ctx,
    `/ad_accounts/${encodeURIComponent(accountId)}/ad_groups`,
    { campaign_id: campaignId },
    500,
  );
  let total = 0;
  for (const g of groups) {
    if (asStr(g.configured_status) !== "ACTIVE") continue;
    if (asStr(g.goal_type) !== "DAILY_SPEND") continue;
    total += asNum(g.goal_value);
  }
  return total;
}

// --------------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------------

/**
 * Run the per-campaign spend report. The v3 reports endpoint is synchronous —
 * POST the query, get `data.metrics` back — so there's no job to poll. Pages
 * (if any) are followed via `pagination.next_url` re-POSTing the same body.
 */
async function runCampaignReport(
  ctx: IntegrationRuntimeContext,
  accountId: string,
  startsAt: string,
  endsAt: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const body = {
    data: {
      breakdowns: ["CAMPAIGN_ID"],
      fields: ["CAMPAIGN_ID", "SPEND", "IMPRESSIONS", "CLICKS", "CPC", "CTR", "CONVERSIONS"],
      starts_at: startsAt,
      ends_at: endsAt,
      time_zone_id: "UTC",
    },
  };
  const rows: Array<Record<string, unknown>> = [];
  let url = withQuery(`/ad_accounts/${encodeURIComponent(accountId)}/reports`, {
    "page.size": 100,
  });
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = (await adsFetch(ctx, url, { method: "POST", body })) as {
      data?: { metrics?: unknown };
      pagination?: { next_url?: unknown };
    };
    const metrics = Array.isArray(res.data?.metrics) ? res.data.metrics : [];
    for (const m of metrics) {
      if (m && typeof m === "object") rows.push(m as Record<string, unknown>);
    }
    if (rows.length >= limit) break;
    const next = res.pagination?.next_url;
    url = typeof next === "string" && next.startsWith(ADS_API) ? next : "";
  }
  return rows.slice(0, limit);
}

/** id → name for the account's campaigns, bounded — a best-effort join for
 *  spend_summary rows (missing entries render as ""). */
async function campaignNameMap(
  ctx: IntegrationRuntimeContext,
  accountId: string,
): Promise<Map<string, string>> {
  const rows = await listPaged(
    ctx,
    `/ad_accounts/${encodeURIComponent(accountId)}/campaigns`,
    {},
    300,
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    const id = asStr(r.id);
    if (id) map.set(id, asStr(r.name));
  }
  return map;
}

/**
 * Preset → hour-aligned UTC `starts_at`/`ends_at`. Reddit 400s on any
 * timestamp with non-zero minutes/seconds, so "now" rounds UP to the next
 * hour boundary (keeping today's partial data in range). Presets ending
 * "yesterday" close at today's 00:00Z, mirroring GAQL's LAST_N_DAYS.
 */
function presetRange(preset: string): { startsAt: string; endsAt: string } {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextHour = Math.ceil(now.getTime() / HOUR) * HOUR;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const prevMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  switch (preset) {
    case "TODAY":
      return { startsAt: hourIso(todayStart), endsAt: hourIso(nextHour) };
    case "YESTERDAY":
      return { startsAt: hourIso(todayStart - DAY), endsAt: hourIso(todayStart) };
    case "LAST_14_DAYS":
      return { startsAt: hourIso(todayStart - 14 * DAY), endsAt: hourIso(todayStart) };
    case "LAST_30_DAYS":
      return { startsAt: hourIso(todayStart - 30 * DAY), endsAt: hourIso(todayStart) };
    case "THIS_MONTH":
      return { startsAt: hourIso(monthStart), endsAt: hourIso(nextHour) };
    case "LAST_MONTH":
      return { startsAt: hourIso(prevMonthStart), endsAt: hourIso(monthStart) };
    case "LAST_7_DAYS":
    default:
      return { startsAt: hourIso(todayStart - 7 * DAY), endsAt: hourIso(todayStart) };
  }
}

function hourIso(ms: number): string {
  // "2026-07-17T09" + ":00:00Z" — hour-aligned by construction.
  return new Date(ms).toISOString().slice(0, 13) + ":00:00Z";
}

// --------------------------------------------------------------------------
// Token lifecycle
// --------------------------------------------------------------------------

/**
 * Reddit access tokens last one hour; the refresh token is permanent until
 * the user revokes it. Refresh eagerly when fewer than 60 seconds remain —
 * same policy as the organic provider, self-contained here because its
 * refresher is module-private.
 */
async function ensureFreshRedditAdsToken(ctx: IntegrationRuntimeContext): Promise<void> {
  if (ctx.authMode !== "oauth2") {
    throw new Error(`Reddit Ads connector does not support authMode "${ctx.authMode}"`);
  }
  const cfg = ctx.config as unknown as RedditAdsConfig;
  if (cfg.expiresAt > Date.now() + 60_000) return;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("Connection is missing OAuth client credentials — disconnect and reconnect.");
  }
  if (!cfg.refreshToken) {
    throw new Error("Connection has no refresh token — reconnect from Settings → Integrations.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
  });
  const res = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(
      oauthErrorMessage(parsed, `Reddit token refresh failed: ${res.status}`),
    );
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(oauthErrorMessage(parsed, "Refresh did not return an access token"));
  }
  // Reddit currently does not rotate refresh tokens, but accept a new one
  // if it ever decides to.
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : cfg.refreshToken;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const scope = typeof parsed.scope === "string" ? parsed.scope : cfg.scope;
  const next: RedditAdsConfig = {
    ...cfg,
    accessToken: parsed.access_token,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

/**
 * One Ads API round-trip. `path` is either an API path or a full
 * `pagination.next_url` (callers guard that it stays on the Ads API host).
 * 429s throw a retry-shortly error — Reddit sends `X-RateLimit-*` headers
 * but no `Retry-After`, and a tool call must never sleep-loop.
 */
async function adsFetch(
  ctx: IntegrationRuntimeContext,
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: unknown },
): Promise<unknown> {
  const cfg = ctx.config as unknown as RedditAdsConfig;
  const url = path.startsWith("http") ? path : `${ADS_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.accessToken}`,
    "User-Agent": REDDIT_USER_AGENT,
    Accept: "application/json",
  };
  const reqInit: RequestInit = { method: init.method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await fetch(url, reqInit);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body — fall through to the status check
  }
  if (res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(
      `Reddit Ads: rate limited (429)${reset ? ` — limit resets in ~${reset}s` : ""}${remaining ? ` (remaining: ${remaining})` : ""}. Retry shortly; Reddit sends no Retry-After so this call does not wait.`,
    );
  }
  if (!res.ok) {
    throw new Error(redditAdsErrorMessage(res.status, parsed, text));
  }
  return parsed ?? {};
}

/**
 * Collect up to `maxItems` records from a paginated list endpoint,
 * following `pagination.next_url` (bounded, and only within the Ads API
 * host so a hostile response can't redirect us elsewhere).
 */
async function listPaged(
  ctx: IntegrationRuntimeContext,
  path: string,
  query: Record<string, string | number | undefined>,
  maxItems: number,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let url = withQuery(path, { ...query, "page.size": Math.min(Math.max(maxItems, 1), 100) });
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = (await adsFetch(ctx, url, { method: "GET" })) as {
      data?: unknown;
      pagination?: { next_url?: unknown };
    };
    const data = Array.isArray(res.data) ? res.data : [];
    for (const d of data) {
      if (d && typeof d === "object") out.push(d as Record<string, unknown>);
    }
    if (out.length >= maxItems) break;
    const next = res.pagination?.next_url;
    url = typeof next === "string" && next.startsWith(ADS_API) ? next : "";
  }
  return out.slice(0, maxItems);
}

function withQuery(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

function redditAdsErrorMessage(status: number, parsed: unknown, raw: string): string {
  let msg = "";
  if (parsed && typeof parsed === "object") {
    const p = parsed as { message?: unknown; error?: unknown };
    if (typeof p.message === "string" && p.message) {
      msg = p.message;
    } else if (p.error && typeof p.error === "object") {
      const inner = (p.error as { message?: unknown }).message;
      if (typeof inner === "string") msg = inner;
    } else if (typeof p.error === "string") {
      msg = p.error;
    }
  }
  if (!msg) msg = raw.slice(0, 300) || `HTTP ${status}`;
  if (status === 403) {
    msg +=
      " (check that the connection granted the ads scopes and that Reddit has allow-listed this account for the Ads API — reporting is open to most advertisers, campaign management sometimes is not)";
  }
  return `Reddit Ads: ${msg}`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function safetyOf(ctx: IntegrationRuntimeContext): AdsSafetyConfig {
  return ctx.config as unknown as RedditAdsConfig;
}

/** Granted-scope check. Reddit hands the scope string back space-separated
 *  (commas also appear in the wild), so split on both. */
function assertScope(ctx: IntegrationRuntimeContext, scope: "adsread" | "adsedit"): void {
  const cfg = ctx.config as unknown as RedditAdsConfig;
  const granted = new Set((cfg.scope ?? "").split(/[\s,]+/).filter(Boolean));
  if (!granted.has(scope)) {
    throw new Error(
      `This connection is missing the "${scope}" scope. Reconnect and grant Reddit Ads access.`,
    );
  }
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
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

function oauthErrorMessage(parsed: Record<string, unknown> | null, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const desc = parsed.error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = parsed.error;
  if (typeof err === "string" && err) return err;
  return fallback;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Money and counters arrive as JSON numbers or strings depending on the
 *  serializer — coerce both, defaulting to 0. */
function asNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
