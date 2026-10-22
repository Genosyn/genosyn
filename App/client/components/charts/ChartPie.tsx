import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import { resolveFrame, seriesColor } from "./chartHelpers";
import { clsx } from "../ui/clsx";
import { usePlotSize } from "./usePlotSize";

type Slice = {
  label: string;
  value: number;
  start: number;
  end: number;
  pct: number;
  color: string;
};

/**
 * Donut chart over a single measure. `vizConfig.dimension` is the slice
 * label; `vizConfig.measure` is the slice size. Falls back to the first
 * categorical + first numeric column if neither is configured. Slices are
 * normalized to 100% — negative values are clamped to 0 so a "loss" row
 * doesn't crash the geometry.
 */
export function ChartPie({ config, result }: { config: VizConfig; result: QueryResult }) {
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

  let acc = 0;
  const slices: Slice[] = values.map((v, i) => {
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

  return <Donut slices={slices} total={total} />;
}

/**
 * The donut, drawn at the pixel size of its box with the legend beside it in
 * page text — or beneath it, in a box too narrow to share — so neither
 * shrinks to an unreadable size in a small card. Pointing at a slice or its
 * legend row puts that slice in the middle.
 */
function Donut({ slices, total }: { slices: Slice[]; total: number }) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const root = usePlotSize(rootRef);
  const { width, height } = usePlotSize(ref);
  const [hovered, setHovered] = React.useState<number | null>(null);
  const outer = Math.max(0, Math.min(width, height) / 2 - 2);
  const inner = outer * 0.6;
  const focus = hovered === null ? null : slices[hovered];
  const legendBelow = root.width > 0 && root.width < 320;

  return (
    <div
      ref={rootRef}
      className={clsx(
        "flex h-full w-full min-w-0 gap-3",
        legendBelow ? "flex-col" : "items-center",
      )}
    >
      <div
        ref={ref}
        className={clsx(
          "relative min-h-0 min-w-0 flex-1 [contain-intrinsic-height:12rem] [contain:size]",
          !legendBelow && "h-full",
        )}
      >
        {outer > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Share of ${formatTotal(total)} across ${slices.length} ${
              slices.length === 1 ? "slice" : "slices"
            }.`}
            className="absolute inset-0 block"
          >
            {slices.map((slice, i) => (
              <path
                key={i}
                d={donutArc(width / 2, height / 2, inner, outer, slice.start, slice.end)}
                fill={slice.color}
                opacity={hovered === null || hovered === i ? 1 : 0.35}
                onPointerEnter={() => setHovered(i)}
                onPointerLeave={() => setHovered(null)}
              >
                <title>
                  {slice.label}: {slice.value.toLocaleString()} ({(slice.pct * 100).toFixed(1)}%)
                </title>
              </path>
            ))}
          </svg>
        )}
        {inner >= 28 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <div
              className="truncate text-[11px] text-slate-500 dark:text-slate-400"
              style={{ maxWidth: inner * 1.6 }}
            >
              {focus ? focus.label : "Total"}
            </div>
            <div className="text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {formatTotal(focus ? focus.value : total)}
            </div>
            {focus && (
              <div className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                {(focus.pct * 100).toFixed(1)}%
              </div>
            )}
          </div>
        )}
      </div>
      <ul
        className={clsx(
          "shrink-0 overflow-y-auto text-xs",
          legendBelow ? "flex max-h-[40%] flex-wrap gap-x-2" : "max-h-full w-36 py-1",
        )}
      >
        {slices.map((slice, i) => (
          <li
            key={i}
            className={clsx(
              "flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5",
              legendBelow && "max-w-full",
              hovered === i && "bg-slate-100 dark:bg-slate-800",
            )}
            onPointerEnter={() => setHovered(i)}
            onPointerLeave={() => setHovered(null)}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: slice.color }}
            />
            <span
              className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300"
              title={slice.label}
            >
              {slice.label}
            </span>
            <span className="tabular-nums text-slate-400 dark:text-slate-500">
              {(slice.pct * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
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
  // A whole ring's arc would start and end on the same point, which SVG draws
  // as nothing; draw a single slice as two halves instead.
  if (end - start >= Math.PI * 2 - 1e-9) {
    const mid = start + Math.PI;
    return `${donutArc(cx, cy, rInner, rOuter, start, mid)} ${donutArc(cx, cy, rInner, rOuter, mid, end)}`;
  }
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

/** In full below a million, so the middle reads "48,213" rather than "48.2K". */
function formatTotal(n: number): string {
  if (Math.abs(n) < 1e6) return n.toLocaleString();
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}
