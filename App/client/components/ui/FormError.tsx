import React from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

/**
 * Inline form-level error banner. Slot this into a <form> above the submit
 * button when an API call fails — the message belongs next to the fields the
 * person has to fix, not in a corner popup or behind a modal that covers
 * them. `null`/empty renders nothing so callers can pass state directly
 * without a surrounding guard.
 *
 * For a failure with no form to sit in — a row button, a menu item, an
 * optimistic update that rolled back — use `useDialog().error(err)` instead.
 */
export function FormError({
  message,
  className,
}: {
  message?: string | null;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={
        "flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200 " +
        (className ?? "")
      }
    >
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}

/**
 * The confirmation half of the same banner, for the narrow case where an
 * action succeeded and nothing on the screen shows it: a test email sent, a
 * key copied, an export queued. If the list re-renders, the row updates, or
 * the modal closes, that *is* the confirmation — say nothing.
 */
export function FormSuccess({
  message,
  className,
}: {
  message?: string | null;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div
      role="status"
      className={
        "flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200 " +
        (className ?? "")
      }
    >
      <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}
