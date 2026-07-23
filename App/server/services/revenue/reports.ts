import type { ChannelCac } from "./cac.js";
import {
  computeBlendedCac,
  computeCacByChannel,
  computeLtvCents,
  computeLtvToCac,
  computePaybackMonths,
} from "./cac.js";
import type {
  FunnelDeal,
  Period,
  PipelineCoverageResult,
  StageConversionRow,
  StageFunnelRow,
  StageLike,
  WinRateResult,
} from "./funnel.js";
import {
  computePipelineCoverage,
  computeSalesCycleDays,
  computeStageConversion,
  computeStageFunnel,
  computeWinRate,
} from "./funnel.js";
import type { MrrMovement, RetentionResult } from "./mrr.js";
import { arrCents, computeMrrMovement, computeRetention, sumSnapshot } from "./mrr.js";
import { roundHalfAway } from "../../lib/money.js";
import type { MonthlyRevenueSnapshots } from "./revenueData.js";
import {
  buildEverBeforeSet,
  buildMonthlyRevenueSnapshots,
  collectCollectedRevenue,
  collectFunnelDeals,
  collectSpendByChannel,
  collectStages,
  collectWonDealsByChannel,
  getReportingCurrency,
} from "./revenueData.js";

/**
 * The revenue reports the API hands to the client.
 *
 * This file assembles; it does not calculate. Every number below comes out of
 * `mrr.ts`, `funnel.ts` or `cac.ts`, and every row comes out of
 * `revenueData.ts`. If you find yourself adding a `/`, a `*` or a `Math.round`
 * here, it belongs in one of those four files instead — the split is what lets
 * the arithmetic be tested without a database and the queries be tested without
 * re-deriving the arithmetic. The two exceptions are named and argued for where
 * they appear ({@link averageMonthlyChurnPct} and {@link arpaCents}), because
 * they are *inputs* the pure modules take and nobody else is positioned to
 * derive them.
 *
 * Three conventions, stated once:
 *
 * - **Periods are half-open `[from, to)`**, as in `funnel.ts` and
 *   `revenueData.ts`. The month series is derived from `to - 1ms` so a period
 *   ending exactly on a month boundary does not pick up an empty trailing
 *   month.
 * - **An empty company returns zeros and nulls, never NaN and never a throw.**
 *   A brand-new company opening the revenue page is the most common state this
 *   code will ever be in, and it must render. Zero is used where zero is a fact
 *   ("no cash collected"), null where the number does not exist ("no cohort, so
 *   no retention percentage") — the distinction the pure modules already make.
 * - **Invalid bounds throw.** A non-Date or Invalid Date `from`/`to` is a caller
 *   bug — a route that failed to parse a query string and called anyway — not a
 *   data condition. Same line `computePipelineCoverage` draws for a non-finite
 *   target: data returns null, programmer error throws, and a report quietly
 *   covering the wrong six months is worse than a 500.
 */

/** Longest series we will build in one call. */
const MAX_SERIES_MONTHS = 60;

/** One decimal is the precision anybody actually reads. Matches `mrr.ts`. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function requirePeriod(period: Period): { from: Date; to: Date } {
  const { from, to } = period ?? {};
  const valid = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());
  if (!valid(from) || !valid(to)) {
    throw new Error("revenue report: period.from and period.to must be valid Dates");
  }
  return { from, to };
}

/** Non-finite targets would make `computePipelineCoverage` throw; 0 means "no target set". */
function safeTargetCents(targetCents: number | undefined): number {
  return Number.isFinite(targetCents) ? (targetCents as number) : 0;
}

export type MrrSeriesPoint = { month: string } & MrrMovement;

export type MrrSection = {
  /** Recurring revenue in the final month of the period, in cents. */
  currentCents: number;
  /** The final month's movement. Zeroed (not null) when the period is empty. */
  movement: MrrMovement;
  series: MrrSeriesPoint[];
};

type MrrBuild = {
  snapshots: MonthlyRevenueSnapshots;
  months: string[];
  section: MrrSection;
};

/** An all-zero movement, for a period with no months in it at all. */
function emptyMovement(): MrrMovement {
  return computeMrrMovement(new Map(), new Map());
}

/**
 * Walk the months and diff each against the one before it.
 *
 * The first month of any window is a **cold start**: its `previous` is empty, so
 * every customer alive in it reads as new business. That is not a bug and it is
 * not hidden — it is why the series is returned whole rather than just the last
 * movement, and why a caller charting "new MRR" should either drop the first
 * point or widen the window by a month. Faking a previous month by loading one
 * extra behind the scenes would make the returned range disagree with the range
 * that was asked for, which is a worse surprise.
 *
 * `everBefore` is rebuilt per month from the snapshots so reactivation is
 * separated from new business — see `buildEverBeforeSet` for what "ever" is
 * bounded by.
 */
