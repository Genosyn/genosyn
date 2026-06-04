import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import {
  InvoicePayment,
  type InvoicePaymentMethod,
} from "../db/entities/InvoicePayment.js";

/**
 * Customer statement (statement of account) builder. A statement is a
 * derived, point-in-time view over a customer's issued invoices and the
 * payments recorded against them — there is no `Statement` entity and
 * nothing is persisted. It answers the question an account manager or
 * the customer themselves asks: "what was charged, what was paid, and
 * what's still owed?"
 *
 * Shape: a chronological ledger of transactions (each issued invoice is a
 * charge, each payment a credit) with a running balance, bracketed by an
 * opening balance carried in from before the period and a closing balance.
 * Plus an aging summary of the outstanding amount as of the `to` date.
 *
 * Money: a statement is always scoped to a single `currency`. Summing a
 * running balance across currencies would be meaningless (the rest of the
 * Finance UI deliberately avoids it too), so when a customer has invoices
 * in more than one currency the caller picks which to render and the others
 * are surfaced via `availableCurrencies` for a switcher.
 *
 * Only `sent` / `paid` invoices count: drafts aren't real liabilities and
 * voids are reversed in the ledger, so neither belongs on a statement.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type StatementTxnKind = "invoice" | "payment";

export type StatementTxn = {
  /** ISO `yyyy-mm-dd` of the invoice issue date or the payment date. */
  date: string;
  kind: StatementTxnKind;
  /** Invoice number (e.g. `INV-0001`) for charges; payment method or its
   *  external reference for credits. */
  reference: string;
  description: string;
  /** Invoice slug so the UI can deep-link a row to its document. */
  invoiceSlug: string | null;
  /** Charge (debit) in minor units — `> 0` for invoices, `0` for payments. */
  chargeCents: number;
  /** Payment (credit) in minor units — `> 0` for payments, `0` for invoices. */
  paymentCents: number;
  /** Running balance after applying this transaction. */
  balanceCents: number;
};

/**
 * Outstanding balance as of the statement `to` date, bucketed by how long
 * each open invoice has been past due. `totalCents` equals the statement's
 * `closingBalanceCents`.
 */
export type StatementAging = {
  /** Open balance on invoices not yet past their due date. */
  currentCents: number;
  d1to30Cents: number;
  d31to60Cents: number;
  d61to90Cents: number;
  d90PlusCents: number;
  totalCents: number;
};

export type CustomerStatement = {
  currency: string;
  /** `null` when the statement has no lower bound ("all time"). */
  fromDate: string | null;
  toDate: string;
  /** Net balance carried in from transactions before `fromDate`. */
  openingBalanceCents: number;
  /** Net balance as of `toDate` — equals `aging.totalCents`. */
  closingBalanceCents: number;
  /** Invoices charged within the period. */
  totalChargesCents: number;
  /** Payments received within the period. */
  totalPaymentsCents: number;
  transactions: StatementTxn[];
  aging: StatementAging;
  /** Every currency the customer has issued invoices in, sorted — drives the
   *  currency switcher in the UI. */
  availableCurrencies: string[];
};

export type BuildStatementOpts = {
  /** Lower bound (inclusive). `null` / omitted = all history. */
  from?: Date | null;
  /** Upper bound (inclusive). Omitted = now. */
  to?: Date;
  /** Render currency. Falls back to the customer default, then to whatever
   *  the customer actually has invoices in. */
  currency?: string;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDayMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function endOfDayMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999);
}

const METHOD_LABELS: Record<InvoicePaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  stripe: "Stripe",
  lightning: "Lightning",
  other: "Payment",
};

function methodLabel(m: InvoicePaymentMethod): string {
  return METHOD_LABELS[m] ?? "Payment";
}

