import React from "react";
import { Building2, CircleCheck, FileCheck2, FileX2, Hourglass } from "lucide-react";
import { formatMoney } from "../../lib/api";
import {
  acceptanceRate,
  dayCount,
  headlineMoney,
  listOf,
  outcomeLabel,
  outcomeViewKey,
  plural,
  sharePct,
  shortDay,
  type EstimateOutcome,
  type EstimateStats,
  type EstimateStatsViewKey,
} from "../../lib/financeStats";
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

/**
 * Won on one side, lost on the other, the undecided in neutral slate between:
 * a diverging scale, emerald for won and red for lost, each arm darker toward
 * its end on a light card and lighter on a dark one. Each arm is validated as
 * an ordinal ramp on both cards, and its steps stay clearly apart.
 */
const OUTCOME_FILL: Record<EstimateOutcome, string> = {
  invoiced: "bg-emerald-700 dark:bg-emerald-400",
  accepted: "bg-emerald-500 dark:bg-emerald-600",
  open: "bg-slate-400 dark:bg-slate-600",
  expired: "bg-red-400 dark:bg-red-700",
  declined: "bg-red-700 dark:bg-red-400",
};

/**
 * The figures above the Estimates list: what is open with customers, how the
 * last 90 days of quotes went, what is about to lapse, what was won but not
 * yet billed, and how much of what is open one customer holds. The server
 * computes every figure (`services/estimateStats.ts`); each tile, and each
 * part of the outcome bar, filters the list to the estimates it counts.
 */
