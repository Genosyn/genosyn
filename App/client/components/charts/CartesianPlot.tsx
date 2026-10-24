import React from "react";
import { seriesColor, type Series } from "./chartHelpers";
import { crisp, fitText, formatAxisNumber, labelStride, niceAxis } from "./axis";
import { AXIS_FONT_SIZE, textWidth, usePlotSize } from "./usePlotSize";

/** Where a chart's marks go, in the pixels of the box it was given. */
export type PlotGeometry = {
  /** Centre of category `index`. */
  x: (index: number) => number;
  /** Pixel row of a value. */
  y: (value: number) => number;
  /** Pixel row of the zero line. */
  zero: number;
  /** One category's share of the width: its band, or the step between points. */
  slot: number;
};

export type LegendMark = "bar" | "line" | "area";

const MARGIN = { top: 8, right: 10, bottom: 24 };
const LABEL_GAP = 10;
/** No category label runs longer than this; the readout has the full text. */
const MAX_LABEL_WIDTH = 160;

/**
 * The frame Explore's bar, line and area charts draw in: a y-axis on round
 * steps through zero, category labels thinned and shortened to fit, a legend
 * once there are two series, and a readout of every series at the category
 * the reader points at, taps, or reaches with the arrow keys.
 *
 * It fills the box it is given — a dashboard card, the chart editor's preview
 * — and draws at that box's pixel size instead of stretching a fixed viewBox,
 * so text and dots keep their shape at any size. In a box with no height of
 * its own the plot takes 12rem.
 *
 * `layout` gives each category an equal `band` (columns sit in it) or a
 * `point` from edge to edge (a line runs through them). `children` draws the
 * marks, once per size; `active` adds what follows the reader.
 */
