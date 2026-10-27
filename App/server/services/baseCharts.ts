import { In } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import {
  applyBaseFilters,
  BASE_FILTER_OPERATORS,
  compareBaseValues,
  isBaseCellEmpty,
} from "../../shared/baseFilters.js";
import { withIndefiniteArticle } from "../../shared/indefiniteArticle.js";
import {
  BASE_CHART_AGGREGATE_LABELS,
  BASE_CHART_AGGREGATES,
  BASE_CHART_BUCKET_LABELS,
  BASE_CHART_DATE_BUCKETS,
  BASE_CHART_LIMITS,
  BASE_CHART_SORT_KEYS,
  baseChartMetricLabel,
  isBaseChartDateType,
  isBaseChartGroupable,
  type BaseChartDateBucket,
  type BaseChartMetric,
  type BaseChartQuery,
} from "../../shared/baseChartQuery.js";
import {
  buildLinkOptionsFor,
  hydrateField,
  hydrateRecord,
  safeBaseSelectOptions,
  UUID_RE,
  type HydratedField,
  type LinkOption,
} from "./bases.js";
import {
  buildResourceOptionsFor,
  isResourceFieldType,
  type ResourceOption,
} from "./baseResources.js";
import { companyTimeZone } from "./companyTimeZone.js";
import type { ProjectActor } from "./projects.js";
import type { QueryResult } from "./explore.js";

/**
 * Charts over a Base: answers a `BaseChartQuery` (`shared/baseChartQuery.ts`)
 * from one table's rows, in the same `QueryResult` shape the SQL executor
 * returns — so the renderer, Dashboards, formulas and Goals need no second
 * code path.
 *
 * Bases live in the App's own database and stay small (see `BaseRecord`), so
 * the table is read once and the question answered in memory. No SQL is
 * generated and none is accepted: a Base Chart needs no Connection, no
 * read-only database role, and cannot reach a table outside its own Base.
 *
 * The rows a Chart counts are the rows a Member sees in the grid: filters run
 * through the same evaluator as a Base view, and choice and link cells are
 * shown by the labels the grid shows.
 */

export class BaseChartError extends Error {}

const filterValueSchema = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(255), z.number()])).max(200),
]);

/**
 * A `BaseChartQuery` at the API boundary — the Explore routes and the AI
 * Employee tools both accept a query through this one schema. Field and table
 * ids are checked against the Base when the query is saved or run.
 */
