import { usageError } from "./errors.js";

/**
 * How results reach stdout.
 *
 * A program gets JSON — compact, one document per run — whenever stdout is
 * not a terminal, or with `--json`. A person at a terminal gets a table for
 * a list, a key-value block for a record, and the bare value for a scalar.
 * `--select` narrows either to one part of the result, and prints a string
 * or number bare (so `$(genosyn-api … --select id)` captures just the id)
 * unless `--json` asks for JSON.
 */

export type RenderOptions = {
  json: boolean;
  /** Indent JSON: only for a person reading it at a terminal. */
  pretty: boolean;
  color: boolean;
  width: number;
  columns?: string[];
  /** Print strings and numbers without JSON quoting. */
  bareScalars?: boolean;
};

const ANSI = { bold: "\u001b[1m", dim: "\u001b[2m", red: "\u001b[31m", green: "\u001b[32m", reset: "\u001b[0m" };

export function paint(style: keyof typeof ANSI, text: string, enabled: boolean): string {
  return enabled ? `${ANSI[style]}${text}${ANSI.reset}` : text;
}

/** Whether color suits this stream: a terminal, without NO_COLOR or `--no-color`. */
export function colorEnabled(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
  noColorFlag: boolean,
): boolean {
  if (noColorFlag || !stream.isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return env.TERM !== "dumb";
}

/**
 * The part of `value` at `path`: dot-separated keys and array indexes, with
 * `*` for every element (`rows.*.id`). A missing step yields null, as jq does.
 */
export function selectPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw usageError("--select needs a path, like id or rows.0.title.");
  let current: unknown[] = [value];
  let fanned = false;
  for (const part of parts) {
    if (part === "*") {
      fanned = true;
      current = current.flatMap((item) =>
        Array.isArray(item)
          ? item
          : item && typeof item === "object"
            ? Object.values(item as Record<string, unknown>)
            : [],
      );
      continue;
    }
    current = current.map((item) => {
      if (Array.isArray(item) && /^-?\d+$/.test(part)) {
        const index = Number(part);
        return item[index < 0 ? item.length + index : index] ?? null;
      }
      if (item && typeof item === "object" && part in (item as Record<string, unknown>)) {
        return (item as Record<string, unknown>)[part];
      }
      return null;
    });
  }
  return fanned ? current : (current[0] ?? null);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** One table cell or key-value value on one line, cut to `max` characters. */
export function cellText(value: unknown, max: number): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "string") text = value.replace(/\s+/g, " ").trim();
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (Array.isArray(value) && value.every(isScalar)) text = value.map(String).join(", ");
  else text = JSON.stringify(value);
  return truncate(text, max);
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const PREFERRED_COLUMNS = [
  "id",
  "operationId",
  "command",
  "slug",
  "name",
  "title",
  "subject",
  "email",
  "status",
  "state",
  "role",
  "kind",
  "type",
  "stage",
  "amountCents",
  "currency",
  "dueAt",
  "createdAt",
  "updatedAt",
];

/**
 * Columns whose values are copied rather than read — ids, slugs, commands —
 * and so are never cut short: a truncated id is no id at all.
 */
export function isKeepColumn(column: string): boolean {
  return /^(id|slug|command|operationId|area)$/i.test(column) || /(Id|ID|Slug)$/.test(column);
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * Columns for a list: the requested ones; else familiar fields first, then
 * the rest, leaving out any that are empty in every row or ever hold an
 * object, as many as fit.
 */
export function chooseColumns(
  rows: Record<string, unknown>[],
  width: number,
  requested?: string[],
): string[] {
  if (requested?.length) return requested;
  const seen = new Map<string, number>();
  const nested = new Set<string>();
  const filled = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    for (const [key, value] of Object.entries(row)) {
      const scalar = isScalar(value) || (Array.isArray(value) && value.every(isScalar));
      if (!scalar) {
        nested.add(key);
        continue;
      }
      if (!isBlank(value)) filled.add(key);
      seen.set(key, Math.max(seen.get(key) ?? 0, cellText(value, 1000).length));
    }
  }
  // A column that holds an object in any row stays out: one cell of JSON
  // reads worse than the record view `--select` or `--json` gives.
  for (const key of seen.keys()) if (nested.has(key) || !filled.has(key)) seen.delete(key);
  const keys = [...seen.keys()];
  const ordered = [
    ...PREFERRED_COLUMNS.filter((key) => seen.has(key)),
    ...keys.filter((key) => !PREFERRED_COLUMNS.includes(key)),
  ];
  const chosen: string[] = [];
  let used = 0;
  for (const key of ordered) {
    const natural = seen.get(key) ?? 0;
    const cost = Math.max(key.length, isKeepColumn(key) ? natural : Math.min(natural, 24)) + 2;
    if (chosen.length > 0 && used + cost > width) continue;
    chosen.push(key);
    used += cost;
  }
  return chosen.length ? chosen : ordered.slice(0, 1);
}

/**
 * Widths that fit `width`: id-like columns at full length, the others
 * sharing what is left — narrow columns keep their size and the widest give
 * way first — and the last column taking whatever remains.
 */
