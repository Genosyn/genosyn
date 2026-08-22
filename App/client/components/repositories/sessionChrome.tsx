import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Spinner } from "../ui/Spinner";
import type { SessionStatusTone } from "./sessionState";

/**
 * Small pieces the Repository AI surfaces share — the status palette every
 * session badge is drawn from, and the failure that stays on the page with a
 * retry on it. Both are used by the session list, the workbench, and the chat
 * panel that now renders the workbench beside a conversation.
 */

export const TONE_CLASS: Record<SessionStatusTone, string> = {
  working: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
  review: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  quiet: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  bad: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
};

export const DOT_CLASS: Record<SessionStatusTone, string> = {
  working: "bg-indigo-500",
  review: "bg-amber-500",
  quiet: "bg-slate-300 dark:bg-slate-600",
  good: "bg-emerald-500",
  bad: "bg-rose-500",
};

export function InlineRetry({
  message,
  onRetry,
  onBack,
  backLabel = "Back to sessions",
  compact = false,
}: {
  message: string;
  onRetry: () => Promise<void>;
  onBack?: () => void;
  /** What the escape hatch is called. The panel's is a close, not a list. */
  backLabel?: string;
  compact?: boolean;
}) {
  const [retrying, setRetrying] = React.useState(false);
  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }
  return (
    <div
      role="alert"
      className={
        "flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/60 text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/5 dark:text-rose-300 " +
        (compact ? "px-3 py-2 text-xs" : "px-4 py-4 text-sm")
      }
    >
      <AlertCircle size={compact ? 14 : 16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-words leading-5">{message}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void retry()}
            disabled={retrying}
            className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 disabled:opacity-60 dark:bg-slate-900 dark:text-rose-300 dark:ring-rose-500/25 dark:hover:bg-rose-500/10"
          >
            {retrying ? <Spinner size={11} /> : <RefreshCw size={11} />}
            Retry
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-xs font-medium text-rose-600 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200"
            >
              {backLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
