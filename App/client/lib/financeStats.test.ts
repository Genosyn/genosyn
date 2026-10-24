import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { displayEstimateStatus, displayInvoiceStatus } from "./api.js";
import {
  acceptanceRate,
  ageLabel,
  ageViewKey,
  changeOnPrevious,
  companyToday,
  dayCount,
  ESTIMATE_OUTCOMES,
  estimateStatsView,
  headlineMoney,
  INVOICE_AGE_BUCKETS,
  invoiceStatsView,
  listOf,
  outcomeLabel,
  outcomeViewKey,
  parseEstimateStatsView,
  parseInvoiceStatsView,
  plural,
  rowsInView,
  sharePct,
  shortDay,
  type EstimateStats,
  type EstimateStatsViewKey,
  type InvoiceStats,
  type InvoiceStatsViewKey,
} from "./financeStats.js";

/**
 * The stats panels on Finance's lists: how their figures read, and which
 * documents each figure stands for when a click filters the list to it.
 */

const docs = (ids: string[], amountCents: number) => ({ count: ids.length, amountCents, ids });

const INVOICE_STATS: InvoiceStats = {
  currency: "USD",
  timeZone: "Europe/London",
  today: "2026-10-24",
  issuedInvoices: 9,
  outstanding: { ...docs(["a", "b", "c", "d", "e"], 980_000), customers: 3 },
  ageing: [
    { bucket: "current", ...docs(["a", "b"], 300_000) },
    { bucket: "1-30", ...docs(["c"], 200_000) },
    { bucket: "31-60", ...docs([], 0) },
    { bucket: "61-90", ...docs(["d"], 180_000) },
    { bucket: "90+", ...docs(["e"], 300_000) },
  ],
  overdue: {
    ...docs(["e", "d", "c"], 680_000),
    oldest: { id: "e", number: "ACME-INV-0001", slug: "acme-inv-0001", daysLate: 97 },
  },
  dueSoon: { ...docs(["a"], 100_000), days: 30 },
  paid: { ...docs(["f", "g"], 455_000), days: 30, previousCents: 350_000, previousCount: 1 },
  daysToPay: { days: 90, averageDays: 17.6, count: 2, ids: ["f", "g"] },
  largestCustomer: { id: "acme", name: "Acme Corp", slug: "acme-corp", ...docs(["d", "e"], 480_000) },
  converted: ["EUR"],
  unconverted: [],
};

const ESTIMATE_STATS: EstimateStats = {
  currency: "USD",
  timeZone: "Europe/London",
  today: "2026-10-24",
  issuedEstimates: 8,
  open: { ...docs(["o1", "o2"], 150_000), customers: 2 },
  expiringSoon: { ...docs(["o1"], 50_000), days: 14, firstValidUntil: "2026-10-30" },
  acceptedNotInvoiced: { ...docs(["a1"], 70_000), oldestDaysWaiting: 21 },
  recent: {
    days: 90,
    outcomes: [
      { outcome: "invoiced", ...docs(["i1"], 90_000) },
      { outcome: "accepted", ...docs(["a1"], 70_000) },
      { outcome: "open", ...docs(["o1"], 50_000) },
      { outcome: "expired", ...docs(["x1"], 20_000) },
      { outcome: "declined", ...docs(["d1", "d2"], 40_000) },
    ],
    acceptance: { accepted: 2, decided: 5, ids: ["i1", "a1", "x1", "d1", "d2"] },
    lost: { ...docs(["x1", "d1", "d2"], 60_000), declined: 2, expired: 1 },
  },
  largestCustomer: { id: "globex", name: "Globex", slug: "globex", ...docs(["o2"], 100_000) },
  converted: [],
  unconverted: [],
};

