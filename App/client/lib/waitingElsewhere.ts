import type { WaitingElsewhere } from "../../shared/navigation";

/** One queue beside the Decision stack that holds something for the viewer. */
export type WaitingLink = { key: keyof WaitingElsewhere; label: string; path: string };

const QUEUES: ReadonlyArray<{
  key: keyof WaitingElsewhere;
  one: string;
  many: string;
  path: string;
}> = [
  { key: "approvals", one: "Approval", many: "Approvals", path: "/decisions/approvals" },
  { key: "revisions", one: "Revision", many: "Revisions", path: "/decisions/revisions" },
  { key: "initiatives", one: "Initiative", many: "Initiatives", path: "/decisions/initiatives" },
  { key: "todoReviews", one: "todo to review", many: "todos to review", path: "/tasks/review" },
  {
    key: "financeProposals",
    one: "Finance proposal",
    many: "Finance proposals",
    path: "/finance/proposals",
  },
];

/**
 * The Decision stack's "Also waiting" line: each queue that holds something,
 * as "3 Approvals" with the page it opens (under `/c/<slug>`). Empty queues and
 * queues that are not this person's to act on (`null`) are left out, so the
 * line disappears when nothing else waits.
 */
export function waitingLinks(waiting: WaitingElsewhere | null): WaitingLink[] {
  if (!waiting) return [];
  const links: WaitingLink[] = [];
  for (const queue of QUEUES) {
    const count = waiting[queue.key];
    if (!count) continue;
    links.push({
      key: queue.key,
      label: `${count} ${count === 1 ? queue.one : queue.many}`,
      path: queue.path,
    });
  }
  return links;
}
