import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationTool,
} from "../types.js";
import {
  ADS_SAFETY_FIELDS,
  adsClampInt,
  adsOptionalString,
  adsRequireNumber,
  adsRequireString,
  enforceAdsMutation,
  formatMinor,
  parseAdsSafetyFields,
  recordAdsMutation,
  type AdsSafetyConfig,
} from "./ads-shared.js";

/**
 * Meta Ads (Facebook & Instagram) — read-first campaign visibility plus a
 * deliberately tiny, approval-gated mutation surface (pause / enable /
 * budget change).
 *
 * Auth is a Business Manager **system-user token** pasted as an API key —
 * no OAuth dance. Generated under Business Settings → System users with the
 * `ads_read` + `ads_management` permissions, and system-user tokens don't
 * expire by default, so there is no refresh machinery here.
 *
 * Transport is the Graph API with plain fetch, no SDK. Reads ride query
 * params; writes POST form-encoded params (the Graph convention). Unlike
 * Google Ads there is no staged mutate step: **edits to live objects apply
 * immediately**, which is exactly why `enforceAdsMutation` runs before the
 * POST, never after (see `ads-shared.ts`).
 *
 * Meta money units are split-brained and worth spelling out once:
 *   • budget fields (`daily_budget`, `lifetime_budget`) are STRINGS of the
 *     account currency's MINOR units ("4500" = 45.00) — already what the
 *     ads-shared ledger wants, so no micros conversion;
 *   • Insights `spend` is a decimal string of MAJOR currency units.
 */

/**
 * Meta ships ~3 Graph API versions a year and each lives ~2 years; the
 * version string rides every URL. Keeping it a single constant makes the
 * periodic bump a one-line change. v25.0 shipped 2026-02-18; a sunset
 * version errors with code 2635, surfaced with an "upgrade Genosyn" hint.
 */
const META_GRAPH_VERSION = "v25.0";
const GRAPH_API = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** Graph codes Meta uses for throttling (app / user / custom / ads BUC). */
const META_RATE_LIMIT_CODES = new Set([4, 17, 613, 80004]);

type MetaAdsConfig = AdsSafetyConfig & {
  systemUserToken: string;
  /** Allowlisted ad account ids (digits, no `act_` prefix). Empty or unset
   *  = every account the token can see. */
  adAccountIds?: string[];
};

