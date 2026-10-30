import { createHash } from "node:crypto";
import type { ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";

/**
 * One way to page every list an AI Employee or an API client reads.
 *
 * Lists used to stop at a fixed number of rows. An AI Employee clearing a
 * Banking queue of 1,069 card purchases was handed the newest 500, told
 * `truncated: false`, and given no offset or date filter to reach the rest —
 * so the 569 older ones, where most of the money sat, could not be filed at
 * all. A cap with no way past it is the bug this module exists to make
 * impossible to write by accident.
 *
 * The contract every paged list follows:
 *
 * - **In:** `limit` (clamped to the list's maximum, never refused for being
 *   large) and `cursor` (the previous page's `nextCursor`).
 * - **Out:** `total` (every row the filters match, ignoring the page),
 *   `hasMore`, `nextCursor` (null on the last page) and, while more rows
 *   follow, a `note` saying how to read on. Lists put these before the rows,
 *   so an answer cut short by a tool-result limit still says how to continue.
 *
 * Pages are keyset pages, not offsets: a cursor names the last row's sort key
 * (ending in its unique id) rather than a row count. That matters for the
 * queues these lists serve — an AI Employee categorizing page one takes those
 * rows out of the To review filter, and an offset would then skip as many
 * rows as it had just filed. A keyset cursor carries on from the same place
 * whatever changed before it, rows sharing a date included.
 *
 * A cursor is bound to its list, its company and the exact filters that
 * issued it, so reusing one with different filters is refused with a message
 * saying what to do, rather than silently starting somewhere else.
 */

/** Bumped when the cursor format changes; older cursors are then refused, never misread. */
export const CURSOR_VERSION = 1;

/** Longest cursor accepted. Real ones are a few hundred characters. */
export const CURSOR_MAX_LENGTH = 1_000;

/** The largest `limit` a request may name before validation refuses it as nonsense. */
export const LIMIT_CEILING = 10_000;

/**
 * A list request its caller has to change: a bad cursor or date bound (400),
 * or a filter naming a record the company does not have (404). Routes and
 * tools answer it with its own status and message.
 */
export class ListQueryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A cursor this list cannot use: garbled, from another list, or for other filters. */
export class ListCursorError extends ListQueryError {}

export const CURSOR_INVALID =
  "That cursor is not one this list issued (it may have been cut short, or come from an older version). Repeat the call without cursor to start from the first page.";
export const CURSOR_OTHER_LIST =
  "That cursor belongs to a different list. Pass a cursor only back to the list that returned it, or repeat the call without cursor to start from the first page.";
export const CURSOR_OTHER_FILTERS =
  "That cursor was issued for different filters. Repeat the call with exactly the filters that returned it, or without cursor to start again from the first page.";

/** One value of a sort key as it travels in a cursor. */
export type CursorValue = string | number;

/** How many rows a list returns by default, and the most it returns at once. */
export type PageLimits = { defaultLimit: number; maxLimit: number };

/** A page request: how many rows, and where the previous page ended. */
export type PageRequest = { limit?: number; cursor?: string };

/** What a page says about the rest of the list. */
export type PageInfo = {
  /** Rows the filters match, ignoring limit and cursor. */
  total: number;
  /** Rows follow this page. */
  hasMore: boolean;
  /** Pass back as `cursor`, with the same filters, for the next page; null on the last. */
  nextCursor: string | null;
  /** How to read on, while more rows follow. */
  note?: string;
};

/**
 * The page size to use: the list's default when none was asked for, and never
 * more than its maximum. A larger request is cut, not refused, so an older
 * Skill that asks for 500 still gets a page and a cursor to the rest.
 */
export function pageLimit(requested: number | undefined, limits: PageLimits): number {
  if (requested === undefined || !Number.isFinite(requested)) return limits.defaultLimit;
  return Math.min(Math.max(Math.trunc(requested), 1), limits.maxLimit);
}

/** The `limit` and `cursor` a paged AI tool's body takes. */
export const pageBodyShape = {
  limit: z.number().int().min(1).max(LIMIT_CEILING).optional(),
  cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
};

/** The same two fields as a REST query string sends them. */
export const pageQueryShape = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMIT_CEILING)
    .optional()
    .describe("Rows per page. Larger values than the list's maximum are cut to it."),
  cursor: z
    .string()
    .min(1)
    .max(CURSOR_MAX_LENGTH)
    .optional()
    .describe(
      "nextCursor from the previous page. Send it with exactly the same filters; another list's cursor, or one issued for other filters, is refused with 400.",
    ),
};

