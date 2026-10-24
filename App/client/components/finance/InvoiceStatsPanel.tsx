import React from "react";
import {
  Banknote,
  Building2,
  CalendarClock,
  CalendarX2,
  Timer,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { formatMoney } from "../../lib/api";
import {
  ageLabel,
  ageViewKey,
  changeOnPrevious,
  dayCount,
  headlineMoney,
  listOf,
  plural,
  sharePct,
  shortDay,
  type InvoiceAgeBucket,
  type InvoiceStats,
  type InvoiceStatsViewKey,
} from "../../lib/financeStats";
import { addDays } from "../../../shared/documentDays";
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
 * Not yet due in neutral slate, then one amber ramp for the overdue bands,
 * darker the later on a light card and lighter on a dark one: the bands have
 * an order, and amber is the Overdue badge's colour. Validated as an ordinal
 * ramp (monotone lightness, visible gaps, the faintest clearing 2:1) on both
 * cards.
 */
const AGE_FILL: Record<InvoiceAgeBucket, string> = {
  current: "bg-slate-400 dark:bg-slate-600",
  "1-30": "bg-amber-500 dark:bg-amber-700",
  "31-60": "bg-amber-600 dark:bg-amber-600",
  "61-90": "bg-amber-700 dark:bg-amber-500",
  "90+": "bg-amber-900 dark:bg-amber-400",
};

/**
 * The figures above the Invoices list: what is outstanding and how overdue,
 * what is due next, what came in over the last 30 days, how long customers
 * take to pay, and how much of what is owed one customer owes. The server
 * computes every figure (`services/invoiceStats.ts`); each tile, and each
 * band of the ageing bar, filters the list to the invoices it counts.
 */
export function InvoiceStatsPanel({
  stats,
  companySlug,
  view,
  onView,
}: {
  stats: InvoiceStats;
  companySlug: string;
  /** The figure the list is filtered to, if any. */
  view: InvoiceStatsViewKey | null;
  /** Filter the list to a figure's invoices; the same figure again clears it. */
  onView: (key: InvoiceStatsViewKey | null) => void;
}) {
  const { currency, outstanding, overdue, dueSoon, paid, daysToPay, largestCustomer } = stats;
  const toggle = (key: InvoiceStatsViewKey) => () => onView(view === key ? null : key);
  const change = changeOnPrevious(paid.amountCents, paid.previousCents, `${paid.days} days`, currency);

  return (
    <StatsPanel label="Invoice figures">
      <StatsLead>
        <StatsHeadline
          label="Outstanding"
          value={headlineMoney(outstanding.amountCents, currency)}
          title={formatMoney(outstanding.amountCents, currency)}
        >
          {outstanding.count === 0
            ? "Nothing outstanding: every issued invoice is settled."
            : `${plural(outstanding.count, "invoice")} · ${plural(outstanding.customers, "customer")} · tax included`}
        </StatsHeadline>
        <StatsBreakdown
          title="By days overdue"
          totalCents={outstanding.amountCents}
          currency={currency}
          segments={stats.ageing.map((band) => ({
            key: band.bucket,
            label: ageLabel(band.bucket),
            amountCents: band.amountCents,
            fill: AGE_FILL[band.bucket],
            detail: `${plural(band.count, "invoice")}, ${formatMoney(band.amountCents, currency)}`,
            onSelect: toggle(ageViewKey(band.bucket)),
            selected: view === ageViewKey(band.bucket),
          }))}
        />
      </StatsLead>

      <StatTiles columns={5}>
        <StatTile
          icon={<CalendarX2 size={14} />}
          label="Overdue"
          value={overdue.count === 0 ? "—" : headlineMoney(overdue.amountCents, currency)}
          title={overdue.count === 0 ? undefined : formatMoney(overdue.amountCents, currency)}
          detail={
            overdue.count === 0 || !overdue.oldest
              ? "Nothing overdue"
              : `${plural(overdue.count, "invoice")}, the oldest ${dayCount(overdue.oldest.daysLate)} late`
          }
          onSelect={overdue.count === 0 ? undefined : toggle("overdue")}
          selected={view === "overdue"}
        />
        <StatTile
          icon={<CalendarClock size={14} />}
          label={`Due in the next ${dueSoon.days} days`}
          value={dueSoon.count === 0 ? "—" : headlineMoney(dueSoon.amountCents, currency)}
          title={dueSoon.count === 0 ? undefined : formatMoney(dueSoon.amountCents, currency)}
          detail={
            dueSoon.count === 0
              ? "Nothing falls due"
              : `${plural(dueSoon.count, "invoice")}, due by ${shortDay(addDays(stats.today, dueSoon.days), stats.today)}`
          }
          onSelect={dueSoon.count === 0 ? undefined : toggle("due-soon")}
          selected={view === "due-soon"}
        />
        <StatTile
          icon={<Banknote size={14} />}
          label={`Paid in the last ${paid.days} days`}
          value={paid.count === 0 ? "—" : headlineMoney(paid.amountCents, currency)}
          title={paid.count === 0 ? undefined : formatMoney(paid.amountCents, currency)}
          detail={
            <span className="inline-flex items-center gap-1">
              {change.direction === "up" && (
                <TrendingUp
                  size={12}
                  aria-hidden="true"
                  className="shrink-0 text-emerald-600 dark:text-emerald-400"
                />
              )}
              {change.direction === "down" && (
                <TrendingDown
                  size={12}
                  aria-hidden="true"
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                />
              )}
              <span title={paid.previousCents > 0 ? `${formatMoney(paid.previousCents, currency)} in the ${paid.days} days before` : undefined}>
                {change.text}
              </span>
            </span>
          }
          onSelect={paid.count === 0 ? undefined : toggle("paid")}
          selected={view === "paid"}
        />
        <StatTile
          icon={<Timer size={14} />}
          label="Average days to pay"
          value={daysToPay.averageDays === null ? "—" : dayCount(Math.round(daysToPay.averageDays))}
          detail={
            daysToPay.count === 0
              ? `Nothing paid in full in ${daysToPay.days} days`
              : `Across ${plural(daysToPay.count, "invoice")} paid in full in ${daysToPay.days} days`
          }
          onSelect={daysToPay.count === 0 ? undefined : toggle("days-to-pay")}
          selected={view === "days-to-pay"}
        />
        <StatTile
          className="col-span-2 lg:col-span-1"
          icon={<Building2 size={14} />}
          label="Largest customer"
          value={largestCustomer ? sharePct(largestCustomer.amountCents, outstanding.amountCents) : "—"}
          title={largestCustomer ? formatMoney(largestCustomer.amountCents, currency) : undefined}
          detail={
            largestCustomer ? (
              <>
                of outstanding, owed by{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {largestCustomer.name}
                </span>
              </>
            ) : (
              "Nobody owes anything"
            )
          }
          onSelect={largestCustomer ? toggle("largest-customer") : undefined}
          selected={view === "largest-customer"}
        />
      </StatTiles>

      <StatsFootnote>
        <FootnoteLine>
          Outstanding is what issued invoices still have due after payments, credit notes and
          write-offs, tax included.
          {stats.converted.length > 0 &&
            ` ${listOf(stats.converted)} convert${stats.converted.length === 1 ? "s" : ""} to ${currency} at the rate each invoice and payment locked.`}{" "}
          Drafts and voided invoices aren&apos;t counted.
        </FootnoteLine>
        <FootnoteLine>
          An invoice is overdue from the day after its due date, by the calendar in{" "}
          {stats.timeZone}. Paid is cash received, archived invoices included; days to pay run
          from the issue date to the last payment.
        </FootnoteLine>
        <UnconvertedNote
          left={stats.unconverted.map((row) => ({ currency: row.currency, count: row.invoices }))}
          noun={{ one: "invoice", many: "invoices" }}
          verb="billed"
          currency={currency}
          companySlug={companySlug}
        />
      </StatsFootnote>
    </StatsPanel>
  );
}