async function buildMrr(companyId: string, from: Date, to: Date): Promise<MrrBuild> {
  // `to` is exclusive, so the last month of the series is the month containing
  // the last instant before it. Without this, a period of exactly [Jan, Feb)
  // would report an empty February.
  const lastInstant = new Date(to.getTime() - 1);
  const snapshots = await buildMonthlyRevenueSnapshots(companyId, from, lastInstant);
  const months = [...snapshots.keys()];

  const series: MrrSeriesPoint[] = [];
  const movements: MrrMovement[] = [];
  let previous: ReadonlyMap<string, number> = new Map();
  for (const month of months) {
    const current = snapshots.get(month) ?? new Map<string, number>();
    const movement = computeMrrMovement(previous, current, buildEverBeforeSet(snapshots, month));
    movements.push(movement);
    series.push({ month, ...movement });
    previous = current;
  }

  // The movement is kept separately rather than reusing the last series point,
  // which carries a `month` the `MrrMovement` type does not declare. A payload
  // with an undeclared field is a payload somebody will eventually depend on.
  const last = movements[movements.length - 1];
  return {
    snapshots,
    months,
    section: {
      currentCents: last?.endingCents ?? 0,
      movement: last ?? emptyMovement(),
      series,
    },
  };
}

/**
 * Average monthly revenue churn across the period, as a percentage.
 *
 * The input `computeLtvCents` needs and nothing in the pure modules can supply:
 * churn is a property of a *series*, and `mrr.ts` deliberately works one month
 * at a time. Averaging the monthly rates rather than taking the last month is a
 * deliberate trade: a single bad month in a small book swings LTV by multiples,
 * and LTV is the number that ends up on a slide.
 *
 * Months that started at zero are skipped, not counted as 0% churn — including
 * the cold-start first month would drag the average down by however many months
 * the window has. `null` when no month had anything to lose, which propagates
 * through `computeLtvCents` as a null LTV rather than an infinite one.
 */
function averageMonthlyChurnPct(series: readonly MrrSeriesPoint[]): number | null {
  let total = 0;
  let counted = 0;
  for (const point of series) {
    if (point.startingCents <= 0) continue;
    total += (point.churnCents / point.startingCents) * 100;
    counted += 1;
  }
  if (counted === 0) return null;
  return oneDecimal(total / counted);
}

/**
 * Average revenue per account in the final month.
 *
 * The other input `computeLtvCents` needs. Straight mean of the paying
 * customers in the last snapshot — not a median, because LTV multiplies it by a
 * lifetime and the total has to reconcile with MRR. `null` for a company with
 * no paying customers, which is the case that would otherwise be 0/0.
 */
function arpaCents(snapshot: ReadonlyMap<string, number> | undefined): number | null {
  if (snapshot === undefined || snapshot.size === 0) return null;
  return roundHalfAway(sumSnapshot(snapshot) / snapshot.size);
}

export type FunnelSection = {
  stages: StageFunnelRow[];
  /** Open deals sitting in a stage that is archived or gone. A staleness signal. */
  orphanedCount: number;
  conversion: StageConversionRow[];
  winRate: WinRateResult;
  /** Median days, won deals only. `null` when nothing closed won in the period. */
  salesCycleDays: number | null;
};

function buildFunnel(
  deals: readonly FunnelDeal[],
  stages: readonly StageLike[],
  period: Period,
): FunnelSection {
  const funnel = computeStageFunnel(deals, stages);
  return {
    stages: funnel.rows,
    orphanedCount: funnel.orphanedCount,
    conversion: computeStageConversion(funnel.rows),
    winRate: computeWinRate(deals, period),
    salesCycleDays: computeSalesCycleDays(deals, period),
  };
}

export type CacSection = {
  channels: ChannelCac[];
  /** Total spend over total wins. `null` when nothing was won anywhere. */
  blendedCacCents: number | null;
  spendCents: number;
  wonCount: number;
  arpaCents: number | null;
  monthlyChurnPct: number | null;
  ltvCents: number | null;
  ltvToCac: number | null;
  paybackMonths: number | null;
  /**
   * Always `true`. Spend is derived from the **authorized budget** ledger, not
   * from realized platform spend — see `collectSpendByChannel`. The flag is on
   * the payload rather than in a comment so the UI is forced to say so too.
   */
  spendIsProxy: boolean;
};

