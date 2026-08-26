import React from "react";
import { clsx } from "./clsx";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  /** Draw the field as rejected. Pair it with a message the person can act on. */
  invalid?: boolean;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, className, id, invalid, ...rest },
  ref,
) {
  const genId = React.useId();
  const inputId = id ?? genId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={invalid || undefined}
        {...rest}
        className={clsx(
          "h-10 rounded-lg border bg-white px-3 text-sm text-slate-900 shadow-sm",
          "dark:bg-slate-900 dark:text-slate-100",
          "placeholder:text-slate-400 dark:placeholder:text-slate-500",
          "focus:outline-none focus:ring-2",
          invalid
            ? "border-red-400 focus:border-red-500 focus:ring-red-500/20 dark:border-red-800 dark:focus:ring-red-500/25"
            : "border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20 dark:border-slate-700 dark:focus:ring-indigo-500/25",
          className,
        )}
      />
    </div>
  );
});
