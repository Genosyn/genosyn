import { Brackets } from "typeorm";

/**
 * Finished attempts usable by self-review and Revision proposals. Interrupted
 * work was never eligible: its new Error status must not widen that boundary.
 * An Error without a recorded cause remains eligible, as runtime failures were
 * before the split; explicitly include null so SQL does not silently drop it.
 */
export function finishedRunEvidence(): Brackets {
  return new Brackets((query) => {
    query
      .where("run.status IN (:...finishedEvidenceStatuses)", {
        finishedEvidenceStatuses: ["completed", "failed", "error", "timeout"],
      })
      .andWhere(
        "(run.status != :evidenceErrorStatus OR run.errorKind IS NULL OR run.errorKind != :evidenceInterruptedKind)",
        { evidenceErrorStatus: "error", evidenceInterruptedKind: "interrupted" },
      );
  });
}