export const baseChartQuerySchema = z
  .object({
    tableId: z.string().uuid(),
    filters: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            fieldId: z.string().uuid(),
            operator: z.enum(BASE_FILTER_OPERATORS),
            value: filterValueSchema.optional(),
          })
          .strict(),
      )
      .max(BASE_CHART_LIMITS.filters)
      .default([]),
    groupBy: z
      .object({
        fieldId: z.string().uuid(),
        bucket: z.enum(BASE_CHART_DATE_BUCKETS).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    metrics: z
      .array(
        z
          .object({
            aggregate: z.enum(BASE_CHART_AGGREGATES),
            fieldId: z.string().uuid().nullable().default(null),
          })
          .strict(),
      )
      .max(BASE_CHART_LIMITS.metrics)
      .default([]),
    sort: z
      .object({
        by: z.enum(BASE_CHART_SORT_KEYS),
        fieldId: z.string().uuid().nullable().default(null),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .nullable()
      .default(null),
    limit: z.number().int().min(1).max(BASE_CHART_LIMITS.rows).nullable().default(null),
  })
  .strict();

const DEFAULT_ROWS = 1_000;
const EMPTY_LABEL = "(empty)";
const UNKNOWN_LABEL = "(unknown)";

type ChartField = Pick<HydratedField, "id" | "name" | "type">;
type ChartRecord = { data: Record<string, unknown>; sortOrder: number };

/**
 * What a choice or link cell displays, by field id: option / record id →
 * label. `order` keeps a choice field's own option order, which is the order
 * its groups are drawn in.
 */
export type BaseChartLabels = Map<
  string,
  { labels: Map<string, string>; order?: Map<string, number> }
>;

function fieldNoun(type: string): string {
  return type === "datetime" ? "date and time" : type === "multiselect" ? "multiple select" : type;
}

/** Why `query` cannot run against `fields`, or null when it can. */
export function baseChartQueryProblem(query: BaseChartQuery, fields: ChartField[]): string | null {
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (query.filters.length > BASE_CHART_LIMITS.filters) {
    return `A chart can have at most ${BASE_CHART_LIMITS.filters} filters.`;
  }
  if (query.filters.some((rule) => !byId.has(rule.fieldId))) {
    return "A filter uses a field this table no longer has. Remove the filter to run the chart.";
  }
  if (query.groupBy) {
    const field = byId.get(query.groupBy.fieldId);
    if (!field) return "The chart groups by a field this table no longer has. Choose another.";
    if (!isBaseChartGroupable(field.type)) {
      return `"${field.name}" is long text, so it cannot group a chart. Choose another field.`;
    }
    if (query.groupBy.bucket && !isBaseChartDateType(field.type)) {
      return `Only a date field can be grouped by ${BASE_CHART_BUCKET_LABELS[query.groupBy.bucket].toLowerCase()}.`;
    }
  }
  if (query.metrics.length > BASE_CHART_LIMITS.metrics) {
    return `A chart can measure at most ${BASE_CHART_LIMITS.metrics} things at once.`;
  }
  for (const metric of query.metrics) {
    if (metric.aggregate === "count") continue;
    const label = BASE_CHART_AGGREGATE_LABELS[metric.aggregate];
    const field = metric.fieldId ? byId.get(metric.fieldId) : undefined;
    if (!metric.fieldId) return `${label} needs a number field to read.`;
    if (!field) return `${label} reads a field this table no longer has. Choose another.`;
    if (field.type !== "number") {
      return `${label} needs a number field, and "${field.name}" is ${withIndefiniteArticle(`${fieldNoun(field.type)} field`)}.`;
    }
  }
  const summarizing = query.metrics.length > 0 || query.groupBy !== null;
  if (query.sort?.by === "field") {
    if (summarizing) return "Sorting by a field applies only when the chart lists rows.";
    if (!query.sort.fieldId || !byId.has(query.sort.fieldId)) {
      return "The chart sorts by a field this table no longer has. Choose another.";
    }
  } else if (query.sort && !summarizing) {
    return "Listed rows sort by a field, not by a group or a measure.";
  }
  return null;
}

// ───────────────────────── dates ─────────────────────────────────────────────

type CalendarDay = { year: number; month: number; day: number };

const DATE_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function realDay(year: number, month: number, day: number): CalendarDay | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayInZone(instant: number, timeZone: string): CalendarDay | null {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    dayFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return realDay(Number(parts.year), Number(parts.month), Number(parts.day));
}

/**
 * The calendar day a date cell falls on. A date, or a date-time without a
 * zone — what the grid's date-time input stores — is already the wall-clock
 * day someone typed. A stamped instant (an API write ending in `Z`) is placed
 * on the company's calendar.
 */
function calendarDay(value: unknown, timeZone: string): CalendarDay | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const match = DATE_TEXT.exec(text);
  if (match && !match[7]) return realDay(Number(match[1]), Number(match[2]), Number(match[3]));
  const instant = Date.parse(text);
  return Number.isNaN(instant) ? null : dayInZone(instant, timeZone);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Bucket labels sort as text in time order: 2026-10-27, 2026-10, 2026-Q4, 2026. */
function bucketLabel(day: CalendarDay, bucket: BaseChartDateBucket): string {
  switch (bucket) {
    case "year":
      return pad(day.year, 4);
    case "quarter":
      return `${pad(day.year, 4)}-Q${Math.floor((day.month - 1) / 3) + 1}`;
    case "month":
      return `${pad(day.year, 4)}-${pad(day.month)}`;
    case "week": {
      // Weeks start on Monday and are named by that Monday.
      const date = new Date(Date.UTC(day.year, day.month - 1, day.day));
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }
    default:
      return `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}`;
  }
}

// ───────────────────────── groups ────────────────────────────────────────────

/** `rank` keeps "(empty)" and "(unknown)" after every real group. */
type Group = { key: string; label: string; order: number | string; rank: number };

const EMPTY: Group = { key: "empty", label: EMPTY_LABEL, order: 0, rank: 1 };
const UNKNOWN: Group = { key: "unknown", label: UNKNOWN_LABEL, order: 0, rank: 2 };
const CHECKED: Group = { key: "yes", label: "Yes", order: 0, rank: 0 };
const UNCHECKED: Group = { key: "no", label: "No", order: 1, rank: 0 };

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function idsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === "string" && value ? [value] : [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id !== ""))];
}

