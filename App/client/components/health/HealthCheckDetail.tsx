import React from "react";
import { Link } from "react-router-dom";
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";

import { clsx } from "@/components/ui/clsx";
import type { HealthProbe, HealthSeverity } from "@/lib/api";

/**
 * One System Health check, told in full: what it is, how bad, and the rows
 * behind the number.
 *
 * Shared by Settings → System Health and by the peek Home opens when a member
 * clicks a failing check there, so the two cannot disagree about what "3 stuck
 * runs" means. The card chrome is deliberately left to the caller — the
 * settings page wraps this in a `<Card>`, the modal supplies its own panel.
 */

export const HEALTH_SEVERITY_STYLE: Record<
  HealthSeverity,
  { icon: typeof CheckCircle2; tone: string; badge: string; ring: string }
> = {
  ok: {
    icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    ring: "border-emerald-200 dark:border-emerald-500/30",
  },
  warn: {
    icon: AlertTriangle,
    tone: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    ring: "border-amber-200 dark:border-amber-500/30",
  },
  error: {
    icon: AlertOctagon,
    tone: "text-rose-600 dark:text-rose-400",
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
    ring: "border-rose-200 dark:border-rose-500/30",
  },
};

export function HealthCheckDetail({
  check,
  /** Suppress the heading when the surface already carries it (a modal title). */
  showHeading = true,
  /** Intercept an item's deep link — used to keep a run on the page it was clicked from. */
  onItemLink,
}: {
  check: HealthProbe;
  showHeading?: boolean;
  onItemLink?: (link: string, event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const style = HEALTH_SEVERITY_STYLE[check.severity];
  const Icon = style.icon;
  // The probe samples rather than materialising every row, so a check with a
  // count of 40 hands back 5. Saying so keeps the list from reading as the
  // whole story when it is a sample.
  const withheld = Math.max(0, check.count - check.items.length);

  return (
    <div className="flex flex-col gap-3">
      {showHeading ? (
        <div className="flex items-start gap-3">
          <Icon size={18} className={clsx("mt-0.5 shrink-0", style.tone)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {check.title}
              </h2>
              {check.count > 0 && (
                <span
                  className={clsx(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                    style.badge,
                  )}
                >
                  {check.count}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{check.summary}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <Icon size={18} className={clsx("mt-0.5 shrink-0", style.tone)} />
          <p className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-300">
            {check.summary}
          </p>
        </div>
      )}

      {check.items.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {check.items.map((item, i) => {
            const body = (
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-900 dark:text-slate-100">
                    {item.label}
                  </div>
                  {item.sublabel && (
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {item.sublabel}
                    </div>
                  )}
                </div>
                {item.badge && (
                  <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                    {item.badge}
                  </span>
                )}
                {item.link && (
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-slate-300 group-hover:text-slate-500 dark:text-slate-600 dark:group-hover:text-slate-400"
                  />
                )}
              </div>
            );
            return (
              <li key={i}>
                {item.link ? (
                  <Link
                    to={item.link}
                    onClick={(event) => onItemLink?.(item.link as string, event)}
                    className="group block transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}

      {withheld > 0 && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          Showing {check.items.length} of {check.count}.
        </p>
      )}
    </div>
  );
}