export async function buildCustomerStatement(
  companyId: string,
  customer: Customer,
  opts: BuildStatementOpts = {},
): Promise<CustomerStatement> {
  const invoices = await AppDataSource.getRepository(Invoice).find({
    where: {
      companyId,
      customerId: customer.id,
      status: In(["sent", "paid"]),
    },
  });

  const availableCurrencies = [...new Set(invoices.map((i) => i.currency))].sort();
  // Prefer the requested currency, then the customer default, then whatever
  // the customer has been billed in — so a statement is never empty just
  // because the default currency was never used.
  const currency =
    opts.currency && availableCurrencies.includes(opts.currency)
      ? opts.currency
      : availableCurrencies.includes(customer.currency)
        ? customer.currency
        : availableCurrencies[0] ?? customer.currency;

  const scoped = invoices.filter((i) => i.currency === currency);
  const invById = new Map(scoped.map((i) => [i.id, i]));
  const payments = scoped.length
    ? await AppDataSource.getRepository(InvoicePayment).find({
        where: { invoiceId: In(scoped.map((i) => i.id)) },
      })
    : [];

  const to = opts.to ?? new Date();
  const toMs = endOfDayMs(to);
  const from = opts.from ?? null;
  const fromMs = from ? startOfDayMs(from) : null;

  type Ev = {
    ms: number;
    txn: StatementTxn;
    /** Tiebreak within a day: an invoice posts before payments against it. */
    order: number;
  };
  const events: Ev[] = [];

  for (const inv of scoped) {
    const ms = inv.issueDate.getTime();
    if (ms > toMs) continue; // not yet issued as of `to`
    events.push({
      ms,
      order: 0,
      txn: {
        date: isoDay(inv.issueDate),
        kind: "invoice",
        reference: inv.number || "Draft",
        description: "Invoice issued",
        invoiceSlug: inv.slug,
        chargeCents: inv.totalCents,
        paymentCents: 0,
        balanceCents: 0,
      },
    });
  }

  for (const p of payments) {
    const ms = p.paidAt.getTime();
    if (ms > toMs) continue;
    const inv = invById.get(p.invoiceId);
    // Guard against the pathological case of a payment dated before its
    // invoice was issued-after-`to`: keep the statement self-consistent so
    // the running balance always reconciles with the aging total.
    if (inv && inv.issueDate.getTime() > toMs) continue;
    events.push({
      ms,
      order: 1,
      txn: {
        date: isoDay(p.paidAt),
        kind: "payment",
        reference: p.reference || methodLabel(p.method),
        description: inv?.number ? `Payment for ${inv.number}` : "Payment received",
        invoiceSlug: inv?.slug ?? null,
        chargeCents: 0,
        paymentCents: p.amountCents,
        balanceCents: 0,
      },
    });
  }

  events.sort((a, b) => a.ms - b.ms || a.order - b.order);

  // Net everything before `from` into the opening balance; the rest forms
  // the visible period.
  let openingBalanceCents = 0;
  let runningBalanceCents = 0;
  let totalChargesCents = 0;
  let totalPaymentsCents = 0;
  const transactions: StatementTxn[] = [];

  for (const ev of events) {
    const net = ev.txn.chargeCents - ev.txn.paymentCents;
    if (fromMs !== null && ev.ms < fromMs) {
      openingBalanceCents += net;
      continue;
    }
    runningBalanceCents =
      (transactions.length === 0 ? openingBalanceCents : runningBalanceCents) + net;
    totalChargesCents += ev.txn.chargeCents;
    totalPaymentsCents += ev.txn.paymentCents;
    transactions.push({ ...ev.txn, balanceCents: runningBalanceCents });
  }

  const closingBalanceCents = openingBalanceCents + totalChargesCents - totalPaymentsCents;

  // Aging is computed independently from each open invoice's balance as of
  // `to` (total minus payments dated on or before `to`), so it stays correct
  // for back-dated statements. Its total reconciles with the closing balance.
  const paidByInvoice = new Map<string, number>();
  for (const p of payments) {
    if (p.paidAt.getTime() <= toMs) {
      paidByInvoice.set(
        p.invoiceId,
        (paidByInvoice.get(p.invoiceId) ?? 0) + p.amountCents,
      );
    }
  }

  const aging: StatementAging = {
    currentCents: 0,
    d1to30Cents: 0,
    d31to60Cents: 0,
    d61to90Cents: 0,
    d90PlusCents: 0,
    totalCents: 0,
  };
  for (const inv of scoped) {
    if (inv.issueDate.getTime() > toMs) continue;
    const bal = inv.totalCents - (paidByInvoice.get(inv.id) ?? 0);
    if (bal <= 0) continue;
    const daysPastDue = Math.floor((toMs - endOfDayMs(inv.dueDate)) / DAY_MS);
    if (daysPastDue <= 0) aging.currentCents += bal;
    else if (daysPastDue <= 30) aging.d1to30Cents += bal;
    else if (daysPastDue <= 60) aging.d31to60Cents += bal;
    else if (daysPastDue <= 90) aging.d61to90Cents += bal;
    else aging.d90PlusCents += bal;
    aging.totalCents += bal;
  }

  return {
    currency,
    fromDate: from ? isoDay(from) : null,
    toDate: isoDay(to),
    openingBalanceCents,
    closingBalanceCents,
    totalChargesCents,
    totalPaymentsCents,
    transactions,
    aging,
    availableCurrencies,
  };
}
