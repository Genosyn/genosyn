import { In, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import {
  addDays,
  clockName,
  dayOf,
  dayStart,
  daysBetween,
  documentDay,
} from "../../shared/documentDays.js";
import {
  INVOICE_AGE_BUCKETS,
  INVOICE_DAYS_TO_PAY_WINDOW,
  INVOICE_DUE_SOON_DAYS,
  INVOICE_PAID_DAYS,
  invoiceAgeBucket,
  type InvoiceAgeBucket,
  type InvoiceStats,
  type StatsDocuments,
} from "../../shared/financeStats.js";
import { companyTimeZone } from "./companyTimeZone.js";
import {
  addDocument,
  currencyOf,
  emptyDocuments,
  largestCustomer,
  LeftOut,
} from "./financeStatsShared.js";
import { convertAtRate, invoiceBookedRate, rateHistory } from "./fx.js";
import { getReportingCurrency } from "./revenue/revenueData.js";

/**
 * The figures Finance → Invoices leads with: what customers still owe, how
 * late it is, what came in lately, and how long customers take to pay.
 *
 * - **Outstanding is what is still due, not what was billed.** An issued
 *   invoice's balance — its total less payments, partial ones included,
 *   credit applied and amounts written off (`Invoice.balanceCents`) — tax
 *   included, because the customer owes the tax too. Drafts owe nothing yet
 *   and a voided invoice owes nothing at all. An archived invoice never has a
 *   balance: only a settled one can be archived, and one owed money again
 *   comes back to the lists by itself.
 * - **One currency, at the rate each document was booked at.** Every amount
 *   is in the home currency: an invoice's balance at the rate it locked when
 *   it was issued, a payment at the rate it locked the day it was paid
 *   (#115's locked rates, read the way `services/fx.ts` reads them for
 *   documents from before the lock). A currency no rate can be found for is
 *   left out and named rather than added at face value.
 * - **Days are the company's.** A document's dates are calendar days
 *   (`shared/documentDays.ts`); today is the date on the company's clock
 *   (`Company.timezone`, server time without one). An invoice is overdue from
 *   the day after its due date, and the 30-day windows run to the end of today.
 * - **Cash already received still counts after it is filed.** "Paid in the
 *   last 30 days" and "Average days to pay" include archived invoices:
 *   archiving files a settled invoice away, but the money it brought in came.
 *
 * Reads only, through indexes that bound the rows to the company's issued
 * invoices: `(companyId, status)` on invoices and `invoiceId` on payments.
 */

const UNCONVERTED = null;
type Rate = number | typeof UNCONVERTED;

type OpenInvoice = Pick<
  Invoice,
  | "id"
  | "companyId"
  | "number"
  | "slug"
  | "customerId"
  | "currency"
  | "exchangeRate"
  | "issueDate"
  | "dueDate"
  | "balanceCents"
>;

type PaidInvoice = Pick<
  Invoice,
  "id" | "companyId" | "currency" | "issueDate" | "status" | "paidCents"
>;

export async function invoiceStats(
  companyId: string,
  now: Date = new Date(),
): Promise<InvoiceStats> {
  const home = (await getReportingCurrency(companyId)).toUpperCase();
  const zone = await companyTimeZone(companyId);
  const today = dayOf(now, zone);
  const invoices = AppDataSource.getRepository(Invoice);
  const leftOut = new LeftOut();
  const converted = new Set<string>();

  const issuedInvoices = await invoices.count({
    where: { companyId, status: In(["sent", "paid"]) },
  });

  // ── Outstanding ───────────────────────────────────────────────────────
  // A paid invoice is settled by definition, so whatever is still due sits on
  // a sent one.
  const open: OpenInvoice[] = await invoices.find({
    where: { companyId, status: "sent", balanceCents: MoreThan(0) },
    select: [
      "id",
      "companyId",
      "number",
      "slug",
      "customerId",
      "currency",
      "exchangeRate",
      "issueDate",
      "dueDate",
      "balanceCents",
    ],
  });
  // Oldest due date first, so every list of ids reads most urgent first.
  open.sort(
    (a, b) =>
      a.dueDate.getTime() - b.dueDate.getTime() ||
      a.number.localeCompare(b.number) ||
      a.id.localeCompare(b.id),
  );

  const outstanding = emptyDocuments();
  const ageing = new Map<InvoiceAgeBucket, StatsDocuments>(
    INVOICE_AGE_BUCKETS.map((bucket) => [bucket, emptyDocuments()]),
  );
  const overdue = emptyDocuments();
  let oldest: InvoiceStats["overdue"]["oldest"] = null;
  const dueSoon = emptyDocuments();
  const byCustomer = new Map<string, StatsDocuments>();

  for (const invoice of open) {
    const code = currencyOf(invoice.currency, home);
    const rate = await bookedRate(invoice, code, home);
    if (rate === UNCONVERTED) {
      leftOut.add(code, invoice.id);
      continue;
    }
    if (code !== home) converted.add(code);
    const amount = convertAtRate(invoice.balanceCents, rate);
    addDocument(outstanding, invoice.id, amount);

    const daysLate = daysBetween(documentDay(invoice.dueDate), today);
    addDocument(ageing.get(invoiceAgeBucket(daysLate))!, invoice.id, amount);
    if (daysLate > 0) {
      addDocument(overdue, invoice.id, amount);
      // Sorted by due date, so the first overdue invoice is the oldest.
      oldest ??= { id: invoice.id, number: invoice.number, slug: invoice.slug, daysLate };
    } else if (-daysLate <= INVOICE_DUE_SOON_DAYS) {
      addDocument(dueSoon, invoice.id, amount);
    }

    const customer = byCustomer.get(invoice.customerId) ?? emptyDocuments();
    addDocument(customer, invoice.id, amount);
    byCustomer.set(invoice.customerId, customer);
  }

  // ── Payments ──────────────────────────────────────────────────────────
  // One read covers both 30-day windows and the 90 days "days to pay" looks
  // back over: the payments dated in them, on the company's issued invoices.
  const paidFrom = addDays(today, -(INVOICE_PAID_DAYS - 1));
  const previousFrom = addDays(today, -(2 * INVOICE_PAID_DAYS - 1));
  const daysToPayFrom = addDays(today, -(INVOICE_DAYS_TO_PAY_WINDOW - 1));
  const windowFrom = previousFrom < daysToPayFrom ? previousFrom : daysToPayFrom;

  const payments = await AppDataSource.getRepository(InvoicePayment)
    .createQueryBuilder("p")
    .innerJoin(Invoice, "i", "CAST(i.id AS text) = p.invoiceId")
    .where("i.companyId = :companyId", { companyId })
    .andWhere("i.status IN (:...issued)", { issued: ["sent", "paid"] })
    .andWhere("p.paidAt >= :windowFrom", { windowFrom: dayStart(windowFrom) })
    .andWhere("p.paidAt < :windowUntil", { windowUntil: dayStart(addDays(today, 1)) })
    .getMany();
  // Oldest payment first, so the invoices read in the order the cash came in.
  payments.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.id.localeCompare(b.id));
  const paidIds = [...new Set(payments.map((payment) => payment.invoiceId))];
  const paidInvoices: PaidInvoice[] = paidIds.length
    ? await invoices.find({
        where: { id: In(paidIds), companyId },
        select: ["id", "companyId", "currency", "issueDate", "status", "paidCents"],
      })
    : [];
  const paidInvoiceById = new Map(paidInvoices.map((invoice) => [invoice.id, invoice]));

  const paymentRate = paymentRates(companyId, home, dayStart(addDays(today, 1)));
  const paid = emptyDocuments();
  const paidInto = new Set<string>();
  let previousCents = 0;
  const previousInvoices = new Set<string>();
  for (const payment of payments) {
    const invoice = paidInvoiceById.get(payment.invoiceId);
    const day = documentDay(payment.paidAt);
    if (!invoice || day < previousFrom) continue;
    const code = currencyOf(invoice.currency, home);
    const rate = await paymentRate(payment, code);
    if (rate === UNCONVERTED) {
      leftOut.add(code, invoice.id);
      continue;
    }
    if (code !== home) converted.add(code);
    const amount = convertAtRate(payment.amountCents, rate);
    if (day >= paidFrom) {
      paid.amountCents += amount;
      if (!paidInto.has(invoice.id)) {
        paidInto.add(invoice.id);
        paid.ids.push(invoice.id);
      }
    } else {
      previousCents += amount;
      previousInvoices.add(invoice.id);
    }
  }
  paid.count = paid.ids.length;

  return {
    currency: home,
    timeZone: clockName(zone),
    today,
    issuedInvoices,
    outstanding: { ...outstanding, customers: byCustomer.size },
    ageing: INVOICE_AGE_BUCKETS.map((bucket) => ({ bucket, ...ageing.get(bucket)! })),
    overdue: { ...overdue, oldest },
    dueSoon: { ...dueSoon, days: INVOICE_DUE_SOON_DAYS },
    paid: {
      ...paid,
      days: INVOICE_PAID_DAYS,
      previousCents,
      previousCount: previousInvoices.size,
    },
    daysToPay: await averageDaysToPay(paidInvoices, payments, daysToPayFrom, today),
    largestCustomer: await largestCustomer(companyId, byCustomer),
    converted: [...converted].sort(),
    unconverted: leftOut
      .list()
      .map(({ currency, documents }) => ({ currency, invoices: documents })),
  };
}

