import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";

/**
 * Single big number. Picks `vizConfig.measure` if present, otherwise the
 * first numeric column of the first row. Optional `prefix` / `suffix` for
 * unit decoration ("$", "%"). Renders the value with the same locale
 * formatting as the table cells.
 */
export function ChartScalar({
  config,
  result,
}: {
  config: VizConfig;
  result: QueryResult;
}) {
  const row = result.rows[0];
  if (!row) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
        No rows.
      </div>
    );
  }
  const measure =
    config.measure && row[config.measure] !== undefined
      ? config.measure
      : pickNumericKey(row) ?? Object.keys(row)[0];
  const raw = row[measure];
  const value = formatScalar(raw);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4">
      <div className="text-[clamp(1.75rem,8vw,4rem)] font-semibold leading-none text-slate-900 tabular-nums dark:text-slate-100">
        {config.prefix}
        {value}
        {config.suffix}
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {measure}
      </div>
    </div>
  );
}

function pickNumericKey(row: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "number") return k;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return k;
  }
  return null;
}

function formatScalar(raw: unknown): string {
  if (raw === null || raw === undefined) return "—";
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n)) {
    // Compact >=1k: 1.2K, 3.4M, 1.5B. Below that, plain locale.
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + "K";
    return n.toLocaleString();
  }
  return String(raw);
}