function columnWidths(natural: number[], columns: string[], width: number): number[] {
  const gap = 2 * Math.max(0, columns.length - 1);
  const widths = [...natural];
  const flexible = columns
    .map((column, index) => index)
    .filter((index) => !isKeepColumn(columns[index]));
  const fixed = columns.reduce(
    (sum, column, index) => sum + (isKeepColumn(column) ? natural[index] : 0),
    0,
  );
  let room = width - gap - fixed;
  const queue = [...flexible].sort((a, b) => natural[a] - natural[b]);
  while (queue.length) {
    const share = Math.floor(room / queue.length);
    const index = queue.shift() as number;
    widths[index] = Math.max(Math.min(natural[index], Math.max(share, 8)), Math.min(natural[index], columns[index].length));
    room -= widths[index];
  }
  return widths;
}

/** A plain-text table: a header row and one line per row, columns padded to fit. */
export function renderTable(
  rows: Record<string, unknown>[],
  columns: string[],
  options: Pick<RenderOptions, "color" | "width">,
): string {
  const full = rows.map((row) => columns.map((column) => cellText(row[column], 10_000)));
  const natural = columns.map((column, index) =>
    Math.max(column.length, ...full.map((line) => line[index].length)),
  );
  const widths = columnWidths(natural, columns, options.width);
  const cells = full.map((line) => line.map((value, index) => truncate(value, widths[index])));
  const line = (values: string[]) =>
    values
      .map((value, index) => (index === values.length - 1 ? value : value.padEnd(widths[index])))
      .join("  ")
      .trimEnd();
  const header = paint("bold", line(columns.map((column) => column.toUpperCase())), options.color);
  return `${[header, ...cells.map(line)].join("\n")}\n`;
}

/** A record as aligned `key  value` lines; nested values as one-line JSON. */
export function renderRecord(
  record: Record<string, unknown>,
  options: Pick<RenderOptions, "color" | "width">,
): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}\n";
  const keyWidth = Math.min(28, Math.max(...keys.map((key) => key.length)));
  const valueWidth = Math.max(20, options.width - keyWidth - 2);
  const lines = keys.map((key) => {
    const value = record[key];
    let text: string;
    if (typeof value === "string" && value.length > 0) {
      const flat = value.length > 500 ? `${value.slice(0, 500)}… (${value.length - 500} more characters; --json shows all)` : value;
      text = flat.split("\n").join(`\n${" ".repeat(keyWidth + 2)}`);
    } else {
      text = cellText(value, valueWidth);
    }
    return `${paint("dim", key.padEnd(keyWidth), options.color)}  ${text}`;
  });
  return `${lines.join("\n")}\n`;
}

const PAGING_KEYS = new Set([
  "total",
  "nextCursor",
  "cursor",
  "hasMore",
  "nextOffset",
  "offset",
  "limit",
  "count",
]);

/**
 * The list property of a page — `{ rows: [...], total }`, `{ items, nextCursor }`
 * — which people read as a table: the object's only array, holding records,
 * beside nothing but plain values. An empty one counts when paging fields
 * say it is a page, so a record with an empty `tags` stays a record.
 */
export function listProperty(value: Record<string, unknown>): string | null {
  const entries = Object.entries(value);
  const arrays = entries.filter(([, child]) => Array.isArray(child));
  if (arrays.length !== 1) return null;
  const [key, list] = arrays[0] as [string, unknown[]];
  const others = entries.filter(([name]) => name !== key);
  if (!others.every(([, child]) => isScalar(child))) return null;
  if (list.length > 0) return list.every(isPlainObject) ? key : null;
  return others.length === 0 || others.some(([name]) => PAGING_KEYS.has(name)) ? key : null;
}

/** Render a result for stdout, ending in a newline (or nothing for no result). */
export function renderValue(value: unknown, options: RenderOptions): string {
  if (value === undefined) return "";
  if (options.bareScalars && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
    return `${String(value)}\n`;
  }
  if (options.json) {
    return `${JSON.stringify(value, null, options.pretty ? 2 : undefined)}\n`;
  }
  if (value === null) return "null\n";
  if (isScalar(value)) return `${String(value)}\n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${paint("dim", "(no results)", options.color)}\n`;
    if (value.every(isPlainObject)) {
      const rows = value as Record<string, unknown>[];
      return renderTable(rows, chooseColumns(rows, options.width, options.columns), options);
    }
    if (value.every(isScalar)) return `${value.map((item) => String(item)).join("\n")}\n`;
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  const record = value as Record<string, unknown>;
  const key = listProperty(record);
  if (key) {
    const rest = Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
    const rows = record[key] as Record<string, unknown>[];
    const table =
      rows.length === 0
        ? `${paint("dim", "(no results)", options.color)}\n`
        : renderTable(rows, chooseColumns(rows, options.width, options.columns), options);
    const footer = Object.keys(rest).length ? `\n${renderRecord(rest, options)}` : "";
    return `${table}${footer}`;
  }
  return renderRecord(record, options);
}
