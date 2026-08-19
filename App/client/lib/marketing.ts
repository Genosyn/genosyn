export type MarketingCampaignStatus =
  | "draft"
  | "ready"
  | "active"
  | "paused"
  | "completed"
  | "archived";
export type MarketingCampaignObjective =
  | "awareness"
  | "traffic"
  | "leads"
  | "sales"
  | "retention";
export type MarketingAutonomyMode = "observe" | "optimize" | "autonomous";
export type MarketingTargetDirection = "at_most" | "at_least";

export type MarketingCampaign = {
  id: string;
  companyId: string;
  name: string;
  objective: MarketingCampaignObjective;
  status: MarketingCampaignStatus;
  autonomyMode: MarketingAutonomyMode;
  channel: string;
  connectionId: string | null;
  externalAccountId: string;
  externalCampaignId: string;
  ownerEmployeeId: string | null;
  brief: string;
  audience: string;
  offer: string;
  landingPageUrl: string;
  successMetric: string;
  targetValue: string;
  targetDirection: MarketingTargetDirection;
  dailyBudgetMinor: number;
  currency: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketingCreativeStatus =
  | "draft"
  | "review"
  | "approved"
  | "active"
  | "retired"
  | "rejected";
export type MarketingCreativeFormat = "text" | "image" | "video" | "carousel" | "responsive";

export type MarketingCreative = {
  id: string;
  companyId: string;
  campaignId: string;
  name: string;
  format: MarketingCreativeFormat;
  status: MarketingCreativeStatus;
  variantGroup: string;
  concept: string;
  headline: string;
  body: string;
  callToAction: string;
  assetUrl: string;
  destinationUrl: string;
  externalCreativeId: string;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketingExperimentStatus = "draft" | "running" | "decided" | "stopped";
export type MarketingExperiment = {
  id: string;
  companyId: string;
  campaignId: string;
  name: string;
  hypothesis: string;
  status: MarketingExperimentStatus;
  primaryMetric: string;
  minimumSampleSize: string;
  creativeIds: string[];
  winnerCreativeId: string | null;
  decisionRationale: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketingPerformanceSnapshot = {
  id: string;
  campaignId: string;
  periodStart: string;
  periodEnd: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: string;
  conversionValue: string;
  currency: string;
  source: string;
  supersededAt: string | null;
  recordedByEmployeeId: string | null;
  createdAt: string;
};

/** How a metric is written down, which decides how a typed target reads. */
export type MarketingMetricUnit = "count" | "money" | "percent" | "multiple";

export type MarketingSuccessMetricOption = {
  key: string;
  label: string;
  unit: MarketingMetricUnit;
  betterDirection: MarketingTargetDirection;
  hint: string;
};

/**
 * The metrics a target can be scored against, mirroring the server catalogue in
 * `server/services/marketingMetrics.ts`. `clientLibs.test.ts` fails if the two
 * drift, because a Campaign offering a metric the server cannot measure would
 * silently never be judged.
 */
export const MARKETING_SUCCESS_METRIC_OPTIONS: MarketingSuccessMetricOption[] = [
  {
    key: "conversions",
    label: "Conversions",
    unit: "count",
    betterDirection: "at_least",
    hint: "How many conversions the period must produce.",
  },
  {
    key: "cpa",
    label: "Cost per acquisition",
    unit: "money",
    betterDirection: "at_most",
    hint: "Spend divided by conversions. Write the target in whole currency, not cents.",
  },
  {
    key: "roas",
    label: "Return on ad spend",
    unit: "multiple",
    betterDirection: "at_least",
    hint: "Conversion value divided by spend. A target of 3 means 3x.",
  },
  {
    key: "conversion_value",
    label: "Conversion value",
    unit: "money",
    betterDirection: "at_least",
    hint: "Total value the platform attributed to the period.",
  },
  {
    key: "conversion_rate",
    label: "Conversion rate",
    unit: "percent",
    betterDirection: "at_least",
    hint: "Conversions divided by clicks. Write the target as a percentage.",
  },
  {
    key: "ctr",
    label: "Click-through rate",
    unit: "percent",
    betterDirection: "at_least",
    hint: "Clicks divided by impressions. Write the target as a percentage.",
  },
  {
    key: "cpc",
    label: "Cost per click",
    unit: "money",
    betterDirection: "at_most",
    hint: "Spend divided by clicks.",
  },
  {
    key: "cpm",
    label: "Cost per 1,000 impressions",
    unit: "money",
    betterDirection: "at_most",
    hint: "Spend per thousand impressions.",
  },
  {
    key: "clicks",
    label: "Clicks",
    unit: "count",
    betterDirection: "at_least",
    hint: "How many clicks the period must produce.",
  },
  {
    key: "impressions",
    label: "Impressions",
    unit: "count",
    betterDirection: "at_least",
    hint: "How many impressions the period must produce.",
  },
  {
    key: "spend",
    label: "Spend",
    unit: "money",
    betterDirection: "at_most",
    hint: "Total settled spend for the period.",
  },
];

export function marketingSuccessMetric(key: string): MarketingSuccessMetricOption | null {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return MARKETING_SUCCESS_METRIC_OPTIONS.find((option) => option.key === normalized) ?? null;
}

export type MarketingTotals = {
  snapshots: number;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMinor: number;
  coveredDays: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export type MarketingDerived = {
  ctr: number | null;
  conversionRate: number | null;
  cpcMinor: number | null;
  cpmMinor: number | null;
  cpaMinor: number | null;
  roas: number | null;
  avgDailySpendMinor: number | null;
};

export type MarketingTargetState =
  | "on_target"
  | "off_target"
  | "no_target"
  | "no_data"
  | "not_comparable";

export type MarketingTargetStatus = {
  metricKey: string | null;
  metricLabel: string;
  unit: MarketingMetricUnit;
  direction: MarketingTargetDirection;
  targetValue: number | null;
  actualValue: number | null;
  state: MarketingTargetState;
};

export type MarketingAttention = {
  code: string;
  severity: "warn" | "info";
  message: string;
};

export type MarketingCampaignMetrics = {
  windowDays: number;
  totals: MarketingTotals;
  derived: MarketingDerived;
  pacingRatio: number | null;
  target: MarketingTargetStatus;
  attention: MarketingAttention[];
};

export type MarketingCampaignWithMetrics = MarketingCampaign & {
  metrics: MarketingCampaignMetrics;
};

export type MarketingCampaignDetail = {
  campaign: MarketingCampaign;
  creatives: MarketingCreative[];
  experiments: MarketingExperiment[];
  snapshots: MarketingPerformanceSnapshot[];
  snapshotCount: number;
  metrics: MarketingCampaignMetrics;
  lifetime: { totals: MarketingTotals; derived: MarketingDerived };
};

export type MarketingOverview = {
  windowDays: number;
  counts: {
    campaigns: number;
    activeCampaigns: number;
    creativeInReview: number;
    runningExperiments: number;
    needsAttention: number;
  };
  plannedDailyBudgetMinor: number;
  currency: string | null;
  performance: {
    currency: string | null;
    mixedCurrency: boolean;
    spendMinor: number | null;
    conversionValueMinor: number | null;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number | null;
    conversionRate: number | null;
    cpcMinor: number | null;
    cpmMinor: number | null;
    cpaMinor: number | null;
    roas: number | null;
  };
  attention: Array<MarketingAttention & { campaignId: string | null; campaignName: string | null }>;
  campaigns: MarketingCampaignWithMetrics[];
};

export type MarketingGrantRow = {
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  };
  grant: {
    id: string;
    accessLevel: "read" | "write" | "operate";
    createdAt: string;
  } | null;
};

export function formatMarketingMoney(minor: number, currency: string | null): string {
  if (!currency) return `${minor.toLocaleString()} mixed`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

export function marketingStatusLabel(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Status values a filter can offer, mirroring the entity constants. */
export const MARKETING_CAMPAIGN_STATUS_OPTIONS: MarketingCampaignStatus[] = [
  "draft",
  "ready",
  "active",
  "paused",
  "completed",
  "archived",
];
export const MARKETING_CREATIVE_STATUS_OPTIONS: MarketingCreativeStatus[] = [
  "draft",
  "review",
  "approved",
  "active",
  "retired",
  "rejected",
];
export const MARKETING_EXPERIMENT_STATUS_OPTIONS: MarketingExperimentStatus[] = [
  "draft",
  "running",
  "decided",
  "stopped",
];

/** An em dash reads as "not measured", which is different from zero. */
export const MARKETING_NO_VALUE = "—";

export function formatMarketingPercent(ratio: number | null, digits = 2): string {
  if (ratio === null || !Number.isFinite(ratio)) return MARKETING_NO_VALUE;
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatMarketingMultiple(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MARKETING_NO_VALUE;
  return `${value.toFixed(2)}x`;
}

export function formatMarketingCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MARKETING_NO_VALUE;
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

/** Format a value the way its own metric is written. */
export function formatMarketingMetric(
  unit: MarketingMetricUnit,
  value: number | null,
  currency: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return MARKETING_NO_VALUE;
  if (unit === "money") return formatMarketingMoney(Math.round(value * 100), currency);
  if (unit === "percent") return `${value.toFixed(2)}%`;
  if (unit === "multiple") return `${value.toFixed(2)}x`;
  return formatMarketingCount(value);
}

/** Spend against plan, as the sentence someone would say out loud. */
export function formatMarketingPacing(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return MARKETING_NO_VALUE;
  return `${Math.round(ratio * 100)}% of plan`;
}

export function marketingTargetTone(state: MarketingTargetState): "good" | "bad" | "muted" {
  if (state === "on_target") return "good";
  if (state === "off_target") return "bad";
  return "muted";
}

export function marketingTargetSummary(
  target: MarketingTargetStatus,
  currency: string | null,
): string {
  if (target.state === "not_comparable") return "Target not measurable";
  if (target.state === "no_target") return "No target set";
  if (target.state === "no_data") return "No data yet";
  const comparator = target.direction === "at_most" ? "≤" : "≥";
  return `${formatMarketingMetric(target.unit, target.actualValue, currency)} of ${comparator} ${formatMarketingMetric(target.unit, target.targetValue, currency)}`;
}
