import React from "react";
import { formatMoney, FinancialTrendPoint } from "../../lib/api";
import { clsx } from "../ui/clsx";
import { Spinner } from "../ui/Spinner";
import { columnPath, crisp } from "../charts/axis";
import { AXIS_FONT_SIZE, textWidth, usePlotSize } from "../charts/usePlotSize";
import {
  formatAxisMoney,
  monthHeading,
  monthStride,
  monthTicks,
  niceScale,
  periodFigure,
} from "./financialTrendScale";

export type FinancialMetricKey =
  | "revenue"
  | "expenses"
  | "netIncome"
  | "assets"
  | "liabilities"
  | "equity"
  | "operatingCash"
  | "investingCash"
  | "financingCash"
  | "netCash"
  | "closingCash";

export type FinancialTrendSeries = {
  key: FinancialMetricKey;
  label: string;
  color: string;
  /**
   * `bar` for a monthly flow, drawn as a column beside the month's other
   * columns; `line` for the balance or bottom line they come to, drawn over
   * them. Two lines that track each other hide one another; columns never do.
   */
  kind: "bar" | "line";
  /** The header's figure for the period: a flow's total, or a balance at the end. */
  summary: "sum" | "last";
};

/**
 * The series colours, in the order every report assigns them: its two
 * columns, then its line. Emerald-600, orange-600 and indigo-500 stay apart
 * under protanopia and deuteranopia and clear 3:1 against both the white and
 * the slate-900 card, so the same three serve light and dark.
 */
export const TREND_COLORS = ["#059669", "#ea580c", "#6366f1"] as const;

/** Plot height in px, month labels included. `h-[16.5rem]` below matches it. */
const HEIGHT = 264;
const MARGIN = { top: 12, right: 12, bottom: 30 };
/** Columns stay thin however wide a month is; the rest of the month is air. */
const BAR_MAX_WIDTH = 24;
const BAR_GAP = 2;

/**
 * The month-by-month chart above each financial report. Flows are columns and
 * the balance or bottom line they come to is a line on the same axis. The
 * header gives each series' figure for the whole period, the same totals as
 * the statement beneath; point at, tap, or arrow-key to a month to read it.
 */
