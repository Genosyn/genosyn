import {
  ApprovalRequiredError,
  type IntegrationCatalogField,
  type IntegrationRuntimeContext,
} from "../types.js";

/**
 * Pieces shared by every ad-platform provider (google-ads, meta-ads,
 * microsoft-ads, reddit-ads):
 *
 *  - Safety knobs collected on the connect form (per-change cap, rolling
 *    daily/monthly authorized-increase caps, approval threshold, kill
 *    switch) — the Lightning `lightning-shared.ts` pattern in ad-account
 *    currency, backed by the SQL `AdSpendEvent` ledger instead of an
 *    encrypted-blob spend log.
 *  - The mutation gate `enforceAdsMutation` + ledger writer
 *    `recordAdsMutation`.
 *  - Unit helpers (Google micros ↔ minor units) and formatting.
 *
 * Design decisions carried from the M26 review:
 *
 *  - **Every spend-increasing mutation defaults to a human Approval**
 *    (`requireApprovalAbove` blank = 0). Owners loosen per Connection.
 *  - **Spend-decreasing mutations are fast-pathed.** Pausing a runaway
 *    campaign or lowering a budget must never wait on the approval queue —
 *    that's the emergency action. They still hit the kill switch, still
 *    require a host-bound ledger, and still record.
 *  - **Hard caps run on every path**, including approved replays —
 *    `bypassApprovalGate` skips only the approval gate.
 *  - **Caps are denominated in the ad account's own currency** (minor
 *    units). No FX: a cap of 500 on a EUR account means €500. Mixed
 *    currencies across one Connection are summed numerically — documented
 *    on the form fields.
 */

// --------------------------------------------------------------------------
// Safety config
// --------------------------------------------------------------------------

export type AdsSafetyConfig = {
  /** Hard cap on a single authorized budget increase (major units of the
   *  ad account's currency). Unset = no cap. */
  maxBudgetChange?: number;
  /** Rolling 24 h cap on total authorized budget increases across this
   *  Connection. Unset = no cap. */
  dailyBudgetDeltaCap?: number;
  /** Rolling 30-day cap on total authorized budget increases. Unset = no
   *  cap. */
  monthlyBudgetDeltaCap?: number;
  /** Spend increases above this go through the Approvals inbox. Unset or
   *  blank = 0: EVERY spend increase requires a human approve. */
  requireApprovalAbove?: number;
  /** When true, AI employees cannot mutate anything on this Connection —
   *  reads still work. */
  killSwitch?: boolean;
};

export const ADS_DAY_MS = 24 * 60 * 60 * 1000;
export const ADS_MONTH_MS = 30 * ADS_DAY_MS;

/** Shared form rows for the connect/reconnect modal. Ads provider modules
 *  splice these in alongside their auth-specific fields. */
export const ADS_SAFETY_FIELDS: IntegrationCatalogField[] = [
  {
    key: "maxBudgetChange",
    label: "Max single budget increase (account currency)",
    type: "text",
    placeholder: "250",
    required: false,
    hint: "Optional hard cap. Any single budget increase above this is refused outright — even a human approval cannot exceed it. Leave blank for no cap.",
  },
  {
    key: "dailyBudgetDeltaCap",
    label: "Daily budget-increase limit (account currency)",
    type: "text",
    placeholder: "500",
    required: false,
    hint: "Optional rolling 24-hour cap on the sum of authorized budget increases on this Connection. Leave blank for no limit.",
  },
  {
    key: "monthlyBudgetDeltaCap",
    label: "Monthly budget-increase limit (account currency)",
    type: "text",
    placeholder: "5000",
    required: false,
    hint: "Optional rolling 30-day cap on authorized budget increases. Leave blank for no limit.",
  },
  {
    key: "requireApprovalAbove",
    label: "Require approval above (account currency)",
    type: "text",
    placeholder: "0",
    required: false,
    hint: "Spend increases above this queue in the Approvals inbox. Leave blank for 0 — every increase needs a human approve (recommended). Decreases and pauses never wait for approval.",
  },
];

