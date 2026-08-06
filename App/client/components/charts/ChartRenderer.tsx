import React from "react";
import { ChartTable } from "./ChartTable";
import { ChartScalar } from "./ChartScalar";
import { ChartBar } from "./ChartBar";
import { ChartLine } from "./ChartLine";
import { ChartArea } from "./ChartArea";
import { ChartPie } from "./ChartPie";
import type { QueryResult, VizConfig, VizType } from "../../lib/explore";

export type { QueryResult, VizConfig, VizType } from "../../lib/explore";

/**
 * Visualization kinds known to the Explore renderer. Mirrors the
 * `ChartVizType` union on the server entity.
 */
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
