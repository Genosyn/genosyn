import React from "react";
import { clsx } from "./clsx";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, className, id, ...rest },
  ref,
) {
  const genId = React.useId();
  const tid = id ?? genId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={tid} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={tid}
        {...rest}
        className={clsx(
          "min-h-[160px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm",
          "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
          "placeholder:text-slate-400 dark:placeholder:text-slate-500",
          "focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900",
          className,
        )}
      />
    </div>
  );
});
