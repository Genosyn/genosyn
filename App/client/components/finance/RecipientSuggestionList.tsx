import React from "react";
import { Plus } from "lucide-react";
import type { RecipientSuggestion } from "@/lib/api";
import {
  emailedLabel,
  SUGGESTIONS_SHOWN,
  suggestionDetail,
  suggestionInitials,
  suggestionLabel,
} from "@/lib/recipientSuggestions";
import type { RecipientField } from "@/lib/recipientTokens";
import { Spinner } from "../ui/Spinner";
import { clsx } from "../ui/clsx";

export type SuggestionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; total: number };

/**
 * The customer's people, one row each, under a send dialog's To and Cc. One
 * click on a row copies the person (Cc); its To button puts them on the To
 * line instead. Whoever is added leaves the list, and the next person takes
 * the row — and the keyboard focus, so a run of Enter presses adds people one
 * after another.
 */
export function RecipientSuggestionList({
  customerName,
  domain,
  suggestions,
  state,
  onAdd,
  onRetry,
  afterLast,
}: {
  customerName: string;
  domain: string | null;
  /** Ranked, and without anyone already on the email. */
  suggestions: RecipientSuggestion[];
  state: SuggestionsState;
  onAdd: (suggestion: RecipientSuggestion, field: RecipientField) => void;
  onRetry: () => void;
  /** Where focus goes when the last suggestion was just added. */
  afterLast: React.RefObject<{ focus: () => void } | null>;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? suggestions : suggestions.slice(0, SUGGESTIONS_SHOWN);
  const hidden = suggestions.length - shown.length;

  // Focus follows the list: when the row that held it is gone, the row that
  // took its place gets it, else the one above, else the Cc field.
  const rowButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = React.useRef<{ email: string; successors: string[] } | null>(null);
  React.useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || suggestions.some((row) => row.email === pending.email)) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const next = pending.successors.map((email) => rowButtons.current.get(email)).find(Boolean);
    if (next) next.focus();
    else afterLast.current?.focus();
  }, [suggestions, afterLast]);

  function add(suggestion: RecipientSuggestion, field: RecipientField, row: HTMLElement | null) {
    if (row?.contains(document.activeElement)) {
      const index = shown.findIndex((item) => item.email === suggestion.email);
      pendingFocus.current = {
        email: suggestion.email,
        successors: [suggestions[index + 1]?.email, shown[index - 1]?.email].filter(
          (email): email is string => Boolean(email),
        ),
      };
    }
    onAdd(suggestion, field);
  }

  const heading = (
    <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
      Suggested from {customerName}
    </p>
  );

  if (state.status === "loading") {
    return (
      <div aria-busy="true">
        {heading}
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={14} /> Finding {customerName}&apos;s people…
        </p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div>
        {heading}
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Couldn&apos;t load suggestions: {state.message}{" "}
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Try again
          </button>
        </p>
      </div>
    );
  }
  if (suggestions.length === 0) {
    return (
      <div>
        {heading}
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {state.total > 0
            ? "Everyone suggested is on this email."
            : `${customerName} has no contacts to suggest yet.`}
        </p>
      </div>
    );
  }

  return (
    <div>
      {heading}
      <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
        {shown.map((suggestion) => {
          const label = suggestionLabel(suggestion);
          const detail = suggestionDetail(suggestion, domain);
          const emailed = emailedLabel(suggestion.lastEmailedAt);
          const second = [suggestion.name ? suggestion.email : "", detail, emailed]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={suggestion.email}
              className="flex items-center gap-1 pr-1.5"
              data-suggestion={suggestion.email}
            >
              <button
                type="button"
                ref={(node) => {
                  if (node) rowButtons.current.set(suggestion.email, node);
                  else rowButtons.current.delete(suggestion.email);
                }}
                onClick={(event) => add(suggestion, "cc", event.currentTarget.closest("li"))}
                aria-label={`Add ${label} to Cc`}
                title={`Add ${suggestion.name ? `${suggestion.name} <${suggestion.email}>` : suggestion.email} to Cc`}
                className={clsx(
                  "group flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left",
                  "hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-slate-800/60 dark:focus-visible:bg-slate-800/60",
                )}
              >
                <span
                  aria-hidden
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  {suggestionInitials(suggestion)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {label}
                    </span>
                    {suggestion.primary && (
                      <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-px text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                        Primary
                      </span>
                    )}
                  </span>
                  {second && (
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {second}
                    </span>
                  )}
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-indigo-600 group-hover:bg-indigo-50 group-focus-visible:bg-indigo-50 dark:text-indigo-400 dark:group-hover:bg-indigo-500/10 dark:group-focus-visible:bg-indigo-500/10">
                  <Plus size={12} aria-hidden /> Cc
                </span>
              </button>
              <button
                type="button"
                onClick={(event) => add(suggestion, "to", event.currentTarget.closest("li"))}
                aria-label={`Add ${label} to To`}
                title={`Put ${label} on the To line`}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <Plus size={12} aria-hidden /> To
              </button>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || expanded) && suggestions.length > SUGGESTIONS_SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mt-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}
