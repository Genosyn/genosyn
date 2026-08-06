export type VizType = "table" | "scalar" | "bar" | "line" | "area" | "pie";

export type QueryResult = {
  fields: { name: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs?: number;
};

export type VizConfig = {
  dimension?: string;
  measures?: string[];
  measure?: string;
  stacked?: boolean;
  prefix?: string;
  suffix?: string;
  columns?: string[];
};

export type ExploreProvider = "postgres" | "mysql" | "clickhouse";

export type ExploreSchemaColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  position: number;
};

export type ExploreSchemaTable = {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: ExploreSchemaColumn[];
};

export type ExploreSchema = {
  provider: ExploreProvider;
  tables: ExploreSchemaTable[];
  truncated: boolean;
};

export type VisualizationSuggestion = {
  vizType: VizType;
  vizConfig: VizConfig;
  label: string;
  reason: string;
};

export function quoteExploreIdentifier(provider: ExploreProvider, identifier: string): string {
  if (provider === "postgres") return `"${identifier.replaceAll('"', '""')}"`;
  return `\`${identifier.replaceAll("`", "``")}\``;
}

export function qualifyExploreTable(
  provider: ExploreProvider,
  table: Pick<ExploreSchemaTable, "schema" | "name">,
): string {
  return [table.schema, table.name].map((part) => quoteExploreIdentifier(provider, part)).join(".");
}

export function buildTablePreviewSql(
  provider: ExploreProvider,
  table: Pick<ExploreSchemaTable, "schema" | "name">,
  limit = 100,
): string {
  const safeLimit = Number.isFinite(limit) ? Math.min(5000, Math.max(1, Math.floor(limit))) : 100;
  return `SELECT *\nFROM ${qualifyExploreTable(provider, table)}\nLIMIT ${safeLimit};`;
}

export function humanizeExploreName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!words) return "Untitled chart";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function filterExploreTables(
  tables: ExploreSchemaTable[],
  query: string,
): ExploreSchemaTable[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return tables;
  return tables.filter((table) =>
    [
      table.schema,
      table.name,
      table.kind,
      ...table.columns.flatMap((column) => [column.name, column.dataType]),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

function nonNullValues(result: QueryResult, column: string): unknown[] {
  return result.rows
    .slice(0, 50)
    .map((row) => row[column])
    .filter((value) => value !== null && value !== undefined && value !== "");
}

function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Number(value));
}

function isNumericColumn(result: QueryResult, column: string): boolean {
  const values = nonNullValues(result, column);
  return values.length > 0 && values.every(isNumericValue);
}

function isTemporalColumn(result: QueryResult, column: string): boolean {
  const nameHint = /(^|_)(date|day|week|month|quarter|year|time|timestamp)($|_)|(_at$)/i.test(
    column,
  );
  const values = nonNullValues(result, column);
  if (values.length === 0 || values.some((value) => typeof value !== "string")) {
    return false;
  }
  const dateValues = values as string[];
  const shapedLikeDates = dateValues.every((value) =>
    /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?(?:[T\s].*)?$/.test(value),
  );
  return (
    shapedLikeDates || (nameHint && dateValues.every((value) => !Number.isNaN(Date.parse(value))))
  );
}

/**
 * A conservative recommendation after a successful query. It never mutates
 * the chart automatically: the editor offers the suggestion as a one-click
 * action so an intentional visualization is not replaced behind the scenes.
 */
export function suggestExploreVisualization(result: QueryResult): VisualizationSuggestion | null {
  const columns = result.fields.map((field) => field.name);
  if (columns.length === 0 || result.rows.length === 0) return null;

  const numeric = columns.filter((column) => isNumericColumn(result, column));
  if (result.rows.length === 1 && numeric.length > 0) {
    return {
      vizType: "scalar",
      vizConfig: { measure: numeric[0] },
      label: "Number",
      reason: `One row with a numeric ${numeric[0]} column`,
    };
  }

  const temporal = columns.find((column) => isTemporalColumn(result, column));
  const dimension = temporal ?? columns.find((column) => !numeric.includes(column));
  const measures = numeric.filter((column) => column !== dimension).slice(0, 3);

  if (temporal && measures.length > 0) {
    return {
      vizType: "line",
      vizConfig: { dimension: temporal, measures },
      label: "Line",
      reason: `${temporal} looks like time and ${measures[0]} is numeric`,
    };
  }

  if (dimension && measures.length > 0) {
    return {
      vizType: "bar",
      vizConfig: { dimension, measures },
      label: "Bar",
      reason: `${dimension} groups the numeric ${measures[0]} column`,
    };
  }

  return {
    vizType: "table",
    vizConfig: {},
    label: "Table",
    reason: "The result is easiest to inspect as rows",
  };
}
