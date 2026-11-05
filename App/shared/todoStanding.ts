import type { TodoWaitKind } from "./todoPickups.js";

/**
 * Where a Todo stands, in one plain sentence, from the state the server already has. No
 * AI Model is involved, so it can't be wrong in an interesting way, and it costs nothing.
 */

export type TodoStandingInput = {
  status: string;
  assignee: { kind: "ai" | "human"; name: string } | null;
  reviewerName: string | null;
  viewerIsReviewer: boolean;
  waitingOn: TodoWaitKind | null;
  waitingSince: string | null;
  waitingCheckAt: string | null;
  /** When the session working it now started, if one is. */
  workingSince: string | null;
  /** A session is queued to start on it. A check-back while it waits isn't this. */
  queued: boolean;
};

const WAITING_ON: Record<TodoWaitKind, string> = {
  customer: "Waiting on the customer",
  member: "Waiting on a person",
  decision: "Waiting on a Decision",
  mail_review: "Waiting for someone to review an email",
  work_review: "Waiting for someone to review proposed work",
  browser_approval: "Waiting for someone to approve a browser action",
  work_session: "Waiting on a work session",
  date: "Waiting until a set date",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(when: Date): number {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
}

/** A day the way a person says it: today, Tuesday, 5 Nov. */
function dayWord(iso: string, now: Date): string {
  const when = new Date(iso);
  const days = Math.round((startOfDay(when) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (Math.abs(days) < 7) return when.toLocaleDateString("en-US", { weekday: "long" });
  return when.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function ago(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return dayWord(iso, now);
}

export function todoStanding(input: TodoStandingInput, now: Date = new Date()): string {
  const { assignee } = input;
  if (input.status === "cancelled") return "Cancelled.";
  if (input.status === "done") {
    return assignee?.kind === "ai" ? `Finished. ${assignee.name}'s report is below.` : "Finished.";
  }
  if (input.workingSince && assignee) {
    return `${assignee.name} is working on this. Started ${ago(input.workingSince, now)}.`;
  }
  if (input.status === "in_review") {
    if (input.viewerIsReviewer) return "Needs your review.";
    return input.reviewerName
      ? `Waiting on ${input.reviewerName}'s review.`
      : "In review, with nobody set to review it.";
  }
  if (input.waitingOn) {
    const since = input.waitingSince ? ` since ${dayWord(input.waitingSince, now)}` : "";
    const back = input.waitingCheckAt
      ? ` Checks back ${dayWord(input.waitingCheckAt, now)}.`
      : "";
    return `${WAITING_ON[input.waitingOn]}${since}.${back}`;
  }
  if (input.queued && assignee) return `${assignee.name} is queued to start on this.`;
  if (!assignee) return "Nobody's on this. Assign an AI Employee and it starts right away.";
  if (assignee.kind === "ai") return `Assigned to ${assignee.name}, and not started yet.`;
  return `Assigned to ${assignee.name}.`;
}