describe("formatting", () => {
  test("headline amounts drop cents from 1,000 up, and keep them below", () => {
    assert.equal(headlineMoney(23_783_200, "USD"), "$237,832");
    assert.equal(headlineMoney(99_999, "USD"), "$999.99");
    assert.equal(headlineMoney(100_000, "USD"), "$1,000");
    assert.equal(headlineMoney(0, "USD"), "$0");
    assert.equal(headlineMoney(-250_000, "USD"), "-$2,500");
    assert.equal(headlineMoney(123_456, "EUR"), "€1,235");
  });

  test("shares, plurals and lists read as a sentence would", () => {
    assert.equal(sharePct(480_000, 980_000), "49%");
    assert.equal(sharePct(1, 1_000), "<1%");
    assert.equal(sharePct(0, 1_000), "0%");
    assert.equal(sharePct(5, 0), "—");
    assert.equal(plural(1, "invoice"), "1 invoice");
    assert.equal(plural(3, "invoice"), "3 invoices");
    assert.equal(plural(2, "decided estimate"), "2 decided estimates");
    assert.equal(dayCount(1), "1 day");
    assert.equal(dayCount(18), "18 days");
    assert.equal(listOf(["EUR"]), "EUR");
    assert.equal(listOf(["EUR", "GBP"]), "EUR and GBP");
    assert.equal(listOf(["EUR", "GBP", "JPY"]), "EUR, GBP and JPY");
  });

  test("a calendar day reads short, with its year only when it isn't this year's", () => {
    assert.equal(shortDay("2026-10-30", "2026-10-24", "en-US"), "Oct 30");
    assert.equal(shortDay("2027-01-02", "2026-12-20", "en-US"), "Jan 2, 2027");
    // Calendar days are read in UTC, so no viewer's clock moves one.
    assert.equal(shortDay("2026-11-01", "2026-10-24", "en-US"), "Nov 1");
  });

  test("today is the date on the company's clock", () => {
    const evening = new Date("2026-10-24T20:00:00.000Z");
    assert.equal(companyToday("Asia/Singapore", evening), "2026-10-25");
    assert.equal(companyToday("America/Los_Angeles", evening), "2026-10-24");
  });

  test("cash received compares with the same span before it, in words", () => {
    assert.deepEqual(changeOnPrevious(455_000, 350_000, "30 days", "USD"), {
      direction: "up",
      text: "Up 30% on the 30 days before",
    });
    assert.deepEqual(changeOnPrevious(300_000, 400_000, "30 days", "USD"), {
      direction: "down",
      text: "Down 25% on the 30 days before",
    });
    assert.deepEqual(changeOnPrevious(100_000, 100_000, "30 days", "USD"), {
      direction: "same",
      text: "Same as the 30 days before",
    });
    assert.deepEqual(changeOnPrevious(100_001, 100_000, "30 days", "USD").text, "Up <1% on the 30 days before");
    assert.deepEqual(changeOnPrevious(5_000, 0, "30 days", "USD"), {
      direction: "none",
      text: "Nothing in the 30 days before",
    });
    assert.deepEqual(changeOnPrevious(0, 420_000, "30 days", "USD"), {
      direction: "none",
      text: "$4,200 in the 30 days before",
    });
    assert.deepEqual(changeOnPrevious(0, 0, "30 days", "USD"), {
      direction: "none",
      text: "No payments recorded",
    });
  });

  test("names every ageing band and estimate outcome", () => {
    assert.deepEqual(INVOICE_AGE_BUCKETS.map(ageLabel), [
      "Not yet due",
      "1–30 days",
      "31–60 days",
      "61–90 days",
      "90+ days",
    ]);
    assert.deepEqual(ESTIMATE_OUTCOMES.map(outcomeLabel), [
      "Invoiced",
      "Accepted",
      "Open",
      "Expired",
      "Declined",
    ]);
  });

  test("the acceptance rate is a whole percentage of those decided", () => {
    assert.equal(acceptanceRate(ESTIMATE_STATS.recent.acceptance), 40);
    assert.equal(acceptanceRate({ accepted: 2, decided: 3, ids: [] }), 67);
    assert.equal(acceptanceRate({ accepted: 0, decided: 0, ids: [] }), null);
  });
});

describe("invoice figures → list filters", () => {
  const expected: Array<[InvoiceStatsViewKey, string, string[]]> = [
    ["outstanding", "Outstanding", ["a", "b", "c", "d", "e"]],
    ["overdue", "Overdue", ["e", "d", "c"]],
    ["due-soon", "Due in the next 30 days", ["a"]],
    ["paid", "Paid in the last 30 days", ["f", "g"]],
    ["days-to-pay", "Paid in full in the last 90 days", ["f", "g"]],
    ["largest-customer", "Owed by Acme Corp", ["d", "e"]],
    ["age-current", "Not yet due", ["a", "b"]],
    ["age-1-30", "1–30 days overdue", ["c"]],
    ["age-31-60", "31–60 days overdue", []],
    ["age-61-90", "61–90 days overdue", ["d"]],
    ["age-over-90", "90+ days overdue", ["e"]],
  ];

  test("each tile and ageing band stands for exactly the invoices it counts", () => {
    for (const [key, label, ids] of expected) {
      const view = invoiceStatsView(INVOICE_STATS, key);
      assert.ok(view, key);
      assert.equal(view.key, key);
      assert.equal(view.label, label, key);
      assert.deepEqual([...view.ids].sort(), [...ids].sort(), key);
    }
  });

  test("an ageing band's key survives a query string", () => {
    for (const bucket of INVOICE_AGE_BUCKETS) {
      const key = ageViewKey(bucket);
      assert.match(key, /^[a-z0-9-]+$/, `${bucket} → ${key}`);
      const params = new URLSearchParams({ show: key });
      assert.equal(parseInvoiceStatsView(new URLSearchParams(params.toString()).get("show")), key);
    }
  });

  test("a link names a figure only if the Invoices list has it", () => {
    for (const [key] of expected) assert.equal(parseInvoiceStatsView(key), key);
    for (const junk of [null, "", "age-90+", "open", "OVERDUE", "overdue "]) {
      assert.equal(parseInvoiceStatsView(junk), null, String(junk));
    }
  });

  test("the largest customer stands for nothing once nobody owes anything", () => {
    assert.equal(
      invoiceStatsView({ ...INVOICE_STATS, largestCustomer: null }, "largest-customer"),
      null,
    );
  });

  test("filtering keeps the list's own order, archived rows included", () => {
    const rows = [
      { id: "g", archivedAt: "2026-10-20T00:00:00.000Z" },
      { id: "x", archivedAt: null },
      { id: "f", archivedAt: null },
    ];
    const view = invoiceStatsView(INVOICE_STATS, "paid")!;
    assert.deepEqual(
      rowsInView(rows, view).map((row) => row.id),
      ["g", "f"],
    );
  });
});

