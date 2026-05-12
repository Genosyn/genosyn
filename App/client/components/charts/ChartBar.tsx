import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import {
  fmtTick,
  resolveFrame,
  seriesColor,
  yScaler,
} from "./chartHelpers";

/**
 * Inline-SVG bar chart. When `vizConfig.stacked` is set, multiple measures
 * stack into one bar per dimension; otherwise they dodge side-by-side.
 * Renders at 100% of the parent container — caller controls the box.
 */
export function ChartBar({
  config,
  result,
}: {
  config: VizConfig;
  result: QueryResult;
}) {
  const frame = resolveFrame(config, result);
  if (!frame) return <Empty />;

  const W = 800;
  const H = 320;
  const padTop = 12;
  const padBottom = 36;
  const padLeft = 44;
  const padRight = 16;

  const stacked = !!config.stacked && frame.series.length > 1;
  // For stacked, max becomes the sum at each dimension; min stays 0.
  let max = frame.max;
  if (stacked) {
    max = frame.labels.reduce((acc, _l, i) => {
      const sum = frame.series.reduce((s, ser) => s + Math.max(0, ser.values[i]), 0);
      return Math.max(acc, sum);
    }, 0);
    if (max === 0) max = 1;
  }
  const scaleY = yScaler(frame.min, max, H, padTop, padBottom);

  const innerW = W - padLeft - padRight;
  const groupW = innerW / frame.labels.length;
  const innerPad = groupW * 0.12; // gap between groups
  const barAreaW = groupW - innerPad * 2;
  const barW = stacked ? barAreaW : barAreaW / frame.series.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-full w-full"
      role="img"
    >
      <YAxis
        min={frame.min}
        max={max}
        scale={scaleY}
        padLeft={padLeft}
        width={W - padRight}
      />
      {frame.labels.map((label, i) => {
        const groupX = padLeft + i * groupW + innerPad;
        return (
          <g key={i}>
            {frame.series.map((s, sIdx) => {
              const v = s.values[i];
              if (stacked) {
                const cumulativeBelow = frame.series
                  .slice(0, sIdx)
                  .reduce((acc, ss) => acc + Math.max(0, ss.values[i]), 0);
                const yTop = scaleY(cumulativeBelow + Math.max(0, v));
                const yBase = scaleY(cumulativeBelow);
                const h = Math.max(0, yBase - yTop);
                return (
                  <rect
                    key={s.name}
                    x={groupX}
                    y={yTop}
                    width={barW}
                    height={h}
                    fill={seriesColor(sIdx)}
                    rx={2}
                  >
                    <title>
                      {label} · {s.name}: {v.toLocaleString()}
                    </title>
                  </rect>
                );
              }
              const yTop = scaleY(Math.max(0, v));
              const yBase = scaleY(0);
              const h = Math.max(0, yBase - yTop);
              return (
                <rect
                  key={s.name}
                  x={groupX + sIdx * barW}
                  y={yTop}
                  width={Math.max(1, barW - 2)}
                  height={h}
                  fill={seriesColor(sIdx)}
                  rx={2}
                >
                  <title>
                    {label} · {s.name}: {v.toLocaleString()}
                  </title>
                </rect>
              );
            })}
            <text
              x={groupX + barAreaW / 2}
              y={H - padBottom + 14}
              textAnchor="middle"
              fontSize={10}
              className="fill-slate-500 dark:fill-slate-400"
            >
              {truncate(label, Math.max(4, Math.floor(groupW / 7)))}
            </text>
          </g>
        );
      })}
      <Legend series={frame.series.map((s) => s.name)} />
    </svg>
  );
}

function YAxis({
  min,
  max,
  scale,
  padLeft,
  width,
}: {
  min: number;
  max: number;
  scale: (v: number) => number;
  padLeft: number;
  width: number;
}) {
  const ticks = niceTicks(min, max, 4);
  return (
    <g>
      {ticks.map((t) => {
        const y = scale(t);
        return (
          <g key={t}>
            <line
              x1={padLeft}
              x2={width}
              y1={y}
              y2={y}
              className="stroke-slate-200 dark:stroke-slate-700"
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              className="fill-slate-500 dark:fill-slate-400"
            >
              {fmtTick(t)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Legend({ series }: { series: string[] }) {
  if (series.length <= 1) return null;
  return (
    <g transform="translate(48, 8)">
      {series.map((name, i) => (
        <g key={name} transform={`translate(${i * 140}, 0)`}>
          <rect width={10} height={10} y={-8} fill={seriesColor(i)} rx={2} />
          <text
            x={14}
            y={1}
            fontSize={10}
            className="fill-slate-600 dark:fill-slate-300"
          >
            {truncate(name, 18)}
          </text>
        </g>
      ))}
    </g>
  );
}

function niceTicks(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(min + ((max - min) * i) / count);
  }
  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)) + "…";
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
      Need at least one numeric column to draw a bar chart.
    </div>
  );
}