function referenceGroup(id: string, fieldId: string, labels: BaseChartLabels): Group {
  const entry = labels.get(fieldId);
  const label = entry?.labels.get(id);
  if (label === undefined) return UNKNOWN;
  return { key: `id:${id}`, label, order: entry?.order?.get(id) ?? label, rank: 0 };
}

/**
 * The groups one cell puts its row in. A multiple select or a link puts the
 * row in each of its values, so a row tagged "Urgent" and "Billing" counts
 * once under each.
 */
function groupsOf(
  value: unknown,
  field: ChartField,
  bucket: BaseChartDateBucket | null,
  labels: BaseChartLabels,
  timeZone: string,
): Group[] {
  switch (field.type) {
    case "checkbox":
      return [value ? CHECKED : UNCHECKED];
    case "number": {
      const n = numeric(value);
      return n === null ? [EMPTY] : [{ key: `n:${n}`, label: String(n), order: n, rank: 0 }];
    }
    case "date":
    case "datetime": {
      const day = calendarDay(value, timeZone);
      if (!day) return [EMPTY];
      const label = bucketLabel(day, bucket ?? "day");
      return [{ key: label, label, order: label, rank: 0 }];
    }
    case "select":
    case "multiselect":
    case "link": {
      const ids = idsIn(value);
      if (ids.length === 0) return [EMPTY];
      return dedupe(ids.map((id) => referenceGroup(id, field.id, labels)));
    }
    default: {
      if (isResourceFieldType(field.type)) {
        const ids = idsIn(value);
        if (ids.length === 0) return [EMPTY];
        return dedupe(ids.map((id) => referenceGroup(id, field.id, labels)));
      }
      const text =
        typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
      return text ? [{ key: `t:${text}`, label: text, order: text, rank: 0 }] : [EMPTY];
    }
  }
}

/** A row counts once per group, however many of its values land there. */
function dedupe(groups: Group[]): Group[] {
  const seen = new Set<string>();
  const out: Group[] = [];
  for (const group of groups) {
    if (seen.has(group.key)) continue;
    seen.add(group.key);
    out.push(group);
  }
  return out;
}

function compareGroups(a: Group, b: Group): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (typeof a.order === "number" && typeof b.order === "number" && a.order !== b.order) {
    return a.order - b.order;
  }
  return (
    String(a.order).localeCompare(String(b.order), undefined, {
      sensitivity: "base",
      numeric: true,
    }) || a.key.localeCompare(b.key)
  );
}

// ───────────────────────── measuring ─────────────────────────────────────────

type Totals = {
  rows: number;
  sums: number[];
  counts: number[];
  mins: (number | null)[];
  maxes: (number | null)[];
};

function emptyTotals(metrics: BaseChartMetric[]): Totals {
  return {
    rows: 0,
    sums: metrics.map(() => 0),
    counts: metrics.map(() => 0),
    mins: metrics.map(() => null),
    maxes: metrics.map(() => null),
  };
}

