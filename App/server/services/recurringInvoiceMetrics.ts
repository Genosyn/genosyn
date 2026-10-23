import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import {
  RecurringInvoice,
  type RecurringInvoiceFrequency,
} from "../db/entities/RecurringInvoice.js";
import { roundHalfAway } from "../lib/money.js";
import { lookupRate } from "./fx.js";
import {
  computeNextRun,
  hydrateRecurringInvoices,
  type HydratedRecurringInvoice,
} from "./recurringInvoices.js";
import { annualCentsForSchedule, getReportingCurrency } from "./revenue/revenueData.js";

/**
 * The recurring revenue Finance → Recurring invoices leads with: what the
 * schedules bring in over a year, what they bill next, and what is paused or
 * about to stop.
 *
 * - **ARR is the active schedules' run rate.** Each schedule's amount per
 *   invoice, before tax and after its discount, annualized by its cadence
 *   (`annualCentsForSchedule`, the reading Revenue's MRR uses). Tax is
 *   collected for a government, so it is no part of revenue. A paused
 *   schedule bills nobody; its revenue is reported apart, as on hold.
 * - **What bills next is what the invoices will total**, tax included: the
 *   amount each schedule's list row shows, once for every run due in the
 *   window, counted the way the heartbeat will bill them.
 * - **One currency.** Every figure is in the company's home currency, a
 *   schedule in another currency converted at the latest exchange rate on
 *   file. A currency with no rate is left out of every figure and named,
 *   rather than added in at face value.
 * - **Only schedules that can bill count.** A schedule whose customer row is
 *   gone cannot create an invoice, and one whose cadence can't be read has no
 *   run rate; both are skipped, as Revenue skips them.
 *
 * Reads only: opening the page must not create the settings row
 * `getFinanceSettings` would.
 */

/** How far ahead the "next 30 days" figure looks. */
export const UPCOMING_DAYS = 30;
/** A schedule that stops billing within this many days is ending soon. */
export const ENDING_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_PER_YEAR = 12;
/** More runs than a daily schedule has in `ENDING_DAYS`, so the walk always ends. */
const MAX_RUNS_WALKED = 400;

/** Shortest period first, the order the page draws them in. */
const CADENCE_ORDER: readonly RecurringInvoiceFrequency[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

export type RecurringRevenueMetrics = {
  /** The company's home currency. Every amount below is in it. */
  currency: string;
  arrCents: number;
  /** `arrCents` over twelve months. */
  mrrCents: number;
  activeSchedules: number;
  /** Distinct customers the active schedules bill. */
  activeCustomers: number;
  /** ARR by billing cadence, shortest period first; cadences with no active schedule left out. */
  cadences: Array<{ frequency: RecurringInvoiceFrequency; schedules: number; arrCents: number }>;
  /** The customer with the most ARR, or null when no active schedule earns any. */
  largestCustomer: { id: string; name: string; slug: string; arrCents: number } | null;
  /** The invoices the active schedules create over the next `days`, tax included. */
  upcoming: { days: number; invoices: number; totalCents: number };
  /** Paused schedules that are not archived, and the ARR they would bring if resumed. */
  paused: { schedules: number; arrCents: number };
  /**
   * Active schedules that stop billing within `days` — at their end date or
   * after the last run their run limit allows — and the ARR they take with
   * them. `firstEndsAt` is the soonest of those stops.
   */
  ending: { days: number; schedules: number; arrCents: number; firstEndsAt: string | null };
  /** The other currencies converted into `currency`, with the rate used. */
  converted: Array<{ currency: string; rate: number; rateDate: string | null }>;
  /**
   * Currencies with no exchange rate into `currency`. Their schedules count
   * in no figure above; `arrCents` is the active ones' ARR in that currency.
   */
  unconverted: Array<{ currency: string; schedules: number; arrCents: number }>;
};

type Rate = { rate: number; rateDate: Date | null };

/** A schedule whose customer still exists, so it can create an invoice. */
type Billable = HydratedRecurringInvoice & {
  customer: NonNullable<HydratedRecurringInvoice["customer"]>;
};

export async function recurringRevenueMetrics(
  companyId: string,
  now: Date = new Date(),
): Promise<RecurringRevenueMetrics> {
  const currency = (await getReportingCurrency(companyId)).toUpperCase();
  const rows = await AppDataSource.getRepository(RecurringInvoice).find({
    where: { companyId, status: In(["active", "paused"]), archivedAt: IsNull() },
    order: { createdAt: "ASC" },
  });
  const schedules = (await hydrateRecurringInvoices(companyId, rows)).filter(
    (schedule): schedule is Billable => schedule.customer !== null,
  );
  const rates = await ratesInto(companyId, currency, schedules, now);

  const upcomingUntil = new Date(now.getTime() + UPCOMING_DAYS * DAY_MS);
  const endingUntil = new Date(now.getTime() + ENDING_DAYS * DAY_MS);

  let arrCents = 0;
  let activeSchedules = 0;
  const cadences = new Map<RecurringInvoiceFrequency, { schedules: number; arrCents: number }>();
  const customers = new Map<string, { id: string; name: string; slug: string; arrCents: number }>();
  const upcoming = { days: UPCOMING_DAYS, invoices: 0, totalCents: 0 };
  const paused = { schedules: 0, arrCents: 0 };
  const ending = { days: ENDING_DAYS, schedules: 0, arrCents: 0 };
  let firstEndsAt: Date | null = null;
  const unconverted = new Map<string, { schedules: number; arrCents: number }>();

  for (const schedule of schedules) {
    const ownArr = annualCentsForSchedule(schedule, schedule.subtotalCents);
    if (ownArr === null) continue;
    const code = currencyOf(schedule, currency);
    const rate = code === currency ? 1 : rates.get(code)?.rate;
    if (rate === undefined) {
      const left = unconverted.get(code) ?? { schedules: 0, arrCents: 0 };
      left.schedules += 1;
      if (schedule.status === "active") left.arrCents += ownArr;
      unconverted.set(code, left);
      continue;
    }

    const arr = convert(ownArr, rate);
    if (schedule.status === "paused") {
      paused.schedules += 1;
      paused.arrCents += arr;
      continue;
    }

    activeSchedules += 1;
    arrCents += arr;
    const cadence = cadences.get(schedule.frequency) ?? { schedules: 0, arrCents: 0 };
    cadence.schedules += 1;
    cadence.arrCents += arr;
    cadences.set(schedule.frequency, cadence);
    const { customer } = schedule;
    const billed = customers.get(customer.id) ?? {
      id: customer.id,
      name: customer.name,
      slug: customer.slug,
      arrCents: 0,
    };
    billed.arrCents += arr;
    customers.set(customer.id, billed);

    const runs = runsDue(schedule, now, endingUntil);
    const soon = runs.filter((run) => run.getTime() <= upcomingUntil.getTime()).length;
    if (soon > 0) {
      upcoming.invoices += soon;
      upcoming.totalCents += convert(schedule.totalCents * soon, rate);
    }
    const endsAt = stopsBillingBy(schedule, runs, now, endingUntil);
    if (endsAt) {
      ending.schedules += 1;
      ending.arrCents += arr;
      if (!firstEndsAt || endsAt.getTime() < firstEndsAt.getTime()) firstEndsAt = endsAt;
    }
  }

  return {
    currency,
    arrCents,
    mrrCents: roundHalfAway(arrCents / MONTHS_PER_YEAR),
    activeSchedules,
    activeCustomers: customers.size,
    cadences: CADENCE_ORDER.flatMap((frequency) => {
      const cadence = cadences.get(frequency);
      return cadence ? [{ frequency, ...cadence }] : [];
    }),
    largestCustomer: largestOf(customers.values()),
    upcoming,
    paused,
    ending: { ...ending, firstEndsAt: firstEndsAt?.toISOString() ?? null },
    converted: [...rates.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, found]) => ({
        currency: code,
        rate: found.rate,
        rateDate: found.rateDate?.toISOString() ?? null,
      })),
    unconverted: [...unconverted.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, left]) => ({ currency: code, ...left })),
  };
}

