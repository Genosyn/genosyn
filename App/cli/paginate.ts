import type { Operation } from "./operations.js";

/**
 * `--all`: follow a list's pages and hand back one result.
 *
 * Genosyn's lists page two ways, both read off the operation and the answer
 * rather than configured per endpoint: keyset (`?cursor=` in, `nextCursor`
 * out — the audit log, record history, follow-ups) and offset (`?offset=` in,
 * `total`, `hasMore` or `nextOffset` out — Contacts, Deals, Customers,
 * applications). The pages' lists are concatenated into the first page's
 * shape, with the paging fields cleared, so a script reads the same object
 * whether it asked for one page or all of them. An operation that doesn't
 * page just answers once.
 */

export type PageStyle = { kind: "cursor" } | { kind: "offset" } | null;

export function pageStyle(operation: Operation): PageStyle {
  const names = new Set(operation.queryParams.map((param) => param.name));
  if (names.has("cursor")) return { kind: "cursor" };
  if (names.has("offset")) return { kind: "offset" };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The property holding the page's rows: the only array, or a familiar name among several. */
export function pageListKey(page: unknown): string | null {
  if (!isRecord(page)) return null;
  const arrays = Object.keys(page).filter((key) => Array.isArray(page[key]));
  if (arrays.length === 1) return arrays[0];
  for (const name of ["items", "rows", "data", "results"]) {
    if (arrays.includes(name)) return name;
  }
  return null;
}

export type PageResult = { value: unknown; pages: number; truncated: boolean };

/**
 * Collect every page after `first`. `fetchPage` sends the same request with
 * the given query values replaced and returns the parsed JSON body.
 */
export async function collectPages(options: {
  style: PageStyle;
  first: unknown;
  query: Record<string, string | undefined>;
  fetchPage: (query: Record<string, string>) => Promise<unknown>;
  maxPages: number;
}): Promise<PageResult> {
  const { style, first } = options;
  const key = pageListKey(first);
  if (!style || !key || !isRecord(first)) return { value: first, pages: 1, truncated: false };

  const merged: Record<string, unknown> = { ...first, [key]: [...(first[key] as unknown[])] };
  const rows = merged[key] as unknown[];
  let page: Record<string, unknown> = first;
  let pages = 1;
  let truncated = false;

  if (style.kind === "cursor") {
    const seen = new Set<string>();
    for (;;) {
      const next = page.nextCursor;
      if (typeof next !== "string" || next === "" || seen.has(next)) break;
      if (pages >= options.maxPages) {
        truncated = true;
        break;
      }
      seen.add(next);
      const value = await options.fetchPage({ cursor: next });
      if (!isRecord(value) || !Array.isArray(value[key])) break;
      page = value;
      pages += 1;
      rows.push(...(value[key] as unknown[]));
    }
    if ("nextCursor" in merged) merged.nextCursor = truncated ? page.nextCursor : null;
  } else {
    const start = Number(options.query.offset ?? 0) || 0;
    let offset = start;
    const limit = options.query.limit !== undefined ? Number(options.query.limit) : undefined;
    for (;;) {
      const count = (page[key] as unknown[]).length;
      if (count === 0) break;
      const nextOffset =
        typeof page.nextOffset === "number" ? page.nextOffset : offset + count;
      let more: boolean;
      if (typeof page.hasMore === "boolean") more = page.hasMore;
      else if (typeof page.nextOffset === "number") more = true;
      else if (page.nextOffset === null) more = false;
      else if (typeof page.total === "number") more = nextOffset < page.total;
      else more = limit === undefined || count >= limit;
      if (!more || nextOffset <= offset) break;
      if (pages >= options.maxPages) {
        truncated = true;
        break;
      }
      offset = nextOffset;
      const value = await options.fetchPage({ offset: String(offset) });
      if (!isRecord(value) || !Array.isArray(value[key])) break;
      page = value;
      pages += 1;
      rows.push(...(value[key] as unknown[]));
    }
    if (!truncated) {
      if ("hasMore" in merged) merged.hasMore = false;
      if ("nextOffset" in merged) merged.nextOffset = null;
    }
  }
  return { value: merged, pages, truncated };
}
