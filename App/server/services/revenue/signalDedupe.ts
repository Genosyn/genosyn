import crypto from "node:crypto";

/**
 * Deduplication for product-usage Signals.
 *
 * A Signal is a query the customer wrote against their own database, re-run on
 * every tick. Without a dedupe key it re-fires on the same rows forever, the
 * owner gets the same alert forty times, and the Signal gets muted inside a
 * day — which is the real failure mode, because a muted Signal never fires
 * again for the row that mattered.
 *
 * Three decisions shape everything below:
 *
 * - **Rows come from somebody else's database.** They can be enormous, cyclic,
 *   contain BigInt, invalid Dates, `Object.create(null)` values, or arrive with
 *   the columns in a different order on a replica. Nothing here throws on any
 *   of that; the worst case is always a degraded-but-stable key, never a tick
 *   that dies and stops every other Signal in the batch.
 * - **A wrong key must fail toward "fire less".** When the configured column is
 *   unusable we hash the row instead, which degrades the Signal from "fire once
 *   per entity" to "fire once per distinct row". Duplicated alerts on an edited
 *   row is a nuisance; firing forever is what gets the Signal muted.
 * - **Pure and deterministic.** No clock, no DB, no `Math.random`. The same row
 *   must produce the same key on every process, forever — a key that changes
 *   after a deploy silently re-fires the entire history.
 */

/**
 * Longest dedupe key we will store. Keys are indexed, and a customer column can
 * hold a whole document; 200 chars is far past any real id or email and keeps
 * the index usable. Collisions after truncation are accepted: two entities
 * whose ids agree for 200 characters are, for alerting purposes, the same
 * entity.
 */
const MAX_KEY_CHARS = 200;

/** Hex characters kept from the sha256 fallback. 32 hex chars = 128 bits, which */
/** makes an accidental collision across a customer's row set impossible in */
/** practice while keeping the key short enough to read in a log line. */
const HASH_KEY_CHARS = 32;

/** Marks a key as derived from the whole row rather than an identity column. */
const ROW_HASH_PREFIX = "row:";

/** What `truncatePayload` returns when the row cannot be encoded at all. */
const UNSERIALIZABLE_PAYLOAD = '{"_truncated":true,"_bytes":0,"preview":"[unserializable]"}';

/**
 * Canonical JSON for a row: keys sorted recursively, so a driver that returns
 * columns in a different order — a replica, a schema change, a `SELECT *`
 * rewritten by hand — cannot change the hash and re-fire the whole history.
 *
 * Exported for testing, and because the hash is only trustworthy if the encoder
 * feeding it is itself pinned by tests.
 *
 * Deliberately not `JSON.stringify`: this must never throw on data we did not
 * author. Cycles become `"[Circular]"`, BigInt becomes its decimal string,
 * invalid Dates become `"Invalid Date"`, non-finite numbers become `null` (as
 * `JSON.stringify` does). `undefined`, functions and symbols are omitted from
 * objects but become `null` inside arrays, because dropping an array element
 * would shift every index after it and change the meaning of the row.
 */
export function canonicalizeRow(row: Record<string, unknown>): string {
  return encode(row, new Set<object>()) ?? "null";
}

