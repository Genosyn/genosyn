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
  createdAt: string;
};

export type MarketingOverview = {
  counts: {
    campaigns: number;
    activeCampaigns: number;
    creativeInReview: number;
    runningExperiments: number;
  };
  plannedDailyBudgetMinor: number;
  currency: string | null;
  latestPerformance: {
    currency: string | null;
    spendMinor: number;
    impressions: number;
    clicks: number;
    conversions: number;
  };
  campaigns: MarketingCampaign[];
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
