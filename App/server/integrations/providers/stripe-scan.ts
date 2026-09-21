/**
 * Internal consumers that select across an entire filtered list must either
 * finish its cursor chain or fail explicitly. A first-page selection is not
 * safe evidence for a commercial-value proposal.
 */
export async function readAllStripePages<T>(
  fetchPage: (startingAfter?: string) => Promise<unknown>,
  maxPages = 100,
): Promise<{ data: T[]; coverage: { complete: true; pages: number; rows: number } }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error("Invalid Stripe scan page bound.");
  const data: T[] = [];
  const seen = new Set<string>();
  let startingAfter: string | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(startingAfter) as {
      data?: Array<T & { id?: unknown }>;
      has_more?: unknown;
      nextStartingAfter?: unknown;
    } | null;
    if (!Array.isArray(result?.data) || result.data.length > 100 || typeof result.has_more !== "boolean" ||
        result.data.some((row) => !row || typeof row.id !== "string" || !row.id)) {
      throw new Error("Incomplete Stripe scan: a page did not provide valid rows and has_more coverage.");
    }
    for (const row of result.data) {
      const id = row.id as string;
      if (seen.has(id)) throw new Error("Incomplete Stripe scan: a repeated row made cursor progress ambiguous. Retry the scan.");
      seen.add(id);
      data.push(row);
    }
    if (!result.has_more) return { data, coverage: { complete: true, pages: page, rows: data.length } };
    const lastId = result.data.at(-1)?.id;
    if (typeof lastId !== "string" || result.nextStartingAfter !== lastId || lastId === startingAfter) {
      throw new Error("Incomplete Stripe scan: more rows were reported without a valid advancing cursor.");
    }
    startingAfter = lastId;
  }
  throw new Error(`Incomplete Stripe scan: the ${maxPages}-page safety bound was reached with rows remaining. No result was selected from partial coverage.`);
}
