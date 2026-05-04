/**
 * Money helpers shared by the finance services. We store all amounts as
 * integer minor units (cents) plus a 3-letter ISO 4217 currency code on
 * the row. Phase A treats every currency as 2-decimal — Phase E (multi-
 * currency) will handle 0/3-decimal currencies (JPY, JOD, BHD …) properly.
 *
 * Keep these helpers dependency-free — `services/finance.ts` and the
 * route layer both import them, and the printable invoice HTML uses
 * `formatMoney` to render line totals.
 */

export const DEFAULT_CURRENCY = "USD";

/** Round half-away-from-zero. JS `Math.round` rounds half-to-+inf, which
 *  rounds negative values incorrectly for accounting (e.g. -0.5 → 0 not -1).
 *  Cents-only math means we land on `.5` exactly when prices end in
 *  half-cents — rare in practice but worth getting right. */
export function roundHalfAway(value: number): number {
  return value >= 0
    ? Math.floor(value + 0.5)
    : -Math.floor(-value + 0.5);
}

export type LineInput = {
  quantity: number;
  unitPriceCents: number;
  taxPercent: number;
  taxInclusive: boolean;
};

export type LineTotals = {
  /** Ex-tax amount (subtotal). For inclusive-tax lines, this is the
   *  derived ex-tax portion of the gross. */
  lineSubtotalCents: number;
  lineTaxCents: number;
  /** Customer-facing total for the line (subtotal + tax for exclusive,
   *  or the gross for inclusive). */
  lineTotalCents: number;
};

/**
 * Compute the three cent-amount columns we persist on `InvoiceLineItem`.
 * Inclusive-tax math derives the tax portion from the gross
 * (`gross × rate / (100 + rate)`) so totals stay consistent regardless
 * of the inclusive/exclusive choice.
 */
export function computeLineTotals(input: LineInput): LineTotals {
  const gross = roundHalfAway(input.quantity * input.unitPriceCents);
  const rate = Number.isFinite(input.taxPercent) ? input.taxPercent : 0;
  if (rate <= 0) {
    return { lineSubtotalCents: gross, lineTaxCents: 0, lineTotalCents: gross };
  }
  if (input.taxInclusive) {
    const tax = roundHalfAway((gross * rate) / (100 + rate));
    return {
      lineSubtotalCents: gross - tax,
      lineTaxCents: tax,
      lineTotalCents: gross,
    };
  }
  const tax = roundHalfAway((gross * rate) / 100);
  return {
    lineSubtotalCents: gross,
    lineTaxCents: tax,
    lineTotalCents: gross + tax,
  };
}

/**
 * Format a cent amount for display. Browser formatting via Intl is fine
 * for both the React UI and the server-rendered printable invoice (Node
 * 22 has full Intl).
 */
export function formatMoney(cents: number, currency: string): string {
  const c = currency || DEFAULT_CURRENCY;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: c,
      currencyDisplay: "symbol",
    }).format(cents / 100);
  } catch {
    // Unknown currency code — fall back to plain numeric with the code suffix.
    return `${(cents / 100).toFixed(2)} ${c}`;
  }
}

/**
 * Display string for an invoice number — `INV-` prefix + zero-padded
 * sequence. Padding to 4 keeps small businesses tidy without forcing
 * 5-digit numbers on day one.
 */
export function formatInvoiceNumber(seq: number): string {
  return `INV-${String(seq).padStart(4, "0")}`;
}
