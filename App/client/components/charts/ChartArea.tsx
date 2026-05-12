import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";
import { ChartLineLike } from "./ChartLine";

/**
 * Area chart — same shape as the line chart but with a translucent fill
 * down to the x-axis. Re-uses `ChartLineLike` so changes flow to both.
 */
export function ChartArea({
  config,
  result,
}: {
  config: VizConfig;
  result: QueryResult;
}) {
  return <ChartLineLike config={config} result={result} filled />;
}
