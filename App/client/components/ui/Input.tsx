import React from "react";
import { clsx } from "./clsx";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { label?: string };

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, className, id, ...rest },
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
        {...rest}
        className={clsx(
          "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm",
          "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
          "placeholder:text-slate-400 dark:placeholder:text-slate-500",
          "focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900",
          className,
        )}
      />
    </div>
  );
});
