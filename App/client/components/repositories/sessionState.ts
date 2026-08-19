import {
  REVISABLE_WORK_SESSION_STATUSES,
  RepositoryWorkSession,
  RepositoryWorkSessionStatus,
} from "../../lib/api";

/**
 * What a Member may do with a work session, and what the page should say about
 * it.
 *
 * Extracted from the page because it is the part with real rules in it: which
 * buttons exist depends on the status, whether the repository has a remote,
 * and whether a pull request already exists — and getting any of those wrong
 * offers someone a button that fails, or hides the one they need. Pure
 * functions are testable; JSX is not.
 */

export type SessionStatusTone = "working" | "review" | "quiet" | "good" | "bad";

export const SESSION_STATUS_LABEL: Record<RepositoryWorkSessionStatus, string> = {
  running: "Working",
  ready: "Ready to review",
  empty: "No changes made",
  proposed: "Pull request open",
  published: "Accepted",
  discarded: "Thrown away",
  failed: "Failed",
};

export const SESSION_STATUS_TONE: Record<RepositoryWorkSessionStatus, SessionStatusTone> = {
  running: "working",
  ready: "review",
  empty: "quiet",
  proposed: "review",
  published: "good",
  discarded: "quiet",
  failed: "bad",
};

/** A session accepting another instruction — the "ask for changes" composer. */
export function canRevise(status: RepositoryWorkSessionStatus): boolean {
  return REVISABLE_WORK_SESSION_STATUSES.includes(status);
}

/** A session whose branch holds commits a Member can merge or propose. */
export function hasReviewableWork(session: Pick<RepositoryWorkSession, "status">): boolean {
  return session.status === "ready" || session.status === "proposed";
}

export type SessionActions = {
  /** Merge the branch into the Genosyn checkout. */
  accept: boolean;
  /** Merge and push the checkout branch onward to the remote. */
  acceptAndSend: boolean;
  /** Push the session branch and open (or update) a pull request. */
  pullRequest: boolean;
  /** The pull request button says "update" once one is already open. */
  pullRequestIsUpdate: boolean;
  /** Throw the work away. */
  discard: boolean;
  /** Send another instruction. */
  revise: boolean;
};

/**
 * The action set for one session.
 *
 * `remote` is the repository having somewhere to send work at all; `github` is
 * that remote being one we can open a pull request against. They are separate
 * because a self-hosted GitLab remote can be pushed to and cannot be given a
 * pull request from here, and offering the button anyway would be a lie.
 */
export function sessionActions(
  session: Pick<RepositoryWorkSession, "status" | "pullRequestUrl">,
  repo: { remote: boolean; github: boolean },
): SessionActions {
  const reviewable = hasReviewableWork(session);
  return {
    accept: reviewable,
    acceptAndSend: reviewable && repo.remote,
    pullRequest: reviewable && repo.remote && repo.github,
    pullRequestIsUpdate: !!session.pullRequestUrl,
    discard: session.status !== "published" && session.status !== "discarded",
    revise: canRevise(session.status),
  };
}

/**
 * Sessions in the order the switcher shows them: the live ones first, then
 * whatever was touched most recently.
 *
 * A running session is the one thing on the page that changes without being
 * asked, so it belongs where it can be seen. Everything else is a history, and
 * a history is read newest-first.
 */
export function sortSessions(sessions: RepositoryWorkSession[]): RepositoryWorkSession[] {
  const rank = (session: RepositoryWorkSession): number => {
    if (session.status === "running") return 0;
    if (session.status === "ready" || session.status === "proposed") return 1;
    if (session.status === "published" || session.status === "discarded") return 3;
    return 2;
  };
  return [...sessions].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

/** The label under a session in the switcher: what state it is in, in words. */
export function sessionSubtitle(session: RepositoryWorkSession): string {
  const employee = session.employee?.name ?? "Removed employee";
  const turns = session.turnCount > 1 ? ` · ${session.turnCount} instructions` : "";
  return `${employee}${turns}`;
}

/** A session's own name, falling back to its opening instruction. */
export function sessionTitle(
  session: Pick<RepositoryWorkSession, "title" | "instruction">,
): string {
  const title = session.title.trim();
  if (title) return title;
  const flat = session.instruction.replace(/\s+/g, " ").trim();
  if (!flat) return "Untitled session";
  return flat.length > 72 ? `${flat.slice(0, 71).trimEnd()}…` : flat;
}
