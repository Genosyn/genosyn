import React from "react";
import { Check, Circle, Clock3, LoaderCircle, TriangleAlert } from "lucide-react";
import type { MailReviewSummary } from "@/lib/mail";
import { mailReviewDescription, mailReviewLabel } from "@/lib/mailReview";
import { clsx } from "@/components/ui/clsx";

/** Worded as well as colored, so a read email can still be visibly unreviewed. */
export function MailReviewBadge({
  review,
  compact = false,
}: {
  review?: MailReviewSummary;
  compact?: boolean;
}) {
  const status = review?.status;
  const Icon =
    status === "reviewing"
      ? LoaderCircle
      : status === "reviewed"
        ? Check
        : status === "queued"
          ? Clock3
          : status === "needs_attention"
            ? TriangleAlert
            : Circle;
  return (
    <span
      title={mailReviewDescription(review)}
      aria-label={`${mailReviewLabel(review)}. ${mailReviewDescription(review)}`}
      data-review-status={status ?? "unavailable"}
      className={clsx(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium",
        compact ? "px-1.5 py-0.5 text-[10px] leading-4" : "px-2 py-1 text-[11px] leading-4",
        status === "reviewing" || status === "queued"
          ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200/70 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20"
          : status === "needs_attention"
            ? "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200/70 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20"
            : status === "reviewed"
              ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              : "text-slate-500 dark:text-slate-400",
      )}
    >
      <Icon
        size={compact ? 11 : 12}
        aria-hidden="true"
        className={status === "reviewing" ? "motion-safe:animate-spin" : undefined}
      />
      <span>{mailReviewLabel(review)}</span>
    </span>
  );
}
