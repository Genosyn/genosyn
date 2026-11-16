/**
 * What the app chrome reads to point at work waiting on someone: outside the
 * Decision stack's own rows, and in total. Shared because the server counts it
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

/**
 * Everything waiting on the viewer, for the number the app sidebar puts beside
 * the Decision stack on every page: the stack's own rows plus the queues it
 * links to. Counts only, so it never carries a title or a body.
 */
export type NavigationAttention = {
  /** Pending, unsnoozed Decisions this person may answer. */
  decisions: number;
  /**
   * Email and work reviews the stack draws as its own rows. `null` when they
   * are not this person's to act on: a Member, or an API key, which the stack
   * never shows them to.
   */
  reviews: number | null;
  /** The queues the stack links to rather than draws. */
  elsewhere: WaitingElsewhere;
};