/**
 * Assemble the CAC block from already-loaded inputs.
 *
 * `grossMarginPct` has **no default**. Every LTV formula needs a margin, every
 * SaaS deck assumes one, and picking 75% here would produce a confident,
 * plausible, entirely invented number that somebody would forward to an
 * investor. Omitted margin means `ltvCents`, `ltvToCac` and `paybackMonths` come
 * back null and the UI prints "set your gross margin", which is the honest
 * prompt. Out-of-range margins are `computeLtvCents`'s to reject.
 */
function buildCac(args: {
  spendByChannel: ReadonlyMap<string, number>;
  wonByChannel: ReadonlyMap<string, number>;
  arpaCents: number | null;
  monthlyChurnPct: number | null;
  grossMarginPct?: number;
}): CacSection {
  const channels = computeCacByChannel(args.spendByChannel, args.wonByChannel);
  const blendedCacCents = computeBlendedCac(args.spendByChannel, args.wonByChannel);

  let spendCents = 0;
  for (const row of channels) spendCents += row.spendCents;
  let wonCount = 0;
  for (const row of channels) wonCount += row.wonCount;

  const margin = args.grossMarginPct;
  const hasMargin = typeof margin === "number" && Number.isFinite(margin);

  const ltvCents =
    hasMargin && args.arpaCents !== null && args.monthlyChurnPct !== null
      ? computeLtvCents(args.arpaCents, margin, args.monthlyChurnPct)
      : null;

  const monthlyGrossProfitCents =
    hasMargin && args.arpaCents !== null ? roundHalfAway((args.arpaCents * margin) / 100) : null;

  const paybackMonths =
    blendedCacCents !== null && monthlyGrossProfitCents !== null
      ? computePaybackMonths(blendedCacCents, monthlyGrossProfitCents)
      : null;

  return {
    channels,
    blendedCacCents,
    spendCents,
    wonCount,
    arpaCents: args.arpaCents,
    monthlyChurnPct: args.monthlyChurnPct,
    ltvCents,
    ltvToCac: computeLtvToCac(ltvCents, blendedCacCents),
    paybackMonths,
    spendIsProxy: true,
  };
}

export type RevenueOverviewOptions = {
  from: Date;
  to: Date;
  /** Sales target for the period. Omitted or 0 → coverage multiples are null. */
  targetCents?: number;
  /** 0-100. Omitted → LTV, LTV:CAC and payback are null rather than invented. */
  grossMarginPct?: number;
};

export type RevenueOverview = {
  period: { from: Date; to: Date };
  mrr: MrrSection;
  /** Annual run rate off the final month's MRR. */
  arrCents: number;
  retention: RetentionResult;
  funnel: FunnelSection;
  coverage: PipelineCoverageResult;
  cac: CacSection;
  /** Cash that actually arrived in the period. Expected to disagree with MRR. */
  collectedCents: number;
  currency: string;
};

/**
 * Everything the revenue page shows, in one call.
 *
 * The queries are issued in parallel because none of them depends on another's
 * result — a page that takes seven sequential round-trips to render is a page
 * people stop opening.
 *
 * **Retention compares the first month of the period against the last.** That
 * makes the window the cohort definition, which is the interpretation that
 * matches how the rest of this object reads ("here is Q3") and the one a caller
 * controls by choosing `from` and `to`. It is *not* a true cohort report — "how
 * did the customers who joined in January do twelve months later" needs a grid
 * of cohorts, which is its own screen and its own query. A single-month period
 * compares the month against itself and honestly reports 100% NRR/GRR.
 */
export async function getRevenueOverview(
  companyId: string,
  opts: RevenueOverviewOptions,
): Promise<RevenueOverview> {
  const { from, to } = requirePeriod(opts);
  const period: Period = { from, to };

  const [mrr, deals, stages, spendByChannel, wonByChannel, collectedCents, currency] =
    await Promise.all([
      buildMrr(companyId, from, to),
      collectFunnelDeals(companyId, { from, to }),
      collectStages(companyId),
      collectSpendByChannel(companyId, from, to),
      collectWonDealsByChannel(companyId, from, to),
      collectCollectedRevenue(companyId, from, to),
      getReportingCurrency(companyId),
    ]);

  const firstMonth = mrr.months[0];
  const lastMonth = mrr.months[mrr.months.length - 1];
  const cohort = firstMonth === undefined ? new Map() : (mrr.snapshots.get(firstMonth) ?? new Map());
  const latest = lastMonth === undefined ? new Map() : (mrr.snapshots.get(lastMonth) ?? new Map());

  return {
    period: { from, to },
    mrr: mrr.section,
    arrCents: arrCents(mrr.section.currentCents),
    retention: computeRetention(cohort, latest),
    funnel: buildFunnel(deals, stages, period),
    coverage: computePipelineCoverage(deals, stages, safeTargetCents(opts.targetCents)),
    cac: buildCac({
      spendByChannel,
      wonByChannel,
      arpaCents: arpaCents(latest),
      monthlyChurnPct: averageMonthlyChurnPct(mrr.section.series),
      grossMarginPct: opts.grossMarginPct,
    }),
    collectedCents,
    currency,
  };
}

