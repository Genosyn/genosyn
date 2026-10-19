import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  discountDraftFrom,
  discountDraftProblem,
  discountFromDraft,
  NO_DISCOUNT_DRAFT,
  previewTotals,
} from "./discountForm.js";

describe("the discount box", () => {
  test("shows a saved discount the way it was entered", () => {
    assert.deepEqual(discountDraftFrom({ discountPercent: 12.5, discountAmountCents: 0 }), {
      mode: "percent",
      text: "12.5",
    });
    assert.deepEqual(discountDraftFrom({ discountPercent: 0, discountAmountCents: 25_000 }), {
      mode: "amount",
      text: "250.00",
    });
    assert.deepEqual(
      discountDraftFrom({ discountPercent: 0, discountAmountCents: 0 }),
      NO_DISCOUNT_DRAFT,
    );
  });

  test("saves what was typed, and nothing for an empty box", () => {
    assert.deepEqual(discountFromDraft({ mode: "percent", text: "10%" }), {
      discountPercent: 10,
      discountAmountCents: 0,
    });
    assert.deepEqual(discountFromDraft({ mode: "amount", text: "$1,250.50" }), {
      discountPercent: 0,
      discountAmountCents: 125_050,
    });
    assert.deepEqual(discountFromDraft({ mode: "percent", text: "" }), {
      discountPercent: 0,
      discountAmountCents: 0,
    });
    assert.deepEqual(discountFromDraft(NO_DISCOUNT_DRAFT), {
      discountPercent: 0,
      discountAmountCents: 0,
    });
  });

  test("says why a typed discount can't be saved", () => {
    assert.equal(discountDraftProblem({ mode: "percent", text: "15" }), null);
    assert.match(discountDraftProblem({ mode: "percent", text: "150" }) ?? "", /100/);
    assert.equal(discountDraftProblem({ mode: "none", text: "150" }), null);
  });
});

describe("previewTotals", () => {
  const vat = { id: "vat", ratePercent: 10, inclusive: false };

  test("shows the discount off the subtotal and the tax on what is left", () => {
    const totals = previewTotals(
      [
        { quantityText: "2", priceText: "500.00", taxRateId: "vat" },
        { quantityText: "1", priceText: "200.00", taxRateId: "" },
      ],
      [vat],
      { mode: "percent", text: "10" },
    );

    assert.deepEqual(totals, {
      subtotalCents: 108_000,
      discountCents: 12_000,
      taxCents: 9_000,
      totalCents: 117_000,
    });
  });

  test("with no discount the totals are the lines added up", () => {
    const totals = previewTotals(
      [{ quantityText: "1", priceText: "99.99", taxRateId: "vat" }],
      [vat],
      NO_DISCOUNT_DRAFT,
    );

    assert.deepEqual(totals, {
      subtotalCents: 9_999,
      discountCents: 0,
      taxCents: 1_000,
      totalCents: 10_999,
    });
  });
});
