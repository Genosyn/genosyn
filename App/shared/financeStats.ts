/**
 * The figures Finance → Invoices and Finance → Estimates lead with, as the
 * server sends them (`services/invoiceStats.ts`, `services/estimateStats.ts`)
 * and the pages lay them out.
 *
 * Every amount is in `currency`, the company's home currency, in minor units.
 * Each set of documents behind a figure carries their ids, so a page can
 * filter its list to exactly the documents a figure counts.
 */

/** The documents behind one figure: how many, what they come to, and which. */
export type StatsDocuments = {
  count: number;
  /** In the home currency, minor units. */
  amountCents: number;
  /** The documents themselves, for a list to filter to. */
  ids: string[];
};

/** The customer that accounts for the most of a figure. */
export type StatsCustomer = StatsDocuments & { id: string; name: string; slug: string };

/** Days an outstanding invoice is past its due date, in the bands Finance ages receivables by. */
export type InvoiceAgeBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

/** Youngest first, the order the page draws them in. */
export const INVOICE_AGE_BUCKETS: readonly InvoiceAgeBucket[] = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "90+",
];

/** How far ahead "Due in the next 30 days" looks, today included. */
export const INVOICE_DUE_SOON_DAYS = 30;
/** The window "Paid in the last 30 days" sums, today included, and the one before it. */
export const INVOICE_PAID_DAYS = 30;
/** Invoices paid in full within this many days make up "Average days to pay". */
export const INVOICE_DAYS_TO_PAY_WINDOW = 90;

/** The band an outstanding invoice falls in, `daysLate` days past its due date. */
export function invoiceAgeBucket(daysLate: number): InvoiceAgeBucket {
  if (daysLate <= 0) return "current";
  if (daysLate <= 30) return "1-30";
  if (daysLate <= 60) return "31-60";
  if (daysLate <= 90) return "61-90";
  return "90+";
}

export type InvoiceStats = {
  /** The company's home currency. Every amount below is in it. */
  currency: string;
  /** The clock day boundaries were read on: the company's time zone, or the server's. */
  timeZone: string;
  /** Today on that clock, `YYYY-MM-DD`. */
  today: string;
  /** Invoices ever issued and not voided; with none, there is nothing to sum up. */
  issuedInvoices: number;
  /** What issued invoices still have due, after payments, credit and write-offs, tax included. */
  outstanding: StatsDocuments & { customers: number };
  /** `outstanding` by days past due, every band in order, empty ones included. */
  ageing: Array<StatsDocuments & { bucket: InvoiceAgeBucket }>;
  /** Outstanding invoices past their due date; the oldest is the longest overdue. */
  overdue: StatsDocuments & {
    oldest: { id: string; number: string; slug: string; daysLate: number } | null;
  };
  /** Outstanding invoices due today or within `days` days. */
  dueSoon: StatsDocuments & { days: number };
  /**
   * Payments dated within the last `days` days, today included, at each
   * payment's locked rate. `count` and `ids` are the invoices they paid;
   * `previousCents` is what came in over the `days` before that.
   */
  paid: StatsDocuments & { days: number; previousCents: number; previousCount: number };
  /**
   * Invoices paid in full whose last payment is dated within the last `days`
   * days: on average how many days that payment came after the issue date.
   */
  daysToPay: { days: number; averageDays: number | null; count: number; ids: string[] };
  /** The customer with the most outstanding, or null with nothing outstanding. */
  largestCustomer: StatsCustomer | null;
  /** Other currencies counted, each invoice and payment at its own locked rate. */
  converted: string[];
  /** Currencies with no rate into the home currency, left out of every figure. */
  unconverted: Array<{ currency: string; invoices: number }>;
};

/**
 * Where an estimate stands: invoiced, accepted, still open, or lost by
 * expiring or being declined. Won first and lost last, with the undecided in
 * the middle, the order the page draws them in.
 */
export type EstimateOutcome = "invoiced" | "accepted" | "open" | "expired" | "declined";

export const ESTIMATE_OUTCOMES: readonly EstimateOutcome[] = [
  "invoiced",
  "accepted",
  "open",
  "expired",
  "declined",
];

/** How far ahead "Expiring in 14 days" looks, today included. */
export const ESTIMATE_EXPIRING_DAYS = 14;
/** Estimates issued within this many days, today included, make up the recent figures. */
export const ESTIMATE_RECENT_DAYS = 90;

export type EstimateStats = {
  /** The company's home currency. Every amount below is in it. */
  currency: string;
  /** The clock day boundaries were read on: the company's time zone, or the server's. */
  timeZone: string;
  /** Today on that clock, `YYYY-MM-DD`. */
  today: string;
  /** Estimates ever issued and not voided; with none, there is nothing to sum up. */
  issuedEstimates: number;
  /** Sent estimates still valid and not yet accepted, declined or invoiced, tax included. */
  open: StatsDocuments & { customers: number };
  /** Open estimates whose valid-until date is today or within `days` days. */
  expiringSoon: StatsDocuments & { days: number; firstValidUntil: string | null };
  /** Accepted estimates not yet converted to an invoice; the oldest waited longest. */
  acceptedNotInvoiced: StatsDocuments & { oldestDaysWaiting: number | null };
  /** Estimates issued within the last `days` days, by where they stand now. */
  recent: {
    days: number;
    outcomes: Array<StatsDocuments & { outcome: EstimateOutcome }>;
    /** Of those decided (accepted, invoiced, declined or expired), how many were won. */
    acceptance: { accepted: number; decided: number; ids: string[] };
    /** Declined or expired. */
    lost: StatsDocuments & { declined: number; expired: number };
  };
  /** The customer with the most open, or null with nothing open. */
  largestCustomer: StatsCustomer | null;
  /** Other currencies counted, each estimate at the rate on file for its issue date. */
  converted: string[];
  /** Currencies with no rate into the home currency, left out of every figure. */
  unconverted: Array<{ currency: string; estimates: number }>;
};
