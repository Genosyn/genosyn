import React from "react";
import { Link } from "react-router-dom";
import { Building2, CalendarClock, CirclePause, Hourglass } from "lucide-react";
import {
  formatExchangeRate,
  formatMoney,
  RecurringInvoiceFrequency,
  RecurringRevenueMetrics,
} from "../../lib/api";
import { headlineMoney, listOf, plural, sharePct } from "../../lib/financeStats";
import {
  FootnoteLine,
  StatsBreakdown,
  StatsFootnote,
  StatsHeadline,
  StatsLead,
  StatsPanel,
  StatTile,
  StatTiles,
  UnconvertedNote,
} from "./StatsPanel";

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

function shortDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The recurring revenue above the Recurring invoices list: ARR from the
 * active schedules with its split by billing cadence, then what the next 30
 * days will invoice, what is paused, what is about to stop, and how much
 * rests on the largest customer. The server computes every figure
 * (`services/recurringInvoiceMetrics.ts`); this lays them out in the stats
 * panel the Invoices and Estimates lists share (`StatsPanel.tsx`).
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
    <StatsPanel label="Recurring revenue">
      <StatsLead>
        <StatsHeadline
          label="Annual recurring revenue"
          value={headlineMoney(arrCents, currency)}
          title={formatMoney(arrCents, currency)}
        >
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
        </StatsHeadline>
        <StatsBreakdown
          title="By billing cadence"
          totalCents={arrCents}
          currency={currency}
          segments={metrics.cadences.map((cadence) => ({
            key: cadence.frequency,
            label: CADENCE_LABEL[cadence.frequency],
            amountCents: cadence.arrCents,
            fill: CADENCE_FILL[cadence.frequency],
            detail: `${plural(cadence.schedules, "schedule")}, ${formatMoney(cadence.arrCents, currency)} a year`,
          }))}
        />
      </StatsLead>

      <StatTiles columns={4}>
        <StatTile
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
        <StatTile
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
        <StatTile
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
        <StatTile
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
      </StatTiles>

      <StatsFootnote>
        <FootnoteLine>
          ARR is each active schedule&apos;s amount per invoice, before tax and after discounts,
          over a year.
          {metrics.converted.length > 0 && (
            <>
              {" "}
              {listOf(
                metrics.converted.map(
                  (rate) => `${rate.currency} at ${formatExchangeRate(rate.rate)}`,
                ),
              )}{" "}
              to {currency}, the latest {metrics.converted.length === 1 ? "rate" : "rates"} on
              file.
            </>
          )}
        </FootnoteLine>
        <UnconvertedNote
          left={metrics.unconverted.map((row) => ({ currency: row.currency, count: row.schedules }))}
          noun={{ one: "schedule", many: "schedules" }}
          verb="billed"
          currency={currency}
          companySlug={companySlug}
        />
      </StatsFootnote>
    </StatsPanel>
  );
}
