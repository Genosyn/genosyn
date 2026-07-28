import type { ImportRow } from "./imports.js";

export const REVENUE_IMPORT_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const REVENUE_IMPORT_SOURCE_MAX_ROWS = 10_000;
export const REVENUE_IMPORT_SOURCE_MAX_COLUMNS = 500;
export const REVENUE_IMPORT_SOURCE_ID_MAX_LENGTH = 500;

export type RevenueImportFileFormat = "csv" | "json" | "ndjson";

export type RevenueImportSourceParseOptions = {
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxSourceIdLength?: number;
  /**
   * Optional source column/property whose value becomes the durable source ID.
   * Without it, deterministic format + source-position IDs are generated.
   */
  sourceIdField?: string;
};

export type ParsedRevenueImportSource = {
  format: RevenueImportFileFormat;
  fields: string[];
  rows: ImportRow[];
};

export type RevenueImportSourceParseErrorCode =
  | "input_too_large"
  | "too_many_rows"
  | "too_many_columns"
  | "malformed_csv"
  | "empty_header"
  | "duplicate_header"
  | "invalid_json"
  | "invalid_row"
  | "invalid_source_id"
  | "duplicate_source_id";

export class RevenueImportSourceParseError extends Error {
  constructor(
    public readonly code: RevenueImportSourceParseErrorCode,
    message: string,
    public readonly line: number | null = null,
  ) {
    super(message);
    this.name = "RevenueImportSourceParseError";
  }
}

type ResolvedParseOptions = {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxSourceIdLength: number;
  sourceIdField?: string;
};

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

type CsvRecord = {
  cells: string[];
  line: number;
};

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function resolveOptions(options: RevenueImportSourceParseOptions): ResolvedParseOptions {
  const sourceIdField = options.sourceIdField?.trim();
  if (options.sourceIdField !== undefined && !sourceIdField) {
    throw new Error("sourceIdField cannot be empty");
  }
  return {
    maxBytes: positiveLimit(options.maxBytes, REVENUE_IMPORT_SOURCE_MAX_BYTES, "maxBytes"),
    maxRows: positiveLimit(options.maxRows, REVENUE_IMPORT_SOURCE_MAX_ROWS, "maxRows"),
    maxColumns: positiveLimit(options.maxColumns, REVENUE_IMPORT_SOURCE_MAX_COLUMNS, "maxColumns"),
    maxSourceIdLength: positiveLimit(
      options.maxSourceIdLength,
      REVENUE_IMPORT_SOURCE_ID_MAX_LENGTH,
      "maxSourceIdLength",
    ),
    sourceIdField,
  };
}

