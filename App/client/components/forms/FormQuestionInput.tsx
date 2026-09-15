import React from "react";
import { Check } from "lucide-react";

import { chipClass } from "@/components/BaseIcons";
import { clsx } from "@/components/ui/clsx";
import type { PublicBaseFormQuestion } from "@/lib/api";
import type { PublicFormValue } from "@/lib/baseForms";

export function FormQuestionInput({
  question,
  value,
  onChange,
  disabled = false,
  invalid = false,
  ariaLabelledBy,
  ariaDescribedBy,
}: {
  question: PublicBaseFormQuestion;
  value: PublicFormValue | undefined;
  onChange: (value: PublicFormValue) => void;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}) {
  const controlId = `form-question-control-${question.id}`;
  const inputClass = clsx(
    "h-11 w-full rounded-xl border bg-white px-3 text-sm text-slate-900 shadow-sm transition",
    "placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
    "dark:bg-slate-950 dark:text-slate-100 dark:disabled:bg-slate-900 dark:disabled:text-slate-500",
    invalid
      ? "border-rose-400 focus:border-rose-500 focus:ring-rose-500/15 dark:border-rose-800"
      : "border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/15 dark:border-slate-700",
  );

  if (question.type === "longtext") {
    return (
      <textarea
        id={controlId}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={question.required}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        placeholder="Type your answer…"
        rows={4}
        className={clsx(inputClass, "h-auto min-h-28 resize-y py-3 leading-6")}
      />
    );
  }

  if (question.type === "select" || question.type === "multiselect") {
    const selected =
      question.type === "multiselect"
        ? new Set(Array.isArray(value) ? value : [])
        : new Set(typeof value === "string" && value ? [value] : []);
    return (
      <fieldset
        id={controlId}
        aria-labelledby={ariaLabelledBy}
        aria-required={question.required}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        className="m-0 min-w-0 border-0 p-0"
      >
        <legend className="sr-only">{question.label}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {question.options.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
              No choices have been added yet.
            </div>
          ) : (
            question.options.map((option) => {
              const checked = selected.has(option.id);
              return (
                <label
                  key={option.id}
                  className={clsx(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/25",
                    checked
                      ? "border-indigo-300 bg-indigo-50/70 text-slate-900 ring-1 ring-indigo-200 dark:border-indigo-700 dark:bg-indigo-500/10 dark:text-slate-100 dark:ring-indigo-900"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-900",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type={question.type === "select" ? "radio" : "checkbox"}
                    name={question.type === "select" ? `form-question-${question.id}` : undefined}
                    checked={checked}
                    disabled={disabled}
                    required={question.type === "select" && question.required}
                    onChange={() => {
                      if (question.type === "select") {
                        onChange(option.id);
                        return;
                      }
                      const next = new Set(selected);
                      if (checked) next.delete(option.id);
                      else next.add(option.id);
                      onChange(Array.from(next));
                    }}
                    className="sr-only"
                  />
                  <span
                    className={clsx(
                      "flex h-5 w-5 shrink-0 items-center justify-center border",
                      question.type === "select" ? "rounded-full" : "rounded-md",
                      checked
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900",
                    )}
                  >
                    {checked ? <Check size={12} strokeWidth={3} /> : null}
                  </span>
                  <span className={clsx("min-w-0 rounded-md px-2 py-0.5", chipClass(option.color))}>
                    {option.label}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </fieldset>
    );
  }

  if (question.type === "checkbox") {
    const checked = value === true;
    return (
      <label
        htmlFor={controlId}
        className={clsx(
          "flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2 text-sm text-slate-700 transition",
          "dark:bg-slate-950 dark:text-slate-200",
          checked
            ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-700 dark:bg-indigo-500/10"
            : invalid
              ? "border-rose-400 dark:border-rose-800"
              : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <input
          id={controlId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          required={question.required}
          aria-invalid={invalid || undefined}
          aria-describedby={ariaDescribedBy}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
        />
        <span>Yes</span>
      </label>
    );
  }

  const inputType =
    question.type === "datetime"
      ? "datetime-local"
      : question.type === "number"
        ? "number"
        : question.type;
  return (
    <input
      id={controlId}
      type={inputType}
      value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
      onChange={(event) => {
        if (question.type !== "number") {
          onChange(event.target.value);
          return;
        }
        onChange(event.target.value === "" ? "" : Number(event.target.value));
      }}
      disabled={disabled}
      required={question.required}
      aria-invalid={invalid || undefined}
      aria-describedby={ariaDescribedBy}
      inputMode={question.type === "number" ? "decimal" : undefined}
      placeholder={question.type === "url" ? "https://…" : "Type your answer…"}
      className={clsx(inputClass, question.type === "number" && "tabular-nums")}
    />
  );
}
