import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { rejectPendingApproval } from "./approvals.js";
import { mailReviewDetails } from "./mail/reviewApprovals.js";
import { proactiveWorkReviewDetails } from "./proactive/approvals.js";

/**
 * The email and work reviews the Decision stack shows: `mail_send` and
 * `proactive_work` Approvals, each holding the exact email or plan a person
 * reviews before it happens.
 */

export function isDecisionStackReview(approval: Approval): boolean {
  return approval.kind === "mail_send" || approval.kind === "proactive_work";
}

/**
 * The payload a decision on this review must still match. A review carries a
 * revision; the person deciding sends back the one they read, and the claim
 * then only succeeds while the payload is unchanged. Null means the review
 * changed since they read it; undefined means the kind has no review to pin.
 */
export function expectedReviewPayload(
  approval: Approval,
  reviewRevision: string | undefined,
): string | undefined | null {
  const review =
    approval.kind === "mail_send"
      ? mailReviewDetails(approval)
      : approval.kind === "proactive_work"
        ? proactiveWorkReviewDetails(approval)
        : null;
  if (!review) return undefined;
  return reviewRevision === review.revision ? (approval.payloadJson ?? "") : null;
}

export type ReviewRejection = { id: string; reviewRevision?: string };

export type ReviewBulkOutcome = {
  /** Reviews now rejected (discarded or declined), in request order. */
  succeeded: string[];
  /** Ids left as they were, each with the reason. */
  skipped: Array<{ id: string; reason: string }>;
};

const CHANGED = "Changed since you read it. Open it to review the latest version";

/** Why a review is no longer waiting, in the words its row would use. */
function settledReason(approval: Approval): string {
  if (approval.status === "pending") return CHANGED;
  if (approval.status === "rejected") {
    return approval.kind === "mail_send" ? "Already discarded" : "Already declined";
  }
  if (approval.status === "expired") return "Expired";
  return "Already approved";
}

/** Let other requests in between rows: every awaited SQLite query here is synchronous. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Discard several emails and decline several work plans at once — the
 * Decision stack's bulk bar.
 *
 * Only ever the safe answer: each review goes through `rejectPendingApproval`,
 * exactly as its own Discard or Don’t do this does, so nothing is sent or
 * started and every employee reads why in its journal. Approving stays one
 * review at a time, because each one is a gate a person passes on its own.
 *
 * Each review must still be the version the person read: a changed one is
 * skipped, as is one that is not a Decision-stack review of this company or
 * was settled meanwhile. A skip never fails the rest.
 */
export async function rejectDecisionStackReviews(params: {
  companyId: string;
  userId: string;
  items: ReviewRejection[];
}): Promise<ReviewBulkOutcome> {
  const repo = AppDataSource.getRepository(Approval);
  const succeeded: string[] = [];
  const skipped: ReviewBulkOutcome["skipped"] = [];
  const seen = new Set<string>();
  for (const item of params.items) {
    if (seen.has(item.id)) continue;
    if (seen.size > 0) await yieldToEventLoop();
    seen.add(item.id);
    const approval = await repo.findOneBy({ id: item.id, companyId: params.companyId });
    if (!approval || !isDecisionStackReview(approval)) {
      skipped.push({ id: item.id, reason: "Review not found" });
      continue;
    }
    if (approval.status !== "pending") {
      skipped.push({ id: item.id, reason: settledReason(approval) });
      continue;
    }
    let expectedPayloadJson: string | undefined | null;
    try {
      expectedPayloadJson = expectedReviewPayload(approval, item.reviewRevision);
    } catch {
      // An unreadable review is left for its own row, which says so.
      skipped.push({ id: item.id, reason: "Could not be read. Open it to decide" });
      continue;
    }
    if (expectedPayloadJson === null) {
      skipped.push({ id: item.id, reason: CHANGED });
      continue;
    }
    const result = await rejectPendingApproval({
      companyId: params.companyId,
      approvalId: approval.id,
      userId: params.userId,
      expectedPayloadJson,
    });
    if (result.outcome === "not_found") {
      skipped.push({ id: item.id, reason: "Review not found" });
    } else if (result.outcome === "conflict") {
      skipped.push({ id: item.id, reason: settledReason(result.approval) });
    } else {
      // A journal entry that failed to write is recorded on the row itself;
      // the review is discarded or declined either way.
      succeeded.push(item.id);
    }
  }
  return { succeeded, skipped };
}