function currencyOf(schedule: HydratedRecurringInvoice, home: string): string {
  return (schedule.currency || home).toUpperCase();
}

/**
 * The latest rate from each other currency the schedules bill in into the
 * home currency. A currency with no rate on file is simply absent: the caller
 * reports it rather than guessing one.
 */
async function ratesInto(
  companyId: string,
  home: string,
  schedules: HydratedRecurringInvoice[],
  now: Date,
): Promise<Map<string, Rate>> {
  const foreign = new Set(
    schedules.map((schedule) => currencyOf(schedule, home)).filter((code) => code !== home),
  );
  const rates = new Map<string, Rate>();
  for (const code of foreign) {
    try {
      const found = await lookupRate(companyId, code, home, now);
      rates.set(code, { rate: found.rate, rateDate: found.sourceDate });
    } catch {
      // No rate on or before today: reported as unconverted.
    }
  }
  return rates;
}

function convert(cents: number, rate: number): number {
  return rate === 1 ? cents : roundHalfAway(cents * rate);
}

/**
 * The runs a schedule bills from now until `until`, as the heartbeat will
 * bill them: its next run, then each slot after it, stopping at its end date
 * or at the last run its limit allows. A run already overdue counts as due
 * now, and the slots it missed collapse into it, as they do when it runs.
 */
function runsDue(schedule: RecurringInvoice, now: Date, until: Date): Date[] {
  const runs: Date[] = [];
  const allowed =
    schedule.maxRuns == null ? MAX_RUNS_WALKED : Math.max(0, schedule.maxRuns - schedule.runsCreated);
  let next = schedule.nextRunAt;
  while (next && runs.length < Math.min(allowed, MAX_RUNS_WALKED)) {
    const at = next.getTime() < now.getTime() ? now : next;
    if (at.getTime() > until.getTime()) break;
    if (schedule.endsOn && at.getTime() > schedule.endsOn.getTime()) break;
    runs.push(at);
    next = computeNextRun(schedule, at);
  }
  return runs;
}

/**
 * When an active schedule stops billing, if it does by `until`: its end
 * date, or the last run its run limit allows. Null while it bills on past
 * `until`.
 */
function stopsBillingBy(
  schedule: RecurringInvoice,
  runs: Date[],
  now: Date,
  until: Date,
): Date | null {
  if (schedule.endsOn && schedule.endsOn.getTime() <= until.getTime()) {
    return schedule.endsOn.getTime() < now.getTime() ? now : schedule.endsOn;
  }
  if (schedule.maxRuns != null) {
    const left = schedule.maxRuns - schedule.runsCreated;
    if (left <= 0) return now;
    if (runs.length >= left) return runs[left - 1];
  }
  return null;
}

function largestOf(
  customers: Iterable<{ id: string; name: string; slug: string; arrCents: number }>,
): RecurringRevenueMetrics["largestCustomer"] {
  let largest: RecurringRevenueMetrics["largestCustomer"] = null;
  for (const customer of customers) {
    if (customer.arrCents <= 0) continue;
    if (
      !largest ||
      customer.arrCents > largest.arrCents ||
      (customer.arrCents === largest.arrCents && customer.name.localeCompare(largest.name) < 0)
    ) {
      largest = customer;
    }
  }
  return largest;
}
