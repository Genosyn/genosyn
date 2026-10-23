import React from "react";
import { Link } from "react-router-dom";
import { Building2, CalendarClock, CirclePause, Hourglass, TriangleAlert } from "lucide-react";
import {
  formatMoney,
  RecurringInvoiceFrequency,
  RecurringRevenueMetrics,
} from "../../lib/api";
import { clsx } from "../ui/clsx";

const CADENCE_LABEL: Record<RecurringInvoiceFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

/**
 * One indigo ramp, darker for the longer billing period on a light card and
 * lighter on a dark one. The cadences have an order, so they share the accent
 * rather than each taking a hue; the steps keep visible lightness gaps and
 * the faintest still clears 2:1 against both cards.
 */
const CADENCE_FILL: Record<RecurringInvoiceFrequency, string> = {
  daily: "bg-indigo-400 dark:bg-indigo-600",
  weekly: "bg-indigo-500 dark:bg-indigo-500",
  monthly: "bg-indigo-600 dark:bg-indigo-400",
  quarterly: "bg-indigo-800 dark:bg-indigo-300",
  yearly: "bg-indigo-950 dark:bg-indigo-100",
};

/**
 * A headline amount. Zero, and anything from 1,000 up, is whole units, where
 * cents are only noise; in between it stays exact. The exact figure is the
 * title either way.
 */
