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
  /**
   * There is reviewable work, and the only two buttons that could send it
   * onward are hidden because this Member may not reach the remote. The page
   * says so rather than looking like the feature is missing.
   */
  remoteNeedsAdmin: boolean;
};

/** What a Member may do here, as far as the surface can know before asking. */
export type SessionCapabilities = {
  /** The repository has somewhere to send work at all. */
  remote: boolean;
  /** That remote is one we can open a pull request against. */
  github: boolean;
  /**
   * The viewer is an owner or admin. Both routes that reach the remote —
   * pushing and opening a pull request — are gated on it server-side, so a
   * Member who is offered either gets a 403 instead of an action.
   */
  admin: boolean;
};

/**
 * The action set for one session.
 *
 * `remote` and `github` are separate because a self-hosted GitLab remote can
 * be pushed to and cannot be given a pull request from here, and offering the
 * button anyway would be a lie. `admin` is separate again because it is about
 * the person rather than the repository: the server refuses both outward
 * actions to an ordinary Member, and a button that always 403s is worse than
 * no button at all.
 */
export function sessionActions(
  session: Pick<RepositoryWorkSession, "status" | "pullRequestUrl">,
  repo: SessionCapabilities,
): SessionActions {
  const reviewable = hasReviewableWork(session);
  return {
    accept: reviewable,
    acceptAndSend: reviewable && repo.remote && repo.admin,
    pullRequest: reviewable && repo.remote && repo.github && repo.admin,
    pullRequestIsUpdate: !!session.pullRequestUrl,
    // Not while a turn is in flight: it owns the worktree, and throwing the
    // branch away underneath it makes the turn fail on a directory that
    // vanished — reported afterwards as if the employee had broken something.
    discard:
      session.status !== "published" &&
      session.status !== "discarded" &&
      session.status !== "running",
    revise: canRevise(session.status),
    remoteNeedsAdmin: reviewable && repo.remote && !repo.admin,
  };
}

/**
 * Whether a pull request can be opened against this remote.
 *
 * Mirrors the server's `isGithubHttpsUrl` exactly, by parsing the URL rather
 * than matching a prefix. A regex anchored on `https://github.com/` disagrees
 * with the server about a URL carrying a port or userinfo, and every
 * disagreement is either a button that 400s or — worse, because there is
 * nothing on screen to explain it — a button that never appears.
 */
export function isGithubRemote(gitUrl: string | null | undefined): boolean {
  if (!gitUrl) return false;
  try {
    const parsed = new URL(gitUrl);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
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
