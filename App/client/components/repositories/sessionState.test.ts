import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RepositoryWorkSession, RepositoryWorkSessionStatus } from "../../lib/api";
import {
  SESSION_INBOX_GROUP_LABEL,
  SESSION_INBOX_GROUP_ORDER,
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TONE,
  canRevise,
  groupSessions,
  hasReviewableWork,
  matchesSessionSearch,
  sessionActions,
  sessionInboxGroup,
  sessionSubtitle,
  sessionTitle,
  sortSessions,
} from "./sessionState";

/**
 * The rules behind the AI work screen's buttons.
 *
 * Every one of these decides whether a Member is offered an action that will
 * work. Offering "Open pull request" on a repository with no remote, or hiding
 * "Ask for changes" on a session that would happily take one, are both bugs a
 * screenshot would not catch.
 */

const ALL_STATUSES: RepositoryWorkSessionStatus[] = [
  "running",
  "ready",
  "empty",
  "proposed",
  "published",
  "discarded",
  "failed",
];

function session(overrides: Partial<RepositoryWorkSession> = {}): RepositoryWorkSession {
  return {
    id: "s1",
    companyId: "c1",
    repositoryId: "r1",
    employeeId: "e1",
    requestedByUserId: "u1",
    title: "Add a health check",
    instruction: "Add a health check endpoint and commit it",
    status: "ready",
    branch: "genosyn/ada/abcdef12",
    baseCommit: "aaa",
    headCommit: "bbb",
    reply: "Done.",
    error: "",
    turnCount: 1,
    filesChanged: 1,
    insertions: 3,
    deletions: 0,
    publishedBranch: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    finishedAt: "2026-08-19T10:00:00.000Z",
    createdAt: "2026-08-19T09:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    employee: { id: "e1", name: "Ada", slug: "ada", avatarKey: null },
    ...overrides,
  };
}

describe("which sessions accept another instruction", () => {
  test("everything except a turn in flight and the two terminal outcomes", () => {
    assert.deepEqual(ALL_STATUSES.filter(canRevise), ["ready", "empty", "proposed", "failed"]);
  });

  test("a session with nothing committed is still worth talking to", () => {
    assert.equal(canRevise("empty"), true);
    assert.equal(canRevise("failed"), true);
  });
});

describe("the actions offered for a session", () => {
  const local = { remote: false, github: false, admin: true };
  const gitlab = { remote: true, github: false, admin: true };
  const github = { remote: true, github: true, admin: true };
  const asMember = { remote: true, github: true, admin: false };

  test("a ready session in a local repository can only be merged or thrown away", () => {
    const actions = sessionActions(session(), local);
    assert.equal(actions.accept, true);
    assert.equal(actions.acceptAndSend, false);
    assert.equal(actions.pullRequest, false);
    assert.equal(actions.discard, true);
    assert.equal(actions.revise, true);
  });

  test("a non-GitHub remote can be pushed to but not proposed", () => {
    const actions = sessionActions(session(), gitlab);
    assert.equal(actions.acceptAndSend, true);
    assert.equal(actions.pullRequest, false);
  });

  test("a GitHub remote gets the pull request button", () => {
    const actions = sessionActions(session(), github);
    assert.equal(actions.pullRequest, true);
    assert.equal(actions.pullRequestIsUpdate, false);
  });

  test("the button becomes an update once a pull request exists", () => {
    const actions = sessionActions(
      session({
        status: "proposed",
        pullRequestUrl: "https://github.com/acme/product/pull/42",
        pullRequestNumber: 42,
      }),
      github,
    );
    assert.equal(actions.pullRequest, true);
    assert.equal(actions.pullRequestIsUpdate, true);
    assert.equal(actions.accept, true, "a proposed session can still be merged here");
    assert.equal(actions.revise, true);
  });

  test("a session with nothing committed offers nothing to merge", () => {
    const actions = sessionActions(session({ status: "empty" }), github);
    assert.equal(actions.accept, false);
    assert.equal(actions.acceptAndSend, false);
    assert.equal(actions.pullRequest, false);
    assert.equal(actions.discard, true, "there is still a branch to clean up");
  });

  test("a running session offers no destructive button while it works", () => {
    const actions = sessionActions(session({ status: "running" }), github);
    assert.equal(actions.accept, false);
    assert.equal(actions.pullRequest, false);
    assert.equal(actions.revise, false);
    assert.equal(actions.discard, false, "a turn in flight owns the worktree");
  });

  test("nothing is offered once the work is accepted or thrown away", () => {
    for (const status of ["published", "discarded"] as RepositoryWorkSessionStatus[]) {
      const actions = sessionActions(session({ status }), github);
      assert.deepEqual(
        { ...actions, pullRequestIsUpdate: false },
        {
          accept: false,
          acceptAndSend: false,
          pullRequest: false,
          pullRequestIsUpdate: false,
          discard: false,
          revise: false,
          remoteNeedsAdmin: false,
        },
        status,
      );
    }
  });

  test("an ordinary Member is not offered the two buttons the server refuses them", () => {
    const actions = sessionActions(session(), asMember);
    assert.equal(actions.accept, true, "merging here is a Member action");
    assert.equal(actions.discard, true);
    assert.equal(actions.revise, true);
    assert.equal(actions.acceptAndSend, false, "pushing is owner/admin only");
    assert.equal(actions.pullRequest, false, "opening a pull request is owner/admin only");
    assert.equal(actions.remoteNeedsAdmin, true, "and the page has to say why");
  });

  test("nothing is said about admins when the repository has no remote anyway", () => {
    const actions = sessionActions(session(), { remote: false, github: false, admin: false });
    assert.equal(actions.remoteNeedsAdmin, false);
  });

  test("only ready and proposed hold work worth reviewing", () => {
    assert.deepEqual(
      ALL_STATUSES.filter((status) => hasReviewableWork({ status })),
      ["ready", "proposed"],
    );
  });
});

