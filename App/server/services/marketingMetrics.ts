import type {
  MarketingCampaign,
  MarketingTargetDirection,
} from "../db/entities/MarketingCampaign.js";
import type { MarketingPerformanceSnapshot } from "../db/entities/MarketingPerformanceSnapshot.js";

/**
 * Turning recorded platform readouts into the numbers a decision is made from.
 *
 * Everything here is pure: the campaign policy and its snapshots in, derived
 * metrics out. The same function feeds the workspace UI and the AI Employee
 * tools, so a Routine and a human read identical numbers and an argument about
 * a campaign is about the campaign rather than about whose arithmetic is right.
 *
 * Money is handled in minor units end to end and converted once, at the edge,
 * for display and for comparison against a target a human typed.
 */

/** How a metric is written down, which decides how a typed target reads. */
export type MarketingMetricUnit = "count" | "money" | "percent" | "multiple";

export type MarketingSuccessMetric = {
  key: string;
  label: string;
  unit: MarketingMetricUnit;
  /** Which way is good, used as the default when a Campaign is created. */
  betterDirection: MarketingTargetDirection;
  /** Free-text spellings that mean this metric. */
  aliases: string[];
  hint: string;
};

/**
 * The metrics a target can be judged against. A Campaign may still name
 * something else — `successMetric` stays free text because companies measure
 * things Genosyn has never heard of — but only these can be compared to a
 * number automatically, and the workspace says so rather than pretending.
 */
export const MARKETING_SUCCESS_METRICS: MarketingSuccessMetric[] = [
  {
    key: "conversions",
    label: "Conversions",
    unit: "count",
    betterDirection: "at_least",
    aliases: [
      "conversion",
      "leads",
      "lead",
      "qualified_leads",
      "qualified_lead",
      "signups",
      "sign_ups",
      "purchases",
      "installs",
      "results",
    ],
    hint: "How many conversions the period must produce.",
  },
  {
    key: "cpa",
    label: "Cost per acquisition",
    unit: "money",
    betterDirection: "at_most",
    aliases: [
      "cost_per_acquisition",
      "cost_per_conversion",
      "cost_per_lead",
      "cost_per_result",
      "cpl",
      "cac",
    ],
    hint: "Spend divided by conversions. Write the target in whole currency, not cents.",
  },
  {
    key: "roas",
    label: "Return on ad spend",
    unit: "multiple",
    betterDirection: "at_least",
    aliases: ["return_on_ad_spend", "return_on_adspend", "romi"],
    hint: "Conversion value divided by spend. A target of 3 means 3x.",
  },
  {
    key: "conversion_value",
    label: "Conversion value",
    unit: "money",
    betterDirection: "at_least",
    aliases: ["revenue", "value", "conversion_revenue"],
    hint: "Total value the platform attributed to the period.",
  },
  {
    key: "conversion_rate",
    label: "Conversion rate",
    unit: "percent",
    betterDirection: "at_least",
    aliases: ["cvr", "cr", "click_to_conversion_rate"],
    hint: "Conversions divided by clicks. Write the target as a percentage.",
  },
  {
    key: "ctr",
    label: "Click-through rate",
    unit: "percent",
    betterDirection: "at_least",
    aliases: ["click_through_rate", "clickthrough_rate"],
    hint: "Clicks divided by impressions. Write the target as a percentage.",
  },
  {
    key: "cpc",
    label: "Cost per click",
    unit: "money",
    betterDirection: "at_most",
    aliases: ["cost_per_click"],
    hint: "Spend divided by clicks.",
  },
  {
    key: "cpm",
    label: "Cost per 1,000 impressions",
    unit: "money",
    betterDirection: "at_most",
    aliases: ["cost_per_mille", "cost_per_thousand_impressions"],
    hint: "Spend per thousand impressions.",
  },
  {
    key: "clicks",
    label: "Clicks",
    unit: "count",
    betterDirection: "at_least",
    aliases: ["click", "link_clicks"],
    hint: "How many clicks the period must produce.",
  },
  {
    key: "impressions",
    label: "Impressions",
    unit: "count",
    betterDirection: "at_least",
    aliases: ["impression", "views"],
    hint: "How many impressions the period must produce.",
  },
  {
    key: "spend",
    label: "Spend",
    unit: "money",
    betterDirection: "at_most",
    aliases: ["cost", "settled_spend"],
    hint: "Total settled spend for the period.",
  },
];