/** Stable JSON: keys sorted at every level, undefined left out. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]);
  }
  return value;
}

/**
 * A short digest of the company and the filters a page was read with. A
 * cursor carries it, so the next page can tell it is being asked for the same
 * list it continues.
 */
export function filterFingerprint(companyId: string, filters: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify([companyId, canonical(filters)]))
    .digest("base64url")
    .slice(0, 16);
}

const cursorSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    s: z.string().min(1).max(80),
    f: z.string().min(1).max(64),
    k: z
      .array(z.union([z.string().max(200), z.number().finite()]))
      .min(1)
      .max(8),
  })
  .strict();

/** The cursor that continues `scope` after a row whose sort key is `key`. */
export function encodeCursor(scope: string, fingerprint: string, key: CursorValue[]): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, s: scope, f: fingerprint, k: key }),
    "utf8",
  ).toString("base64url");
}

/** The sort key a cursor continues after; throws {@link ListCursorError} on any mismatch. */
export function decodeCursor(scope: string, fingerprint: string, cursor: string): CursorValue[] {
  let parsed: z.infer<typeof cursorSchema>;
  try {
    if (cursor.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new ListCursorError(CURSOR_INVALID);
  }
  if (parsed.s !== scope) throw new ListCursorError(CURSOR_OTHER_LIST);
  if (parsed.f !== fingerprint) throw new ListCursorError(CURSOR_OTHER_FILTERS);
  return parsed.k;
}

/**
 * One column of a keyset sort. Every keyset ends in a unique column (the
 * row's id), so no two rows share a key and a page boundary can never fall
 * between rows that tie.
 */
export type KeysetColumn =
  | {
      /** The column as a query builder writes it: `t.date`. Must not be null. */
      column: string;
      direction: "ASC" | "DESC";
      /**
       * `timestamp` travels as the database's own text for the value, so a
       * Postgres timestamp keeps its microseconds and rows in the same
       * millisecond are neither skipped nor repeated.
       */
      type: "timestamp" | "string" | "number";
    }
  | {
      /**
       * A constant: the same number for every row of this query. Lets one
       * keyset span several tables merged into one list — each table's rows
       * carry their own rank — without sorting by a literal, which SQL would
       * read as a column position.
       */
      literal: number;
      direction: "ASC" | "DESC";
    };

/**
 * The condition "comes after `after` in this order", for a query builder's
 * `andWhere`. Constant columns are decided here, so they never reach SQL.
 * Returns null when every row qualifies.
 */
export function keysetCondition(
  keys: KeysetColumn[],
  after: CursorValue[],
  prefix: string,
): { sql: string; params: Record<string, CursorValue> } | null {
  if (after.length !== keys.length) throw new ListCursorError(CURSOR_INVALID);
  const params: Record<string, CursorValue> = {};
  const build = (index: number): string | boolean => {
    if (index === keys.length) return false;
    const key = keys[index];
    const value = after[index];
    if ("literal" in key) {
      if (typeof value !== "number") throw new ListCursorError(CURSOR_INVALID);
      if (key.literal === value) return build(index + 1);
      return key.direction === "ASC" ? key.literal > value : key.literal < value;
    }
    if (key.type === "number" ? typeof value !== "number" : typeof value !== "string") {
      throw new ListCursorError(CURSOR_INVALID);
    }
    const name = `${prefix}${index}`;
    params[name] = value;
    const rest = build(index + 1);
    const strict = key.direction === "DESC" ? "<" : ">";
    if (rest === false) return `${key.column} ${strict} :${name}`;
    if (rest === true) return `${key.column} ${strict}= :${name}`;
    return `(${key.column} ${strict} :${name} OR (${key.column} = :${name} AND ${rest}))`;
  };
  const sql = build(0);
  if (sql === true) return null;
  if (sql === false) return { sql: "1 = 0", params };
  return { sql, params };
}

/** One fetched row and the sort key a cursor after it carries. */
export type KeyedRow<T> = { row: T; key: CursorValue[] };

/**
 * Fetch up to `limit + 1` rows after `after`, in keyset order, each with its
 * key. The extra row only says whether another page follows; the caller keeps
 * `limit`. The query builder brings the filters and must not be ordered yet.
 * The last key must be the row's unique `id`.
 */
export async function keysetRows<T extends ObjectLiteral & { id: string }>(
  qb: SelectQueryBuilder<T>,
  args: { keys: KeysetColumn[]; after: CursorValue[] | null; limit: number; prefix?: string },
): Promise<KeyedRow<T>[]> {
  const prefix = args.prefix ?? "keyset";
  const last = args.keys[args.keys.length - 1];
  if (!last || "literal" in last || last.type !== "string") {
    throw new Error("A keyset must end in the row's unique string id");
  }
  let ordered = false;
  args.keys.forEach((key, index) => {
    if ("literal" in key) return;
    // A timestamp travels as its own text, so no precision is lost on the way
    // to the next page. Every key is selected as an expression: selecting the
    // bare `t.id` under another name would rename the entity's own column and
    // leave the row without its id.
    qb.addSelect(
      key.type === "number" ? `(${key.column})` : `CAST(${key.column} AS text)`,
      `${prefix}_k${index}`,
    );
    if (ordered) qb.addOrderBy(key.column, key.direction);
    else qb.orderBy(key.column, key.direction);
    ordered = true;
  });
  if (args.after) {
    const condition = keysetCondition(args.keys, args.after, `${prefix}After`);
    if (condition) qb.andWhere(condition.sql, condition.params);
  }
  qb.limit(args.limit + 1);
  const { entities, raw } = await qb.getRawAndEntities<Record<string, unknown>>();
  const keyById = new Map<string, CursorValue[]>();
  for (const record of raw) {
    const key = args.keys.map((column, index): CursorValue => {
      if ("literal" in column) return column.literal;
      const value = record[`${prefix}_k${index}`];
      return column.type === "number" ? Number(value) : String(value);
    });
    keyById.set(String(key[key.length - 1]), key);
  }
  return entities.map((row) => {
    const key = keyById.get(String(row.id));
    if (!key) throw new Error(`Keyset row ${String(row.id)} came back without its key`);
    return { row, key };
  });
}

/**
 * How many of `rows`, from the front, fit in `budgetChars` of pretty-printed
 * JSON as an AI Employee's tool result renders it — at least one. A page that
 * would be clipped by the runtime's tool-result limit loses the rows past the
 * clip while its cursor points beyond them; ending the page early, with the
 * cursor after the last row kept, loses nothing.
 */
export function rowsWithinBudget(rows: readonly unknown[], budgetChars: number): number {
  // Rows sit two levels deep in the answer ({ "rows": [ … ] }), so every line
  // of one is indented four more spaces than it is on its own.
  let used = 0;
  for (let index = 0; index < rows.length; index++) {
    const text = JSON.stringify(rows[index], null, 2) ?? "null";
    const lines = text.split("\n").length;
    used += text.length + lines * 4 + 2;
    if (used > budgetChars && index > 0) return index;
  }
  return rows.length;
}

/** Characters of pretty JSON a page of rows may take in an AI Employee's tool result. */
export const TOOL_PAGE_BUDGET_CHARS = 40_000;

/**
 * The note a page carries while more rows follow, so whoever reads it — a
 * model most often — knows the list goes on and exactly how to read the rest.
 */
export function pageNote(args: {
  shown: number;
  /** Omitted by a list too large to count on every page (a mailbox). */
  total?: number;
  noun: string;
  hasMore: boolean;
}): string | undefined {
  if (!args.hasMore) return undefined;
  const count = (n: number) => n.toLocaleString("en-US");
  const held =
    args.total === undefined
      ? `This page holds ${count(args.shown)} ${args.noun}; more match.`
      : `This page holds ${count(args.shown)} of the ${count(args.total)} matching ${args.noun}.`;
  return `${held} Call again with the same filters and cursor set to nextCursor for the next page; keep going until hasMore is false.`;
}

/**
 * Close a page: keep `limit` of the fetched rows (fewer when `budgetChars`
 * says the rest would not fit), and say what follows.
 */
export function finishPage<T, Out>(args: {
  fetched: KeyedRow<T>[];
  limit: number;
  total: number;
  noun: string;
  scope: string;
  fingerprint: string;
  /** The row as the answer shows it; measured against `budgetChars`. */
  present: (row: T) => Out;
  budgetChars?: number;
}): PageInfo & { rows: Out[] };
/** A list too large to count on every page answers without `total`. */
export function finishPage<T, Out>(args: {
  fetched: KeyedRow<T>[];
  limit: number;
  total?: undefined;
  noun: string;
  scope: string;
  fingerprint: string;
  present: (row: T) => Out;
  budgetChars?: number;
}): Omit<PageInfo, "total"> & { rows: Out[] };
export function finishPage<T, Out>(args: {
  fetched: KeyedRow<T>[];
  limit: number;
  total?: number;
  noun: string;
  scope: string;
  fingerprint: string;
  present: (row: T) => Out;
  budgetChars?: number;
}): Omit<PageInfo, "total"> & { total?: number; rows: Out[] } {
  const kept = args.fetched.slice(0, args.limit);
  let rows = kept.map((entry) => args.present(entry.row));
  if (args.budgetChars !== undefined)
    rows = rows.slice(0, rowsWithinBudget(rows, args.budgetChars));
  const hasMore = args.fetched.length > rows.length;
  const lastKey = rows.length > 0 ? kept[rows.length - 1].key : null;
  const nextCursor =
    hasMore && lastKey ? encodeCursor(args.scope, args.fingerprint, lastKey) : null;
  const note = pageNote({ shown: rows.length, total: args.total, noun: args.noun, hasMore });
  return {
    ...(args.total !== undefined ? { total: args.total } : {}),
    hasMore: hasMore && nextCursor !== null,
    nextCursor,
    ...(note ? { note } : {}),
    rows,
  };
}

/**
 * A date bound as Finance reads one. A bare `YYYY-MM-DD` is a calendar day in
 * UTC — the way bank dates, card dates and journal dates are stored and shown
 * — so `to: "2023-07-31"` includes everything dated that day. A full ISO
 * timestamp is that instant, offset honoured.
 */
export type DateRange = {
  /** Inclusive lower bound. */
  gte?: Date;
  /** Exclusive upper bound: the day after a date-only `to`. */
  lt?: Date;
  /** Inclusive upper bound: a timestamp `to`. */
  lte?: Date;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown for a date bound that is not a date, or a range that ends before it starts. */
export class DateRangeError extends ListQueryError {}

function parseBound(value: string, label: string): { at: Date; dateOnly: boolean } {
  const dateOnly = DATE_ONLY.test(value);
  const at = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(at.getTime()) || (dateOnly && at.toISOString().slice(0, 10) !== value)) {
    throw new DateRangeError(
      `${label} must be a date (YYYY-MM-DD) or an ISO timestamp, got ${JSON.stringify(value)}`,
    );
  }
  return { at, dateOnly };
}

/** `from` / `to` as a {@link DateRange}; both inclusive, see the type. */
export function dateRange(
  from: string | undefined,
  to: string | undefined,
  labels = ["from", "to"],
): DateRange {
  const range: DateRange = {};
  if (from) range.gte = parseBound(from, labels[0]).at;
  if (to) {
    const end = parseBound(to, labels[1]);
    if (end.dateOnly) range.lt = new Date(end.at.getTime() + 86_400_000);
    else range.lte = end.at;
  }
  const upper = range.lt ?? range.lte;
  if (range.gte && upper && (range.lt ? range.gte >= upper : range.gte > upper)) {
    throw new DateRangeError(`${labels[0]} must be on or before ${labels[1]}`);
  }
  return range;
}

/**
 * Raw SQL comparing a primary key with a column that references it. On
 * Postgres the key is `uuid` and the reference `varchar`, which it will not
 * compare; on SQLite both are text. Cast the side that is not being looked
 * up, so the other side's index still answers: `e.id = asUuid(t.entryId)`,
 * `l.entryId = asText(e.id)`.
 */
export function asUuid(expression: string): string {
  return AppDataSource.options.type === "postgres" ? `CAST(${expression} AS uuid)` : expression;
}

/** See {@link asUuid}: a `uuid` key compared with a `varchar` reference column. */
export function asText(expression: string): string {
  return AppDataSource.options.type === "postgres" ? `CAST(${expression} AS text)` : expression;
}

/** Apply a {@link DateRange} to one column of a query. */
export function andWhereDateRange<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  column: string,
  range: DateRange,
  prefix: string,
): SelectQueryBuilder<T> {
  if (range.gte) qb.andWhere(`${column} >= :${prefix}From`, { [`${prefix}From`]: range.gte });
  if (range.lt) qb.andWhere(`${column} < :${prefix}Before`, { [`${prefix}Before`]: range.lt });
  if (range.lte) qb.andWhere(`${column} <= :${prefix}Through`, { [`${prefix}Through`]: range.lte });
  return qb;
}