describe("the session switcher's ordering and labels", () => {
  test("running first, then work waiting on a human, then everything else", () => {
    const rows = [
      session({ id: "done", status: "published", updatedAt: "2026-08-19T12:00:00.000Z" }),
      session({ id: "failed", status: "failed", updatedAt: "2026-08-19T09:00:00.000Z" }),
      session({ id: "ready", status: "ready", updatedAt: "2026-08-19T08:00:00.000Z" }),
      session({ id: "running", status: "running", updatedAt: "2026-08-19T07:00:00.000Z" }),
    ];
    assert.deepEqual(
      sortSessions(rows).map((row) => row.id),
      ["running", "ready", "failed", "done"],
    );
  });

  test("within a rank, the most recently touched comes first", () => {
    const rows = [
      session({ id: "older", status: "ready", updatedAt: "2026-08-19T08:00:00.000Z" }),
      session({ id: "newer", status: "proposed", updatedAt: "2026-08-19T11:00:00.000Z" }),
    ];
    assert.deepEqual(
      sortSessions(rows).map((row) => row.id),
      ["newer", "older"],
    );
  });

  test("does not mutate the array it was given", () => {
    const rows = [
      session({ id: "a", status: "published" }),
      session({ id: "b", status: "running" }),
    ];
    sortSessions(rows);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["a", "b"],
    );
  });

  test("falls back to the instruction when a session has no title", () => {
    assert.equal(sessionTitle(session({ title: "" })), "Add a health check endpoint and commit it");
    assert.equal(sessionTitle(session({ title: "  ", instruction: "  " })), "Untitled session");
    const long = sessionTitle(session({ title: "", instruction: "x".repeat(200) }));
    assert.ok(long.length <= 72);
    assert.match(long, /…$/);
  });

  test("names the employee, and the turn count once there is more than one", () => {
    assert.equal(sessionSubtitle(session()), "Ada");
    assert.equal(sessionSubtitle(session({ turnCount: 3 })), "Ada · 3 instructions");
    assert.equal(sessionSubtitle(session({ employee: null })), "Removed employee");
  });

  test("every status has a label and a tone", () => {
    for (const status of ALL_STATUSES) {
      assert.ok(SESSION_STATUS_LABEL[status], status);
      assert.ok(SESSION_STATUS_TONE[status], status);
    }
  });
});

describe("the session inbox", () => {
  test("exposes the three sections in their display order", () => {
    assert.deepEqual(SESSION_INBOX_GROUP_ORDER, ["in_progress", "review", "completed"]);
    assert.deepEqual(SESSION_INBOX_GROUP_LABEL, {
      in_progress: "In progress",
      review: "Needs attention",
      completed: "Completed",
    });
  });

  test("assigns every status to exactly one section", () => {
    assert.deepEqual(
      Object.fromEntries(ALL_STATUSES.map((status) => [status, sessionInboxGroup(status)])),
      {
        running: "in_progress",
        ready: "review",
        empty: "review",
        proposed: "review",
        published: "completed",
        discarded: "completed",
        failed: "review",
      },
    );
  });

  test("groups sessions without mutating them and keeps each section newest-first", () => {
    const rows = [
      session({ id: "published", status: "published", updatedAt: "2026-08-19T08:00:00.000Z" }),
      session({ id: "failed", status: "failed", updatedAt: "2026-08-19T09:00:00.000Z" }),
      session({ id: "running", status: "running", updatedAt: "2026-08-19T07:00:00.000Z" }),
      session({ id: "ready", status: "ready", updatedAt: "2026-08-19T11:00:00.000Z" }),
      session({ id: "discarded", status: "discarded", updatedAt: "2026-08-19T12:00:00.000Z" }),
    ];

    const groups = groupSessions(rows);

    assert.deepEqual(
      groups.in_progress.map((row) => row.id),
      ["running"],
    );
    assert.deepEqual(
      groups.review.map((row) => row.id),
      ["ready", "failed"],
    );
    assert.deepEqual(
      groups.completed.map((row) => row.id),
      ["discarded", "published"],
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ["published", "failed", "running", "ready", "discarded"],
    );
  });

  test("returns every section for an empty inbox", () => {
    assert.deepEqual(groupSessions([]), { in_progress: [], review: [], completed: [] });
  });
});

describe("session inbox search", () => {
  const row = session({
    title: "Harden OAuth callbacks",
    instruction: "Keep the existing refresh-token fallback",
    status: "proposed",
    branch: "genosyn/ADA/oauth-guard",
    employee: { id: "e1", name: "Ada Lovelace", slug: "ada", avatarKey: null },
  });

  test("blank search shows every session", () => {
    assert.equal(matchesSessionSearch(row, ""), true);
    assert.equal(matchesSessionSearch(row, "   "), true);
  });

  test("matches title and opening instruction case-insensitively", () => {
    assert.equal(matchesSessionSearch(row, "OAUTH CALLBACKS"), true);
    assert.equal(matchesSessionSearch(row, "REFRESH-token"), true);
  });

  test("matches employee, branch, and the human-readable status", () => {
    assert.equal(matchesSessionSearch(row, "lovelace"), true);
    assert.equal(matchesSessionSearch(row, "ADA/OAUTH-GUARD"), true);
    assert.equal(matchesSessionSearch(row, "pull request OPEN"), true);
  });

  test("does not match unrelated text or invent fields for removed employees", () => {
    assert.equal(matchesSessionSearch(row, "database migration"), false);
    assert.equal(
      matchesSessionSearch(session({ employee: null, branch: null }), "removed employee"),
      false,
    );
  });
});