/**
 * The rate an issued invoice was booked at, into the home currency: the one
 * it locked when issued, or for an invoice from before rates were locked the
 * one its issue entry used (`invoiceBookedRate`). Null when neither exists
 * and no rate is on file for its issue date.
 */
async function bookedRate(invoice: OpenInvoice, code: string, home: string): Promise<Rate> {
  if (code === home) return 1;
  if (invoice.exchangeRate && invoice.exchangeRate > 0) return invoice.exchangeRate;
  try {
    return await invoiceBookedRate({ ...invoice, currency: code }, home);
  } catch {
    return UNCONVERTED;
  }
}

/**
 * The rate a payment brought its cash in at: the one it locked the day it was
 * paid, or the rate on file for that day for a payment from before the lock.
 * A currency's rates are read once for those (`rateHistory`), however many
 * days the payments span.
 */
function paymentRates(
  companyId: string,
  home: string,
  until: Date,
): (payment: InvoicePayment, code: string) => Promise<Rate> {
  const histories = new Map<string, Promise<(date: Date) => number | null>>();
  return async (payment, code) => {
    if (code === home) return 1;
    if (payment.exchangeRate && payment.exchangeRate > 0) return payment.exchangeRate;
    let history = histories.get(code);
    if (!history) {
      history = rateHistory(companyId, code, home, until);
      histories.set(code, history);
    }
    return (await history)(payment.paidAt) ?? UNCONVERTED;
  };
}

