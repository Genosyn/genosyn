import type { MailAnalysis, MailReviewSummary, MailThread } from "@/lib/mail";

export function mailReviewLabel(review?: MailReviewSummary): string {
  switch (review?.status) {
    case "not_reviewed":
      return "Not reviewed";
    case "queued":
      return "AI queued";
    case "reviewing":
      return "AI reviewing";
    case "reviewed":
      return "AI reviewed";
    case "needs_attention":
      return "Needs attention";
    default:
      return "Review unavailable";
  }
}

export function mailReviewDescription(review?: MailReviewSummary): string {
  const employee = review?.employee?.name ?? "An AI Employee";
  switch (review?.status) {
    case "not_reviewed":
      return review.latestMessageId
        ? "The latest incoming email has not been reviewed by an AI Employee."
        : "There is no incoming email to review in this conversation.";
    case "queued":
      return "The latest incoming email is waiting for an AI Employee to review it.";
    case "reviewing":
      return `${employee} is reviewing the latest incoming email.`;
    case "reviewed":
      return `${employee} reviewed the latest incoming email. See the timeline for what happened next.`;
    case "needs_attention":
      return "AI work on the latest incoming email needs attention. See the timeline for details.";
    default:
      return "The AI review status could not be loaded.";
  }
}

/** Never turn an omitted projection in a mailbox mutation into lost evidence. */
export function mergeMailThreadUpdate(current: MailThread, updated: MailThread): MailThread {
  if (current.id !== updated.id) return current;
  return { ...updated, aiReview: updated.aiReview ?? current.aiReview };
}

/** A previous message's summary must not appear to describe a new reply. */
export function currentMailAnalysis(
  analyses: MailAnalysis[],
  review?: MailReviewSummary,
): MailAnalysis | null {
  if (!review?.latestMessageId) return null;
  return (
    [...analyses].reverse().find((analysis) => analysis.messageId === review.latestMessageId) ??
    null
  );
}

/** Timeline navigation remains inside this company, even for malformed data. */
export function mailReviewHref(companySlug: string, href: string | null): string | null {
  if (
    !href ||
    !/^\/(?!\/)/.test(href) ||
    href.includes("\\") ||
    [...href].some((character) => character.charCodeAt(0) <= 32)
  )
    return null;
  const path = href.split(/[?#]/)[0];
  // Encoded separators and dot segments can escape the company prefix after
  // browser normalization. Our destinations use plain resource paths + UUIDs.
  if (
    /%(?:2e|2f|5c)/i.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return `/c/${encodeURIComponent(companySlug)}${href}`;
}
