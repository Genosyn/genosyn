/**
 * How a line's tax reads on an invoice, estimate or bill. Shared by the
 * printed documents and the detail pages so they always agree.
 *
 * A line shows its tax beside its amount instead of folding it in, so the
 * amount still reads quantity × unit price and the tax can be checked line
 * by line against the totals below.
 */

/** The tax a finance line snapshots from its rate, and what it comes to. */
export type TaxedLine = {
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
  lineTaxCents: number;
  lineTotalCents: number;
};

/** Whether any line is taxed, which is when a document shows a Tax column. */
export function anyLineTaxed(lines: ReadonlyArray<Pick<TaxedLine, "taxPercent">>): boolean {
  return lines.some((l) => l.taxPercent > 0);
}

/**
 * The line's amount: quantity × unit price. Tax on an exclusive rate is added
 * on top of it, while an inclusive rate's tax is already inside it.
 */
export function lineAmountCents(
  line: Pick<TaxedLine, "taxInclusive" | "lineTaxCents" | "lineTotalCents">,
): number {
  return line.taxInclusive ? line.lineTotalCents : line.lineTotalCents - line.lineTaxCents;
}

/**
 * The rate's name and percentage, e.g. "CA HST 13%". A name that already
 * states its percentage ("VAT 20%") keeps it once rather than reading
 * "VAT 20% 20%". An inclusive rate adds "incl.", since its tax is inside the
 * line's amount rather than added to it.
 */
export function lineTaxLabel(line: Pick<TaxedLine, "taxName" | "taxPercent" | "taxInclusive">): string {
  const name = line.taxName.trim() || "Tax";
  const label = statesPercent(name, line.taxPercent)
    ? name
    : `${name} ${Number(line.taxPercent.toFixed(4))}%`;
  return line.taxInclusive ? `${label} incl.` : label;
}

/** Whether `name` already says `percent`, written as "13%", "13 %" or "7,25%". */
function statesPercent(name: string, percent: number): boolean {
  for (const match of name.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    // Postgres keeps the rate as a 4-byte real, so compare loosely.
    if (Math.abs(Number(match[1].replace(",", ".")) - percent) < 1e-4) return true;
  }
  return false;
}