/**
 * How many days after its issue date an invoice paid in full received its
 * last payment, averaged over the invoices whose last payment falls in the
 * window. Paid in full means in cash, at least in part: an invoice cleared
 * only by credit or a write-off was never paid. An invoice the window's
 * payments paid off may hold a later payment, dated after today, which is
 * then its last, so its payments are read in full.
 */
async function averageDaysToPay(
  paidInvoices: PaidInvoice[],
  windowPayments: InvoicePayment[],
  from: string,
  today: string,
): Promise<InvoiceStats["daysToPay"]> {
  const inWindow = new Set(
    windowPayments
      .filter((payment) => documentDay(payment.paidAt) >= from)
      .map((payment) => payment.invoiceId),
  );
  const candidates = paidInvoices.filter(
    (invoice) => invoice.status === "paid" && invoice.paidCents > 0 && inWindow.has(invoice.id),
  );
  const lastPaid = new Map<string, Date>();
  if (candidates.length) {
    const all = await AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: In(candidates.map((invoice) => invoice.id)) },
      select: ["id", "invoiceId", "paidAt"],
    });
    for (const payment of all) {
      const seen = lastPaid.get(payment.invoiceId);
      if (!seen || payment.paidAt.getTime() > seen.getTime()) {
        lastPaid.set(payment.invoiceId, payment.paidAt);
      }
    }
  }
  const counted: Array<{ id: string; days: number; paidOn: string }> = [];
  for (const invoice of candidates) {
    const last = lastPaid.get(invoice.id);
    if (!last) continue;
    const paidOn = documentDay(last);
    if (paidOn < from || paidOn > today) continue;
    counted.push({
      id: invoice.id,
      // A payment dated before the invoice counts as paid the day it was issued.
      days: Math.max(0, daysBetween(documentDay(invoice.issueDate), paidOn)),
      paidOn,
    });
  }
  counted.sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.id.localeCompare(b.id));
  const total = counted.reduce((sum, row) => sum + row.days, 0);
  return {
    days: INVOICE_DAYS_TO_PAY_WINDOW,
    averageDays: counted.length ? Math.round((total / counted.length) * 10) / 10 : null,
    count: counted.length,
    ids: counted.map((row) => row.id),
  };
}