function headlineMoney(cents: number, currency: string): string {
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

function sharePct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "EUR", "EUR and GBP", "EUR, GBP and JPY". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** A rate to at most four decimals: 1.1, 0.0068, 157.25. */
function formatRate(rate: number): string {
  return String(Number(rate.toFixed(4)));
}

/**
 * The recurring revenue above the Recurring invoices list: ARR from the
 * active schedules with its split by billing cadence, then what the next 30
 * days will invoice, what is paused, what is about to stop, and how much
 * rests on the largest customer. The server computes every figure
 * (`services/recurringInvoiceMetrics.ts`); this lays them out.
 */
export function RecurringRevenueSummary({
  metrics,
  companySlug,
}: {
  metrics: RecurringRevenueMetrics;
  companySlug: string;
}) {
  const { currency, arrCents, mrrCents, activeSchedules, activeCustomers } = metrics;
  const { upcoming, paused, ending, largestCustomer } = metrics;
  return (
    <section
      aria-label="Recurring revenue"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex flex-col gap-6 p-5 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
        <div className="min-w-0 lg:shrink-0">
          <h2 className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Annual recurring revenue
          </h2>
          <p
            className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl dark:text-slate-50"
            title={formatMoney(arrCents, currency)}
          >
            {headlineMoney(arrCents, currency)}
          </p>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
            {activeSchedules === 0 ? (
              "No schedule is billing right now."
            ) : (
              <>
                <span
                  className="font-medium text-slate-700 dark:text-slate-200"
                  title={formatMoney(mrrCents, currency)}
                >
                  {headlineMoney(mrrCents, currency)}
                </span>{" "}
                a month · {plural(activeSchedules, "active schedule")} ·{" "}
                {plural(activeCustomers, "customer")}
              </>
            )}
          </p>
        </div>
        <CadenceMix cadences={metrics.cadences} totalCents={arrCents} currency={currency} />
      </div>

      <dl className="grid grid-cols-2 gap-px border-y border-slate-100 bg-slate-100 lg:grid-cols-4 dark:border-slate-800 dark:bg-slate-800">
        <Stat
          icon={<CalendarClock size={14} />}
          label={`Next ${upcoming.days} days`}
          value={upcoming.invoices === 0 ? "—" : headlineMoney(upcoming.totalCents, currency)}
          title={upcoming.invoices === 0 ? undefined : formatMoney(upcoming.totalCents, currency)}
          detail={
            upcoming.invoices === 0
              ? "No invoices due"
              : `${plural(upcoming.invoices, "invoice")} to create, tax included`
          }
        />
        <Stat
          icon={<CirclePause size={14} />}
          label="Paused"
          value={paused.schedules === 0 ? "—" : headlineMoney(paused.arrCents, currency)}
          title={paused.schedules === 0 ? undefined : formatMoney(paused.arrCents, currency)}
          detail={
            paused.schedules === 0
              ? "Nothing on hold"
              : `ARR on hold in ${plural(paused.schedules, "schedule")}`
          }
        />
        <Stat
          icon={<Hourglass size={14} />}
          label={`Ending in ${ending.days} days`}
          value={ending.schedules === 0 ? "—" : headlineMoney(ending.arrCents, currency)}
          title={ending.schedules === 0 ? undefined : formatMoney(ending.arrCents, currency)}
          detail={
            ending.schedules === 0
              ? "Nothing set to end"
              : `ARR in ${plural(ending.schedules, "schedule")}${
                  ending.firstEndsAt
                    ? `, ${ending.schedules === 1 ? "ending" : "first"} ${shortDate(ending.firstEndsAt)}`
                    : ""
                }`
          }
        />
        <Stat
          icon={<Building2 size={14} />}
          label="Largest customer"
          value={largestCustomer ? sharePct(largestCustomer.arrCents, metrics.arrCents) : "—"}
          detail={
            largestCustomer ? (
              <>
                of ARR from{" "}
                <Link
                  to={`/c/${companySlug}/customers/${largestCustomer.slug}`}
                  className="font-medium text-slate-700 hover:text-indigo-600 hover:underline dark:text-slate-200 dark:hover:text-indigo-400"
                >
                  {largestCustomer.name}
                </Link>
              </>
            ) : (
              "No active customers"
            )
          }
        />
      </dl>

      <div className="space-y-1.5 bg-slate-50/70 px-5 py-3 text-xs dark:bg-slate-800/30">
        <p className="text-slate-500 dark:text-slate-400">
          ARR is each active schedule&apos;s amount per invoice, before tax and after discounts,
          over a year.
          {metrics.converted.length > 0 && (
            <>
              {" "}
              {listOf(
                metrics.converted.map((rate) => `${rate.currency} at ${formatRate(rate.rate)}`),
              )}{" "}
              to {currency}, the latest {metrics.converted.length === 1 ? "rate" : "rates"} on
              file.
            </>
          )}
        </p>
        {metrics.unconverted.length > 0 && (
          <UnconvertedNote metrics={metrics} companySlug={companySlug} />
        )}
      </div>
    </section>
  );
}

/**
 * ARR split by billing cadence, shortest period first: one bar for the
 * shares, with the legend underneath carrying every figure, so the bar itself
 * is only a picture of them.
 */
function CadenceMix({
  cadences,
  totalCents,
  currency,
}: {
  cadences: RecurringRevenueMetrics["cadences"];
  totalCents: number;
  currency: string;
}) {
  const shown = cadences.filter((cadence) => cadence.arrCents > 0);
  if (totalCents <= 0 || shown.length === 0) return null;
  return (
    <div className="w-full lg:max-w-md">
      <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">
        By billing cadence
      </h3>
      <div aria-hidden="true" className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full">
        {shown.map((cadence) => (
          <div
            key={cadence.frequency}
            className={clsx("h-full min-w-[4px]", CADENCE_FILL[cadence.frequency])}
            style={{ flexGrow: cadence.arrCents / totalCents, flexBasis: 0 }}
            title={`${CADENCE_LABEL[cadence.frequency]}: ${formatMoney(cadence.arrCents, currency)}`}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {shown.map((cadence) => (
          <li key={cadence.frequency} className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className={clsx("h-2 w-2 shrink-0 rounded-full", CADENCE_FILL[cadence.frequency])}
            />
            <span className="text-slate-600 dark:text-slate-300">
              {CADENCE_LABEL[cadence.frequency]}
            </span>
            <span
              className="font-medium tabular-nums text-slate-900 dark:text-slate-100"
              title={`${plural(cadence.schedules, "schedule")}, ${formatMoney(cadence.arrCents, currency)} a year`}
            >
              {headlineMoney(cadence.arrCents, currency)}
            </span>
            <span className="tabular-nums text-slate-400 dark:text-slate-500">
              {sharePct(cadence.arrCents, totalCents)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Schedules in a currency with no exchange rate count nowhere; say so, and where to fix it. */
function UnconvertedNote({
  metrics,
  companySlug,
}: {
  metrics: RecurringRevenueMetrics;
  companySlug: string;
}) {
  const codes = metrics.unconverted.map((left) => left.currency);
  const count = metrics.unconverted.reduce((sum, left) => sum + left.schedules, 0);
  return (
    <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
      <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
      <span>
        {plural(count, "schedule")} billed in {listOf(codes)} {count === 1 ? "isn't" : "aren't"}{" "}
        counted: there&apos;s no exchange rate into {metrics.currency}.{" "}
        <Link
          to={`/c/${companySlug}/finance/currencies`}
          className="font-medium underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300"
        >
          Add {codes.length === 1 ? "a rate" : "rates"}
        </Link>
      </span>
    </p>
  );
}

function Stat({
  icon,
  label,
  value,
  title,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  title?: string;
  detail: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col bg-white p-4 dark:bg-slate-900">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
        {/* Dropped on a phone, where a half-width cell has room for the label alone. */}
        <span aria-hidden="true" className="hidden text-slate-400 sm:inline dark:text-slate-500">
          {icon}
        </span>
        {label}
      </dt>
      <dd
        className="mt-2 truncate text-xl font-semibold text-slate-900 dark:text-slate-100"
        title={title}
      >
        {value}
      </dd>
      <dd className="mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400">{detail}</dd>
    </div>
  );
}
