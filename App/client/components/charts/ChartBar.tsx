import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import { columnPath } from "./axis";
import { CartesianPlot, type PlotGeometry } from "./CartesianPlot";
import { resolveFrame, seriesColor, type Series } from "./chartHelpers";

/** Columns stay thin however wide a category is; the rest of it is air. */
const COLUMN_MAX_WIDTH = 24;
/** The surface gap between side-by-side columns and between stacked segments. */
const GAP = 2;

/**
 * Inline-SVG bar chart. When `vizConfig.stacked` is set, multiple measures
 * stack into one column per dimension value — positive values up from zero,
 * negative ones down; otherwise they stand side by side. Fills the box its
 * caller gives it.
 */
export function ChartBar({ config, result }: { config: VizConfig; result: QueryResult }) {
  const frame = resolveFrame(config, result);
  if (!frame) return <Empty />;
  const stacked = !!config.stacked && frame.series.length > 1;
  const columns = stacked ? 1 : frame.series.length;
  return (
    <CartesianPlot
      labels={frame.labels}
      series={frame.series}
      domain={stacked ? stackExtents(frame.series) : frame.series.flatMap((item) => item.values)}
      layout="band"
      legendMark="bar"
      markWidth={(slot) => columnLayout(slot, columns).groupWidth}
      showTotal={stacked}
    >
      {(geometry) =>
        stacked ? stackedColumns(frame.series, geometry) : sideBySideColumns(frame.series, geometry)
      }
    </CartesianPlot>
  );
}

/** How wide each of a category's `columns` is, and the gap between them. */
function columnLayout(slot: number, columns: number) {
  const room = slot * 0.7;
  // Too crowded for gaps, the columns touch rather than vanish.
  const gap = room >= columns * 4 + (columns - 1) * GAP ? GAP : 0;
  const width = Math.max(1, Math.min(COLUMN_MAX_WIDTH, (room - gap * (columns - 1)) / columns));
  return { width, gap, groupWidth: columns * width + (columns - 1) * gap };
}

function sideBySideColumns(series: Series[], { x, y, zero, slot }: PlotGeometry) {
  const { width, gap, groupWidth } = columnLayout(slot, series.length);
  return series.map((item, s) => (
    <g key={item.name} fill={seriesColor(s)}>
      {item.values.map((value, i) => {
        if (value === 0) return null;
        const left = x(i) - groupWidth / 2 + s * (width + gap);
        // A sliver of a value against a large scale still shows.
        const end = value > 0 ? Math.min(y(value), zero - 1) : Math.max(y(value), zero + 1);
        return <path key={i} d={columnPath(left, zero, end, width)} />;
      })}
    </g>
  ));
}

/**
 * One column per category, its segments a gap apart. Positive values stack
 * up from zero and negative ones down; only the outermost end each way is
 * rounded.
 */
function stackedColumns(series: Series[], { x, y, zero, slot }: PlotGeometry) {
  const { width } = columnLayout(slot, 1);
  const count = series[0]?.values.length ?? 0;
  const segments: React.ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const left = x(i) - width / 2;
    let lastUp = -1;
    let lastDown = -1;
    series.forEach((item, s) => {
      if (item.values[i] > 0) lastUp = s;
      if (item.values[i] < 0) lastDown = s;
    });
    let up = 0;
    let down = 0;
    let upEnd = zero;
    let downEnd = zero;
    series.forEach((item, s) => {
      const value = item.values[i];
      if (value === 0) return;
      let base: number;
      let end: number;
      if (value > 0) {
        base = up === 0 ? zero : upEnd - GAP;
        up += value;
        end = Math.min(y(up), base - 1);
        upEnd = end;
      } else {
        base = down === 0 ? zero : downEnd + GAP;
        down += value;
        end = Math.max(y(down), base + 1);
        downEnd = end;
      }
      const outermost = s === (value > 0 ? lastUp : lastDown);
      segments.push(
        <path
          key={`${i}-${s}`}
          d={columnPath(left, base, end, width, outermost ? 4 : 0)}
          fill={seriesColor(s)}
        />,
      );
    });
  }
  return segments;
}

/** Each category's stacked reach above and below zero, for the y-axis. */
function stackExtents(series: Series[]): number[] {
  const count = series[0]?.values.length ?? 0;
  const extents: number[] = [];
  for (let i = 0; i < count; i++) {
    let up = 0;
    let down = 0;
    for (const item of series) {
      if (item.values[i] > 0) up += item.values[i];
      else down += item.values[i];
    }
    extents.push(up, down);
  }
  return extents;
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
      Need at least one numeric column to draw a bar chart.
    </div>
  );
}