/** Returns undefined for values that must be *omitted* from an object. */
function encode(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "undefined" || type === "function" || type === "symbol") return undefined;
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "bigint") return JSON.stringify(String(value));
  if (type === "number") {
    return Number.isFinite(value as number) ? String(value) : "null";
  }
  if (type === "string") return JSON.stringify(value);

  const object = value as object;
  if (value instanceof Date) {
    const time = value.getTime();
    return JSON.stringify(Number.isNaN(time) ? "Invalid Date" : value.toISOString());
  }

  // Cycles are tracked along the current path only, so a value legitimately
  // shared by two sibling columns still encodes twice rather than collapsing.
  if (seen.has(object)) return '"[Circular]"';
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item) => encode(item, seen) ?? "null");
      return `[${parts.join(",")}]`;
    }
    const parts: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const encoded = encode((object as Record<string, unknown>)[key], seen);
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * The key that decides whether this row has already fired.
 *
 * The happy path is the customer naming an identity column — `id`, `email`,
 * `subscription_id` — and we use its stringified, trimmed value. Numbers and
 * strings coerce to the same key on purpose: a driver that returns `42` today
 * and `"42"` after a type change must not re-fire the row.
 *
 * When the column is missing, empty-named, null, or whitespace-only we fall
 * back to a sha256 of the canonical row. That is a real downgrade — the Signal
 * now fires once per *distinct row* rather than once per entity, so editing an
 * unrelated column re-fires it — but it is the safe direction: the alternative
 * is a stable-but-shared key (silently suppressing everyone else's rows) or no
 * key at all (firing forever). Callers that care should validate the column
 * exists at Signal-save time; this function's job is to never make a tick fail.
 *
 * Never returns an empty string, because an empty key would collapse every
 * unkeyed row in the batch into one event.
 */
export function dedupeKeyFor(row: Record<string, unknown>, column: string): string {
  const source = row && typeof row === "object" ? row : {};

  if (typeof column === "string" && column.trim() !== "") {
    const value = (source as Record<string, unknown>)[column];
    if (value !== null && value !== undefined) {
      const text = stringifyScalar(value);
      // `trim` first, then slice: the first character of a trimmed string is
      // never whitespace, so the slice can never come back empty.
      const trimmed = text === null ? "" : text.trim();
      if (trimmed !== "") return trimmed.slice(0, MAX_KEY_CHARS);
    }
  }

  return rowHashKey(source as Record<string, unknown>);
}

/**
 * `String(value)` throws for a null-prototype object and for any object whose
 * `toString`/`valueOf` throws — both of which a customer's ORM can hand us.
 * Returning null routes those rows to the hash fallback instead of the tick.
 */
function stringifyScalar(value: unknown): string | null {
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** Prefixed so a hashed key is visibly distinguishable from a customer id in */
/** logs — "why is this firing every edit" is otherwise impossible to diagnose. */
function rowHashKey(row: Record<string, unknown>): string {
  const digest = crypto
    .createHash("sha256")
    .update(canonicalizeRow(row))
    .digest("hex")
    .slice(0, HASH_KEY_CHARS);
  return `${ROW_HASH_PREFIX}${digest}`;
}

export type SelectedEvent<T> = { key: string; row: T };

export type SelectionResult<T> = {
  /** In input order, one entry per key we have never fired on. */
  fresh: Array<SelectedEvent<T>>;
  /** Rows dropped because an earlier row *in this batch* claimed the key. */
  duplicateInBatch: number;
  /** Rows dropped because the key was already stored from an earlier tick. */
  alreadySeen: number;
};

/**
 * Split one tick's rows into "fire on these" and "we've seen this".
 *
 * Order matters twice. The first occurrence of a key wins, not the last,
 * because a query with `ORDER BY` puts the row the customer considers most
 * relevant first, and `fresh` preserves input order so the notification reads
 * in the same order as the customer's own query.
 *
 * `existingKeys` is checked *before* batch-duplicate detection, so a key that
 * is both already stored and repeated within the batch counts once in
 * `alreadySeen` per occurrence and never in `duplicateInBatch`. The two counters
 * answer different questions — "is this Signal re-querying settled data?" vs
 * "is this query missing a `DISTINCT`?" — and blending them would answer
 * neither.
 *
 * Guaranteed: no two entries in `fresh` share a key, and
 * `fresh.length + duplicateInBatch + alreadySeen === rows.length`.
 */
export function selectNewEvents<T extends Record<string, unknown>>(
  rows: T[],
  column: string,
  existingKeys: ReadonlySet<string>,
): SelectionResult<T> {
  const fresh: Array<SelectedEvent<T>> = [];
  let duplicateInBatch = 0;
  let alreadySeen = 0;

  const seenInBatch = new Set<string>();
  for (const row of rows ?? []) {
    const key = dedupeKeyFor(row, column);
    if (existingKeys && existingKeys.has(key)) {
      alreadySeen += 1;
      continue;
    }
    if (seenInBatch.has(key)) {
      duplicateInBatch += 1;
      continue;
    }
    seenInBatch.add(key);
    fresh.push({ key, row });
  }

  return { fresh, duplicateInBatch, alreadySeen };
}

/**
 * Encode a row for storage on the fired event.
 *
 * The payload is whatever the customer's query returned: a 40 MB JSONB blob, a
 * bytea column, a row with a cycle introduced by their ORM's hydration. All
 * three would otherwise take down the tick or the row insert, so this function
 * has exactly one contract — it always returns a string, and that string is
 * always valid JSON.
 *
 * Over the cap we return an envelope rather than a raw prefix, so a consumer
 * can tell "this is the row" from "this is the first few hundred characters of
 * the row" without guessing. `preview` is shrunk until the *whole envelope*
 * fits inside `maxChars`, because the cap exists to satisfy a column limit and
 * an envelope that overflows it is no better than the payload that caused it.
 * The one exception is a `maxChars` smaller than the empty envelope itself,
 * where we return the minimal envelope and overflow — there is nothing useful
 * to return at that size.
 *
 * `_bytes` is the UTF-8 byte length of the original payload (what you would
 * quote to the customer), while the cap is measured in JS string characters
 * (what a varchar limit counts). They differ for non-ASCII and that is
 * intentional, not an oversight.
 */
export function truncatePayload(row: Record<string, unknown>, maxChars = 4000): string {
  let json: unknown;
  try {
    json = JSON.stringify(row);
  } catch {
    // Cycles, BigInt, and a throwing `toJSON` all land here.
    return UNSERIALIZABLE_PAYLOAD;
  }
  // `undefined` for a function/symbol/undefined row, and for a `toJSON` that
  // returns nothing. Not JSON, so it cannot be stored.
  if (typeof json !== "string") return UNSERIALIZABLE_PAYLOAD;
  if (json.length <= maxChars) return json;

  const bytes = Buffer.byteLength(json, "utf8");
  const empty = envelope(bytes, "");
  let sliceLength = Math.max(0, maxChars - empty.length);
  for (;;) {
    const out = envelope(bytes, json.slice(0, sliceLength));
    if (out.length <= maxChars || sliceLength === 0) return out;
    // Escaping (quotes, control chars, lone surrogates) makes the encoded
    // preview longer than the slice, so converge by the observed overflow
    // instead of assuming a ratio.
    sliceLength = Math.max(0, sliceLength - (out.length - maxChars));
  }
}

/** Key order is fixed and hand-written so the envelope shape is a contract. */
function envelope(bytes: number, preview: string): string {
  return `{"_truncated":true,"_bytes":${bytes},"preview":${JSON.stringify(preview)}}`;
}