describe("estimate figures → list filters", () => {
  const expected: Array<[EstimateStatsViewKey, string, string[]]> = [
    ["open", "Open", ["o1", "o2"]],
    ["expiring", "Expiring in 14 days", ["o1"]],
    ["accepted", "Accepted, not yet invoiced", ["a1"]],
    ["acceptance", "Decided, issued in the last 90 days", ["i1", "a1", "x1", "d1", "d2"]],
    ["lost", "Declined or expired, issued in the last 90 days", ["x1", "d1", "d2"]],
    ["largest-customer", "Open with Globex", ["o2"]],
    ["recent-invoiced", "Invoiced, issued in the last 90 days", ["i1"]],
    ["recent-accepted", "Accepted, issued in the last 90 days", ["a1"]],
    ["recent-open", "Open, issued in the last 90 days", ["o1"]],
    ["recent-expired", "Expired, issued in the last 90 days", ["x1"]],
    ["recent-declined", "Declined, issued in the last 90 days", ["d1", "d2"]],
  ];

  test("each tile and outcome stands for exactly the estimates it counts", () => {
    for (const [key, label, ids] of expected) {
      const view = estimateStatsView(ESTIMATE_STATS, key);
      assert.ok(view, key);
      assert.equal(view.label, label, key);
      assert.deepEqual([...view.ids].sort(), [...ids].sort(), key);
    }
  });

  test("every outcome has a key a link can carry", () => {
    for (const outcome of ESTIMATE_OUTCOMES) {
      const key = outcomeViewKey(outcome);
      assert.equal(parseEstimateStatsView(key), key);
    }
    for (const junk of [null, "", "overdue", "recent-void", "recent-"]) {
      assert.equal(parseEstimateStatsView(junk), null, String(junk));
    }
  });

  test("the largest customer stands for nothing once nothing is open", () => {
    assert.equal(
      estimateStatsView({ ...ESTIMATE_STATS, largestCustomer: null }, "largest-customer"),
      null,
    );
  });
});

describe("displayed statuses on a calendar day", () => {
  const invoice = {
    status: "sent" as const,
    dueDate: "2026-10-24T00:00:00.000Z",
    paidCents: 0,
    writtenOffCents: 0,
    creditedCents: 0,
  };

  test("an invoice is due all of its due date, and overdue from the day after", () => {
    assert.equal(displayInvoiceStatus(invoice, undefined, "2026-10-24"), "sent");
    assert.equal(displayInvoiceStatus(invoice, undefined, "2026-10-25"), "overdue");
    assert.equal(displayInvoiceStatus(invoice, undefined, "2026-10-23"), "sent");
    assert.equal(
      displayInvoiceStatus({ ...invoice, status: "paid", paidCents: 0, creditedCents: 100 }, undefined, "2026-12-01"),
      "credited",
    );
  });

  test("without a day given, it reads the day of `now` on the viewer's clock", () => {
    const now = new Date("2026-10-24T12:00:00.000Z");
    assert.equal(displayInvoiceStatus(invoice, now), displayInvoiceStatus(invoice, now, companyToday(undefined, now)));
  });

  test("a sent estimate can be accepted all of its last day; an accepted one never expires", () => {
    const estimate = { status: "sent" as const, validUntil: "2026-10-24T00:00:00.000Z", invoiceId: null };
    assert.equal(displayEstimateStatus(estimate, undefined, "2026-10-24"), "sent");
    assert.equal(displayEstimateStatus(estimate, undefined, "2026-10-25"), "expired");
    assert.equal(
      displayEstimateStatus({ ...estimate, status: "accepted" }, undefined, "2027-01-01"),
      "accepted",
    );
    assert.equal(
      displayEstimateStatus({ ...estimate, invoiceId: "inv-1" }, undefined, "2027-01-01"),
      "invoiced",
    );
  });
});
