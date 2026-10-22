import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { anyLineTaxed, lineAmountCents, lineTaxLabel } from "../../shared/lineTax.js";
import type { Customer } from "../db/entities/Customer.js";
import type { Estimate } from "../db/entities/Estimate.js";
import type { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import type { Invoice } from "../db/entities/Invoice.js";
import type { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { computeLineTotals } from "../lib/money.js";
import { renderEstimateHtml } from "./estimateHtml.js";
import { renderInvoiceHtml } from "./invoiceHtml.js";

/** A line priced the way the finance services price it. */
function line(
  description: string,
  quantity: number,
  unitPriceCents: number,
  tax: { name: string; percent: number; inclusive?: boolean } | null = null,
) {
  const taxPercent = tax?.percent ?? 0;
  const taxInclusive = tax?.inclusive ?? false;
  return {
    description,
    quantity,
    unitPriceCents,
    taxName: tax?.name ?? "",
    taxPercent,
    taxInclusive,
    ...computeLineTotals({ quantity, unitPriceCents, taxPercent, taxInclusive }),
  };
}

const customer = { name: "Health Sciences North", email: "", billingAddress: "", taxNumber: "" } as Customer;

/** A sent document whose totals are the sum of its lines. */
function totalsOf(lines: ReturnType<typeof line>[]) {
  const subtotalCents = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const taxCents = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  return {
    currency: "USD",
    status: "sent",
    number: "HSN-INV-0001",
    issueDate: new Date("2026-10-01"),
    dueDate: new Date("2026-10-15"),
    validUntil: new Date("2026-10-31"),
    subtotalCents,
    discountCents: 0,
    discountPercent: 0,
    discountAmountCents: 0,
    taxCents,
    totalCents: subtotalCents + taxCents,
    paidCents: 0,
    balanceCents: subtotalCents + taxCents,
    notes: "",
    footer: "",
    issuerSnapshot: null,
  };
}

function invoiceHtml(lines: ReturnType<typeof line>[]) {
  return renderInvoiceHtml({
    invoice: totalsOf(lines) as unknown as Invoice,
    customer,
    lines: lines as InvoiceLineItem[],
    payments: [],
    companyName: "Elkrem Limited",
  });
}

/** The line table's header cells and its rows' cells, as text. */
function lineTable(html: string) {
  const head = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
  );
  return { head, rows };
}

describe("lineTaxLabel", () => {
  test("adds the rate to a name that doesn't state it", () => {
    assert.equal(lineTaxLabel({ taxName: "GST", taxPercent: 5, taxInclusive: false }), "GST 5%");
    assert.equal(lineTaxLabel({ taxName: "  ", taxPercent: 7.25, taxInclusive: false }), "Tax 7.25%");
  });

  test("says the rate once when the name already states it", () => {
    assert.equal(lineTaxLabel({ taxName: "CA HST 13%", taxPercent: 13, taxInclusive: false }), "CA HST 13%");
    assert.equal(lineTaxLabel({ taxName: "Sales tax 8.875 %", taxPercent: 8.875, taxInclusive: false }), "Sales tax 8.875 %");
    assert.equal(lineTaxLabel({ taxName: "MwSt 7,5%", taxPercent: 7.5, taxInclusive: false }), "MwSt 7,5%");
    // Postgres hands a 4-byte real back slightly off.
    assert.equal(lineTaxLabel({ taxName: "GST 6.35%", taxPercent: 6.349999904632568, taxInclusive: false }), "GST 6.35%");
    assert.equal(lineTaxLabel({ taxName: "GST", taxPercent: 6.349999904632568, taxInclusive: false }), "GST 6.35%");
  });

  test("a name stating another rate still shows the rate charged", () => {
    assert.equal(lineTaxLabel({ taxName: "VAT 20%", taxPercent: 5, taxInclusive: false }), "VAT 20% 5%");
    assert.equal(lineTaxLabel({ taxName: "Tax 113%", taxPercent: 13, taxInclusive: false }), "Tax 113% 13%");
  });

  test("an inclusive rate says so", () => {
    assert.equal(lineTaxLabel({ taxName: "VAT 20%", taxPercent: 20, taxInclusive: true }), "VAT 20% incl.");
  });
});

describe("lineAmountCents", () => {
  test("is quantity × unit price, with or without tax inside it", () => {
    assert.equal(lineAmountCents(line("Seats", 25, 22_800, { name: "CA HST 13%", percent: 13 })), 570_000);
    assert.equal(lineAmountCents(line("Seat", 1, 11_300, { name: "VAT", percent: 13, inclusive: true })), 11_300);
    assert.equal(lineAmountCents(line("Setup", 2, 5_000)), 10_000);
  });

  test("only taxed lines call for a Tax column", () => {
    assert.equal(anyLineTaxed([]), false);
    assert.equal(anyLineTaxed([line("Setup", 1, 5_000)]), false);
    assert.equal(anyLineTaxed([line("Setup", 1, 5_000), line("Seats", 1, 100, { name: "GST", percent: 5 })]), true);
  });
});

describe("printed documents", () => {
  test("a taxed invoice line shows its tax beside an amount of quantity × unit price", () => {
    const { head, rows } = lineTable(
      invoiceHtml([line("OneUptime Enterprise On Prem", 25, 22_800, { name: "CA HST 13%", percent: 13 })]),
    );
    assert.deepEqual(head, ["Description", "Qty", "Unit", "Tax", "Amount"]);
    assert.deepEqual(rows, [["OneUptime Enterprise On Prem", "25", "$228.00", "$741.00 CA HST 13%", "$5,700.00"]]);
  });

  test("an inclusive line keeps its tax inside its amount, and an untaxed line shows none", () => {
    const { rows } = lineTable(
      invoiceHtml([
        line("Licence", 1, 12_000, { name: "VAT 20%", percent: 20, inclusive: true }),
        line("Shipping", 1, 1_500),
      ]),
    );
    assert.deepEqual(rows, [
      ["Licence", "1", "$120.00", "$20.00 VAT 20% incl.", "$120.00"],
      ["Shipping", "1", "$15.00", "—", "$15.00"],
    ]);
  });

  test("an invoice with no tax keeps its four columns", () => {
    const { head, rows } = lineTable(invoiceHtml([line("Setup", 2, 5_000)]));
    assert.deepEqual(head, ["Description", "Qty", "Unit", "Amount"]);
    assert.deepEqual(rows, [["Setup", "2", "$50.00", "$100.00"]]);
  });

  test("an estimate lays out its taxed lines the same way", () => {
    const lines = [line("OneUptime Enterprise On Prem", 25, 22_800, { name: "CA HST 13%", percent: 13 })];
    const { head, rows } = lineTable(
      renderEstimateHtml({
        estimate: totalsOf(lines) as unknown as Estimate,
        customer,
        lines: lines as EstimateLineItem[],
        companyName: "Elkrem Limited",
      }),
    );
    assert.deepEqual(head, ["Description", "Qty", "Unit", "Tax", "Amount"]);
    assert.deepEqual(rows, [["OneUptime Enterprise On Prem", "25", "$228.00", "$741.00 CA HST 13%", "$5,700.00"]]);
  });
});
