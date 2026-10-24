import React from "react";
import { passwordManagerProps } from "@/lib/passwordManagers";
import { clsx } from "./clsx";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  /** Draw the field as rejected. Pair it with a message the person can act on. */
  invalid?: boolean;
};

/**
 * The text-field look, shared with Textarea, Select and the handful of raw
 * fields that cannot use these components: a slate-300 edge that reads as a
 * field at rest, and on focus an indigo edge (4.6:1 on white) with a soft halo.
 */
export function fieldClassName({ invalid = false }: { invalid?: boolean } = {}): string {
  return clsx(
    "rounded-lg border bg-white text-sm text-slate-900 shadow-sm transition-colors",
    "dark:bg-slate-900 dark:text-slate-100",
    "placeholder:text-slate-400 dark:placeholder:text-slate-500",
    "focus:outline-none focus:ring-[3px]",
    "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 dark:disabled:bg-slate-800/60 dark:disabled:text-slate-400",
    invalid
      ? "border-red-400 focus:border-red-500 focus:ring-red-500/20 dark:border-red-700 dark:focus:border-red-400 dark:focus:ring-red-500/25"
      : "border-slate-300 hover:border-slate-400/80 focus:border-indigo-500 focus:ring-indigo-500/20 dark:border-slate-700 dark:hover:border-slate-600 dark:focus:border-indigo-400 dark:focus:ring-indigo-400/25",
  );
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, className, id, invalid, ...rest },
  ref,
) {
  const genId = React.useId();
  const inputId = id ?? genId;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={invalid || undefined}
        // Password managers stay out unless this is the person's own sign-in.
        {...passwordManagerProps(rest)}
        {...rest}
        className={clsx("h-10 px-3", fieldClassName({ invalid }), className)}
      />
    </div>
  );
});