function addRow(totals: Totals, metrics: BaseChartMetric[], record: ChartRecord): void {
  totals.rows += 1;
  metrics.forEach((metric, i) => {
    if (metric.aggregate === "count" || !metric.fieldId) return;
    const value = numeric(record.data[metric.fieldId]);
    if (value === null) return;
    totals.sums[i] += value;
    totals.counts[i] += 1;
    totals.mins[i] = totals.mins[i] === null ? value : Math.min(totals.mins[i]!, value);
    totals.maxes[i] = totals.maxes[i] === null ? value : Math.max(totals.maxes[i]!, value);
  });
}

/** Drop floating-point noise: 0.1 + 0.2 reads 0.3, not 0.30000000000000004. */
function tidy(value: number): number {
  return Number(value.toPrecision(15));
}

function metricValue(metric: BaseChartMetric, i: number, totals: Totals): number | null {
  switch (metric.aggregate) {
    case "count":
      return totals.rows;
    case "sum":
      return tidy(totals.sums[i]);
    case "avg":
      return totals.counts[i] > 0 ? tidy(totals.sums[i] / totals.counts[i]) : null;
    case "min":
      return totals.mins[i];
    case "max":
      return totals.maxes[i];
  }
}

/** Column names are what the visualization picks from, so they never repeat. */
function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name || "Untitled";
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${n})`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function displayCell(value: unknown, field: ChartField, labels: BaseChartLabels): unknown {
  switch (field.type) {
    case "number":
      return numeric(value);
    case "checkbox":
      return value ? "Yes" : "No";
    case "select":
    case "multiselect":
    case "link": {
      const ids = idsIn(value);
      if (ids.length === 0) return null;
      return ids.map((id) => labels.get(field.id)?.labels.get(id) ?? UNKNOWN_LABEL).join(", ");
    }
    default: {
      if (isResourceFieldType(field.type)) {
        const ids = idsIn(value);
        if (ids.length === 0) return null;
        return ids.map((id) => labels.get(field.id)?.labels.get(id) ?? UNKNOWN_LABEL).join(", ");
      }
      if (value === null || value === undefined || value === "") return null;
      return typeof value === "string" ? value : String(value);
    }
  }
}

function clampRows(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ROWS;
  return Math.min(BASE_CHART_LIMITS.rows, Math.max(1, Math.floor(value)));
}

export type BaseChartInput = {
  query: BaseChartQuery;
  /** The table's fields in grid order. */
  fields: ChartField[];
  /** The table's rows in grid order. */
  records: ChartRecord[];
  labels: BaseChartLabels;
  /** IANA zone that dates a stamped date-time; "UTC" when the company names none. */
  timeZone: string;
  maxRows?: number;
};

/**
 * Answer a query from rows already in memory. Pure, so every rule above can
 * be checked without a database; {@link runBaseChartQuery} loads its inputs.
 */
export function answerBaseChartQuery(input: BaseChartInput): Omit<QueryResult, "elapsedMs"> {
  const { query, fields, labels, timeZone } = input;
  const problem = baseChartQueryProblem(query, fields);
  if (problem) throw new BaseChartError(problem);
  const maxRows = clampRows(input.maxRows);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const records = applyBaseFilters(input.records, query.filters, fields);

  let names: string[];
  let rows: Record<string, unknown>[];

  if (query.metrics.length === 0 && !query.groupBy) {
    // List the rows themselves, each cell as the grid shows it.
    names = uniqueNames(fields.map((field) => field.name));
    const sort =
      query.sort?.by === "field" && query.sort.fieldId ? byId.get(query.sort.fieldId) : null;
    const direction = query.sort?.direction === "desc" ? -1 : 1;
    // Empty cells stay at the end either way, so "largest first" starts with a value.
    const ordered = sort
      ? records.slice().sort((a, b) => {
          const av = a.data[sort.id];
          const bv = b.data[sort.id];
          const aEmpty = isBaseCellEmpty(av);
          if (aEmpty !== isBaseCellEmpty(bv)) return aEmpty ? 1 : -1;
          return direction * compareBaseValues(av, bv, sort.type) || a.sortOrder - b.sortOrder;
        })
      : records;
    rows = ordered.map((record) =>
      Object.fromEntries(
        fields.map((field, i) => [names[i], displayCell(record.data[field.id], field, labels)]),
      ),
    );
  } else {
    const metrics: BaseChartMetric[] =
      query.metrics.length > 0 ? query.metrics : [{ aggregate: "count", fieldId: null }];
    const metricNames = metrics.map((metric) =>
      baseChartMetricLabel(
        metric,
        metric.fieldId ? (byId.get(metric.fieldId)?.name ?? null) : null,
      ),
    );
    const groupField = query.groupBy ? byId.get(query.groupBy.fieldId)! : null;
    names = uniqueNames(groupField ? [groupField.name, ...metricNames] : metricNames);
    const valueNames = groupField ? names.slice(1) : names;

    if (!groupField) {
      // Totals over every matching row: always one row, even with no matches,
      // so a Number card reads 0 rather than "No rows".
      const totals = emptyTotals(metrics);
      for (const record of records) addRow(totals, metrics, record);
      rows = [
        Object.fromEntries(metrics.map((m, i) => [valueNames[i], metricValue(m, i, totals)])),
      ];
    } else {
      const groups = new Map<string, { group: Group; totals: Totals }>();
      for (const record of records) {
        const cell = record.data[groupField.id];
        for (const group of groupsOf(cell, groupField, query.groupBy!.bucket, labels, timeZone)) {
          let entry = groups.get(group.key);
          if (!entry) {
            entry = { group, totals: emptyTotals(metrics) };
            groups.set(group.key, entry);
          }
          addRow(entry.totals, metrics, record);
        }
      }
      const answered = [...groups.values()].map(({ group, totals }) => ({
        group,
        values: metrics.map((metric, i) => metricValue(metric, i, totals)),
      }));
      const direction = query.sort?.direction === "desc" ? -1 : 1;
      answered.sort((a, b) => {
        if (query.sort?.by === "metric") {
          const av = a.values[0];
          const bv = b.values[0];
          if (av !== bv) {
            if (av === null) return 1;
            if (bv === null) return -1;
            return direction * (av - bv);
          }
          return compareGroups(a.group, b.group);
        }
        // Reversing the group order still leaves "(empty)" last.
        if (a.group.rank !== b.group.rank) return a.group.rank - b.group.rank;
        return direction * compareGroups(a.group, b.group);
      });
      rows = answered.map(({ group, values }) =>
        Object.fromEntries([
          [names[0], group.label],
          ...values.map((value, i) => [valueNames[i], value]),
        ]),
      );
    }
  }

  const limited = query.limit ? rows.slice(0, query.limit) : rows;
  const truncated = limited.length > maxRows;
  return {
    fields: names.map((name) => ({ name })),
    rows: truncated ? limited.slice(0, maxRows) : limited,
    rowCount: limited.length,
    truncated,
  };
}

// ───────────────────────── loading ───────────────────────────────────────────

/** Which fields need labels: the grouping for a summary, every field for a list. */
function labelledFields(query: BaseChartQuery, fields: BaseField[]): BaseField[] {
  const listing = query.metrics.length === 0 && !query.groupBy;
  return fields.filter(
    (field) =>
      (listing || field.id === query.groupBy?.fieldId) &&
      (field.type === "select" ||
        field.type === "multiselect" ||
        field.type === "link" ||
        isResourceFieldType(field.type)),
  );
}

async function loadLabels(
  companyId: string,
  fields: BaseField[],
  opts: { viewer?: ProjectActor; forEmployee?: boolean },
): Promise<BaseChartLabels> {
  const labels: BaseChartLabels = new Map();
  const links = fields.filter((field) => field.type === "link");
  const resources = fields.filter((field) => isResourceFieldType(field.type));
  const [linkOptions, resourceOptions] = await Promise.all([
    links.length
      ? buildLinkOptionsFor(links, { includeArchivedTargets: !opts.forEmployee })
      : Promise.resolve({} as Record<string, LinkOption[]>),
    resources.length
      ? buildResourceOptionsFor(companyId, resources, {
          ...(opts.viewer ? { projectViewer: opts.viewer } : {}),
        })
      : Promise.resolve({} as Record<string, ResourceOption[]>),
  ]);
  for (const field of fields) {
    if (field.type === "select" || field.type === "multiselect") {
      const options = safeBaseSelectOptions(field);
      labels.set(field.id, {
        labels: new Map(options.map((option) => [option.id, option.label])),
        order: new Map(options.map((option, i) => [option.id, i])),
      });
    } else if (field.type === "link") {
      const target = hydrateField(field).config.targetTableId;
      const options = typeof target === "string" ? (linkOptions[target] ?? []) : [];
      labels.set(field.id, { labels: new Map(options.map((option) => [option.id, option.label])) });
    } else {
      const options = resourceOptions[field.type] ?? [];
      labels.set(field.id, { labels: new Map(options.map((option) => [option.id, option.label])) });
    }
  }
  return labels;
}

export type BaseChartRunOptions = {
  maxRows?: number;
  /** Who is looking, so a project link shows only projects they may see. */
  viewer?: ProjectActor;
  /** An AI Employee is asking: archived tables stay out of every AI surface. */
  forEmployee?: boolean;
};

/** Load a Base table belonging to the company, or say why it cannot be charted. */
export async function loadChartableTable(
  companyId: string,
  baseId: string,
  tableId: string,
  opts: { forEmployee?: boolean } = {},
): Promise<{ base: Base; table: BaseTable }> {
  const base = UUID_RE.test(baseId)
    ? await AppDataSource.getRepository(Base).findOneBy({ id: baseId, companyId })
    : null;
  if (!base) throw new BaseChartError("The chart's Base no longer exists");
  const table = UUID_RE.test(tableId)
    ? await AppDataSource.getRepository(BaseTable).findOneBy({ id: tableId, baseId: base.id })
    : null;
  if (!table) throw new BaseChartError("The chart's table no longer exists in its Base");
  if (opts.forEmployee && table.archivedAt) {
    throw new BaseChartError(
      "The chart's table is archived. A Member can restore it from the Base to chart it again.",
    );
  }
  return { base, table };
}

async function tableFields(tableId: string): Promise<BaseField[]> {
  return AppDataSource.getRepository(BaseField).find({
    where: { tableId },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
}

/** Check a query against its table before it is saved. */
export async function assertBaseChartQuery(
  companyId: string,
  baseId: string,
  query: BaseChartQuery,
  opts: { forEmployee?: boolean } = {},
): Promise<void> {
  const { table } = await loadChartableTable(companyId, baseId, query.tableId, opts);
  const problem = baseChartQueryProblem(query, (await tableFields(table.id)).map(hydrateField));
  if (problem) throw new BaseChartError(problem);
}

/**
 * Run a query over a Base belonging to `companyId`. `baseId` and the query's
 * table are trusted only after they resolve inside that company.
 */
export async function runBaseChartQuery(
  companyId: string,
  baseId: string,
  query: BaseChartQuery,
  opts: BaseChartRunOptions = {},
): Promise<QueryResult> {
  const started = Date.now();
  const { table } = await loadChartableTable(companyId, baseId, query.tableId, opts);
  const fields = await tableFields(table.id);
  const problem = baseChartQueryProblem(query, fields.map(hydrateField));
  if (problem) throw new BaseChartError(problem);
  const [records, labels, zone] = await Promise.all([
    AppDataSource.getRepository(BaseRecord).find({
      where: { tableId: table.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    }),
    loadLabels(companyId, labelledFields(query, fields), opts),
    companyTimeZone(companyId),
  ]);
  const answer = answerBaseChartQuery({
    query,
    fields: fields.map(hydrateField),
    records: records.map(hydrateRecord),
    labels,
    timeZone: zone || "UTC",
    maxRows: opts.maxRows,
  });
  return { ...answer, elapsedMs: Date.now() - started };
}

// ───────────────────────── the editor's view of a Base ───────────────────────

export type ExploreBaseTable = { id: string; name: string; archived: boolean };
export type ExploreBase = {
  id: string;
  name: string;
  slug: string;
  icon: string;
  color: string;
  tables: ExploreBaseTable[];
};

/** Every Base in the company with its tables, for the chart editor's pickers. */
export async function listExploreBases(companyId: string): Promise<ExploreBase[]> {
  const bases = await AppDataSource.getRepository(Base).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  if (bases.length === 0) return [];
  const tables = await AppDataSource.getRepository(BaseTable).find({
    where: { baseId: In(bases.map((base) => base.id)) },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  return bases.map((base) => ({
    id: base.id,
    name: base.name,
    slug: base.slug,
    icon: base.icon,
    color: base.color,
    tables: tables
      .filter((table) => table.baseId === base.id)
      .map((table) => ({ id: table.id, name: table.name, archived: table.archivedAt !== null })),
  }));
}

/**
 * The columns of one table and the labels its filter pickers offer — what the
 * chart editor needs to build a query, without the table's rows.
 */
export async function loadBaseChartSchema(
  companyId: string,
  baseId: string,
  tableId: string,
  viewer?: ProjectActor,
): Promise<{
  fields: HydratedField[];
  linkOptions: Record<string, LinkOption[]>;
  resourceOptions: Record<string, ResourceOption[]>;
}> {
  const { table } = await loadChartableTable(companyId, baseId, tableId);
  const fields = await tableFields(table.id);
  const [linkOptions, resourceOptions] = await Promise.all([
    buildLinkOptionsFor(fields),
    buildResourceOptionsFor(companyId, fields, viewer ? { projectViewer: viewer } : undefined),
  ]);
  return { fields: fields.map(hydrateField), linkOptions, resourceOptions };
}

/**
 * The query in words, for an AI Employee reading the Chart as context:
 * "Sum of Amount by Close date (month), 2 filters, largest first, top 10".
 */
export function describeBaseChartQuery(query: BaseChartQuery, fields: ChartField[]): string {
  const nameOf = (id: string | null) =>
    id ? (fields.find((f) => f.id === id)?.name ?? "a removed field") : "";
  const parts: string[] = [];
  const metrics = query.metrics.map((metric) =>
    baseChartMetricLabel(metric, metric.fieldId ? nameOf(metric.fieldId) : null),
  );
  if (query.groupBy) {
    const bucket = query.groupBy.bucket ? ` (${query.groupBy.bucket})` : "";
    parts.push(
      `${metrics.length ? metrics.join(", ") : "Count"} by ${nameOf(query.groupBy.fieldId)}${bucket}`,
    );
  } else {
    parts.push(metrics.length ? metrics.join(", ") : "Every row");
  }
  if (query.filters.length) {
    parts.push(
      `filtered on ${[...new Set(query.filters.map((rule) => nameOf(rule.fieldId)))].join(", ")}`,
    );
  }
  if (query.sort?.by === "metric") {
    parts.push(query.sort.direction === "desc" ? "largest first" : "smallest first");
  } else if (query.sort?.by === "group" && query.sort.direction === "desc") {
    parts.push("in reverse order");
  } else if (query.sort?.by === "field") {
    parts.push(
      `sorted by ${nameOf(query.sort.fieldId)}${query.sort.direction === "desc" ? ", descending" : ""}`,
    );
  }
  if (query.limit) parts.push(`first ${query.limit}`);
  return parts.join(", ");
}

/** Field names for {@link describeBaseChartQuery}, keyed by the chart's table. */
export async function fieldsForTables(tableIds: string[]): Promise<Map<string, ChartField[]>> {
  const ids = [...new Set(tableIds)].filter((id) => UUID_RE.test(id));
  const out = new Map<string, ChartField[]>();
  if (ids.length === 0) return out;
  const rows = await AppDataSource.getRepository(BaseField).find({
    where: { tableId: In(ids) },
    select: { id: true, name: true, type: true, tableId: true },
  });
  for (const row of rows) {
    const list = out.get(row.tableId) ?? [];
    list.push({ id: row.id, name: row.name, type: row.type });
    out.set(row.tableId, list);
  }
  return out;
}
