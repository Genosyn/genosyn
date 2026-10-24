import React from "react";
import { passwordManagerProps } from "@/lib/passwordManagers";
import { clsx } from "./clsx";
import { fieldClassName } from "./Input";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  /** Explains what the field is for. Rendered below and wired up for readers. */
  hint?: React.ReactNode;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, className, id, ...rest },
  ref,
) {
  const genId = React.useId();
  const tid = id ?? genId;
  const hintId = `${tid}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={tid} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={tid}
        aria-describedby={hint ? hintId : undefined}
        {...passwordManagerProps(rest)}
        {...rest}
        className={clsx("min-h-[160px] px-3 py-2 leading-6", fieldClassName(), className)}
      />
      {hint && (
        <p id={hintId} className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
    </div>
  );
});
