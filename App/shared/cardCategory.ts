/**
 * Where a card purchase's category is changed: on Banking, and nowhere else.
 *
 * A card purchase is posted once, under its card's default category, and the
 * purchase remembers the category it is filed under now
 * (`CardTransaction.expenseAccountId`). Banking changes it by posting a
 * reclassification from that category to the new one. Entry review can only
 * see the entry as it was first posted, so a category change made there moved
 * money out of the original category even after Banking had moved the
 * purchase elsewhere, and the purchase never heard of it — the next change on
 * Banking moved it out of the stale category again. Either order left the
 * card's default category negative and two categories each carrying the
 * purchase. So Entry review signs off a card purchase's entries as they are,
 * and Banking stays the one place its category changes.
 *
 * Shared between client and server so Entry review only offers what the
 * server will accept: the review endpoints refuse a category change on these
 * entries with this reason, and the page shows their categories read-only.
 */

/** Why Entry review won't change a card purchase's category. */
export const CARD_CATEGORY_ON_BANKING =
  "A card purchase's category is changed on Banking — approve it here as it is";

/** A card purchase or refund, and every reclassification Banking posted for one. */
export const CARD_CATEGORY_SOURCES = [
  "brex_card_expense",
  "brex_card_refund",
  "brex_card_reclass",
] as const;

const CARD_CATEGORY_SOURCE_SET: ReadonlySet<string> = new Set(CARD_CATEGORY_SOURCES);

/** Whether an entry files a card purchase under its category. */
export function isCardCategoryEntry(entry: { source: string }): boolean {
  return CARD_CATEGORY_SOURCE_SET.has(entry.source);
}
