import React from "react";
import { Link } from "react-router-dom";
import { TriangleAlert, X } from "lucide-react";
import { formatMoney } from "../../lib/api";
import { headlineMoney, listOf, plural, sharePct } from "../../lib/financeStats";
import { Button } from "../ui/Button";
import { clsx } from "../ui/clsx";

/**
 * The figures Finance's lists lead with — Invoices, Estimates and Recurring
 * invoices — drawn from one set of pieces so the three read alike: a card
 * holding a headline figure with a breakdown bar beside it, a row of tiles,
 * and a footnote that says what each figure counts. A tile or a breakdown
 * entry given `onSelect` filters the list below to the documents it counts.
 */

/** The card. */
export function StatsPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      {children}
    </section>
  );
}

/** The headline on the left and the breakdown beside it, stacked on a narrow screen. */
export function StatsLead({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 p-5 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
      {children}
    </div>
  );
}

/** The one figure the panel leads with, and a line under it. */
export function StatsHeadline({
  label,
  value,
  title,
  children,
}: {
  label: string;
  value: string;
  /** The exact figure, when `value` is rounded. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 lg:shrink-0">
      <h2 className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</h2>
      <p
        className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl dark:text-slate-50"
        title={title}
      >
        {value}
      </p>
      <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{children}</p>
    </div>
  );
}

export type BreakdownSegment = {
  key: string;
  label: string;
  amountCents: number;
  /** Tailwind background classes for the bar and the legend's swatch, light and dark. */
  fill: string;
  /** Said on hover over the amount: how many documents, and anything else worth it. */
  detail?: string;
  /** Filters the list to this segment's documents. */
  onSelect?: () => void;
  selected?: boolean;
};

/**
 * A figure split into its parts: one bar for the shares, with the legend
 * underneath carrying every amount, so the bar itself is only a picture of
 * them. Empty parts are left out of both.
 */
export function StatsBreakdown({
  title,
  segments,
  totalCents,
  currency,
}: {
  title: string;
  segments: BreakdownSegment[];
  totalCents: number;
  currency: string;
}) {
  const shown = segments.filter((segment) => segment.amountCents > 0);
  if (totalCents <= 0 || shown.length === 0) return null;
  return (
    <div className="w-full lg:max-w-md">
      <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">{title}</h3>
      <div aria-hidden="true" className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full">
        {shown.map((segment) => (
          <div
            key={segment.key}
            className={clsx("h-full min-w-[4px]", segment.fill)}
            style={{ flexGrow: segment.amountCents / totalCents, flexBasis: 0 }}
            title={`${segment.label}: ${formatMoney(segment.amountCents, currency)}`}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {shown.map((segment) => {
          const content = (
            <>
              <span
                aria-hidden="true"
                className={clsx("h-2 w-2 shrink-0 rounded-full", segment.fill)}
              />
              <span className="text-slate-600 dark:text-slate-300">{segment.label}</span>
              <span
                className="font-medium tabular-nums text-slate-900 dark:text-slate-100"
                title={segment.detail ?? formatMoney(segment.amountCents, currency)}
              >
                {headlineMoney(segment.amountCents, currency)}
              </span>
              <span className="tabular-nums text-slate-400 dark:text-slate-500">
                {sharePct(segment.amountCents, totalCents)}
              </span>
            </>
          );
          return (
            <li key={segment.key} className="flex text-xs">
              {segment.onSelect ? (
                <button
                  type="button"
                  onClick={segment.onSelect}
                  aria-pressed={segment.selected ?? false}
                  className={clsx(
                    "touch-target relative -mx-1.5 -my-0.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    segment.selected
                      ? "bg-indigo-50 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-500/10 dark:ring-indigo-500/40"
                      : "hover:bg-slate-100 dark:hover:bg-slate-800",
                  )}
                >
                  {content}
                </button>
              ) : (
                <span className="flex items-center gap-1.5">{content}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const TILE_COLUMNS: Record<number, string> = {
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
};

/** The row of tiles: two across on a phone, one row on a wide screen. */
export function StatTiles({ columns, children }: { columns: 4 | 5; children: React.ReactNode }) {
  return (
    <div
      className={clsx(
        "grid grid-cols-2 gap-px border-y border-slate-100 bg-slate-100 dark:border-slate-800 dark:bg-slate-800",
        TILE_COLUMNS[columns],
      )}
    >
      {children}
    </div>
  );
}

/**
 * One figure in the row. With `onSelect` the whole tile is a button that
 * filters the list to the documents the figure counts, pressed while it does;
 * without, it is a term and its description.
 */
export function StatTile({
  icon,
  label,
  value,
  title,
  detail,
  onSelect,
  selected = false,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** The exact figure, when `value` is rounded. */
  title?: string;
  detail: React.ReactNode;
  onSelect?: () => void;
  selected?: boolean;
  className?: string;
}) {
  const labelRow = (
    <>
      {/* Dropped on a phone, where a half-width cell has room for the label alone. */}
      <span aria-hidden="true" className="hidden text-slate-400 sm:inline dark:text-slate-500">
        {icon}
      </span>
      {label}
    </>
  );
  const labelClass =
    "flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400";
  const valueClass = "mt-2 truncate text-xl font-semibold text-slate-900 dark:text-slate-100";
  const detailClass = "mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400";

  if (!onSelect) {
    return (
      <dl className={clsx("flex min-w-0 flex-col bg-white p-4 dark:bg-slate-900", className)}>
        <dt className={labelClass}>{labelRow}</dt>
        <dd className={valueClass} title={title}>
          {value}
        </dd>
        <dd className={detailClass}>{detail}</dd>
      </dl>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        "flex min-w-0 flex-col p-4 text-left transition focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
        selected
          ? "bg-indigo-50 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-950/50 dark:ring-indigo-500/40"
          : "bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/70",
        className,
      )}
    >
      <span className={labelClass}>{labelRow}</span>
      <span className={clsx("block", valueClass)} title={title}>
        {value}
      </span>
      <span className={clsx("block", detailClass)}>{detail}</span>
    </button>
  );
}

/** What each figure counts, under the tiles. */
export function StatsFootnote({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 bg-slate-50/70 px-5 py-3 text-xs dark:bg-slate-800/30">
      {children}
    </div>
  );
}

/** One sentence of the footnote. */
export function FootnoteLine({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-500 dark:text-slate-400">{children}</p>;
}

/**
 * Documents in a currency with no exchange rate count nowhere; say so, and
 * where to fix it.
 */
export function UnconvertedNote({
  left,
  noun,
  verb,
  currency,
  companySlug,
}: {
  left: Array<{ currency: string; count: number }>;
  /** `{ one: "invoice", many: "invoices" }`. */
  noun: { one: string; many: string };
  /** How the documents came to be in that currency: "billed", "quoted". */
  verb: string;
  /** The home currency. */
  currency: string;
  companySlug: string;
}) {
  if (left.length === 0) return null;
  const codes = left.map((row) => row.currency);
  const count = left.reduce((sum, row) => sum + row.count, 0);
  return (
    <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
      <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
      <span>
        {plural(count, noun.one, noun.many)} {verb} in {listOf(codes)}{" "}
        {count === 1 ? "isn't" : "aren't"} counted: there&apos;s no exchange rate into {currency}.{" "}
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

/**
 * Above a list filtered to one figure's documents: which figure, how many,
 * and the way back to the tab it was on.
 */
export function StatsViewBar({
  label,
  count,
  noun,
  onClear,
}: {
  label: string;
  count: number;
  /** `{ one: "invoice", many: "invoices" }`. */
  noun: { one: string; many: string };
  onClear: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 dark:border-indigo-500/30 dark:bg-indigo-500/10">
      <p role="status" className="text-sm text-slate-700 dark:text-slate-200">
        <span className="font-medium text-slate-900 dark:text-slate-100">{label}</span>
        <span className="text-slate-500 dark:text-slate-400">
          {" "}
          · {plural(count, noun.one, noun.many)}
        </span>
      </p>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
      >
        <X size={12} aria-hidden="true" /> Show all
      </button>
    </div>
  );
}

/** In the panel's place when its figures didn't load: the list below still stands. */
export function StatsUnavailable({
  what,
  retrying,
  onRetry,
}: {
  /** "the invoice figures". */
  what: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-sm text-slate-500 dark:text-slate-400">Couldn&apos;t load {what}.</p>
      <Button variant="secondary" size="sm" loading={retrying} onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
