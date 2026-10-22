import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import { CartesianPlot } from "./CartesianPlot";
import { resolveFrame, seriesColor } from "./chartHelpers";

/**
 * Inline-SVG line chart. Each measure becomes one line across the dimension's
 * values; dots mark the points while there is room for them, so a sparse or
 * single-row series stays visible. Fills the box its caller gives it.
 */
export function ChartLine({ config, result }: { config: VizConfig; result: QueryResult }) {
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
  const count = frame.labels.length;
  return (
    <CartesianPlot
      labels={frame.labels}
      series={frame.series}
      domain={frame.series.flatMap((item) => item.values)}
      layout="point"
      legendMark={filled ? "area" : "line"}
      active={({ x, y }, index) =>
        frame.series.map((item, s) => (
          <circle
            key={item.name}
            cx={x(index)}
            cy={y(item.values[index])}
            r={5}
            fill={seriesColor(s)}
            strokeWidth={2}
            className="stroke-white dark:stroke-slate-950"
          />
        ))
      }
    >
      {({ x, y, zero, slot }) =>
        frame.series.map((item, s) => {
          const color = seriesColor(s);
          const line = `M${item.values.map((value, i) => `${x(i)},${y(value)}`).join("L")}`;
          const showDots = count === 1 || slot >= 28;
          return (
            <g key={item.name}>
              {filled && count > 1 && (
                <path
                  d={`${line}L${x(count - 1)},${zero}L${x(0)},${zero}Z`}
                  fill={color}
                  fillOpacity={0.12}
                />
              )}
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {showDots &&
                item.values.map((value, i) => (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(value)}
                    r={4}
                    fill={color}
                    strokeWidth={2}
                    className="stroke-white dark:stroke-slate-950"
                  />
                ))}
            </g>
          );
        })
      }
    </CartesianPlot>
  );
}
