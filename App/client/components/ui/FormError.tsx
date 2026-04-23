import React from "react";
import { AlertCircle } from "lucide-react";

/**
 * Inline form-level error banner. Slot this into a <form> above the submit
 * button when an API call fails, instead of firing a toast — toasts pop off
 * in the corner and are easy to miss when the user's attention is on the
 * form they just submitted. `null`/empty renders nothing so callers can pass
 * state directly without a surrounding guard.
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
