import type { Routine } from "../../db/entities/Routine.js";
import type { MailDeliveryMode } from "../mail/deliveryPolicy.js";

/** Read a persisted server-owned ceiling; prose and identifiers confer no authority. */
export function routineDeliveryPolicy(
  routine: Pick<Routine, "mailDeliveryMode"> & Partial<Pick<Routine, "selfReviewOnly">>,
): {
  mailDeliveryMode: MailDeliveryMode | null;
  allowPrivilegedToolSources: boolean;
} {
  // Unknown stored values also stay restricted during mixed-version deployments.
  const restricted = routine.mailDeliveryMode != null;
  return {
    mailDeliveryMode: restricted ? "draft" : null,
    allowPrivilegedToolSources: !restricted && !routine.selfReviewOnly,
  };
}
