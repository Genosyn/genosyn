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
  const mailDeliveryMode = restricted
    ? originDeliveryMode === "triage"
      ? "triage"
      : "draft"
    : originDeliveryMode;
  return {
    mailDeliveryMode,
    allowPrivilegedToolSources: !mailDeliveryMode && !routine.selfReviewOnly && !proactiveReview,
  };
}

/** Existing starters retain their server marker; custom event work is covered too. */
export function routineNeedsWorkReview(
  routine: Pick<Routine, "mailDeliveryMode" | "selfReviewOnly">,
  triggerKind: RunTrigger,
): boolean {
  // Own-work reviews already have a stricter, suggestion-only surface.
  if (routine.selfReviewOnly) return false;
  return routine.mailDeliveryMode != null || ["event", "webhook", "retry"].includes(triggerKind);
}
