import assert from "node:assert/strict";
import test from "node:test";
import {
  computeLineTotals,
  formatEstimateNumber,
  formatInvoiceNumber,
  formatMoney,
  reconcilePartsToTotal,
  roundHalfAway,
} from "./money.js";

// ─────────────────────────── roundHalfAway ────────────────────────────

test("roundHalfAway rounds half away from zero on both sides of 0", () => {
  assert.equal(roundHalfAway(0), 0);
  assert.equal(roundHalfAway(0.5), 1);
  assert.equal(roundHalfAway(1.5), 2);
  assert.equal(roundHalfAway(2.5), 3);
  assert.equal(roundHalfAway(1.4), 1);
  assert.equal(roundHalfAway(1.6), 2);
  // The whole reason this helper exists: Math.round(-0.5) is -0, which
  // is wrong for accounting. Half-away-from-zero gives -1.
  assert.equal(roundHalfAway(-0.5), -1);
  assert.equal(roundHalfAway(-1.5), -2);
  assert.equal(roundHalfAway(-2.5), -3);
  assert.equal(roundHalfAway(-1.4), -1);
});

test("roundHalfAway is sign-symmetric: round(-x) === -round(x)", () => {
  for (const v of [0.5, 1.5, 2.5, 9.5, 100.5, 314.159, 999.5, 12345.5]) {
    assert.equal(roundHalfAway(-v), -roundHalfAway(v), `symmetry at ${v}`);
  }
});

// ────────────────────────── computeLineTotals ──────────────────────────

test("computeLineTotals: no tax leaves the gross untouched", () => {
  assert.deepEqual(
    computeLineTotals({ quantity: 3, unitPriceCents: 1000, taxPercent: 0, taxInclusive: false }),
    { lineSubtotalCents: 3000, lineTaxCents: 0, lineTotalCents: 3000 },
  );
  // A negative rate is treated as no tax, never as a rebate.
  assert.deepEqual(
    computeLineTotals({ quantity: 1, unitPriceCents: 5000, taxPercent: -10, taxInclusive: false }),
    { lineSubtotalCents: 5000, lineTaxCents: 0, lineTotalCents: 5000 },
  );
});

test("computeLineTotals: exclusive tax is added on top of the subtotal", () => {
  assert.deepEqual(
    computeLineTotals({ quantity: 1, unitPriceCents: 10000, taxPercent: 10, taxInclusive: false }),
    { lineSubtotalCents: 10000, lineTaxCents: 1000, lineTotalCents: 11000 },
  );
  assert.deepEqual(
    computeLineTotals({ quantity: 2, unitPriceCents: 2500, taxPercent: 8.5, taxInclusive: false }),
    { lineSubtotalCents: 5000, lineTaxCents: 425, lineTotalCents: 5425 },
  );
});

test("computeLineTotals: inclusive tax is carved out of the gross", () => {
  // $110.00 gross at 10% inclusive → $100.00 base + $10.00 tax.
  assert.deepEqual(
    computeLineTotals({ quantity: 1, unitPriceCents: 11000, taxPercent: 10, taxInclusive: true }),
    { lineSubtotalCents: 10000, lineTaxCents: 1000, lineTotalCents: 11000 },
  );
});

test("computeLineTotals: inclusive subtotal + tax always reconstitute the gross", () => {
  for (const gross of [1, 99, 100, 700, 999, 12345, 100000]) {
    for (const rate of [5, 7.5, 10, 13, 20, 23]) {
      const t = computeLineTotals({
        quantity: 1,
        unitPriceCents: gross,
        taxPercent: rate,
        taxInclusive: true,
      });
      assert.equal(
        t.lineSubtotalCents + t.lineTaxCents,
        t.lineTotalCents,
        `parts sum to gross at gross=${gross} rate=${rate}`,
      );
      assert.equal(t.lineTotalCents, gross, `gross preserved at gross=${gross} rate=${rate}`);
    }
  }
});

test("computeLineTotals: exclusive subtotal + tax always equal the total", () => {
  for (const qty of [1, 3, 7]) {
    for (const unit of [1, 333, 1099, 9999]) {
      for (const rate of [5, 7.25, 10, 15]) {
        const t = computeLineTotals({
          quantity: qty,
          unitPriceCents: unit,
          taxPercent: rate,
          taxInclusive: false,
        });
        assert.equal(t.lineSubtotalCents + t.lineTaxCents, t.lineTotalCents);
      }
    }
  }
});

