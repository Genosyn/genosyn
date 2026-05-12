import type { QueryResult, VizConfig } from "./ChartRenderer";

/**
 * Shared helpers for the inline SVG chart components. Each chart picks a
 * `dimension` column (categorical or ordered) and one or more `measures`
 * (numeric). We coerce numeric measures defensively because Postgres
 * returns numeric/bigint as strings; the executor stringifies BigInts so
 * everything that came back as a number-ish value is recoverable.
 */

export type Series = {
  name: string;
  values: number[];
};

export type ChartFrame = {
  labels: string[];
  series: Series[];
  /** Pre-computed bounds for axis scaling. */
  min: number;
  max: number;
};

const NULL_NUMERIC = 0;

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return NULL_NUMERIC;
  if (typeof v === "number") return Number.isFinite(v) ? v : NULL_NUMERIC;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NULL_NUMERIC;
  }
  return NULL_NUMERIC;
}

function toLabel(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Resolve `dimension` + `measures` from a viz config + result, applying
 * sensible defaults: dimension defaults to the first non-numeric column;
 * measures default to every other numeric column.
 */
export function resolveFrame(
  config: VizConfig,
  result: QueryResult,
): ChartFrame | null {
  if (result.rows.length === 0 || result.fields.length === 0) return null;
  const colNames = result.fields.map((f) => f.name);
  const firstRow = result.rows[0];
  const isNumeric = (k: string): boolean => {
    const v = firstRow[k];
    if (typeof v === "number") return true;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return true;
    return false;
  };

  const dim =
    config.dimension && colNames.includes(config.dimension)
      ? config.dimension
      : colNames.find((c) => !isNumeric(c)) ?? colNames[0];

  let measureCols: string[] = [];
  if (config.measures && config.measures.length > 0) {
    measureCols = config.measures.filter((c) => colNames.includes(c));
  } else if (config.measure && colNames.includes(config.measure)) {
    measureCols = [config.measure];
  }
  if (measureCols.length === 0) {
    measureCols = colNames.filter((c) => c !== dim && isNumeric(c));
  }
  if (measureCols.length === 0) return null;

  const labels = result.rows.map((r) => toLabel(r[dim]));
  const series: Series[] = measureCols.map((m) => ({
    name: m,
    values: result.rows.map((r) => toNumber(r[m])),
  }));

  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;
  if (min === max) {
    // Avoid a divide-by-zero in the axis scaler.
    max = min + 1;
  }
  // Always anchor the y-axis at 0 unless data goes negative — matches the
  // usual analytics expectation that bars start at zero.
  if (min > 0) min = 0;

  return { labels, series, min, max };
}

/** Linear-interpolation scaler for the y-axis. */
export function yScaler(
  min: number,
  max: number,
  height: number,
  topPad: number,
  bottomPad: number,
): (v: number) => number {
  const usable = height - topPad - bottomPad;
  return (v) => topPad + (1 - (v - min) / (max - min)) * usable;
}

/**
 * Ten-color palette tuned for both light and dark backgrounds. Picked
 * from Tailwind's 500/400 shades; no external dep.
 */
export const PALETTE = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#ec4899", // pink
  "#22c55e", // green
];

/** Pick a deterministic color for the n-th series. */
export function seriesColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/**
 * Pretty-print a number for axis ticks. Compresses to K/M/B for
 * readability — actual values stay in the tooltip.
 */
export function fmtTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "K";
  if (abs < 1 && abs > 0) return v.toFixed(2);
  return Math.round(v).toString();
}
