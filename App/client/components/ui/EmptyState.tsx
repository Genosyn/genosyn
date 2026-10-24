import React from "react";
import { clsx } from "./clsx";

/**
 * What a list or section shows when there is nothing in it yet: what would be
 * here, why it is worth having, and the one action that starts it.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** A lucide icon for what would be here, drawn in a soft tile above the title. */
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/60",
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 [&>svg]:h-5 [&>svg]:w-5"
        >
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {description && (
        <p className="mt-1 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