export const MARKETING_SUCCESS_METRIC_KEYS: string[] = MARKETING_SUCCESS_METRICS.map(
  (metric) => metric.key,
);

/** `Qualified Leads` and `qualified-leads` are the same metric. */
export function normalizeMetricKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function resolveSuccessMetric(value: string): MarketingSuccessMetric | null {
  const key = normalizeMetricKey(value);
  if (!key) return null;
  return (
    MARKETING_SUCCESS_METRICS.find(
      (metric) => metric.key === key || metric.aliases.includes(key),
    ) ?? null
  );
}

/** The Campaign fields a measurement judgement actually depends on. */
export type MarketingCampaignPolicy = Pick<
  MarketingCampaign,
  "status" | "currency" | "successMetric" | "targetValue" | "targetDirection" | "dailyBudgetMinor"
>;

/** The snapshot fields the arithmetic reads. */
export type MarketingReadout = Pick<
  MarketingPerformanceSnapshot,
  | "periodStart"
  | "periodEnd"
  | "spendMinor"
  | "impressions"
  | "clicks"
  | "conversions"
  | "conversionValue"
  | "supersededAt"
>;

export type MarketingTotals = {
  snapshots: number;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMinor: number;
  /** Days of delivery the readouts actually cover, overlaps counted once. */
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
  /** Both in display units — whole currency for money, percent for rates. */
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
  /** Average daily spend over planned daily budget. 1 is exactly on plan. */
  pacingRatio: number | null;
  target: MarketingTargetStatus;
  attention: MarketingAttention[];
};

const DAY_MS = 86_400_000;

/** Days after which an active Campaign's newest readout counts as stale. */
export const MARKETING_STALE_AFTER_DAYS = 3;
export const MARKETING_DEFAULT_WINDOW_DAYS = 30;

