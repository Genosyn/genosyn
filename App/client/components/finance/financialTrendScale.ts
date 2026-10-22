import type { FinancialTrendPoint } from "../../lib/api";
import { niceAxis, type Axis } from "../charts/axis";

/**
 * The arithmetic behind `FinancialTrendChart`, kept apart from its SVG so each
 * piece can be checked on its own: a y-axis on round numbers with zero always
 * on it, compact money for its ticks, month labels that thin out evenly
 * instead of colliding, and the figure the chart's header gives each series.
 */

/**
 * The money axis, in cents: round steps through zero (see `niceAxis`), at
 * least one whole unit of currency tall so a flat line or a few cents still
 * sit on an axis that can be cut into round steps, and never a fraction of a
 * cent apart.
 */
export function niceScale(values: number[]): Axis {
  return niceAxis(values, { minSpan: 100, integerSteps: true });
}

/** "$25K", "-$1.25M", "€0": the home currency, compact enough for an axis. */
export function formatAxisMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "symbol",
      notation: "compact",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${Math.round(cents / 100)} ${currency}`;
  }
}

const SHORT_MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const LONG_MONTH = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

type MonthSpan = Pick<FinancialTrendPoint, "from" | "to">;

/**
 * The months the x-axis names: every `stride`th one counted back from the
 * latest, so the most recent month is always labelled. The year rides on the
 * first label and on any label where it changes — "Jan 2026", "Feb", "Mar".
 */
export function monthTicks(
  points: MonthSpan[],
  stride: number,
): Array<{ index: number; label: string }> {
  const ticks: Array<{ index: number; label: string }> = [];
  let year: number | null = null;
  points.forEach((point, index) => {
    if ((points.length - 1 - index) % stride !== 0) return;
    const start = new Date(point.from);
    const month = SHORT_MONTH.format(start);
    ticks.push({
      index,
      label: start.getUTCFullYear() === year ? month : `${month} ${start.getUTCFullYear()}`,
    });
    year = start.getUTCFullYear();
  });
  return ticks;
}

/**
 * The smallest stride at which no two month labels crowd each other, given the
 * width of one month on the axis and a way to measure a label.
 */
export function monthStride(
  points: MonthSpan[],
  monthWidth: number,
  measure: (text: string) => number,
  gap = 12,
): number {
  for (let stride = 1; stride < points.length; stride++) {
    const ticks = monthTicks(points, stride);
    const fits = ticks.every(
      (tick, i) =>
        i === 0 ||
        (tick.index - ticks[i - 1].index) * monthWidth >=
          (measure(ticks[i - 1].label) + measure(tick.label)) / 2 + gap,
    );
    if (fits) return stride;
  }
  return Math.max(1, points.length);
}

/** "October 2026", or "Oct 1 – 22, 2026" for a month the period cuts short. */
export function monthHeading(point: MonthSpan): string {
  const from = new Date(point.from);
  const to = new Date(point.to);
  const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  if (from.getUTCDate() === 1 && to.getUTCDate() === lastDay.getUTCDate()) {
    return LONG_MONTH.format(from);
  }
  const month = SHORT_MONTH.format(from);
  const days =
    from.getUTCDate() === to.getUTCDate()
      ? `${from.getUTCDate()}`
      : `${from.getUTCDate()} – ${to.getUTCDate()}`;
  return `${month} ${days}, ${from.getUTCFullYear()}`;
}

/**
 * What one series amounts to over the period: monthly flows add up, balances
 * are read at the period's end. Matches the totals in the statement beneath
 * the chart. `null` when there are no months to read.
 */
export function periodFigure(values: number[], summary: "sum" | "last"): number | null {
  if (values.length === 0) return null;
  if (summary === "last") return values[values.length - 1];
  return values.reduce((total, value) => total + value, 0);
}
