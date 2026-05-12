import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import {
  fmtTick,
  resolveFrame,
  seriesColor,
  yScaler,
} from "./chartHelpers";

/**
 * Inline-SVG line chart. Each measure becomes one polyline. Dots are drawn
 * for individual points so a single-row series stays visible. Axis labels
 * are auto-thinned when there are too many dimension values to fit.
 */
export function ChartLine({
  config,
  result,
}: {
  config: VizConfig;
  result: QueryResult;
}) {
  return <ChartLineLike config={config} result={result} filled={false} />;
}

export function ChartLineLike({
  config,
  result,
  filled,
}: {
  config: VizConfig;
  result: QueryResult;
  filled: boolean;
}) {
  const frame = resolveFrame(config, result);
  if (!frame) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
        Need at least one numeric column.
      </div>
    );
  }
  const W = 800;
  const H = 320;
  const padTop = 12;
  const padBottom = 36;
  const padLeft = 44;
  const padRight = 16;

  const scaleY = yScaler(frame.min, frame.max, H, padTop, padBottom);
  const xCount = frame.labels.length;
  const innerW = W - padLeft - padRight;
  const stepX = xCount > 1 ? innerW / (xCount - 1) : 0;
  const xAt = (i: number): number =>
    xCount === 1 ? padLeft + innerW / 2 : padLeft + i * stepX;

  const ticks = niceTicks(frame.min, frame.max, 4);
  const labelEvery = Math.max(1, Math.ceil(xCount / 8));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-full w-full"
      role="img"
    >
      {ticks.map((t) => {
        const y = scaleY(t);
        return (
          <g key={t}>
            <line
              x1={padLeft}
              x2={W - padRight}
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

      {frame.series.map((s, sIdx) => {
        const color = seriesColor(sIdx);
        const pts = s.values.map((v, i) => `${xAt(i)},${scaleY(v)}`);
        const path = `M ${pts.join(" L ")}`;
        const fillPath =
          filled && pts.length > 0
            ? `${path} L ${xAt(pts.length - 1)},${scaleY(0)} L ${xAt(0)},${scaleY(0)} Z`
            : null;
        return (
          <g key={s.name}>
            {fillPath && (
              <path
                d={fillPath}
                fill={color}
                fillOpacity={0.18}
                stroke="none"
              />
            )}
            <path
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {s.values.map((v, i) => (
              <circle
                key={i}
                cx={xAt(i)}
                cy={scaleY(v)}
                r={2.5}
                fill={color}
              >
                <title>
                  {frame.labels[i]} · {s.name}: {v.toLocaleString()}
                </title>
              </circle>
            ))}
          </g>
        );
      })}

      {frame.labels.map((label, i) =>
        i % labelEvery !== 0 && i !== xCount - 1 ? null : (
          <text
            key={i}
            x={xAt(i)}
            y={H - padBottom + 14}
            textAnchor="middle"
            fontSize={10}
            className="fill-slate-500 dark:fill-slate-400"
          >
            {truncate(label, 12)}
          </text>
        ),
      )}

      {frame.series.length > 1 && (
        <g transform="translate(48, 8)">
          {frame.series.map((s, i) => (
            <g key={s.name} transform={`translate(${i * 140}, 0)`}>
              <rect width={10} height={10} y={-8} fill={seriesColor(i)} rx={2} />
              <text
                x={14}
                y={1}
                fontSize={10}
                className="fill-slate-600 dark:fill-slate-300"
              >
                {truncate(s.name, 18)}
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
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
