import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatScheduleTotal,
  hasScheduleTotal,
  summarizeScheduleInvoices,
  unlistedScheduleInvoices,
  type ScheduleInvoice,
} from "./recurringInvoiceHistory.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const PAST = "2026-10-01T09:00:00.000Z";
const FUTURE = "2026-11-01T09:00:00.000Z";

function invoice(overrides: Partial<ScheduleInvoice>): ScheduleInvoice {
  return {
    status: "sent",
    dueDate: FUTURE,
    currency: "USD",
    totalCents: 100_00,
    paidCents: 0,
    creditedCents: 0,
    writtenOffCents: 0,
    balanceCents: 100_00,
    ...overrides,
  };
}

describe("summarizeScheduleInvoices", () => {
  test("counts every invoice, bills only issued ones, and owes only what is still due", () => {
    const summary = summarizeScheduleInvoices(
      [
        invoice({ status: "draft" }),
        invoice({ status: "sent" }),
        invoice({ status: "sent", dueDate: PAST, paidCents: 40_00, balanceCents: 60_00 }),
        invoice({ status: "paid", paidCents: 100_00, balanceCents: 0 }),
        invoice({ status: "void", balanceCents: 0 }),
      ],
      "USD",
      NOW,
    );
    assert.equal(summary.count, 5);
    assert.equal(summary.drafts, 1);
    assert.equal(summary.overdue, 1);
    assert.deepEqual(summary.totals, [
      { currency: "USD", invoicedCents: 300_00, paidCents: 140_00, outstandingCents: 160_00 },
    ]);
  });

  test("a written-off or credited invoice was billed, but brought no cash and owes nothing", () => {
    const summary = summarizeScheduleInvoices(
      [
        invoice({ status: "paid", writtenOffCents: 100_00, balanceCents: 0, dueDate: PAST }),
        invoice({ status: "paid", creditedCents: 100_00, balanceCents: 0, dueDate: PAST }),
      ],
      "USD",
      NOW,
    );
    assert.equal(summary.overdue, 0);
    assert.deepEqual(summary.totals, [
      { currency: "USD", invoicedCents: 200_00, paidCents: 0, outstandingCents: 0 },
    ]);
  });

  test("never sums across currencies, and lists the schedule's own currency first", () => {
    const summary = summarizeScheduleInvoices(
      [
        invoice({ currency: "EUR", totalCents: 50_00, balanceCents: 50_00 }),
        invoice({ currency: "USD" }),
        invoice({ currency: "EUR", status: "paid", totalCents: 50_00, paidCents: 50_00, balanceCents: 0 }),
      ],
      "USD",
      NOW,
    );
    assert.deepEqual(
      summary.totals.map((row) => [row.currency, row.invoicedCents, row.outstandingCents]),
      [
        ["USD", 100_00, 100_00],
        ["EUR", 100_00, 50_00],
      ],
    );
    assert.equal(
      formatScheduleTotal(summary.totals, "invoicedCents", "USD"),
      "$100.00 · €100.00",
    );
  });

  test("only drafts so far is zero billed, in the schedule's currency", () => {
    const summary = summarizeScheduleInvoices([invoice({ status: "draft" })], "EUR", NOW);
    assert.deepEqual(summary.totals, []);
    assert.equal(formatScheduleTotal(summary.totals, "invoicedCents", "EUR"), "€0.00");
    assert.equal(hasScheduleTotal(summary.totals, "outstandingCents"), false);
  });

  test("an empty history is all zeros", () => {
    assert.deepEqual(summarizeScheduleInvoices([], "USD", NOW), {
      count: 0,
      drafts: 0,
      overdue: 0,
      totals: [],
    });
  });
});

describe("unlistedScheduleInvoices", () => {
  test("is what the run count holds beyond the list, never less than zero", () => {
    assert.equal(unlistedScheduleInvoices(5, 3), 2);
    assert.equal(unlistedScheduleInvoices(3, 3), 0);
    assert.equal(unlistedScheduleInvoices(0, 2), 0);
  });
});
