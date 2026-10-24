import React from "react";
import { clsx } from "./clsx";

/**
 * A status or category label: "Connected", "Running", "Draft", "Urgent".
 *
 * One look for every chip in the App — 12px medium text in sentence case on a
 * pale tint with a hairline ring — replacing the tiny uppercase capsules that
 * each page used to draw for itself. Tones carry meaning, not decoration:
 *
 *   neutral  a plain fact (Paused, Draft, Unclear)
 *   accent   the selected or primary one (Active)
 *   success  it worked (Connected, Completed, Paid)
 *   warning  it needs a look soon (Waiting, Overdue)
 *   danger   it went wrong or is urgent (Failed, Error, Urgent)
 *   info     it is happening now (Running, Sent)
 *   ai       about an AI Employee's own judgement
 *
 * Text in every tone passes WCAG AA on its tint in both themes. The label's
 * first letter is shown upper-case, so a lowercase status value from the API
 * reads as a sentence while its text — what tests and screen readers see —
 * stays exactly as given.
 */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "ai";
export type BadgeSize = "sm" | "md";

const TONE: Record<BadgeTone, string> = {
  neutral:
    "bg-slate-100 text-slate-700 ring-slate-500/15 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20",
  accent:
    "bg-indigo-50 text-indigo-700 ring-indigo-600/15 dark:bg-indigo-500/15 dark:text-indigo-200 dark:ring-indigo-400/25",
  success:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25",
  warning:
    "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25",
  danger:
    "bg-rose-50 text-rose-700 ring-rose-600/15 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25",
  info: "bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/25",
  ai: "bg-violet-50 text-violet-700 ring-violet-600/15 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-400/25",
};

/** The dot beside a label, a step stronger than the tint so it reads at 6px. */
const DOT: Record<BadgeTone, string> = {
  neutral: "bg-slate-400",
  accent: "bg-indigo-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  info: "bg-sky-500",
  ai: "bg-violet-500",
};

const SIZE: Record<BadgeSize, string> = {
  sm: "h-5 gap-1 px-1.5",
  md: "h-6 gap-1.5 px-2",
};

export function badgeClassName({
  tone = "neutral",
  size = "sm",
  className,
}: {
  tone?: BadgeTone;
  size?: BadgeSize;
  className?: string;
} = {}): string {
  return clsx(
    "inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-md text-xs font-medium leading-none ring-1 ring-inset",
    TONE[tone],
    SIZE[size],
    className,
  );
}

export type BadgeProps = Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> & {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** A leading lucide icon, drawn at the label's size. */
  icon?: React.ReactNode;
  /** A small coloured dot instead of an icon, for a status read at a glance. */
  dot?: boolean;
  /** Show the first letter upper-case (the default). Turn off for a code or a name. */
  capitalize?: boolean;
  children: React.ReactNode;
};

export function Badge({
  tone = "neutral",
  size = "sm",
  icon,
  dot = false,
  capitalize = true,
  className,
  title,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span {...rest} className={badgeClassName({ tone, size, className })}>
      {dot && <span aria-hidden="true" className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone])} />}
      {icon && (
        <span aria-hidden="true" className="flex shrink-0 items-center [&>svg]:h-3 [&>svg]:w-3">
          {icon}
        </span>
      )}
      {/* The title sits on the words, the element a reader (and a test)
          finds by its text. */}
      <span
        title={title}
        className={clsx("min-w-0 truncate", capitalize && "inline-block first-letter:uppercase")}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * A count beside a label — "Needs attention 3", a rail link's waiting items.
 * Tabular figures, so a column of counts lines up.
 */
export function CountBadge({
  count,
  tone = "neutral",
  className,
  ...rest
}: Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> & {
  count: number;
  tone?: Extract<BadgeTone, "neutral" | "accent" | "danger" | "warning">;
}) {
  return (
    <span
      {...rest}
      className={clsx(
        "inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums leading-none",
        tone === "neutral" && "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
        tone === "accent" && "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200",
        tone === "danger" && "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200",
        tone === "warning" && "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
        className,
      )}
    >
      {count}
    </span>
  );
}
