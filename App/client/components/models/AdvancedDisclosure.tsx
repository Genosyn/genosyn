import React from "react";
import { ChevronDown } from "lucide-react";

/**
 * The single "Advanced" disclosure a model section keeps for what most people
 * never touch. Closed until opened, so the page is just the answer to "is it
 * connected?" — and the closed line is honest about what is inside: it names
 * anything moved off its default, so a setting that matters is never invisible
 * just because it is folded away.
 *
 * `summary` is that line, empty when nothing is changed; `hint` stands in for it
 * then, saying what a person would find by opening it.
 */
export function AdvancedDisclosure({
  summary,
  hint,
  children,
}: {
  summary: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Advanced</span>
        <span
          title={summary || hint}
          className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-slate-400"
        >
          {summary || hint}
        </span>
        <ChevronDown
          aria-hidden
          size={14}
          className="shrink-0 text-slate-400 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-4 border-t border-slate-100 p-4 dark:border-slate-800">
        {children}
      </div>
    </details>
  );
}
