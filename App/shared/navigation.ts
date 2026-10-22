/**
 * What the app chrome reads to point at work waiting outside the Decision
 * stack's own rows. Shared because the server counts it
 * (`services/navigation.ts`) and the client draws it.
 */

/**
 * What waits on the viewer in the queues the Decision stack links to rather
 * than draws itself. `null` means the queue is not this person's to act on (an
 * Approval needs an owner or admin; a Finance proposal needs full Finance
 * access), so it is not counted at all rather than counted as zero.
 */
export type WaitingElsewhere = {
  /** Pending Approvals other than the email and work reviews the stack shows. */
  approvals: number | null;
  /** Pending Soul, Skill, and Routine edits AI Employees proposed. */
  revisions: number | null;
  /** Pending standing work AI Employees proposed. */
  initiatives: number | null;
  /** Todos waiting in review with this person named as the reviewer. */
  todoReviews: number;
  /** Ledger entries an AI Employee staged for review. */
  financeProposals: number | null;
};
