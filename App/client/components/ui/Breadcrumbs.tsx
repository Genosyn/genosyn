import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

/**
 * Breadcrumb trail. The last item is rendered as the current page (no link).
 * Earlier items should include a `to` so people can navigate back up. Used at
 * the top of most main panes so "where am I?" is always one glance away.
 */
export type Crumb = { label: React.ReactNode; to?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400"
    >
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 && (
              <ChevronRight
                size={12}
                aria-hidden="true"
                className="shrink-0 text-slate-300 dark:text-slate-600"
              />
            )}
            {c.to && !last ? (
              <Link
                to={c.to}
                className="rounded px-1 py-0.5 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                {c.label}
              </Link>
            ) : (
              <span
                className={
                  last
                    ? "min-w-0 truncate px-1 py-0.5 font-medium text-slate-700 dark:text-slate-200"
                    : "px-1 py-0.5"
                }
                aria-current={last ? "page" : undefined}
              >
                {c.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
