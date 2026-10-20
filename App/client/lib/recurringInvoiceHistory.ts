import { displayInvoiceStatus, formatMoney, type InvoiceListItem } from "./api";

/**
 * What a recurring invoice has billed so far, read from the invoices it
 * created — the summary on its page, kept out of the component so it can be
 * tested without a DOM. Money is never summed across currencies: a schedule
 * whose currency was changed keeps one total per currency, its own first.
 */

export type ScheduleInvoice = Pick<
  InvoiceListItem,
  | "status"
  | "dueDate"
  | "currency"
  | "totalCents"
  | "paidCents"
  | "creditedCents"
  | "writtenOffCents"
  | "balanceCents"
>;

export type ScheduleCurrencyTotals = {
  currency: string;
  /** Issued and not void: what customers were billed. */
  invoicedCents: number;
  /** Cash received against those invoices. */
  paidCents: number;
  /** Still owed on the issued invoices. */
  outstandingCents: number;
};

export type ScheduleInvoiceSummary = {
  /** Every invoice the schedule created that still exists, void included. */
  count: number;
  /** Not issued yet. */
  drafts: number;
  /** Issued and past due with a balance left. */
  overdue: number;
  totals: ScheduleCurrencyTotals[];
};

export type ScheduleTotalKey = "invoicedCents" | "paidCents" | "outstandingCents";

export function summarizeScheduleInvoices(
  invoices: ScheduleInvoice[],
  scheduleCurrency: string,
  now: Date = new Date(),
): ScheduleInvoiceSummary {
  const totals = new Map<string, ScheduleCurrencyTotals>();
  let drafts = 0;
  let overdue = 0;
  for (const invoice of invoices) {
    if (invoice.status === "draft") {
      drafts += 1;
      continue;
    }
    if (invoice.status === "void") continue;
    if (displayInvoiceStatus(invoice, now) === "overdue") overdue += 1;
    const row = totals.get(invoice.currency) ?? {
      currency: invoice.currency,
      invoicedCents: 0,
      paidCents: 0,
      outstandingCents: 0,
    };
    row.invoicedCents += invoice.totalCents;
    row.paidCents += invoice.paidCents;
    if (invoice.status === "sent") row.outstandingCents += Math.max(0, invoice.balanceCents);
    totals.set(invoice.currency, row);
  }
  const ordered = [...totals.values()].sort(
    (a, b) => Number(b.currency === scheduleCurrency) - Number(a.currency === scheduleCurrency),
  );
  return { count: invoices.length, drafts, overdue, totals: ordered };
}

/** One total, per currency — "$1,200.00 · €300.00" — or zero in the schedule's. */
export function formatScheduleTotal(
  totals: ScheduleCurrencyTotals[],
  key: ScheduleTotalKey,
  scheduleCurrency: string,
): string {
  if (totals.length === 0) return formatMoney(0, scheduleCurrency);
  return totals.map((row) => formatMoney(row[key], row.currency)).join(" · ");
}

/** Whether anything in this total is more than zero, in any currency. */
export function hasScheduleTotal(totals: ScheduleCurrencyTotals[], key: ScheduleTotalKey): boolean {
  return totals.some((row) => row[key] > 0);
}

/**
 * How many invoices the schedule's run count includes that its list cannot
 * show: drafts someone deleted, and invoices it created before invoices
 * recorded their schedule.
 */
export function unlistedScheduleInvoices(runsCreated: number, listed: number): number {
  return Math.max(0, runsCreated - listed);
}
