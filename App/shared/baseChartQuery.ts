import { BASE_FILTER_OPERATORS, type BaseFilterRule } from "./baseFilters.js";

/**
 * The question a Chart over a Base asks of one of its tables: which rows (the
 * same filter rules a Base view uses), grouped how, and measured how. The
 * server answers it (`server/services/baseCharts.ts`) in the rows-and-columns
 * shape a SQL Chart returns, so the renderer, Dashboards, formulas and Goals
 * read a Base Chart exactly as they read a SQL one.
 *
 *  - `metrics` empty and no `groupBy`: list the matching rows themselves.
 *  - `groupBy` with no `metrics`: count the rows in each group.
 *  - `metrics` with no `groupBy`: one row of totals — a Number card.
 *
 * Fields are referenced by id, never by name, so renaming a column leaves a
 * Chart working.
 */

export const BASE_CHART_AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export type BaseChartAggregate = (typeof BASE_CHART_AGGREGATES)[number];

export const BASE_CHART_DATE_BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type BaseChartDateBucket = (typeof BASE_CHART_DATE_BUCKETS)[number];

export const BASE_CHART_SORT_KEYS = ["group", "metric", "field"] as const;
export type BaseChartSortKey = (typeof BASE_CHART_SORT_KEYS)[number];

/** `count` counts rows; every other aggregate reads a number field. */
export type BaseChartMetric = { aggregate: BaseChartAggregate; fieldId: string | null };

/** A date or date-time field groups by `bucket`; null groups by the exact day. */
export type BaseChartGroupBy = { fieldId: string; bucket: BaseChartDateBucket | null };

/**
 * `group` orders groups the way the grouped field does (dates in time order,
 * choices in the order the field lists them), `metric` by the first metric's
 * value, and `field` orders listed rows by one field.
 */
export type BaseChartSort = {
  by: BaseChartSortKey;
  fieldId: string | null;
  direction: "asc" | "desc";
};

export type BaseChartQuery = {
  tableId: string;
  filters: BaseFilterRule[];
  groupBy: BaseChartGroupBy | null;
  metrics: BaseChartMetric[];
  sort: BaseChartSort | null;
  limit: number | null;
};

export const BASE_CHART_LIMITS = { filters: 20, metrics: 5, rows: 5000 } as const;

/** Field types a Chart can group by. Long text is prose, not a category. */
export const BASE_CHART_GROUPABLE_TYPES = [
  "text",
  "number",
  "checkbox",
  "date",
  "datetime",
  "email",
  "url",
  "select",
  "multiselect",
  "link",
  "customer",
  "invoice",
  "project",
  "employee",
  "member",
  "note",
  "pipeline",
] as const;

export function isBaseChartGroupable(type: string): boolean {
  return (BASE_CHART_GROUPABLE_TYPES as readonly string[]).includes(type);
}

export function isBaseChartDateType(type: string): boolean {
  return type === "date" || type === "datetime";
}

export const BASE_CHART_AGGREGATE_LABELS: Record<BaseChartAggregate, string> = {
  count: "Count",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
};

export const BASE_CHART_BUCKET_LABELS: Record<BaseChartDateBucket, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

/** The column a metric becomes: "Count", "Sum of Amount", "Average of Amount". */
export function baseChartMetricLabel(metric: BaseChartMetric, fieldName: string | null): string {
  if (metric.aggregate === "count") return "Count";
  return `${BASE_CHART_AGGREGATE_LABELS[metric.aggregate]} of ${fieldName ?? "a field"}`;
}

/** An empty query over one table: list its rows, unfiltered. */
export function emptyBaseChartQuery(tableId: string): BaseChartQuery {
  return { tableId, filters: [], groupBy: null, metrics: [], sort: null, limit: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Read a stored query back. The API validates every query it saves; this only
 * keeps a damaged or hand-edited row from crashing a page, dropping the parts
 * it cannot read. Null when the value is not a query at all.
 */
export function normalizeBaseChartQuery(raw: unknown): BaseChartQuery | null {
  if (!isRecord(raw) || typeof raw.tableId !== "string" || !raw.tableId) return null;
  const operators = BASE_FILTER_OPERATORS as readonly string[];
  const filters = (Array.isArray(raw.filters) ? raw.filters : [])
    .filter(isRecord)
    .filter(
      (rule) =>
        typeof rule.fieldId === "string" &&
        typeof rule.operator === "string" &&
        operators.includes(rule.operator),
    )
    .slice(0, BASE_CHART_LIMITS.filters)
    .map((rule, index) => ({
      id: typeof rule.id === "string" && rule.id ? rule.id : `rule-${index + 1}`,
      fieldId: rule.fieldId as string,
      operator: rule.operator as BaseFilterRule["operator"],
      ...(rule.value !== undefined ? { value: rule.value } : {}),
    }));

  const groupBy =
    isRecord(raw.groupBy) && typeof raw.groupBy.fieldId === "string"
      ? {
          fieldId: raw.groupBy.fieldId,
          bucket: (BASE_CHART_DATE_BUCKETS as readonly unknown[]).includes(raw.groupBy.bucket)
            ? (raw.groupBy.bucket as BaseChartDateBucket)
            : null,
        }
      : null;

  const metrics = (Array.isArray(raw.metrics) ? raw.metrics : [])
    .filter(isRecord)
    .filter((metric) => (BASE_CHART_AGGREGATES as readonly unknown[]).includes(metric.aggregate))
    .slice(0, BASE_CHART_LIMITS.metrics)
    .map((metric) => ({
      aggregate: metric.aggregate as BaseChartAggregate,
      fieldId: metric.aggregate === "count" ? null : stringOrNull(metric.fieldId),
    }));

  const sort =
    isRecord(raw.sort) &&
    (BASE_CHART_SORT_KEYS as readonly unknown[]).includes(raw.sort.by) &&
    (raw.sort.direction === "asc" || raw.sort.direction === "desc")
      ? {
          by: raw.sort.by as BaseChartSortKey,
          fieldId: stringOrNull(raw.sort.fieldId),
          direction: raw.sort.direction as "asc" | "desc",
        }
      : null;

  const limit =
    typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit >= 1
      ? Math.min(raw.limit, BASE_CHART_LIMITS.rows)
      : null;

  return { tableId: raw.tableId, filters, groupBy, metrics, sort, limit };
}

/** Parse the JSON a Chart row stores its query in. */
export function parseBaseChartQuery(json: string | null | undefined): BaseChartQuery | null {
  if (!json) return null;
  try {
    return normalizeBaseChartQuery(JSON.parse(json));
  } catch {
    return null;
  }
}
