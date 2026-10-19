/**
 * A discount on a whole estimate or invoice: a percentage or a fixed amount,
 * taken off before tax. Shared by the server, which stores the totals this
 * produces, and the edit forms, which preview them.
 *
 * Lines are never rewritten. Each keeps its own undiscounted amounts, so a
 * line still reads quantity × unit price. The discount is spread across the
 * lines in proportion to their pre-tax amounts only to work out the tax on
 * what is actually charged, since tax is due on the discounted price.
 *
 * The document's `subtotalCents` is what is charged before tax — the lines'
 * subtotal less the discount — so `subtotal + tax = total` holds with or
 * without one, and revenue stays the subtotal.
 */

/** Percentage or fixed amount; at most one is above zero. */
export type DocumentDiscount = {
  /** 0–100. Zero when the discount is a fixed amount, or there is none. */
  discountPercent: number;
  /** Pre-tax minor units. Zero when the discount is a percentage, or there is none. */
  discountAmountCents: number;
};

/** The saved amounts of one line, before any discount. */
export type DiscountableLine = {
  lineSubtotalCents: number;
  lineTaxCents: number;
  lineTotalCents: number;
  taxPercent: number;
};

export type DocumentTotals = {
  /** Pre-tax amount charged: the lines' subtotal less the discount. */
  subtotalCents: number;
  /** The discount actually taken, pre-tax. Never more than the lines' subtotal. */
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

export const NO_DISCOUNT: DocumentDiscount = { discountPercent: 0, discountAmountCents: 0 };

/** Half away from zero, the rounding the finance services use for cents. */
function roundHalfAway(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
}

/**
 * Why a requested discount can't be saved, or null when it can. A discount is
 * a percentage from 0 to 100 or a whole number of cents, never both.
 */
export function discountProblem(discount: DocumentDiscount): string | null {
  const { discountPercent: percent, discountAmountCents: amount } = discount;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return "A discount percentage must be between 0 and 100.";
  }
  if (!Number.isInteger(amount) || amount < 0) {
    return "A discount amount must be zero or more.";
  }
  if (percent > 0 && amount > 0) {
    return "Choose a percentage or an amount for the discount, not both.";
  }
  return null;
}

/** The discount taken from a pre-tax `baseCents`, capped at the base. */
export function discountCentsFor(baseCents: number, discount: DocumentDiscount): number {
  if (baseCents <= 0) return 0;
  if (discount.discountPercent > 0) {
    return Math.min(baseCents, roundHalfAway((baseCents * discount.discountPercent) / 100));
  }
  if (discount.discountAmountCents > 0) {
    return Math.min(baseCents, Math.trunc(discount.discountAmountCents));
  }
  return 0;
}

/**
 * Split `total` across non-negative `weights` in proportion, exactly: the
 * shares always sum to `total`, and the cents rounding leaves behind go to
 * the largest remainders first.
 */
export function allocateCents(total: number, weights: ReadonlyArray<number>): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const shares = exact.map((x) => Math.floor(x));
  let left = total - shares.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

/**
 * A document's totals from its saved lines and its discount. With no
 * discount this is exactly the sum of the lines, as it always was.
 */
export function documentTotals(
  lines: ReadonlyArray<DiscountableLine>,
  discount: DocumentDiscount,
): DocumentTotals {
  const base = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const discountCents = discountCentsFor(base, discount);
  if (discountCents === 0) {
    return {
      subtotalCents: base,
      discountCents: 0,
      taxCents: lines.reduce((s, l) => s + l.lineTaxCents, 0),
      totalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0),
    };
  }
  // A line that already credits the customer takes no share of the discount.
  const shares = allocateCents(
    discountCents,
    lines.map((l) => Math.max(l.lineSubtotalCents, 0)),
  );
  const taxCents = lines.reduce(
    (s, l, i) =>
      s +
      (shares[i] === 0
        ? l.lineTaxCents
        : roundHalfAway(((l.lineSubtotalCents - shares[i]) * l.taxPercent) / 100)),
    0,
  );
  const subtotalCents = base - discountCents;
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** "Discount (10%)" for a percentage, "Discount" for a fixed amount. */
export function discountLabel(discount: DocumentDiscount): string {
  if (discount.discountPercent > 0) {
    return `Discount (${Number(discount.discountPercent.toFixed(2))}%)`;
  }
  return "Discount";
}