test("computeLineTotals: fractional quantity rounds the gross half-away", () => {
  // 1.5 × 333 = 499.5 → 500 cents.
  const t = computeLineTotals({
    quantity: 1.5,
    unitPriceCents: 333,
    taxPercent: 0,
    taxInclusive: false,
  });
  assert.equal(t.lineSubtotalCents, 500);
  assert.equal(t.lineTotalCents, 500);
});

test("computeLineTotals: negative quantity (a credit line) keeps every column negative", () => {
  const t = computeLineTotals({
    quantity: -2,
    unitPriceCents: 5000,
    taxPercent: 10,
    taxInclusive: false,
  });
  assert.deepEqual(t, {
    lineSubtotalCents: -10000,
    lineTaxCents: -1000,
    lineTotalCents: -11000,
  });
});

test("computeLineTotals: non-finite tax percent is treated as zero", () => {
  const t = computeLineTotals({
    quantity: 1,
    unitPriceCents: 1000,
    taxPercent: Number.NaN,
    taxInclusive: false,
  });
  assert.deepEqual(t, { lineSubtotalCents: 1000, lineTaxCents: 0, lineTotalCents: 1000 });
});

// ────────────────────────── reconcilePartsToTotal ──────────────────────

test("reconcilePartsToTotal: leaves parts alone when they already sum to target", () => {
  assert.deepEqual(reconcilePartsToTotal(300, [100, 200]), [100, 200]);
});

test("reconcilePartsToTotal: absorbs the residual into the largest part", () => {
  // Revenue (1302) is bigger than tax (1302 tie → first wins); target 2605.
  assert.deepEqual(reconcilePartsToTotal(2605, [1302, 1302]), [1303, 1302]);
  // Clear largest: 5000 absorbs the -1 so tax (417) stays exact.
  assert.deepEqual(reconcilePartsToTotal(5416, [5000, 417]), [4999, 417]);
});

test("reconcilePartsToTotal: never touches the input array", () => {
  const parts = [10, 20, 30];
  const out = reconcilePartsToTotal(59, parts);
  assert.deepEqual(parts, [10, 20, 30]);
  assert.equal(out.reduce((s, p) => s + p, 0), 59);
});

test("reconcilePartsToTotal: empty parts return empty (caller anchors elsewhere)", () => {
  assert.deepEqual(reconcilePartsToTotal(100, []), []);
});

test("reconcilePartsToTotal: the output always sums to target across the FX drift space", () => {
  // This is the exact space that made postInvoiceIssue throw: convert each
  // column independently, then reconcile — the parts must land on the total.
  for (const rate of [1.08, 1.27, 1.34, 0.91, 1.11, 1.465]) {
    for (let sub = 100; sub <= 5000; sub += 137) {
      for (const pct of [5, 7.5, 8.25, 10, 13, 20]) {
        const tax = roundHalfAway((sub * pct) / 100);
        const total = sub + tax;
        const totalConv = roundHalfAway(total * rate);
        const parts = reconcilePartsToTotal(totalConv, [
          roundHalfAway(sub * rate),
          roundHalfAway(tax * rate),
        ]);
        assert.equal(
          parts.reduce((s, p) => s + p, 0),
          totalConv,
          `balanced at rate=${rate} sub=${sub} pct=${pct}`,
        );
      }
    }
  }
});

// ─────────────────────────────── formatMoney ───────────────────────────

test("formatMoney renders a symbol and two decimals for known currencies", () => {
  assert.equal(formatMoney(123456, "USD"), "$1,234.56");
  assert.equal(formatMoney(0, "USD"), "$0.00");
  assert.equal(formatMoney(-500, "USD"), "-$5.00");
  assert.equal(formatMoney(123456, "EUR"), "€1,234.56");
});

test("formatMoney falls back to a plain suffix for malformed currency codes", () => {
  // A two-letter code makes Intl throw; the helper degrades gracefully.
  assert.equal(formatMoney(12345, "US"), "123.45 US");
  assert.equal(formatMoney(12345, ""), "$123.45"); // empty → DEFAULT_CURRENCY (USD)
});

// ──────────────────────── document number formatting ───────────────────

test("formatInvoiceNumber zero-pads to four digits and uppercases the prefix", () => {
  assert.equal(formatInvoiceNumber(1), "INV-0001");
  assert.equal(formatInvoiceNumber(42), "INV-0042");
  assert.equal(formatInvoiceNumber(42, "acme-corp"), "ACME-CORP-INV-0042");
  // Sequences past 9999 keep growing rather than truncating.
  assert.equal(formatInvoiceNumber(12345), "INV-12345");
});

test("formatEstimateNumber mirrors the invoice numbering shape", () => {
  assert.equal(formatEstimateNumber(1), "EST-0001");
  assert.equal(formatEstimateNumber(7, "globex"), "GLOBEX-EST-0007");
});