function boundedText(
  text: string,
  format: RevenueImportFileFormat,
  options: ResolvedParseOptions,
): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > options.maxBytes) {
    throw new RevenueImportSourceParseError(
      "input_too_large",
      `${format.toUpperCase()} source is ${bytes} bytes; the limit is ${options.maxBytes}`,
    );
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function assertRowLimit(count: number, options: ResolvedParseOptions, line?: number): void {
  if (count > options.maxRows) {
    throw new RevenueImportSourceParseError(
      "too_many_rows",
      `Import source contains more than ${options.maxRows} data rows`,
      line ?? null,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableSourceId(
  raw: unknown,
  generated: string,
  options: ResolvedParseOptions,
  line: number,
): string {
  if (raw === undefined) return generated;
  if (typeof raw !== "string" && !(typeof raw === "number" && Number.isFinite(raw))) {
    throw new RevenueImportSourceParseError(
      "invalid_source_id",
      `Source ID at line ${line} must be a string or finite number`,
      line,
    );
  }
  const id = String(raw);
  if (!id || id.trim() !== id || hasControlCharacters(id)) {
    throw new RevenueImportSourceParseError(
      "invalid_source_id",
      `Source ID at line ${line} must be non-empty and cannot contain surrounding whitespace or control characters`,
      line,
    );
  }
  if (id.length > options.maxSourceIdLength) {
    throw new RevenueImportSourceParseError(
      "invalid_source_id",
      `Source ID at line ${line} exceeds ${options.maxSourceIdLength} characters`,
      line,
    );
  }
  return id;
}

function assertUniqueSourceId(id: string, seen: Set<string>, line: number): void {
  if (seen.has(id)) {
    throw new RevenueImportSourceParseError(
      "duplicate_source_id",
      `Duplicate source ID "${id}" at line ${line}`,
      line,
    );
  }
  seen.add(id);
}

function appendFields(
  values: Record<string, unknown>,
  fields: string[],
  knownFields: Set<string>,
  options: ResolvedParseOptions,
  line: number,
): void {
  for (const field of Object.keys(values)) {
    if (knownFields.has(field)) continue;
    if (fields.length >= options.maxColumns) {
      throw new RevenueImportSourceParseError(
        "too_many_columns",
        `Import source contains more than ${options.maxColumns} fields`,
        line,
      );
    }
    knownFields.add(field);
    fields.push(field);
  }
}

function csvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let value = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let closedQuote = false;
  let fieldStarted = false;

  const finishField = (): void => {
    cells.push(value);
    value = "";
    closedQuote = false;
    fieldStarted = false;
  };
  const finishRecord = (): void => {
    finishField();
    if (cells.some((cell) => cell.trim().length > 0)) {
      records.push({ cells, line: recordLine });
    }
    cells = [];
    recordLine = line + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        value += char;
        if (char === "\n") line += 1;
        else if (char === "\r" && text[index + 1] !== "\n") line += 1;
      }
      continue;
    }

    if (closedQuote) {
      if (char === ",") {
        finishField();
        continue;
      }
      if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        finishRecord();
        line += 1;
        continue;
      }
      throw new RevenueImportSourceParseError(
        "malformed_csv",
        `Unexpected character after a closing quote at line ${line}`,
        line,
      );
    }

    if (char === '"') {
      if (fieldStarted || value.length > 0) {
        throw new RevenueImportSourceParseError(
          "malformed_csv",
          `Unexpected quote in an unquoted field at line ${line}`,
          line,
        );
      }
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      finishField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRecord();
      line += 1;
    } else {
      value += char;
      fieldStarted = true;
    }
  }

  if (quoted) {
    throw new RevenueImportSourceParseError(
      "malformed_csv",
      `Unclosed quoted field beginning on or before line ${recordLine}`,
      recordLine,
    );
  }
  if (closedQuote || fieldStarted || value.length > 0 || cells.length > 0) {
    finishRecord();
  }
  return records;
}

function csvHeaders(record: CsvRecord, options: ResolvedParseOptions): string[] {
  if (record.cells.length > options.maxColumns) {
    throw new RevenueImportSourceParseError(
      "too_many_columns",
      `CSV contains more than ${options.maxColumns} columns`,
      record.line,
    );
  }
  const headers = record.cells.map((header) => header.trim());
  const seen = new Map<string, string>();
  for (const header of headers) {
    if (!header) {
      throw new RevenueImportSourceParseError(
        "empty_header",
        `CSV contains an empty header at line ${record.line}`,
        record.line,
      );
    }
    const normalized = header.toLocaleLowerCase("en-US");
    const existing = seen.get(normalized);
    if (existing) {
      throw new RevenueImportSourceParseError(
        "duplicate_header",
        `CSV header "${header}" duplicates "${existing}"`,
        record.line,
      );
    }
    seen.set(normalized, header);
  }
  if (options.sourceIdField && !headers.includes(options.sourceIdField)) {
    throw new RevenueImportSourceParseError(
      "invalid_source_id",
      `CSV source ID column "${options.sourceIdField}" was not found`,
      record.line,
    );
  }
  return headers;
}

export function parseRevenueCsvSource(
  input: string,
  options: RevenueImportSourceParseOptions = {},
): ParsedRevenueImportSource {
  const resolved = resolveOptions(options);
  const records = csvRecords(boundedText(input, "csv", resolved));
  if (records.length === 0) {
    throw new RevenueImportSourceParseError("empty_header", "CSV source has no header row");
  }
  const fields = csvHeaders(records[0], resolved);
  const sourceColumn = resolved.sourceIdField ? fields.indexOf(resolved.sourceIdField) : -1;
  const rows: ImportRow[] = [];
  const seenSourceIds = new Set<string>();
  for (const record of records.slice(1)) {
    assertRowLimit(rows.length + 1, resolved, record.line);
    if (record.cells.length > fields.length) {
      throw new RevenueImportSourceParseError(
        "malformed_csv",
        `CSV row at line ${record.line} has ${record.cells.length} cells but the header has ${fields.length}`,
        record.line,
      );
    }
    const values = Object.fromEntries(
      fields.map((field, column) => [field, record.cells[column] ?? ""]),
    );
    const sourceId = stableSourceId(
      sourceColumn >= 0 ? record.cells[sourceColumn] : undefined,
      `csv:${record.line}`,
      resolved,
      record.line,
    );
    assertUniqueSourceId(sourceId, seenSourceIds, record.line);
    rows.push({ sourceId, values });
  }
  return { format: "csv", fields, rows };
}

