/**
 * Which sections the ⌘K palette lists before anyone asks for more, and what is
 * waiting on someone outside the Decision stack's own rows.
 *
 * Genosyn has a section for nearly every part of running a company, and a new
 * company uses a handful of them. Listing every one on the first day asks each
 * owner to work out which twenty they can ignore. So the palette's browse view
 * starts with the sections every company uses, and a section joins it the first
 * time the company has something in it: a mailbox, a project, an invoice, an AI
 * Employee granted Finance access. Typing still searches every section, and
 * "Show all sections" lists the rest.
 *
 * Shared because the server decides which usage sections are in use
 * (`services/navigation.ts`) and the client decides what to draw
 * (`client/lib/sections.ts`); both read these lists.
 */

/** Listed from the first day: the places every company uses. */
export const CORE_SECTIONS = [
  "home",
  "decisions",
  "tldrs",
  "workspace",
  "employees",
  "goals",
  "settings",
] as const;

/** Listed once the company has something in them. The server checks which. */
export const USAGE_SECTIONS = [
  "mail",
  "meetings",
  "tasks",
  "vault",
  "skills",
  "routines",
  "bases",
  "notes",
  "resources",
  "explore",
  "repositories",
  "pipelines",
  "marketing",
  "revenue",
  "customers",
  "signatures",
  "finance",
] as const;

export type CoreSection = (typeof CORE_SECTIONS)[number];
export type UsageSection = (typeof USAGE_SECTIONS)[number];

/** `GET /api/companies/:cid/navigation/sections` */
export type UsedSectionsResponse = { used: UsageSection[] };

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
