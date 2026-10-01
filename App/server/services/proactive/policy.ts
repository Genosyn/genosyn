import type { Routine } from "../../db/entities/Routine.js";
import type { RunTrigger } from "../../db/entities/Run.js";
import type { MailDeliveryMode } from "../mail/deliveryPolicy.js";

/** Read a persisted server-owned ceiling; prose and identifiers confer no authority. */
export function routineDeliveryPolicy(
  routine: Pick<Routine, "mailDeliveryMode"> & Partial<Pick<Routine, "selfReviewOnly">>,
  proactiveReview = false,
  originDeliveryMode: MailDeliveryMode | null = null,
): {
  mailDeliveryMode: MailDeliveryMode | null;
  allowPrivilegedToolSources: boolean;
} {
  // Unknown stored values also stay restricted during mixed-version deployments.
  const restricted = routine.mailDeliveryMode != null;
  // `draft` is the persisted compatibility marker used by shipped starter
  // Routines. Automatic work must no longer materialize provider drafts: at
  // runtime that marker means an exact Decision-stack review. Triage remains
  // the narrower inherited ceiling; every other inherited mode is reduced to
  // review so an old `reply`/`draft` origin cannot widen the Routine.
  const mailDeliveryMode = restricted
    ? originDeliveryMode === "triage"
      ? "triage"
      : "review"
    : originDeliveryMode;
  return {
    mailDeliveryMode,
    allowPrivilegedToolSources: !mailDeliveryMode && !routine.selfReviewOnly && !proactiveReview,
  };
}

/**
 * Existing starters retain their server marker; custom event work is covered too.
 *
 * A retry is not new proactive work. Only scheduled Runs are retried, and a
 * retry repeats that scheduled occurrence with its Effects in view, so it runs
 * with the scope the attempt before it had. Reviewing it instead could never
 * finish that work, and the retry preflight refused it outright whenever the
 * earlier attempt had used native coding or any tool outside preparation.
 */
export function routineNeedsWorkReview(
  routine: Pick<Routine, "mailDeliveryMode" | "selfReviewOnly">,
  triggerKind: RunTrigger,
): boolean {
  // Own-work reviews already have a stricter, suggestion-only surface.
  if (routine.selfReviewOnly) return false;
  return routine.mailDeliveryMode != null || ["event", "webhook"].includes(triggerKind);
}
