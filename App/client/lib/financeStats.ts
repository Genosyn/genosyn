import { formatMoney } from "./api";
import { dayOf, dayStart } from "../../shared/documentDays";
import type {
  EstimateOutcome,
  EstimateStats,
  InvoiceAgeBucket,
  InvoiceStats,
} from "../../shared/financeStats";

export type {
  EstimateOutcome,
  EstimateStats,
  InvoiceAgeBucket,
  InvoiceStats,
  StatsCustomer,
  StatsDocuments,
} from "../../shared/financeStats";
export { ESTIMATE_OUTCOMES, INVOICE_AGE_BUCKETS } from "../../shared/financeStats";

/**
 * Formatting for the stats panels Finance's lists lead with (Invoices,
 * Estimates, Recurring invoices), and which documents each figure stands
 * for, so a click on a figure can filter the list to exactly those. Kept out
 * of the components so it can be tested without a DOM.
 */

// ───────────────────────────── Formatting ──────────────────────────────

/**
 * A headline amount. Zero, and anything from 1,000 up, is whole units, where
 * cents are only noise; in between it stays exact. Put the exact figure in a
 * title beside it.
 */
export function headlineMoney(cents: number, currency: string): string {
  if (cents !== 0 && Math.abs(cents) < 100_000) return formatMoney(cents, currency);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return formatMoney(cents, currency);
  }
}

/** `part` as a whole percentage of `whole`: "37%", "<1%", or "—" with no whole. */
export function sharePct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** "1 invoice", "3 invoices". */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** "EUR", "EUR and GBP", "EUR, GBP and JPY". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A calendar day (`YYYY-MM-DD`) as the page says it: "Oct 30", with the year
 * when it isn't `today`'s. Read in UTC, where calendar days are kept, so no
 * viewer's clock moves it.
 */
export function shortDay(day: string, today: string, locale?: string): string {
  return dayStart(day).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}

/** "1 day", "12 days". */
export function dayCount(days: number): string {
  return plural(days, "day");
}

/**
 * Today on the company's clock (`Company.timezone`), the viewer's when the
 * company has none. The stats the server sends carry the day it used; this
 * stands in until they arrive, so the list never waits on them.
 */
export function companyToday(timeZone?: string | null, now: Date = new Date()): string {
  return dayOf(now, timeZone);
}

export type Change = {
  /** Which way it went, for the icon beside the words. */
  direction: "up" | "down" | "same" | "none";
  text: string;
};

/**
 * How `current` compares with `previous`, the same span just before it, in
 * words: "Up 12% on the 30 days before", or what the earlier span had when
 * either side is empty.
 */
export function changeOnPrevious(
  current: number,
  previous: number,
  span: string,
  currency: string,
): Change {
  if (previous <= 0) {
    return current > 0
      ? { direction: "none", text: `Nothing in the ${span} before` }
      : { direction: "none", text: "No payments recorded" };
  }
  if (current <= 0) {
    return { direction: "none", text: `${headlineMoney(previous, currency)} in the ${span} before` };
  }
  const pct = ((current - previous) / previous) * 100;
  if (pct === 0) return { direction: "same", text: `Same as the ${span} before` };
  const size = Math.abs(pct) < 1 ? "<1" : String(Math.round(Math.abs(pct)));
  return pct > 0
    ? { direction: "up", text: `Up ${size}% on the ${span} before` }
    : { direction: "down", text: `Down ${size}% on the ${span} before` };
}

// ─────────────────────────── Invoice ageing ────────────────────────────

const AGE_LABEL: Record<InvoiceAgeBucket, string> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

/** A band's name in the breakdown's legend. */
export function ageLabel(bucket: InvoiceAgeBucket): string {
  return AGE_LABEL[bucket];
}

const OUTCOME_LABEL: Record<EstimateOutcome, string> = {
  invoiced: "Invoiced",
  accepted: "Accepted",
  open: "Open",
  expired: "Expired",
  declined: "Declined",
};

/** Where an estimate stands, as the breakdown's legend names it. */
export function outcomeLabel(outcome: EstimateOutcome): string {
  return OUTCOME_LABEL[outcome];
}

// ──────────────────────── Figures → list filters ───────────────────────

/** The documents behind one figure, as a list filters to them. */
export type StatsView<Key extends string> = {
  key: Key;
  /** What the list is narrowed to, for the line above it. */
  label: string;
  ids: Set<string>;
};

/** A band's key in a link, safe in a query string ("90+" is not: "+" reads as a space). */
const AGE_KEY = {
  current: "age-current",
  "1-30": "age-1-30",
  "31-60": "age-31-60",
  "61-90": "age-61-90",
  "90+": "age-over-90",
} as const satisfies Record<InvoiceAgeBucket, string>;

export type InvoiceStatsViewKey =
  | "outstanding"
  | "overdue"
  | "due-soon"
  | "paid"
  | "days-to-pay"
  | "largest-customer"
  | (typeof AGE_KEY)[InvoiceAgeBucket];

const INVOICE_VIEW_KEYS: readonly string[] = [
  "outstanding",
  "overdue",
  "due-soon",
  "paid",
  "days-to-pay",
  "largest-customer",
  ...Object.values(AGE_KEY),
];

