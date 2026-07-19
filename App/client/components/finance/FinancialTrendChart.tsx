import React from "react";
import { formatMoney, FinancialTrendPoint } from "../../lib/api";

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
  dashed?: boolean;
};

export function FinancialTrendChart({
  title,
  subtitle,
  points,
  series,
  truncated,
}: {
  title: string;
  subtitle: string;
  points: FinancialTrendPoint[];
  series: FinancialTrendSeries[];
  truncated?: boolean;
}) {
  const width = 900;
  const height = 300;
  const pad = { top: 22, right: 24, bottom: 42, left: 72 };
  const values = points.flatMap((point) => series.map((item) => point[item.key]));
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max = min + 100;
  const spread = max - min;
  min -= spread * 0.08;
  max += spread * 0.08;
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const xAt = (index: number) =>
    points.length <= 1
      ? pad.left + innerWidth / 2
      : pad.left + (innerWidth * index) / (points.length - 1);
  const yAt = (value: number) => pad.top + ((max - value) / (max - min)) * innerHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const last = points.at(-1);

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {subtitle}
            {truncated ? " Showing the most recent 24 months." : ""}
          </p>
        </div>
        {last && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {series.map((item) => (
              <div key={item.key} className="text-right">
                <div className="flex items-center justify-end gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                </div>
                <div className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {formatMoney(last[item.key], "USD")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {points.length === 0 ? (
        <div className="flex h-72 items-center justify-center text-sm text-slate-400">
          No ledger data in this period.
        </div>
      ) : (
        <div className="h-72 w-full p-3">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label={`${title}. ${subtitle}`}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={yAt(tick)}
                  y2={yAt(tick)}
                  className="stroke-slate-100 dark:stroke-slate-800"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={pad.left - 10}
                  y={yAt(tick) + 4}
                  textAnchor="end"
                  fontSize="11"
                  className="fill-slate-400 dark:fill-slate-500"
                >
                  {formatTick(tick)}
                </text>
              </g>
            ))}
            {min < 0 && max > 0 && (
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={yAt(0)}
                y2={yAt(0)}
                className="stroke-slate-300 dark:stroke-slate-600"
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {series.map((item) => {
              const path = points
                .map(
                  (point, index) =>
                    `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point[item.key])}`,
                )
                .join(" ");
              return (
                <g key={item.key}>
                  <path
                    d={path}
                    fill="none"
                    stroke={item.color}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={item.dashed ? "7 5" : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                  {points.map((point, index) => (
                    <circle
                      key={`${item.key}-${point.to}`}
                      cx={xAt(index)}
                      cy={yAt(point[item.key])}
                      r="3"
                      fill={item.color}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>
                        {point.label} · {item.label}: {formatMoney(point[item.key], "USD")}
                      </title>
                    </circle>
                  ))}
                </g>
              );
            })}
            {points.map((point, index) =>
              index % labelEvery !== 0 && index !== points.length - 1 ? null : (
                <text
                  key={point.to}
                  x={xAt(index)}
                  y={height - 13}
                  textAnchor="middle"
                  fontSize="11"
                  className="fill-slate-400 dark:fill-slate-500"
                >
                  {point.label}
                </text>
              ),
            )}
          </svg>
        </div>
      )}
    </section>
  );
}

function formatTick(cents: number): string {
  const amount = cents / 100;
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${amount < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${amount < 0 ? "-" : ""}$${(abs / 1_000).toFixed(0)}k`;
  return `${amount < 0 ? "-" : ""}$${Math.round(abs)}`;
}
