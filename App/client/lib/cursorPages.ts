/**
 * Previous / Next over a list the server pages by cursor
 * (`server/services/listPaging.ts`): which page is open, and the cursor each
 * page it has visited started at.
 *
 * A keyset cursor says "after this row", not "from row 50", so a list paged
 * this way never skips or repeats a row when rows are archived, added or
 * re-sorted between pages — which an offset does. Next is the open page's
 * `nextCursor`; Previous goes back to the cursor the page before started at,
 * remembered here because a cursor only reads forward.
 */

/** The pages visited so far: where each one started, and which is open. */
export type CursorPages = {
  /** Where each visited page starts: null for the first, then each page's cursor. */
  starts: Array<string | null>;
  /** The open page, counted from 0. */
  index: number;
};

/** The first page of a list. */
export function firstCursorPage(): CursorPages {
  return { starts: [null], index: 0 };
}

/** The cursor the open page is read from: null for the first page. */
export function openPageCursor(pages: CursorPages): string | null {
  return pages.starts[pages.index] ?? null;
}

/**
 * The page after the open one, read from the open page's `nextCursor`. Pages
 * visited after the open one are forgotten: they were read from an older
 * cursor, and the list may have moved since.
 */
export function nextCursorPage(pages: CursorPages, nextCursor: string | null): CursorPages {
  if (!nextCursor) return pages;
  return { starts: [...pages.starts.slice(0, pages.index + 1), nextCursor], index: pages.index + 1 };
}

/** The page before the open one; the first page stays put. */
export function previousCursorPage(pages: CursorPages): CursorPages {
  if (pages.index === 0) return pages;
  return { starts: pages.starts.slice(0, pages.index), index: pages.index - 1 };
}

/**
 * "26–50 of 120": the open page's place in the list. Every page before the
 * open one was full when it was read, so the open page starts after
 * `index × pageSize` rows. `of` is never less than the rows already passed,
 * even when some left the list since (archived, say) and the total shrank.
 */
export function cursorPageRange(
  pages: CursorPages,
  pageSize: number,
  shown: number,
  total: number,
): { start: number; end: number; of: number } {
  if (shown === 0) return { start: 0, end: 0, of: total };
  const start = pages.index * pageSize + 1;
  const end = start + shown - 1;
  return { start, end, of: Math.max(total, end) };
}
