import React from "react";
import type { QueryResult, VizConfig } from "./ChartRenderer";

/**
 * Tabular rendering — the default fallback. Honours `vizConfig.columns` if
 * present so a user who only wants a subset of the SELECT can hide noise.
 * Cells coerce primitives via {@link formatCell}; non-primitive payloads
 * (objects, arrays) are JSON-stringified.
 */
export function ChartTable({
  config,
  result,
}: {
  config: VizConfig;
  result: QueryResult;
}) {
  const allCols = result.fields.map((f) => f.name);
  const cols =
    config.columns && config.columns.length > 0
      ? config.columns.filter((c) => allCols.includes(c))
      : allCols;
  if (cols.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
        Query returned no columns.
      </div>
    );
  }
  return (
    <div className="h-full w-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-xs tabular-nums">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                className="sticky top-0 z-10 border-b border-slate-200 bg-white px-3 py-2 text-left font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
              {cols.map((c) => (
                <td
                  key={c}
                  className="border-b border-slate-100 px-3 py-1.5 align-top text-slate-700 dark:border-slate-800 dark:text-slate-200"
                >
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString() : String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
