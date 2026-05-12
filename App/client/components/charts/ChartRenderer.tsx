import React from "react";
import { ChartTable } from "./ChartTable";
import { ChartScalar } from "./ChartScalar";
import { ChartBar } from "./ChartBar";
import { ChartLine } from "./ChartLine";
import { ChartArea } from "./ChartArea";
import { ChartPie } from "./ChartPie";

/**
 * Visualization kinds known to the Explore renderer. Mirrors the
 * `ChartVizType` union on the server entity.
 */
export type VizType = "table" | "scalar" | "bar" | "line" | "area" | "pie";

export type QueryResult = {
  fields: { name: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs?: number;
};

export type VizConfig = {
  /** Categorical or ordered axis (bar / line / area / pie). */
  dimension?: string;
  /** Numeric column names. Single value for pie / scalar; array for bar/line/area. */
  measures?: string[];
  measure?: string;
  /** Bar-stack flag — when true, multiple measures stack instead of dodge. */
  stacked?: boolean;
  /** Scalar prefix/suffix (e.g. "$", "%"). */
  prefix?: string;
  suffix?: string;
  /** Table column allowlist. */
  columns?: string[];
};

/**
 * Dispatch a `vizType` to the right SVG renderer. Falls back to the table
 * view if the type is unknown or the config is incomplete — keeps a stale
 * `vizConfig` from breaking the page.
 */
export function ChartRenderer({
  vizType,
  vizConfig,
  result,
}: {
  vizType: VizType;
  vizConfig: VizConfig;
  result: QueryResult;
}) {
  if (result.rows.length === 0 && vizType !== "table") {
    return <EmptyHint />;
  }
  switch (vizType) {
    case "scalar":
      return <ChartScalar config={vizConfig} result={result} />;
    case "bar":
      return <ChartBar config={vizConfig} result={result} />;
    case "line":
      return <ChartLine config={vizConfig} result={result} />;
    case "area":
      return <ChartArea config={vizConfig} result={result} />;
    case "pie":
      return <ChartPie config={vizConfig} result={result} />;
    case "table":
    default:
      return <ChartTable config={vizConfig} result={result} />;
  }
}

function EmptyHint() {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
      No rows returned.
    </div>
  );
}
