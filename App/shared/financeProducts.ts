/**
 * The small contract shared by a product's ⌘K result and the Products &
 * services page it opens.
 *
 * The server builds the result link from the product's name; the page reads
 * the same `q` back and filters with the same word rules. Keeping both here
 * means a search result can never open a catalogue filtered by something the
 * page would not have matched.
 */

/** Where a Finance product's search result opens: the catalogue, filtered. */
export function financeProductPath(name: string): string {
  return `/finance/products?q=${encodeURIComponent(name)}`;
}

export type FinanceProductSearchFields = {
  name: string;
  description?: string | null;
};

/**
 * Does a product answer to a query? Case-insensitive, and every word must
 * appear in the name or description, in any order — the same AND rule the
 * server's name search applies. A blank query matches everything.
 */
export function matchesFinanceProduct(
  product: FinanceProductSearchFields,
  query: string,
): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = `${product.name} ${product.description ?? ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