const tools: IntegrationTool[] = [
  {
    name: "list_ad_accounts",
    description:
      "List the ad accounts the system-user token can access (first page only). Returns numeric account ids — use them with every other tool. Filtered to this Connection's account allowlist when one is configured. `accountStatus` is Meta's numeric enum (1 = active).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max accounts to return (default 50).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_campaigns",
    description:
      "List campaigns in one ad account with status, objective, and budgets. Meta budgets are MINOR currency units (4500 = 45.00); null means the budget lives elsewhere (ad sets, or a lifetime budget).",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: {
          type: "string",
          description: "Ad account id, digits or with prefix (e.g. \"act_1234567890\").",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max campaigns to return (default 50).",
        },
      },
      required: ["ad_account_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_campaign",
    description:
      "Fetch one campaign's live state: status, effective status, objective, owning account, and budgets. Budgets are MINOR currency units (4500 = 45.00). Read this before proposing any mutation.",
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
    name: "spend_summary",
    description:
      "Per-campaign spend, impressions, clicks, and conversions for a Meta date preset. Spend is in the account's currency units. `conversions` is a crude sum of purchase- and lead-type actions; the raw `actions` array rides along for anything finer. Use for daily pacing checks.",
    inputSchema: {
      type: "object",
      properties: {
        ad_account_id: { type: "string" },
        date_preset: {
          type: "string",
          enum: [
            "today",
            "yesterday",
            "last_3d",
            "last_7d",
            "last_14d",
            "last_28d",
            "last_30d",
            "last_90d",
            "this_month",
            "last_month",
          ],
          description: "Meta insights preset range (default last_7d).",
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
      "Pause a campaign. Spend-DECREASING, so it never waits for approval — this is the emergency lever for a runaway campaign. Applies immediately on Meta. Records the freed daily budget to the spend ledger.",
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
      "Change a campaign's daily budget. `new_daily_budget` is in the account's currency units (e.g. 45.50). Only campaigns that already carry a campaign-level daily budget (Advantage campaign budget) can be changed — ad-set-level and lifetime budgets aren't managed in v1. Increases go through the Connection's caps and (by default) a human Approval; decreases apply immediately. Both are recorded to the spend ledger.",
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

export const metaAdsProvider: IntegrationProvider = {
  catalog: {
    provider: "meta-ads",
    name: "Meta Ads",
    category: "Analytics",
    tagline: "Facebook & Instagram campaign spend, pacing, and approval-gated budget levers.",
    description:
      "Connect Meta Ads (Facebook & Instagram) so AI employees can watch campaign spend and pacing (Insights reports), and — behind per-Connection caps and human approvals — pause/enable campaigns and change budgets. Uses a Business Manager system-user token with ads_read + ads_management; system-user tokens don't expire by default. Optionally pin the Connection to an allowlist of ad accounts.",
    icon: "Megaphone",
    authMode: "apikey",
    fields: [
      {
        key: "systemUserToken",
        label: "System user token",
        type: "password",
        placeholder: "EAAG…",
        required: true,
        hint: "Business Manager → Business Settings → System users → generate a token with ads_read + ads_management for a Business-type app. System-user tokens don't expire by default.",
      },
      {
        key: "adAccountIds",
        label: "Ad account allowlist",
        type: "text",
        placeholder: "act_1234567890, 9876543210",
        required: false,
        hint: "Optional comma-separated ad account ids. When set, tools refuse to touch any other account. Leave blank to allow every account the token can see.",
      },
      ...ADS_SAFETY_FIELDS,
    ],
    enabled: true,
  },

  tools,

  async validateApiKey(input) {
    const systemUserToken = (input.systemUserToken ?? "").trim();
    if (!systemUserToken) throw new Error("System user token is required");
    const adAccountIds = parseAllowlist(input.adAccountIds ?? "");
    const safety = parseAdsSafetyFields(input);
    const { body } = await graphGet({ systemUserToken }, "/me", { fields: "id,name" });
    const name = String(body.name ?? body.id ?? "Meta system user");
    const cfg: MetaAdsConfig = {
      systemUserToken,
      adAccountIds,
      ...safety,
    };
    return { config: cfg as unknown as IntegrationConfig, accountHint: name };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as unknown as MetaAdsConfig;
    try {
      await graphGet(cfg, "/me", { fields: "id" });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as unknown as MetaAdsConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_ad_accounts": {
        const limit = adsClampInt(a.limit, 1, 200, 50);
        const { body, rateLimitNote } = await graphGet(cfg, "/me/adaccounts", {
          fields: "account_id,name,currency,account_status",
          limit: String(limit),
        });
        const allow = cfg.adAccountIds ?? [];
        const accounts = asRows(body.data)
          .map((r) => ({
            accountId: String(r.account_id ?? ""),
            name: String(r.name ?? ""),
            currency: String(r.currency ?? ""),
            accountStatus: toCount(r.account_status),
          }))
          .filter((acc) => allow.length === 0 || allow.includes(acc.accountId));
        return { accounts, ...(rateLimitNote ? { rateLimitNote } : {}) };
      }

      case "list_campaigns": {
        const accountId = normalizeAdAccountId(adsRequireString(a.ad_account_id, "ad_account_id"));
        assertAccountAllowed(cfg, accountId);
        const limit = adsClampInt(a.limit, 1, 200, 50);
        const { body, rateLimitNote } = await graphGet(cfg, `/act_${accountId}/campaigns`, {
          fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget",
          limit: String(limit),
        });
        const campaigns = asRows(body.data).map((r) => ({
          campaignId: String(r.id ?? ""),
          name: String(r.name ?? ""),
          status: String(r.status ?? ""),
          effectiveStatus: String(r.effective_status ?? ""),
          objective: String(r.objective ?? ""),
          dailyBudgetMinor: minorBudget(r.daily_budget),
          lifetimeBudgetMinor: minorBudget(r.lifetime_budget),
        }));
        return { campaigns, ...(rateLimitNote ? { rateLimitNote } : {}) };
      }

      case "get_campaign": {
        const campaignId = requireDigits(a.campaign_id, "campaign_id");
        const info = await fetchCampaignInfo(cfg, campaignId);
        assertAccountAllowed(cfg, info.accountId);
        return {
          campaignId,
          name: info.name,
          status: info.status,
          effectiveStatus: info.effectiveStatus,
          objective: info.objective,
          accountId: info.accountId,
          dailyBudgetMinor: info.dailyBudgetMinor,
          lifetimeBudgetMinor: info.lifetimeBudgetMinor,
          ...(info.rateLimitNote ? { rateLimitNote: info.rateLimitNote } : {}),
        };
      }

      case "spend_summary": {
        const accountId = normalizeAdAccountId(adsRequireString(a.ad_account_id, "ad_account_id"));
        assertAccountAllowed(cfg, accountId);
        const preset = adsOptionalString(a.date_preset) ?? "last_7d";
        const limit = adsClampInt(a.limit, 1, 500, 200);
        const currency = await fetchAccountCurrency(cfg, accountId);
        const { body, rateLimitNote } = await graphGet(cfg, `/act_${accountId}/insights`, {
          level: "campaign",
          date_preset: preset,
          fields: "campaign_id,campaign_name,spend,impressions,clicks,actions",
          limit: String(limit),
        });
        const campaigns = asRows(body.data).map((r) => {
          const actions = Array.isArray(r.actions) ? r.actions : [];
          return {
            campaignId: String(r.campaign_id ?? ""),
            name: String(r.campaign_name ?? ""),
            spend: Number(r.spend ?? 0),
            impressions: toCount(r.impressions),
            clicks: toCount(r.clicks),
            conversions: sumConversions(actions),
            actions,
          };
        });
        return {
          datePreset: preset,
          currency,
          campaigns,
          ...(rateLimitNote ? { rateLimitNote } : {}),
        };
      }

      case "pause_campaign":
        return setCampaignStatus(ctx, a, "PAUSED");

      case "enable_campaign":
        return setCampaignStatus(ctx, a, "ACTIVE");

      case "update_campaign_budget": {
        const campaignId = requireDigits(a.campaign_id, "campaign_id");
        const newDaily = adsRequireNumber(a.new_daily_budget, "new_daily_budget");
        const info = await fetchCampaignInfo(cfg, campaignId);
        assertAccountAllowed(cfg, info.accountId);
        if (info.dailyBudgetMinor == null) {
          throw new Error(
            `Campaign "${info.name}" (${campaignId}) has no campaign-level daily budget — its budget lives on the ad sets (or is a lifetime budget), and ad-set-level budgets aren't managed in v1. Adjust it in Ads Manager.`,
          );
        }
        const newMinor = Math.round(newDaily * 100);
        const deltaMinor = newMinor - info.dailyBudgetMinor;
        if (deltaMinor === 0) {
          return { ok: true, note: "Budget already at the requested amount." };
        }
        const currency = await fetchAccountCurrency(cfg, info.accountId);
        const kind = deltaMinor > 0 ? ("budget_increase" as const) : ("budget_decrease" as const);
        await enforceAdsMutation({
          cfg,
          ctx,
          platform: "meta-ads",
          platformLabel: "Meta Ads",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency,
          description: `Change daily budget of "${info.name}" (${campaignId}) from ${formatMinor(info.dailyBudgetMinor, currency)} to ${formatMinor(newMinor, currency)}`,
          adAccountRef: info.accountId,
          campaignRef: campaignId,
          beforeState: { status: info.status, dailyBudget: info.dailyBudgetMinor },
        });
        const { rateLimitNote } = await graphPost(cfg, `/${campaignId}`, {
          daily_budget: String(newMinor),
        });
        await recordAdsMutation(ctx, {
          toolName: "update_campaign_budget",
          mutationKind: kind,
          amountMinor: deltaMinor,
          currency,
          adAccountRef: info.accountId,
          campaignRef: campaignId,
          summary: `Daily budget of "${info.name}" ${deltaMinor > 0 ? "raised" : "lowered"} to ${formatMinor(newMinor, currency)}`,
        });
        return {
          ok: true,
          campaignId,
          previousDailyBudget: info.dailyBudgetMinor / 100,
          newDailyBudget: newMinor / 100,
          currency,
          ...(rateLimitNote ? { rateLimitNote } : {}),
        };
      }

      default:
        throw new Error(`Unknown Meta Ads tool: ${name}`);
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
  const cfg = ctx.config as unknown as MetaAdsConfig;
  const campaignId = requireDigits(a.campaign_id, "campaign_id");
  const info = await fetchCampaignInfo(cfg, campaignId);
  assertAccountAllowed(cfg, info.accountId);
  if (info.status === status) {
    return { ok: true, note: `Campaign is already ${status}.` };
  }
  // A campaign without a campaign-level daily budget (ad-set budgets,
  // lifetime budget) authorizes 0 — enables still route through the gate.
  const budgetMinor = info.dailyBudgetMinor ?? 0;
  const currency = await fetchAccountCurrency(cfg, info.accountId);
  const kind = status === "ACTIVE" ? ("campaign_enable" as const) : ("campaign_pause" as const);
  await enforceAdsMutation({
    cfg,
    ctx,
    platform: "meta-ads",
    platformLabel: "Meta Ads",
    mutationKind: kind,
    amountMinor: status === "ACTIVE" ? budgetMinor : -budgetMinor,
    currency,
    description: `${status === "ACTIVE" ? "Enable" : "Pause"} campaign "${info.name}" (${campaignId}) — daily budget ${formatMinor(budgetMinor, currency)}`,
    adAccountRef: info.accountId,
    campaignRef: campaignId,
    beforeState: { status: info.status, dailyBudget: budgetMinor },
  });
  const { rateLimitNote } = await graphPost(cfg, `/${campaignId}`, { status });
  await recordAdsMutation(ctx, {
    toolName: status === "ACTIVE" ? "enable_campaign" : "pause_campaign",
    mutationKind: kind,
    amountMinor: status === "ACTIVE" ? budgetMinor : -budgetMinor,
    currency,
    adAccountRef: info.accountId,
    campaignRef: campaignId,
    summary: `Campaign "${info.name}" set to ${status}`,
  });
  return {
    ok: true,
    campaignId,
    previousStatus: info.status,
    newStatus: status,
    ...(rateLimitNote ? { rateLimitNote } : {}),
  };
}

type CampaignInfo = {
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string;
  /** Owning ad account id, digits only. */
  accountId: string;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  rateLimitNote?: string;
};

async function fetchCampaignInfo(cfg: MetaAdsConfig, campaignId: string): Promise<CampaignInfo> {
  const { body, rateLimitNote } = await graphGet(cfg, `/${campaignId}`, {
    fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,account_id",
  });
  return {
    name: String(body.name ?? campaignId),
    status: String(body.status ?? "UNKNOWN"),
    effectiveStatus: String(body.effective_status ?? ""),
    objective: String(body.objective ?? ""),
    accountId: String(body.account_id ?? "").replace(/^act_/i, ""),
    dailyBudgetMinor: minorBudget(body.daily_budget),
    lifetimeBudgetMinor: minorBudget(body.lifetime_budget),
    ...(rateLimitNote ? { rateLimitNote } : {}),
  };
}

async function fetchAccountCurrency(cfg: MetaAdsConfig, accountId: string): Promise<string> {
  const { body } = await graphGet(cfg, `/act_${accountId}`, { fields: "currency" });
  return String(body.currency ?? "");
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

function graphGet(
  cfg: MetaAdsConfig,
  path: string,
  params: Record<string, string>,
): Promise<GraphResult> {
  return graphFetch(cfg, path, { method: "GET", params });
}

function graphPost(
  cfg: MetaAdsConfig,
  path: string,
  form: Record<string, string>,
): Promise<GraphResult> {
  return graphFetch(cfg, path, { method: "POST", form });
}

type GraphResult = {
  body: Record<string, unknown>;
  /** Set when Meta reports ≥90% of an hourly rate-limit allowance used. */
  rateLimitNote?: string;
};

async function graphFetch(
  cfg: MetaAdsConfig,
  path: string,
  init: { method: "GET" | "POST"; params?: Record<string, string>; form?: Record<string, string> },
): Promise<GraphResult> {
  if (!cfg.systemUserToken) {
    throw new Error("This connection has no Meta system-user token — reconnect and fill it in.");
  }
  const qs = new URLSearchParams(init.params ?? {}).toString();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.systemUserToken}`,
    accept: "application/json",
  };
  const reqInit: RequestInit = { method: init.method, headers };
  if (init.form) {
    // Graph writes take form-encoded params, not JSON bodies.
    headers["content-type"] = "application/x-www-form-urlencoded";
    reqInit.body = new URLSearchParams(init.form).toString();
  }
  const res = await fetch(`${GRAPH_API}${path}${qs ? `?${qs}` : ""}`, reqInit);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body — fall through to the status check
  }
  if (!res.ok) {
    throw new Error(metaAdsErrorMessage(res.status, parsed, text));
  }
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const rateLimitNote = usageNote(res.headers.get("x-business-use-case-usage"));
  return rateLimitNote ? { body, rateLimitNote } : { body };
}

/** Graph errors: {error:{message,type,code,error_subcode,fbtrace_id}}. */
function metaAdsErrorMessage(status: number, parsed: unknown, raw: string): string {
  let message = "";
  let code: number | undefined;
  if (parsed && typeof parsed === "object") {
    const err = (parsed as { error?: { message?: string; code?: number } }).error;
    if (typeof err?.message === "string") message = err.message;
    if (typeof err?.code === "number") code = err.code;
  }
  if (!message) message = raw.slice(0, 300) || `HTTP ${status}`;
  let out = `Meta Ads: ${message}${code != null ? ` (code ${code})` : ""}`;
  if (code === 2635) {
    out += ` (Graph API ${META_GRAPH_VERSION} may have been sunset — check for a Genosyn upgrade.)`;
  }
  if (status === 429 || (code != null && META_RATE_LIMIT_CODES.has(code))) {
    out +=
      " Rate limited — new Meta apps sit in the Limited Access tier (300 + 40×active-ads calls/hour per ad account); batch reads and retry later.";
  }
  return out;
}

/**
 * `x-business-use-case-usage` is a JSON header mapping business id → usage
 * entries whose call_count / total_cputime / total_time are percentages of
 * the hourly allowance. Parsed best-effort — a malformed header must never
 * fail a call that succeeded.
 */
function usageNote(header: string | null): string | undefined {
  if (!header) return undefined;
  let max = 0;
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    for (const value of Object.values(parsed)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (!entry || typeof entry !== "object") continue;
        const usage = entry as Record<string, unknown>;
        for (const key of ["call_count", "total_cputime", "total_time"]) {
          const pct = usage[key];
          if (typeof pct === "number" && pct > max) max = pct;
        }
      }
    }
  } catch {
    return undefined;
  }
  return max >= 90
    ? `Approaching Meta rate limit — ${max}% of an hourly allowance is used on this ad account. Batch further calls and back off.`
    : undefined;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** The allowlist is a hard fence: when configured, every tool — reads
 *  included — refuses to touch an account that isn't on it. */
function assertAccountAllowed(cfg: MetaAdsConfig, accountId: string): void {
  const allow = cfg.adAccountIds ?? [];
  if (allow.length === 0 || allow.includes(accountId)) return;
  throw new Error(
    `Ad account ${accountId} is not on this Connection's allowlist. Allowed: ${allow.map((id) => `act_${id}`).join(", ")}.`,
  );
}

function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAdAccountId);
}

/** Accept "act_1234567890" or bare digits; store digits only. */
function normalizeAdAccountId(v: string): string {
  const digits = v.trim().replace(/^act_/i, "");
  if (!/^\d+$/.test(digits)) {
    throw new Error(
      `Invalid ad account id "${v}" — expected digits, e.g. "act_1234567890" or "1234567890".`,
    );
  }
  return digits;
}

function requireDigits(v: unknown, name: string): string {
  const s = adsRequireString(v, name);
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be numeric.`);
  return s;
}

function asRows(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/** Budget fields are minor-unit strings ("4500" = 45.00) and absent when
 *  the budget lives elsewhere (ad sets, lifetime). */
function minorBudget(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Graph serializes counts as strings ("1234"). */
function toCount(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Insights reports conversions as a list of {action_type, value}; count
 *  the purchase- and lead-flavored ones ("purchase",
 *  "offsite_conversion.fb_pixel_purchase", "lead", "onsite_web_lead", …) —
 *  crude but stable for pacing checks. */
function sumConversions(actions: unknown[]): number {
  let total = 0;
  for (const entry of actions) {
    if (!entry || typeof entry !== "object") continue;
    const action = entry as Record<string, unknown>;
    const type = String(action.action_type ?? "");
    if (type.endsWith("purchase") || type.endsWith("lead")) {
      total += toCount(action.value);
    }
  }
  return total;
}
