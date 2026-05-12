import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import { resolveFrame, seriesColor } from "./chartHelpers";

/**
 * Donut chart over a single measure. `vizConfig.dimension` is the slice
 * label; `vizConfig.measure` is the slice size. Falls back to the first
 * categorical + first numeric column if neither is configured. Slices are
 * normalized to 100% — negative values are clamped to 0 so a "loss" row
 * doesn't crash the geometry.
 */
export function ChartPie({
  config,
  result,
}: {
  config: VizConfig;
  result: QueryResult;
}) {
  const adapted: VizConfig = {
    ...config,
    measures:
      config.measure && (!config.measures || config.measures.length === 0)
        ? [config.measure]
        : config.measures,
  };
  const frame = resolveFrame(adapted, result);
  if (!frame || frame.series.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
        Pick a dimension column and one numeric measure.
      </div>
    );
  }
  const measure = frame.series[0];
  const values = measure.values.map((v) => Math.max(0, v));
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
        Measure sum is zero.
      </div>
    );
  }

  const W = 360;
  const H = 320;
  const cx = 140;
  const cy = H / 2;
  const outerR = 130;
  const innerR = 70;

  let acc = 0;
  const slices = values.map((v, i) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    return {
      label: frame.labels[i] ?? "—",
      value: v,
      start,
      end,
      pct: v / total,
      color: seriesColor(i),
    };
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="block h-full w-full"
      role="img"
    >
      {slices.map((s) => (
        <path
          key={s.label}
          d={donutArc(cx, cy, innerR, outerR, s.start, s.end)}
          fill={s.color}
        >
          <title>
            {s.label}: {s.value.toLocaleString()} ({(s.pct * 100).toFixed(1)}%)
          </title>
        </path>
      ))}
      <text
        x={cx}
        y={cy - 4}
        textAnchor="middle"
        fontSize={11}
        className="fill-slate-500 dark:fill-slate-400"
      >
        Total
      </text>
      <text
        x={cx}
        y={cy + 14}
        textAnchor="middle"
        fontSize={16}
        className="fill-slate-900 dark:fill-slate-100"
      >
        {fmt(total)}
      </text>
      {/* Legend column to the right of the donut. */}
      <g transform="translate(280, 16)">
        {slices.slice(0, 10).map((s, i) => (
          <g key={s.label} transform={`translate(0, ${i * 22})`}>
            <rect width={10} height={10} fill={s.color} rx={2} y={-8} />
            <text
              x={16}
              y={1}
              fontSize={10}
              className="fill-slate-600 dark:fill-slate-300"
            >
              {truncate(s.label, 14)}
            </text>
            <text
              x={16}
              y={12}
              fontSize={9}
              className="fill-slate-400 dark:fill-slate-500"
            >
              {(s.pct * 100).toFixed(1)}%
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function donutArc(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  start: number,
  end: number,
): string {
  // Single-slice (full circle) — draw as two half-arcs so the SVG path is valid.
  const sweep = end - start;
  const large = sweep > Math.PI ? 1 : 0;
  const x1 = cx + rOuter * Math.cos(start);
  const y1 = cy + rOuter * Math.sin(start);
  const x2 = cx + rOuter * Math.cos(end);
  const y2 = cy + rOuter * Math.sin(end);
  const x3 = cx + rInner * Math.cos(end);
  const y3 = cy + rInner * Math.sin(end);
  const x4 = cx + rInner * Math.cos(start);
  const y4 = cy + rInner * Math.sin(start);
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toLocaleString();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)) + "…";
}
