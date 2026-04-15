import React from "react";
import { clsx } from "./clsx";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string };

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, className, id, children, ...rest },
  ref,
) {
  const genId = React.useId();
  const sid = id ?? genId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={sid} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={sid}
        {...rest}
        className={clsx(
          "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm",
          "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
          "focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900",
          className,
        )}
      >
        {children}
      </select>
    </div>
  );
});
