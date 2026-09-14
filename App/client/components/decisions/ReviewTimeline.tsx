import React from "react";
import type { LucideIcon } from "lucide-react";
import { clsx } from "@/components/ui/clsx";

export type ReviewTimelineTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASS: Record<ReviewTimelineTone, string> = {
  neutral:
    "border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400",
  accent:
    "border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  warning:
    "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  danger:
    "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300",
};

/** A quiet vertical sequence shared by pending and resolved review cards. */
export function ReviewTimeline({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <ol className={clsx("m-0 list-none p-0", className)}>{children}</ol>;
}
export function ReviewTimelineItem({
  icon: Icon,
  title,
  meta,
  tone = "neutral",
  children,
  className,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  meta?: React.ReactNode;
  tone?: ReviewTimelineTone;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <li
      className={clsx(
        "relative grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-x-3 pb-5",
        "after:absolute after:bottom-0 after:left-[0.9375rem] after:top-8 after:w-px after:bg-slate-200 last:pb-0 last:after:hidden dark:after:bg-slate-700",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "relative z-[1] flex h-8 w-8 items-center justify-center rounded-full border",
          TONE_CLASS[tone],
        )}
      >
        <Icon size={14} />
      </span>
      <div className="min-w-0 pt-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
          {meta && <span className="text-xs text-slate-500 dark:text-slate-400">{meta}</span>}
        </div>
        {children && <div className="mt-2 min-w-0">{children}</div>}
      </div>
    </li>
  );
}