export function FinancialTrendChart({
  title,
  subtitle,
  points,
  series,
  truncated,
  homeCurrency,
  loading = false,
}: {
  title: string;
  subtitle: string;
  /** `null` until the first months arrive. */
  points: FinancialTrendPoint[] | null;
  series: FinancialTrendSeries[];
  truncated?: boolean;
  homeCurrency: string;
  /** New months are on their way; the current ones stay up, dimmed, until then. */
  loading?: boolean;
}) {
  const hasActivity =
    points?.some((point) => series.some((item) => point[item.key] !== 0)) ?? false;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {subtitle}
            {truncated ? " Showing the most recent 24 months." : ""}
          </p>
        </div>
        <dl
          className={clsx(
            "flex flex-wrap gap-x-8 gap-y-3 transition-opacity",
            loading && "opacity-50",
          )}
        >
          {series.map((item) => {
            const figure = points
              ? periodFigure(
                  points.map((point) => point[item.key]),
                  item.summary,
                )
              : null;
            return (
              <div key={item.key}>
                <dt className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <SeriesKey kind={item.kind} color={item.color} />
                  {item.label}
                </dt>
                <dd className="mt-1 text-base font-semibold text-slate-900 sm:text-lg dark:text-slate-100">
                  {figure === null ? "—" : formatMoney(figure, homeCurrency)}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="px-2 pb-2 pt-4 sm:px-3">
        {points === null ? (
          <div className="flex h-[16.5rem] items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : !hasActivity ? (
          <div className="flex h-[16.5rem] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            No ledger activity in this period.
          </div>
        ) : (
          <div className={clsx("transition-opacity", loading && "opacity-50")}>
            <TrendPlot title={title} points={points} series={series} homeCurrency={homeCurrency} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The legend mirrors the mark: a column for a column, a line for a line. */
function SeriesKey({ kind, color }: { kind: FinancialTrendSeries["kind"]; color: string }) {
  return (
    <svg aria-hidden="true" width="14" height="10" viewBox="0 0 14 10" className="shrink-0">
      {kind === "bar" ? (
        <rect x="3" y="0" width="8" height="10" rx="2" fill={color} />
      ) : (
        <>
          <line x1="1" x2="13" y1="5" y2="5" stroke={color} strokeWidth="2" strokeLinecap="round" />
          <circle cx="7" cy="5" r="3" fill={color} />
        </>
      )}
    </svg>
  );
}

/**
 * The plot itself, drawn at the pixel size of its box rather than stretched
 * from a fixed viewBox, so text and dots keep their shape at any width.
 */
function TrendPlot({
  title,
  points,
  series,
  homeCurrency,
}: {
  title: string;
  points: FinancialTrendPoint[];
  series: FinancialTrendSeries[];
  homeCurrency: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const tooltipRef = React.useRef<HTMLDivElement>(null);
  const { width, font } = usePlotSize(ref);
  const [active, setActive] = React.useState<number | null>(null);
  const [tooltipWidth, setTooltipWidth] = React.useState(0);
  const current = active !== null && active < points.length ? active : null;

  // Placed by its real width, measured before paint whenever its text changes.
  React.useLayoutEffect(() => {
    const measured = tooltipRef.current?.offsetWidth;
    if (measured !== undefined && measured !== tooltipWidth) setTooltipWidth(measured);
  }, [current, points, series, homeCurrency, tooltipWidth]);

  const measure = (text: string) => textWidth(text, font);
  const scale = niceScale(points.flatMap((point) => series.map((item) => point[item.key])));
  const tickLabels = scale.ticks.map((tick) => formatAxisMoney(tick, homeCurrency));
  const left = Math.ceil(Math.max(...tickLabels.map(measure))) + 14;
  const plotWidth = Math.max(1, width - left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const monthWidth = plotWidth / points.length;
  const center = (index: number) => left + monthWidth * (index + 0.5);
  const y = (value: number) =>
    MARGIN.top + ((scale.max - value) / (scale.max - scale.min)) * plotHeight;
  const zero = y(0);

  const bars = series.filter((item) => item.kind === "bar");
  const lines = series.filter((item) => item.kind === "line");
  const gaps = Math.max(0, bars.length - 1) * BAR_GAP;
  const barWidth =
    bars.length === 0
      ? 0
      : Math.max(2, Math.min(BAR_MAX_WIDTH, (monthWidth * 0.6 - gaps) / bars.length));
  const groupWidth = bars.length * barWidth + gaps;
  const highlightWidth = Math.min(monthWidth - 2, Math.max(groupWidth, 12) + 28);
  const monthLabels = monthTicks(points, monthStride(points, monthWidth, measure));
  const showDots = monthWidth >= 16;

  const indexAt = (clientX: number): number | null => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return null;
    const x = clientX - box.left - left;
    if (x < -8 || x > plotWidth + 8) return null;
    return Math.min(points.length - 1, Math.max(0, Math.floor(x / monthWidth)));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = points.length - 1;
    let next: number | null;
    if (event.key === "ArrowRight") next = Math.min(last, (current ?? -1) + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, (current ?? last + 1) - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = null;
    else return;
    event.preventDefault();
    setActive(next);
  };

  // The tooltip sits beside the month's marks, on whichever side has room.
  // On a phone-width card, where neither does, it centres over them instead.
  const anchor = current === null ? 0 : center(current);
  const offset = Math.max(groupWidth / 2, 6) + 12;
  const tooltipLeft =
    anchor + offset + tooltipWidth <= width
      ? anchor + offset
      : anchor - offset - tooltipWidth >= 0
        ? anchor - offset - tooltipWidth
        : Math.max(0, Math.min(width - tooltipWidth, anchor - tooltipWidth / 2));

  return (
    <>
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label={`${title}, month by month. Use the arrow keys to step through the months.`}
        className="relative h-[16.5rem] touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onPointerMove={(event) => setActive(indexAt(event.clientX))}
        onPointerDown={(event) => setActive(indexAt(event.clientX))}
        onPointerLeave={(event) => {
          // A tap leaves the month it picked on screen until focus moves on.
          if (event.pointerType !== "touch") setActive(null);
        }}
        onFocus={() => setActive((index) => index ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        {width > 0 && (
          <svg width={width} height={HEIGHT} aria-hidden="true" className="block select-none">
            {current !== null && (
              <rect
                x={center(current) - highlightWidth / 2}
                y={MARGIN.top - 6}
                width={highlightWidth}
                height={plotHeight + 6}
                rx={6}
                className="fill-slate-100 dark:fill-slate-800/70"
              />
            )}

            {scale.ticks.map((tick, i) => (
              <g key={tick}>
                {tick !== 0 && (
                  <line
                    x1={left}
                    x2={width - MARGIN.right}
                    y1={crisp(y(tick))}
                    y2={crisp(y(tick))}
                    className="stroke-slate-100 dark:stroke-slate-800"
                  />
                )}
                <text
                  x={left - 10}
                  y={y(tick)}
                  dy="0.35em"
                  textAnchor="end"
                  fontSize={AXIS_FONT_SIZE}
                  className="fill-slate-500 tabular-nums dark:fill-slate-400"
                >
                  {tickLabels[i]}
                </text>
              </g>
            ))}

            {bars.map((item, slot) => (
              <g key={item.key} fill={item.color}>
                {points.map((point, i) => {
                  const value = point[item.key];
                  if (value === 0) return null;
                  const x = center(i) - groupWidth / 2 + slot * (barWidth + BAR_GAP);
                  // A month with a few dollars against a scale of thousands
                  // still shows that it had some.
                  const end =
                    value > 0 ? Math.min(y(value), zero - 2) : Math.max(y(value), zero + 2);
                  return <path key={point.from} d={columnPath(x, zero, end, barWidth)} />;
                })}
              </g>
            ))}

            <line
              x1={left}
              x2={width - MARGIN.right}
              y1={crisp(zero)}
              y2={crisp(zero)}
              className="stroke-slate-300 dark:stroke-slate-600"
            />

            {lines.map((item) => (
              <g key={item.key}>
                <path
                  d={points
                    .map((point, i) => `${i === 0 ? "M" : "L"}${center(i)},${y(point[item.key])}`)
                    .join("")}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {points.map((point, i) =>
                  showDots || i === current ? (
                    <circle
                      key={point.from}
                      cx={center(i)}
                      cy={y(point[item.key])}
                      r={i === current ? 5.5 : 4}
                      fill={item.color}
                      strokeWidth={2}
                      className="stroke-white dark:stroke-slate-900"
                    />
                  ) : null,
                )}
              </g>
            ))}

            {monthLabels.map((tick) => {
              const half = measure(tick.label) / 2;
              return (
                <text
                  key={tick.index}
                  x={Math.min(Math.max(center(tick.index), half), width - half)}
                  y={HEIGHT - 9}
                  textAnchor="middle"
                  fontSize={AXIS_FONT_SIZE}
                  className={
                    tick.index === current
                      ? "fill-slate-900 font-medium dark:fill-slate-100"
                      : "fill-slate-500 dark:fill-slate-400"
                  }
                >
                  {tick.label}
                </text>
              );
            })}
          </svg>
        )}

        {current !== null && (
          <div
            ref={tooltipRef}
            aria-hidden="true"
            className="pointer-events-none absolute top-1 z-10 w-max min-w-[12rem] rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-lg dark:border-slate-700 dark:bg-slate-800"
            style={{ left: tooltipLeft }}
          >
            <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
              {monthHeading(points[current])}
            </div>
            <div className="mt-2 space-y-1.5">
              {series.map((item) => (
                <div key={item.key} className="flex items-center gap-2 text-xs">
                  <span
                    className="h-[3px] w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-slate-500 dark:text-slate-400">{item.label}</span>
                  <span className="ml-auto pl-6 font-medium tabular-nums text-slate-900 dark:text-slate-100">
                    {formatMoney(points[current][item.key], homeCurrency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((item) => (
              <th key={item.key} scope="col">
                {item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.from}>
              <th scope="row">{monthHeading(point)}</th>
              {series.map((item) => (
                <td key={item.key}>{formatMoney(point[item.key], homeCurrency)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