/** The filter key for an ageing band's legend entry. */
export function ageViewKey(bucket: InvoiceAgeBucket): InvoiceStatsViewKey {
  return AGE_KEY[bucket];
}

/** A key read from a link, or null when it names no figure the Invoices list has. */
export function parseInvoiceStatsView(value: string | null): InvoiceStatsViewKey | null {
  return value && INVOICE_VIEW_KEYS.includes(value) ? (value as InvoiceStatsViewKey) : null;
}

/**
 * The invoices behind a figure on Finance → Invoices: a tile, or an ageing
 * band. Null when the figure has no documents to stand for — the largest
 * customer once nothing is owed.
 */
export function invoiceStatsView(
  stats: InvoiceStats,
  key: InvoiceStatsViewKey,
): StatsView<InvoiceStatsViewKey> | null {
  const view = (label: string, ids: string[]) => ({ key, label, ids: new Set(ids) });
  switch (key) {
    case "outstanding":
      return view("Outstanding", stats.outstanding.ids);
    case "overdue":
      return view("Overdue", stats.overdue.ids);
    case "due-soon":
      return view(`Due in the next ${stats.dueSoon.days} days`, stats.dueSoon.ids);
    case "paid":
      return view(`Paid in the last ${stats.paid.days} days`, stats.paid.ids);
    case "days-to-pay":
      return view(`Paid in full in the last ${stats.daysToPay.days} days`, stats.daysToPay.ids);
    case "largest-customer":
      return stats.largestCustomer
        ? view(`Owed by ${stats.largestCustomer.name}`, stats.largestCustomer.ids)
        : null;
    default: {
      const bucket = (Object.keys(AGE_KEY) as InvoiceAgeBucket[]).find(
        (candidate) => AGE_KEY[candidate] === key,
      );
      const band = bucket && stats.ageing.find((row) => row.bucket === bucket);
      if (!bucket || !band) return null;
      return view(bucket === "current" ? "Not yet due" : `${ageLabel(bucket)} overdue`, band.ids);
    }
  }
}

export type EstimateStatsViewKey =
  | "open"
  | "expiring"
  | "accepted"
  | "acceptance"
  | "lost"
  | "largest-customer"
  | `recent-${EstimateOutcome}`;

const ESTIMATE_VIEW_KEYS: readonly string[] = [
  "open",
  "expiring",
  "accepted",
  "acceptance",
  "lost",
  "largest-customer",
  ...(["invoiced", "accepted", "open", "expired", "declined"] as const).map(
    (outcome) => `recent-${outcome}`,
  ),
];

/** The filter key for an outcome's legend entry. */
export function outcomeViewKey(outcome: EstimateOutcome): EstimateStatsViewKey {
  return `recent-${outcome}`;
}

/** A key read from a link, or null when it names no figure the Estimates list has. */
export function parseEstimateStatsView(value: string | null): EstimateStatsViewKey | null {
  return value && ESTIMATE_VIEW_KEYS.includes(value) ? (value as EstimateStatsViewKey) : null;
}

/**
 * The estimates behind a figure on Finance → Estimates: a tile, or an outcome
 * in the recent breakdown. Null when the figure has none to stand for.
 */
export function estimateStatsView(
  stats: EstimateStats,
  key: EstimateStatsViewKey,
): StatsView<EstimateStatsViewKey> | null {
  const view = (label: string, ids: string[]) => ({ key, label, ids: new Set(ids) });
  const days = stats.recent.days;
  switch (key) {
    case "open":
      return view("Open", stats.open.ids);
    case "expiring":
      return view(`Expiring in ${stats.expiringSoon.days} days`, stats.expiringSoon.ids);
    case "accepted":
      return view("Accepted, not yet invoiced", stats.acceptedNotInvoiced.ids);
    case "acceptance":
      return view(`Decided, issued in the last ${days} days`, stats.recent.acceptance.ids);
    case "lost":
      return view(`Declined or expired, issued in the last ${days} days`, stats.recent.lost.ids);
    case "largest-customer":
      return stats.largestCustomer
        ? view(`Open with ${stats.largestCustomer.name}`, stats.largestCustomer.ids)
        : null;
    default: {
      const outcome = key.slice("recent-".length) as EstimateOutcome;
      const row = stats.recent.outcomes.find((candidate) => candidate.outcome === outcome);
      if (!row) return null;
      return view(`${outcomeLabel(outcome)}, issued in the last ${days} days`, row.ids);
    }
  }
}

/**
 * The rows a figure stands for, in the list's own order. Archived rows come
 * too: a figure that counts one — cash an archived invoice brought in — must
 * show it.
 */
export function rowsInView<Row extends { id: string }>(
  rows: Row[],
  view: StatsView<string>,
): Row[] {
  return rows.filter((row) => view.ids.has(row.id));
}

/** The acceptance rate as a whole percentage, or null with nothing decided yet. */
export function acceptanceRate(acceptance: EstimateStats["recent"]["acceptance"]): number | null {
  if (acceptance.decided <= 0) return null;
  return Math.round((acceptance.accepted / acceptance.decided) * 100);
}