export type MrrSeriesReport = {
  months: string[];
  currentCents: number;
  arrCents: number;
  series: MrrSeriesPoint[];
  currency: string;
};

/**
 * The last `months` months of MRR movement, ending with the month containing
 * `now`.
 *
 * The current month is **included and incomplete** — it reflects who is paying
 * today, not who will be on the 31st. Excluding it would make the chart end a
 * month in the past, which reads as broken; including it means the last point
 * moves during the month, which is what a run rate does.
 *
 * `now` is a parameter rather than `Date.now()` so the caller owns the clock and
 * the tests are deterministic, matching `dealStage.ts`. `months` is clamped to
 * 1..60 instead of rejected: a query string asking for 500 months should give
 * five years, not a 400.
 */
export async function getMrrSeries(
  companyId: string,
  months: number,
  now: Date = new Date(),
): Promise<MrrSeriesReport> {
  const anchor = Number.isFinite(now.getTime()) ? now : new Date();
  const wanted = Number.isFinite(months) ? Math.floor(months) : 1;
  const span = Math.min(Math.max(wanted, 1), MAX_SERIES_MONTHS);

  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - (span - 1), 1));
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));

  const [mrr, currency] = await Promise.all([
    buildMrr(companyId, from, to),
    getReportingCurrency(companyId),
  ]);

  return {
    months: mrr.months,
    currentCents: mrr.section.currentCents,
    arrCents: arrCents(mrr.section.currentCents),
    series: mrr.section.series,
    currency,
  };
}

export type FunnelReport = FunnelSection & {
  period: { from: Date; to: Date };
  coverage: PipelineCoverageResult;
  currency: string;
};

/**
 * The funnel screen: stage columns, conversion, win rate, cycle length and
 * coverage.
 *
 * Coverage is here rather than only on the overview because the target is a
 * funnel question, and the two numbers are read together — "3.2x coverage
 * against a 40% win rate" is a sentence, "3.2x" on its own is not.
 */
export async function getFunnelReport(
  companyId: string,
  period: Period,
  opts: { targetCents?: number } = {},
): Promise<FunnelReport> {
  const { from, to } = requirePeriod(period);

  const [deals, stages, currency] = await Promise.all([
    collectFunnelDeals(companyId, { from, to }),
    collectStages(companyId),
    getReportingCurrency(companyId),
  ]);

  return {
    period: { from, to },
    ...buildFunnel(deals, stages, { from, to }),
    coverage: computePipelineCoverage(deals, stages, safeTargetCents(opts.targetCents)),
    currency,
  };
}

export type CacReport = CacSection & {
  period: { from: Date; to: Date };
  currency: string;
};

/**
 * The acquisition screen: spend, wins and unit economics per channel.
 *
 * Builds the MRR snapshots for the same period even though nothing here charts
 * them — ARPA and churn are the two inputs LTV needs, and deriving them from
 * anything other than the same snapshots the MRR chart uses would leave two
 * screens quoting different churn rates for the same quarter.
 *
 * Read `collectSpendByChannel` before quoting any of these numbers: the spend
 * side is authorized budget, not realized spend, and `spendIsProxy` says so on
 * the payload.
 */
export async function getCacReport(
  companyId: string,
  period: Period,
  opts: { grossMarginPct?: number } = {},
): Promise<CacReport> {
  const { from, to } = requirePeriod(period);

  const [mrr, spendByChannel, wonByChannel, currency] = await Promise.all([
    buildMrr(companyId, from, to),
    collectSpendByChannel(companyId, from, to),
    collectWonDealsByChannel(companyId, from, to),
    getReportingCurrency(companyId),
  ]);

  const lastMonth = mrr.months[mrr.months.length - 1];
  const latest = lastMonth === undefined ? undefined : mrr.snapshots.get(lastMonth);

  return {
    period: { from, to },
    ...buildCac({
      spendByChannel,
      wonByChannel,
      arpaCents: arpaCents(latest),
      monthlyChurnPct: averageMonthlyChurnPct(mrr.section.series),
      grossMarginPct: opts.grossMarginPct,
    }),
    currency,
  };
}