export function parseAdsSafetyFields(input: Record<string, string>): AdsSafetyConfig {
  return {
    maxBudgetChange: parseOptionalAmount(input.maxBudgetChange, "Max single budget increase"),
    dailyBudgetDeltaCap: parseOptionalAmount(
      input.dailyBudgetDeltaCap,
      "Daily budget-increase limit",
    ),
    monthlyBudgetDeltaCap: parseOptionalAmount(
      input.monthlyBudgetDeltaCap,
      "Monthly budget-increase limit",
    ),
    requireApprovalAbove: parseOptionalAmount(
      input.requireApprovalAbove,
      "Require approval above",
    ),
  };
}

function parseOptionalAmount(v: unknown, label: string): number | undefined {
  if (v == null) return undefined;
  const trimmed = typeof v === "string" ? v.trim() : String(v);
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative number (or blank).`);
  }
  return n;
}

// --------------------------------------------------------------------------
// Mutation gate
// --------------------------------------------------------------------------

export type AdsMutationKind =
  | "budget_increase"
  | "budget_decrease"
  | "campaign_enable"
  | "campaign_pause";

/** Is this mutation kind spend-increasing (gated) or spend-decreasing
 *  (fast-pathed)? Enables authorize spend at the current budget; pauses
 *  free it. */
export function isSpendIncreasing(kind: AdsMutationKind): boolean {
  return kind === "budget_increase" || kind === "campaign_enable";
}

/**
 * Gate one spend-affecting mutation. Call BEFORE contacting the platform,
 * with the live object already read (`beforeState`). Throws on denial;
 * throws `ApprovalRequiredError` (with an `ad_spend` request) when a human
 * must approve first. Returns normally when the mutation may proceed —
 * follow the successful platform call with `recordAdsMutation`.
 */
export async function enforceAdsMutation(args: {
  cfg: AdsSafetyConfig;
  ctx: IntegrationRuntimeContext;
  /** Provider id, e.g. "google-ads". */
  platform: string;
  /** Human-facing platform label for messages, e.g. "Google Ads". */
  platformLabel: string;
  mutationKind: AdsMutationKind;
  /** Signed authorized delta in minor currency units (increase positive). */
  amountMinor: number;
  currency: string;
  /** Short human-readable description — goes on the approval summary. */
  description: string;
  adAccountRef?: string;
  campaignRef?: string;
  /** Snapshot of the live object read just before this call. Queued on the
   *  approval; compared against `ctx.approvalSnapshot` on replay. */
  beforeState?: Record<string, unknown>;
}): Promise<void> {
  const { cfg, ctx } = args;

  if (cfg.killSwitch) {
    throw new Error(
      `The kill switch is on for this ${args.platformLabel} Connection — AI employees cannot change campaigns or budgets until a human turns it off in Settings → Integrations.`,
    );
  }

  // The ledger is host-bound at the trusted call sites. Its absence means
  // this context was never meant to mutate ad spend — fail closed.
  if (!ctx.adSpend) {
    throw new Error(
      "Ad mutations are not available in this context (no spend ledger bound).",
    );
  }

  // Drift check on approved replay: the human approved a specific
  // before→after; if the live object moved since queueing, abort rather
  // than firing a stale change.
  if (ctx.bypassApprovalGate && ctx.approvalSnapshot && args.beforeState) {
    if (stableStringify(ctx.approvalSnapshot) !== stableStringify(args.beforeState)) {
      throw new Error(
        `The ${args.platformLabel} object changed after this approval was requested — aborting the replay. Re-run the tool to propose the change against the current state.`,
      );
    }
  }

  // Spend-decreasing mutations are the emergency lever: no caps, no
  // approval. (Kill switch and ledger checks above still apply.)
  if (!isSpendIncreasing(args.mutationKind) && args.amountMinor <= 0) {
    return;
  }

  const amount = Math.max(0, Math.round(args.amountMinor));

  if (
    cfg.maxBudgetChange != null &&
    amount > Math.round(cfg.maxBudgetChange * 100)
  ) {
    throw new Error(
      `This change authorizes ${formatMinor(amount, args.currency)}, above the per-change cap of ${formatMinor(Math.round(cfg.maxBudgetChange * 100), args.currency)} on this Connection. Edit the Connection's safety limits to allow it, or ask a human teammate.`,
    );
  }

  if (cfg.dailyBudgetDeltaCap != null) {
    const spent = await ctx.adSpend.authorizedInWindow(ADS_DAY_MS);
    if (spent + amount > Math.round(cfg.dailyBudgetDeltaCap * 100)) {
      throw new Error(
        `Daily budget-increase limit of ${formatMinor(Math.round(cfg.dailyBudgetDeltaCap * 100), args.currency)} would be exceeded — ${formatMinor(spent, args.currency)} already authorized in the last 24h on this Connection.`,
      );
    }
  }

  if (cfg.monthlyBudgetDeltaCap != null) {
    const spent = await ctx.adSpend.authorizedInWindow(ADS_MONTH_MS);
    if (spent + amount > Math.round(cfg.monthlyBudgetDeltaCap * 100)) {
      throw new Error(
        `Monthly budget-increase limit of ${formatMinor(Math.round(cfg.monthlyBudgetDeltaCap * 100), args.currency)} would be exceeded — ${formatMinor(spent, args.currency)} already authorized in the last 30 days on this Connection.`,
      );
    }
  }

  if (!ctx.bypassApprovalGate) {
    // Blank/unset = 0: every spend increase queues a human Approval. This
    // is the single highest-leverage safety default — owners must
    // deliberately loosen it per Connection.
    const thresholdMinor = Math.round((cfg.requireApprovalAbove ?? 0) * 100);
    if (amount > thresholdMinor) {
      throw new ApprovalRequiredError(
        `${args.platformLabel} · ${labelForKind(args.mutationKind)} · ${formatMinor(amount, args.currency)}`,
        args.description,
        0,
        {
          kind: "ad_spend",
          amountMinor: amount,
          currency: args.currency,
          platform: args.platform,
          mutationKind: args.mutationKind,
          adAccountRef: args.adAccountRef,
          campaignRef: args.campaignRef,
          beforeState: args.beforeState,
        },
      );
    }
  }
}