function jsonImportRow(
  value: unknown,
  format: "json" | "ndjson",
  sourcePosition: number,
  line: number,
  options: ResolvedParseOptions,
  seenSourceIds: Set<string>,
): ImportRow {
  if (!isPlainObject(value)) {
    throw new RevenueImportSourceParseError(
      "invalid_row",
      `${format.toUpperCase()} row at line ${line} must be an object`,
      line,
    );
  }
  const wrappedValues = isPlainObject(value.values) ? value.values : null;
  const isWrapped =
    wrappedValues !== null &&
    Object.keys(value).every((key) => key === "sourceId" || key === "values");
  const values: Record<string, unknown> = isWrapped ? wrappedValues : value;
  const rawSourceId = isWrapped
    ? value.sourceId
    : options.sourceIdField
      ? values[options.sourceIdField]
      : undefined;
  if (options.sourceIdField && !isWrapped && !(options.sourceIdField in values)) {
    throw new RevenueImportSourceParseError(
      "invalid_source_id",
      `${format.toUpperCase()} row at line ${line} has no "${options.sourceIdField}" source ID field`,
      line,
    );
  }
  const sourceId = stableSourceId(rawSourceId, `${format}:${sourcePosition}`, options, line);
  assertUniqueSourceId(sourceId, seenSourceIds, line);
  return { sourceId, values };
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new RevenueImportSourceParseError("invalid_json", `JSON source is invalid: ${detail}`);
  }
}

export function parseRevenueJsonSource(
  input: string,
  options: RevenueImportSourceParseOptions = {},
): ParsedRevenueImportSource {
  const resolved = resolveOptions(options);
  const parsed = parseJsonValue(boundedText(input, "json", resolved));
  if (!Array.isArray(parsed)) {
    throw new RevenueImportSourceParseError(
      "invalid_json",
      "JSON source must be an array of row objects",
    );
  }
  assertRowLimit(parsed.length, resolved);
  const fields: string[] = [];
  const knownFields = new Set<string>();
  const seenSourceIds = new Set<string>();
  const rows = parsed.map((value, index) => {
    const line = index + 1;
    const row = jsonImportRow(value, "json", index + 1, line, resolved, seenSourceIds);
    appendFields(row.values, fields, knownFields, resolved, line);
    return row;
  });
  return { format: "json", fields, rows };
}

export function parseRevenueNdjsonSource(
  input: string,
  options: RevenueImportSourceParseOptions = {},
): ParsedRevenueImportSource {
  const resolved = resolveOptions(options);
  const text = boundedText(input, "ndjson", resolved);
  const fields: string[] = [];
  const knownFields = new Set<string>();
  const seenSourceIds = new Set<string>();
  const rows: ImportRow[] = [];
  for (const [lineIndex, sourceLine] of text.split(/\r?\n/).entries()) {
    if (!sourceLine.trim()) continue;
    const line = lineIndex + 1;
    assertRowLimit(rows.length + 1, resolved, line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(sourceLine) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid JSON";
      throw new RevenueImportSourceParseError(
        "invalid_json",
        `NDJSON row at line ${line} is invalid: ${detail}`,
        line,
      );
    }
    const row = jsonImportRow(parsed, "ndjson", line, line, resolved, seenSourceIds);
    appendFields(row.values, fields, knownFields, resolved, line);
    rows.push(row);
  }
  return { format: "ndjson", fields, rows };
}

export function parseRevenueImportSource(
  format: RevenueImportFileFormat,
  input: string,
  options: RevenueImportSourceParseOptions = {},
): ParsedRevenueImportSource {
  if (format === "csv") return parseRevenueCsvSource(input, options);
  if (format === "json") return parseRevenueJsonSource(input, options);
  return parseRevenueNdjsonSource(input, options);
}