export function CartesianPlot({
  labels,
  series,
  domain,
  layout,
  legendMark,
  markWidth,
  showTotal = false,
  active: renderActive,
  children,
}: {
  labels: string[];
  series: Series[];
  /** Every value the y-axis has to reach — stacked totals, for stacked columns. */
  domain: number[];
  layout: "band" | "point";
  legendMark: LegendMark;
  /** How wide one category's columns are, so the hover band hugs them. */
  markWidth?: (slot: number) => number;
  /** Add a total to the readout, for stacked columns where it is the column's height. */
  showTotal?: boolean;
  active?: (geometry: PlotGeometry, index: number) => React.ReactNode;
  children: (geometry: PlotGeometry) => React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const tooltipRef = React.useRef<HTMLDivElement>(null);
  const { width, height, font } = usePlotSize(ref);
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [tooltipWidth, setTooltipWidth] = React.useState(0);
  const count = labels.length;
  const current = hovered !== null && hovered < count ? hovered : null;

  const plot = React.useMemo(() => {
    const measure = (text: string) => textWidth(text, font);
    const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom);
    // A gridline every 28px or more: one interval in the shortest card, six in a tall one.
    const most = Math.min(6, Math.max(1, Math.floor(plotHeight / 28)));
    const axis = niceAxis(domain, { intervals: [Math.min(3, most), most] });
    const tickLabels = axis.ticks.map((tick) => formatAxisNumber(tick, axis.step));
    const left = Math.ceil(Math.max(...tickLabels.map(measure))) + 10;
    const right = Math.max(left + 1, width - MARGIN.right);
    const plotWidth = right - left;
    const slot =
      layout === "band" ? plotWidth / count : count > 1 ? plotWidth / (count - 1) : plotWidth;
    const x = (index: number) =>
      layout === "band"
        ? left + slot * (index + 0.5)
        : count > 1
          ? left + slot * index
          : left + plotWidth / 2;
    const y = (value: number) =>
      MARGIN.top + ((axis.max - value) / (axis.max - axis.min)) * plotHeight;
    const geometry: PlotGeometry = { x, y, zero: y(0), slot };

    const widths = labels.map((label) => Math.min(measure(label), MAX_LABEL_WIDTH));
    const stride = labelStride(widths, slot, LABEL_GAP);
    const room = Math.max(12, Math.min(MAX_LABEL_WIDTH, stride * slot - LABEL_GAP));
    const categoryLabels: Array<{ index: number; text: string; x: number }> = [];
    let previousEnd = -Infinity;
    for (let index = 0; index < count; index += stride) {
      const text = fitText(labels[index], room, measure);
      const half = measure(text) / 2;
      // Kept inside the box, an edge label can slide into its neighbour; drop it then.
      const at = Math.min(Math.max(x(index), half), width - half);
      if (at - half < previousEnd + LABEL_GAP) continue;
      categoryLabels.push({ index, text, x: at });
      previousEnd = at + half;
    }
    return { axis, tickLabels, left, right, plotHeight, geometry, categoryLabels };
  }, [labels, domain, layout, width, height, font, count]);

  // The marks only change with the data or the box, not as the reader moves.
  const marks = React.useMemo(() => children(plot.geometry), [children, plot]);

  // The readout is placed by its real width, measured before paint.
  React.useLayoutEffect(() => {
    const measured = tooltipRef.current?.offsetWidth;
    if (measured !== undefined && measured !== tooltipWidth) setTooltipWidth(measured);
  }, [current, series, tooltipWidth]);

  const { x, y, zero, slot } = plot.geometry;
  const bottom = MARGIN.top + plot.plotHeight;
  const band = markWidth ? markWidth(slot) : slot * 0.7;

  const indexAt = (clientX: number): number | null => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || count === 0) return null;
    const px = clientX - box.left;
    if (px < plot.left - 8 || px > plot.right + 8) return null;
    const raw =
      layout === "band"
        ? Math.floor((px - plot.left) / slot)
        : count > 1
          ? Math.round((px - plot.left) / slot)
          : 0;
    return Math.min(count - 1, Math.max(0, raw));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = count - 1;
    let next: number | null;
    if (event.key === "ArrowRight") next = Math.min(last, (current ?? -1) + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, (current ?? last + 1) - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = null;
    else return;
    event.preventDefault();
    setHovered(next);
  };

  // The readout sits beside the category's marks, on whichever side has room;
  // in a box too narrow for either, it centres over them.
  const anchor = current === null ? 0 : x(current);
  const offset = (layout === "band" ? band / 2 : 4) + 10;
  const tooltipLeft =
    anchor + offset + tooltipWidth <= width
      ? anchor + offset
      : anchor - offset - tooltipWidth >= 0
        ? anchor - offset - tooltipWidth
        : Math.max(0, Math.min(width - tooltipWidth, anchor - tooltipWidth / 2));

  const zeroLine = (
    <line
      x1={plot.left}
      x2={plot.right}
      y1={crisp(zero)}
      y2={crisp(zero)}
      className="stroke-slate-300 dark:stroke-slate-600"
    />
  );

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {series.length > 1 && <Legend series={series} mark={legendMark} />}
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label={`${series.map((item) => item.name).join(", ")} across ${count} ${
          count === 1 ? "row" : "rows"
        }. Use the arrow keys to read each one.`}
        className="relative min-h-0 flex-1 touch-pan-y rounded-md outline-none [contain-intrinsic-height:12rem] [contain:size] focus-visible:ring-2 focus-visible:ring-focus"
        onPointerMove={(event) => setHovered(indexAt(event.clientX))}
        onPointerDown={(event) => setHovered(indexAt(event.clientX))}
        onPointerLeave={(event) => {
          // A tap leaves its readout up until focus moves on.
          if (event.pointerType !== "touch") setHovered(null);
        }}
        onFocus={() => setHovered((index) => index ?? count - 1)}
        onBlur={() => setHovered(null)}
        onKeyDown={onKeyDown}
      >
        {width > 0 && height > 0 && (
          <svg
            width={width}
            height={height}
            aria-hidden="true"
            className="absolute inset-0 block select-none overflow-visible"
          >
            {current !== null && layout === "band" && (
              <rect
                x={x(current) - Math.min(slot - 2, band + 16) / 2}
                y={MARGIN.top - 4}
                width={Math.max(0, Math.min(slot - 2, band + 16))}
                height={plot.plotHeight + 4}
                rx={4}
                className="fill-slate-100 dark:fill-slate-800/70"
              />
            )}

            {plot.axis.ticks.map((tick, i) => (
              <g key={tick}>
                {tick !== 0 && (
                  <line
                    x1={plot.left}
                    x2={plot.right}
                    y1={crisp(y(tick))}
                    y2={crisp(y(tick))}
                    className="stroke-slate-100 dark:stroke-slate-800"
                  />
                )}
                <text
                  x={plot.left - 8}
                  y={y(tick)}
                  dy="0.35em"
                  textAnchor="end"
                  fontSize={AXIS_FONT_SIZE}
                  className="fill-slate-500 tabular-nums dark:fill-slate-400"
                >
                  {plot.tickLabels[i]}
                </text>
              </g>
            ))}

            {current !== null && layout === "point" && (
              <line
                x1={crisp(x(current))}
                x2={crisp(x(current))}
                y1={MARGIN.top}
                y2={bottom}
                className="stroke-slate-300 dark:stroke-slate-600"
              />
            )}

            {/* Columns stand on the zero line; lines run over it. */}
            {layout === "point" && zeroLine}
            {marks}
            {layout === "band" && zeroLine}
            {current !== null && renderActive?.(plot.geometry, current)}

            {plot.categoryLabels.map((label) => (
              <text
                key={label.index}
                x={label.x}
                y={bottom + 16}
                textAnchor="middle"
                fontSize={AXIS_FONT_SIZE}
                className={
                  label.index === current
                    ? "fill-slate-900 font-medium dark:fill-slate-100"
                    : "fill-slate-500 dark:fill-slate-400"
                }
              >
                {label.text}
              </text>
            ))}
          </svg>
        )}

        {current !== null && (
          <div
            ref={tooltipRef}
            aria-hidden="true"
            className="pointer-events-none absolute top-1 z-10 w-max min-w-[9rem] max-w-[18rem] rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg dark:border-slate-700 dark:bg-slate-900"
            style={{ left: tooltipLeft }}
          >
            <div className="truncate text-xs font-medium text-slate-900 dark:text-slate-100">
              {labels[current]}
            </div>
            <div className="mt-1.5 space-y-1">
              {series.map((item, index) => (
                <ReadoutRow
                  key={item.name}
                  color={seriesColor(index)}
                  label={item.name}
                  value={item.values[current]}
                />
              ))}
              {showTotal && (
                <div className="border-t border-slate-100 pt-1 dark:border-slate-800">
                  <ReadoutRow
                    label="Total"
                    value={series.reduce((total, item) => total + item.values[current], 0)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReadoutRow({ color, label, value }: { color?: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="h-[3px] w-3 shrink-0 rounded-full"
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="min-w-0 truncate text-slate-500 dark:text-slate-400">{label}</span>
      <span className="ml-auto pl-4 font-medium tabular-nums text-slate-900 dark:text-slate-100">
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function Legend({ series, mark }: { series: Series[]; mark: LegendMark }) {
  return (
    <ul className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-1 pb-1.5 text-xs text-slate-600 dark:text-slate-300">
      {series.map((item, index) => (
        <li key={item.name} className="flex min-w-0 max-w-[12rem] items-center gap-1.5">
          <LegendKey mark={mark} color={seriesColor(index)} />
          <span className="truncate" title={item.name}>
            {item.name}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The legend mirrors the mark: a block for columns and areas, a stroke for lines. */
function LegendKey({ mark, color }: { mark: LegendMark; color: string }) {
  return (
    <svg aria-hidden="true" width="14" height="10" viewBox="0 0 14 10" className="shrink-0">
      {mark === "bar" && <rect x="2" y="0" width="10" height="10" rx="2" fill={color} />}
      {mark === "area" && (
        <>
          <rect x="1" y="3" width="12" height="7" fill={color} opacity={0.25} />
          <line x1="1" x2="13" y1="3" y2="3" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </>
      )}
      {mark === "line" && (
        <line x1="1" x2="13" y1="5" y2="5" stroke={color} strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}