/**
 * Append the authorized delta to the SQL ledger after the platform call
 * succeeded. Failures propagate — a mutation the ledger cannot account for
 * should surface loudly, not silently drift the caps.
 */
export async function recordAdsMutation(
  ctx: IntegrationRuntimeContext,
  event: {
    toolName: string;
    mutationKind: AdsMutationKind;
    amountMinor: number;
    currency: string;
    adAccountRef?: string;
    campaignRef?: string;
    summary?: string;
  },
): Promise<void> {
  if (!ctx.adSpend) return;
  await ctx.adSpend.record(event);
}

function labelForKind(kind: AdsMutationKind): string {
  switch (kind) {
    case "budget_increase":
      return "budget increase";
    case "budget_decrease":
      return "budget decrease";
    case "campaign_enable":
      return "enable campaign";
    case "campaign_pause":
      return "pause campaign";
  }
}

// --------------------------------------------------------------------------
// Units + formatting
// --------------------------------------------------------------------------

/** Google Ads reports money in micros (1,000,000 per currency unit);
 *  minor units are hundredths. */
export function minorFromMicros(micros: number): number {
  return Math.round(micros / 10_000);
}

export function microsFromMinor(minor: number): number {
  return Math.round(minor * 10_000);
}

export function formatMinor(minor: number, currency: string): string {
  const major = (minor / 100).toFixed(2);
  return currency ? `${major} ${currency}` : major;
}

/** Deterministic JSON for snapshot comparison — key order independent. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

// --------------------------------------------------------------------------
// Argument coercion (kept local so ads providers don't reach into the
// lightning or google modules for generic helpers)
// --------------------------------------------------------------------------

export function adsRequireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

export function adsOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function adsRequireNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return v;
}

export function adsClampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
