import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  allocateCents,
  discountCentsFor,
  discountLabel,
  discountProblem,
  documentTotals,
  NO_DISCOUNT,
} from "../../shared/documentDiscount.js";
import { computeLineTotals } from "../lib/money.js";

/** A line priced the way the finance services price it. */
function line(quantity: number, unitPriceCents: number, taxPercent = 0, taxInclusive = false) {
  return {
    ...computeLineTotals({ quantity, unitPriceCents, taxPercent, taxInclusive }),
    taxPercent,
  };
}

describe("documentTotals", () => {
  test("with no discount it is exactly the sum of the lines, as before", () => {
    const lines = [line(2, 5_000, 10), line(1, 3_333, 20, true)];
    // A legacy row whose columns don't add up keeps adding up the old way.
    const legacy = { lineSubtotalCents: 0, lineTaxCents: 0, lineTotalCents: 25_000, taxPercent: 0 };

    assert.deepEqual(documentTotals([...lines, legacy], NO_DISCOUNT), {
      subtotalCents: 10_000 + 2_777,
      discountCents: 0,
      taxCents: 1_000 + 556,
      totalCents: 11_000 + 3_333 + 25_000,
    });
  });

  test("a percentage comes off before tax, and tax follows the discounted price", () => {
    const totals = documentTotals([line(1, 100_000, 10)], {
      discountPercent: 10,
      discountAmountCents: 0,
    });

    assert.deepEqual(totals, {
      subtotalCents: 90_000,
      discountCents: 10_000,
      taxCents: 9_000,
      totalCents: 99_000,
    });
  });

  test("each line's tax rate applies to its own share of the discount", () => {
    const totals = documentTotals([line(1, 60_000, 20), line(1, 40_000, 0)], {
      discountPercent: 0,
      discountAmountCents: 10_000,
    });

    // 6,000 off the taxed line and 4,000 off the untaxed one.
    assert.equal(totals.discountCents, 10_000);
    assert.equal(totals.subtotalCents, 90_000);
    assert.equal(totals.taxCents, 10_800);
    assert.equal(totals.totalCents, 100_800);
  });

  test("tax-inclusive lines are taxed on their discounted pre-tax amount", () => {
    // 1,100.00 including 10% tax is 1,000.00 plus 100.00 of tax.
    const totals = documentTotals([line(1, 110_000, 10, true)], {
      discountPercent: 50,
      discountAmountCents: 0,
    });

    assert.deepEqual(totals, {
      subtotalCents: 50_000,
      discountCents: 50_000,
      taxCents: 5_000,
      totalCents: 55_000,
    });
  });

  test("a fixed amount never takes more than the subtotal", () => {
    const totals = documentTotals([line(1, 5_000, 10)], {
      discountPercent: 0,
      discountAmountCents: 9_999_999,
    });

    assert.deepEqual(totals, {
      subtotalCents: 0,
      discountCents: 5_000,
      taxCents: 0,
      totalCents: 0,
    });
  });

  test("a line that already credits the customer takes no share", () => {
    const credit = line(1, -20_000);
    const totals = documentTotals([line(1, 100_000, 10), credit], {
      discountPercent: 10,
      discountAmountCents: 0,
    });

    // 10% of the 800.00 net subtotal, all of it from the charged line.
    assert.equal(totals.discountCents, 8_000);
    assert.equal(totals.subtotalCents, 72_000);
    assert.equal(totals.taxCents, 9_200);
    assert.equal(totals.totalCents, 81_200);
  });
});

describe("allocateCents", () => {
  test("splits exactly, giving leftover cents to the largest remainders", () => {
    assert.deepEqual(allocateCents(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(allocateCents(10, [3, 0, 7]), [3, 0, 7]);
    assert.deepEqual(allocateCents(0, [3, 7]), [0, 0]);
    assert.deepEqual(allocateCents(5, [0, 0]), [0, 0]);
    const shares = allocateCents(99_999, [12_345, 67_890, 1]);
    assert.equal(
      shares.reduce((s, x) => s + x, 0),
      99_999,
    );
  });
});

describe("discount rules", () => {
  test("a discount is a percentage or an amount, within range", () => {
    assert.equal(discountProblem(NO_DISCOUNT), null);
    assert.equal(discountProblem({ discountPercent: 12.5, discountAmountCents: 0 }), null);
    assert.equal(discountProblem({ discountPercent: 0, discountAmountCents: 500 }), null);
    assert.match(
      discountProblem({ discountPercent: 10, discountAmountCents: 500 }) ?? "",
      /not both/,
    );
    assert.match(discountProblem({ discountPercent: 101, discountAmountCents: 0 }) ?? "", /100/);
    assert.match(discountProblem({ discountPercent: -1, discountAmountCents: 0 }) ?? "", /100/);
    assert.match(discountProblem({ discountPercent: 0, discountAmountCents: 1.5 }) ?? "", /amount/);
  });

  test("the discount is rounded to the cent and labelled for the document", () => {
    assert.equal(discountCentsFor(333, { discountPercent: 50, discountAmountCents: 0 }), 167);
    assert.equal(discountCentsFor(-100, { discountPercent: 50, discountAmountCents: 0 }), 0);
    assert.equal(
      discountLabel({ discountPercent: 12.5, discountAmountCents: 0 }),
      "Discount (12.5%)",
    );
    assert.equal(discountLabel({ discountPercent: 0, discountAmountCents: 500 }), "Discount");
  });
});