function ms(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function decimal(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Live rows only: a superseded readout is history, never arithmetic. */
export function liveReadouts<T extends Pick<MarketingReadout, "supersededAt">>(rows: T[]): T[] {
  return rows.filter((row) => !row.supersededAt);
}

/**
 * Live readouts whose period ends inside the window. Snapshots straddling the
 * window edge are included whole rather than pro-rated: a platform readout is
 * an indivisible statement about its own period, and slicing it would invent
 * precision the platform never reported.
 */
export function readoutsInWindow<T extends MarketingReadout>(
  rows: T[],
  windowDays: number,
  now: Date = new Date(),
): T[] {
  const floor = now.getTime() - windowDays * DAY_MS;
  return liveReadouts(rows).filter((row) => ms(row.periodEnd) >= floor);
}

/**
 * Delivery days the readouts cover, merging any overlap.
 *
 * Live windows for one Campaign cannot overlap any more — `recordMarketing
 * Performance` refuses that — but rows written before this rule existed can,
 * and counting a day twice would halve every average built on top of it.
 */
function coveredDays(rows: MarketingReadout[]): number {
  const spans = rows
    .map((row) => [ms(row.periodStart), ms(row.periodEnd)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let start: number | null = null;
  let end = 0;
  for (const [spanStart, spanEnd] of spans) {
    if (start === null) {
      start = spanStart;
      end = spanEnd;
      continue;
    }
    if (spanStart <= end) {
      end = Math.max(end, spanEnd);
      continue;
    }
    total += end - start;
    start = spanStart;
    end = spanEnd;
  }
  if (start !== null) total += end - start;
  return total / DAY_MS;
}

export function totalReadouts(rows: MarketingReadout[]): MarketingTotals {
  const totals: MarketingTotals = {
    snapshots: rows.length,
    spendMinor: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversionValueMinor: 0,
    coveredDays: coveredDays(rows),
    periodStart: null,
    periodEnd: null,
  };
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const row of rows) {
    totals.spendMinor += row.spendMinor;
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.conversions += decimal(row.conversions);
    // Conversion value is recorded in whole currency; spend is in minor units.
    // Everything downstream is minor, so it converts here exactly once.
    totals.conversionValueMinor += Math.round(decimal(row.conversionValue) * 100);
    const start = ms(row.periodStart);
    const end = ms(row.periodEnd);
    if (Number.isFinite(start) && (earliest === null || start < earliest)) earliest = start;
    if (Number.isFinite(end) && (latest === null || end > latest)) latest = end;
  }
  totals.periodStart = earliest === null ? null : new Date(earliest).toISOString();
  totals.periodEnd = latest === null ? null : new Date(latest).toISOString();
  return totals;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function deriveMetrics(totals: MarketingTotals): MarketingDerived {
  const cpc = ratio(totals.spendMinor, totals.clicks);
  const cpa = ratio(totals.spendMinor, totals.conversions);
  const cpm = ratio(totals.spendMinor * 1000, totals.impressions);
  const avgDaily = ratio(totals.spendMinor, totals.coveredDays);
  return {
    ctr: ratio(totals.clicks, totals.impressions),
    conversionRate: ratio(totals.conversions, totals.clicks),
    cpcMinor: cpc === null ? null : Math.round(cpc),
    cpmMinor: cpm === null ? null : Math.round(cpm),
    cpaMinor: cpa === null ? null : Math.round(cpa),
    roas: ratio(totals.conversionValueMinor, totals.spendMinor),
    avgDailySpendMinor: avgDaily === null ? null : Math.round(avgDaily),
  };
}

/** The raw value behind a metric, in its internal unit. */
function actualFor(
  metric: MarketingSuccessMetric,
  totals: MarketingTotals,
  derived: MarketingDerived,
): number | null {
  switch (metric.key) {
    case "conversions":
      return totals.conversions;
    case "clicks":
      return totals.clicks;
    case "impressions":
      return totals.impressions;
    case "spend":
      return totals.spendMinor;
    case "conversion_value":
      return totals.conversionValueMinor;
    case "cpa":
      return derived.cpaMinor;
    case "cpc":
      return derived.cpcMinor;
    case "cpm":
      return derived.cpmMinor;
    case "ctr":
      return derived.ctr;
    case "conversion_rate":
      return derived.conversionRate;
    case "roas":
      return derived.roas;
    default:
      return null;
  }
}

/** Internal unit to the unit a human typed the target in. */
export function toDisplayUnit(unit: MarketingMetricUnit, value: number | null): number | null {
  if (value === null) return null;
  if (unit === "money") return value / 100;
  if (unit === "percent") return value * 100;
  return value;
}

export function targetStatus(
  policy: MarketingCampaignPolicy,
  totals: MarketingTotals,
  derived: MarketingDerived,
): MarketingTargetStatus {
  const metric = resolveSuccessMetric(policy.successMetric);
  const target = policy.targetValue.trim() === "" ? null : Number(policy.targetValue);
  const targetValue = target !== null && Number.isFinite(target) ? target : null;
  const base = {
    metricKey: metric?.key ?? null,
    metricLabel: metric?.label ?? policy.successMetric,
    unit: metric?.unit ?? ("count" as MarketingMetricUnit),
    direction: policy.targetDirection,
    targetValue,
  };
  if (!metric) return { ...base, actualValue: null, state: "not_comparable" };
  const actualValue = toDisplayUnit(metric.unit, actualFor(metric, totals, derived));
  if (targetValue === null) return { ...base, actualValue, state: "no_target" };
  if (actualValue === null) return { ...base, actualValue, state: "no_data" };
  const met =
    policy.targetDirection === "at_most" ? actualValue <= targetValue : actualValue >= targetValue;
  return { ...base, actualValue, state: met ? "on_target" : "off_target" };
}

function money(minor: number | null, currency: string): string {
  if (minor === null) return "—";
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

function rounded(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** How far off plan counts as worth surfacing, in either direction. */
const OVERSPEND_RATIO = 1.15;
const UNDERSPEND_RATIO = 0.6;

export function campaignAttention(
  policy: MarketingCampaignPolicy,
  metrics: Omit<MarketingCampaignMetrics, "attention">,
  context: { liveCreativeCount: number; now?: Date },
): MarketingAttention[] {
  const now = context.now ?? new Date();
  const out: MarketingAttention[] = [];
  const running = policy.status === "active";
  const { totals, target, pacingRatio } = metrics;

  if (running && totals.snapshots === 0) {
    out.push({
      code: "no_performance_data",
      severity: "warn",
      message: `Active with no recorded performance in the last ${metrics.windowDays} days. The loop has nothing to decide against.`,
    });
  } else if (running && totals.periodEnd) {
    const ageDays = (now.getTime() - ms(totals.periodEnd)) / DAY_MS;
    if (ageDays > MARKETING_STALE_AFTER_DAYS) {
      out.push({
        code: "stale_performance",
        severity: "warn",
        message: `Newest readout is ${Math.floor(ageDays)} days old. Record a fresh snapshot before acting on these numbers.`,
      });
    }
  }

  if (target.state === "off_target" && target.targetValue !== null) {
    const unit = target.unit;
    const actual =
      unit === "money"
        ? money(Math.round((target.actualValue ?? 0) * 100), policy.currency)
        : rounded(target.actualValue ?? 0);
    const goal =
      unit === "money"
        ? money(Math.round(target.targetValue * 100), policy.currency)
        : rounded(target.targetValue);
    const comparator = target.direction === "at_most" ? "at most" : "at least";
    out.push({
      code: "off_target",
      severity: "warn",
      message: `${target.metricLabel} is ${actual}${unit === "percent" ? "%" : ""} against a target of ${comparator} ${goal}${unit === "percent" ? "%" : ""}.`,
    });
  }

  if (target.state === "not_comparable" && policy.targetValue.trim() !== "") {
    out.push({
      code: "target_not_comparable",
      severity: "info",
      message: `"${policy.successMetric}" is not a metric Genosyn can measure, so its target is never checked. Pick a known success metric to have it judged automatically.`,
    });
  }

  if (running && pacingRatio !== null) {
    if (pacingRatio > OVERSPEND_RATIO) {
      out.push({
        code: "overspending",
        severity: "warn",
        message: `Spending ${money(metrics.derived.avgDailySpendMinor, policy.currency)} a day against a ${money(policy.dailyBudgetMinor, policy.currency)} plan.`,
      });
    } else if (pacingRatio < UNDERSPEND_RATIO && totals.spendMinor > 0) {
      out.push({
        code: "underdelivering",
        severity: "info",
        message: `Only ${money(metrics.derived.avgDailySpendMinor, policy.currency)} of a ${money(policy.dailyBudgetMinor, policy.currency)} daily plan is being spent.`,
      });
    }
  }

  if (running && context.liveCreativeCount === 0) {
    out.push({
      code: "no_live_creative",
      severity: "info",
      message: "Active with no approved or running Creative in the workspace.",
    });
  }

  return out;
}

export function campaignMetrics(
  policy: MarketingCampaignPolicy,
  readouts: MarketingReadout[],
  options: { windowDays?: number; now?: Date; liveCreativeCount?: number } = {},
): MarketingCampaignMetrics {
  const windowDays = options.windowDays ?? MARKETING_DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const rows = readoutsInWindow(readouts, windowDays, now);
  const totals = totalReadouts(rows);
  const derived = deriveMetrics(totals);
  const pacingRatio =
    policy.dailyBudgetMinor > 0 && derived.avgDailySpendMinor !== null
      ? derived.avgDailySpendMinor / policy.dailyBudgetMinor
      : null;
  const target = targetStatus(policy, totals, derived);
  const partial = { windowDays, totals, derived, pacingRatio, target };
  return {
    ...partial,
    attention: campaignAttention(policy, partial, {
      liveCreativeCount: options.liveCreativeCount ?? 0,
      now,
    }),
  };
}