export function EstimateStatsPanel({
  stats,
  companySlug,
  view,
  onView,
}: {
  stats: EstimateStats;
  companySlug: string;
  /** The figure the list is filtered to, if any. */
  view: EstimateStatsViewKey | null;
  /** Filter the list to a figure's estimates; the same figure again clears it. */
  onView: (key: EstimateStatsViewKey | null) => void;
}) {
  const { currency, open, expiringSoon, acceptedNotInvoiced, recent, largestCustomer } = stats;
  const { acceptance, lost } = recent;
  const toggle = (key: EstimateStatsViewKey) => () => onView(view === key ? null : key);
  const rate = acceptanceRate(acceptance);
  const recentTotal = recent.outcomes.reduce((sum, row) => sum + row.amountCents, 0);

  return (
    <StatsPanel label="Estimate figures">
      <StatsLead>
        <StatsHeadline
          label="Open estimates"
          value={headlineMoney(open.amountCents, currency)}
          title={formatMoney(open.amountCents, currency)}
        >
          {open.count === 0
            ? "Nothing is waiting on a customer's answer."
            : `${plural(open.count, "estimate")} · ${plural(open.customers, "customer")} · tax included`}
        </StatsHeadline>
        <StatsBreakdown
          title={`Issued in the last ${recent.days} days`}
          totalCents={recentTotal}
          currency={currency}
          segments={recent.outcomes.map((row) => ({
            key: row.outcome,
            label: outcomeLabel(row.outcome),
            amountCents: row.amountCents,
            fill: OUTCOME_FILL[row.outcome],
            detail: `${plural(row.count, "estimate")}, ${formatMoney(row.amountCents, currency)}`,
            onSelect: toggle(outcomeViewKey(row.outcome)),
            selected: view === outcomeViewKey(row.outcome),
          }))}
        />
      </StatsLead>

      <StatTiles columns={5}>
        <StatTile
          icon={<CircleCheck size={14} />}
          label="Acceptance rate"
          value={rate === null ? "—" : `${rate}%`}
          detail={
            acceptance.decided === 0
              ? `Nothing decided from the last ${recent.days} days`
              : `${acceptance.accepted} of ${plural(acceptance.decided, "decided estimate")}, last ${recent.days} days`
          }
          onSelect={acceptance.decided === 0 ? undefined : toggle("acceptance")}
          selected={view === "acceptance"}
        />
        <StatTile
          icon={<Hourglass size={14} />}
          label={`Expiring in ${expiringSoon.days} days`}
          value={expiringSoon.count === 0 ? "—" : headlineMoney(expiringSoon.amountCents, currency)}
          title={
            expiringSoon.count === 0 ? undefined : formatMoney(expiringSoon.amountCents, currency)
          }
          detail={
            expiringSoon.count === 0 || !expiringSoon.firstValidUntil
              ? "Nothing about to lapse"
              : `${plural(expiringSoon.count, "estimate")}, the first valid until ${shortDay(expiringSoon.firstValidUntil, stats.today)}`
          }
          onSelect={expiringSoon.count === 0 ? undefined : toggle("expiring")}
          selected={view === "expiring"}
        />
        <StatTile
          icon={<FileCheck2 size={14} />}
          label="Accepted, not invoiced"
          value={
            acceptedNotInvoiced.count === 0
              ? "—"
              : headlineMoney(acceptedNotInvoiced.amountCents, currency)
          }
          title={
            acceptedNotInvoiced.count === 0
              ? undefined
              : formatMoney(acceptedNotInvoiced.amountCents, currency)
          }
          detail={
            acceptedNotInvoiced.count === 0
              ? "Nothing waiting to be billed"
              : `${plural(acceptedNotInvoiced.count, "estimate")}${
                  acceptedNotInvoiced.oldestDaysWaiting === null
                    ? ""
                    : acceptedNotInvoiced.oldestDaysWaiting === 0
                      ? ", accepted today"
                      : `, the oldest accepted ${dayCount(acceptedNotInvoiced.oldestDaysWaiting)} ago`
                }`
          }
          onSelect={acceptedNotInvoiced.count === 0 ? undefined : toggle("accepted")}
          selected={view === "accepted"}
        />
        <StatTile
          icon={<FileX2 size={14} />}
          label="Declined or expired"
          value={lost.count === 0 ? "—" : headlineMoney(lost.amountCents, currency)}
          title={lost.count === 0 ? undefined : formatMoney(lost.amountCents, currency)}
          detail={
            lost.count === 0
              ? `None lost from the last ${recent.days} days`
              : `${lost.declined} declined · ${lost.expired} expired, last ${recent.days} days`
          }
          onSelect={lost.count === 0 ? undefined : toggle("lost")}
          selected={view === "lost"}
        />
        <StatTile
          className="col-span-2 lg:col-span-1"
          icon={<Building2 size={14} />}
          label="Largest customer"
          value={largestCustomer ? sharePct(largestCustomer.amountCents, open.amountCents) : "—"}
          title={largestCustomer ? formatMoney(largestCustomer.amountCents, currency) : undefined}
          detail={
            largestCustomer ? (
              <>
                of open value, with{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {largestCustomer.name}
                </span>
              </>
            ) : (
              "Nothing open"
            )
          }
          onSelect={largestCustomer ? toggle("largest-customer") : undefined}
          selected={view === "largest-customer"}
        />
      </StatTiles>

      <StatsFootnote>
        <FootnoteLine>
          Open is what sent estimates still within their valid-until date come to, tax included,
          until the customer accepts or declines.
          {stats.converted.length > 0 &&
            ` ${listOf(stats.converted)} convert${stats.converted.length === 1 ? "s" : ""} to ${currency} at the rate on file for each estimate's issue date.`}{" "}
          An accepted estimate doesn&apos;t expire.
        </FootnoteLine>
        <FootnoteLine>
          The rate, the lost figure and the bar cover estimates issued in the last {recent.days}{" "}
          days, by the calendar in {stats.timeZone}; one converted to an invoice counts as
          accepted. Drafts and voided estimates aren&apos;t counted; archived ones count only in
          those 90-day figures, once decided.
        </FootnoteLine>
        <UnconvertedNote
          left={stats.unconverted.map((row) => ({ currency: row.currency, count: row.estimates }))}
          noun={{ one: "estimate", many: "estimates" }}
          verb="quoted"
          currency={currency}
          companySlug={companySlug}
        />
      </StatsFootnote>
    </StatsPanel>
  );
}
