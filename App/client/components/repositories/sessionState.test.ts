import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  RepositoryForgeInfo,
  RepositoryWorkSession,
  RepositoryWorkSessionEvent,
  RepositoryWorkSessionStatus,
} from "../../lib/api";
import {
  SESSION_INBOX_GROUP_LABEL,
  SESSION_INBOX_GROUP_ORDER,
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TONE,
  appendSessionEvents,
  buildSessionActivity,
  canRevise,
  commandResultText,
  describeSessionActivity,
  eventSteps,
  eventsByTurn,
  groupSessions,
  hasReviewableWork,
  isArchived,
  lastEventOrdinal,
  matchesSessionSearch,
  sessionActions,
  sessionInboxGroup,
  sessionSearchText,
  sessionSubtitle,
  sessionTitle,
  sessionToolFamily,
  sortSessions,
  toolInput,
  toolOutput,
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
    archivedAt: null,
    createdAt: "2026-08-19T09:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    employee: { id: "e1", name: "Ada", slug: "ada", avatarKey: null },
    ...overrides,
  };
}

/** A self-hosted Forgejo one Connection covers, as the server describes it. */
const FORGEJO: RepositoryForgeInfo = {
  provider: "forgejo",
  name: "Forgejo",
  credential: "sole",
};

/** A public github.com remote: known, with no Connection behind it. */
const GITHUB: RepositoryForgeInfo = { provider: "github", name: "GitHub", credential: "none" };

/** The capability exactly as the repository pages derive it from the row. */
function fromForge(forge: RepositoryForgeInfo | null) {
  return { remote: true, pullRequests: !!forge, admin: true };
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
  const local = { remote: false, pullRequests: false, admin: true };
  // A remote nothing can speak for: pushable, but with no API behind it to
  // open a pull request through.
  const unanswerable = { remote: true, pullRequests: false, admin: true };
  const github = { remote: true, pullRequests: true, admin: true };
  const asMember = { remote: true, pullRequests: true, admin: false };

  test("a ready session in a local repository can only be merged or thrown away", () => {
    const actions = sessionActions(session(), local);
    assert.equal(actions.accept, true);
    assert.equal(actions.acceptAndSend, false);
    assert.equal(actions.pullRequest, false);
    assert.equal(actions.discard, true);
    assert.equal(actions.revise, true);
  });

  test("a remote no Connection speaks for can be pushed to but not proposed", () => {
    const actions = sessionActions(session(), unanswerable);
    assert.equal(actions.acceptAndSend, true);
    assert.equal(actions.pullRequest, false);
  });

  test("a remote a Connection speaks for gets the pull request button", () => {
    const actions = sessionActions(session(), github);
    assert.equal(actions.pullRequest, true);
    assert.equal(actions.pullRequestIsUpdate, false);
  });

  test("a self-hosted Forgejo repository reaches that same branch", () => {
    // The capability is "a forge Connection speaks for this host", which the
    // server answers on the row — the pages read `!!repo.forge` and nothing
    // here is allowed to care which host it turned out to be. A hostname test
    // in the browser could only ever have said yes to github.com.
    const forgejo = sessionActions(session(), fromForge(FORGEJO));
    assert.equal(forgejo.pullRequest, true);
    assert.deepEqual(forgejo, sessionActions(session(), fromForge(GITHUB)));
    assert.equal(sessionActions(session(), fromForge(null)).pullRequest, false);
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

  test("once the work is accepted or thrown away, only filing it away is left", () => {
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
          // Archiving is about the list, not the work — a finished session is
          // exactly the one somebody wants out of their inbox.
          archive: true,
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
    const actions = sessionActions(session(), { remote: false, pullRequests: false, admin: false });
    assert.equal(actions.remoteNeedsAdmin, false);
  });

  test("only ready and proposed hold work worth reviewing", () => {
    assert.deepEqual(
      ALL_STATUSES.filter((status) => hasReviewableWork({ status })),
      ["ready", "proposed"],
    );
  });
});

describe("filing a session away", () => {
  test("offered at every status except a turn in flight", () => {
    const offered = ALL_STATUSES.filter(
      (status) =>
        sessionActions(session({ status }), { remote: false, pullRequests: false, admin: false })
          .archive,
    );
    assert.deepEqual(offered, ["ready", "empty", "proposed", "published", "discarded", "failed"]);
  });

  test("an ordinary Member is offered it — nothing here reaches the remote", () => {
    const actions = sessionActions(session(), { remote: true, pullRequests: true, admin: false });
    assert.equal(actions.archive, true);
  });

  test("archived is a timestamp, not a status", () => {
    assert.equal(isArchived(session()), false);
    assert.equal(isArchived(session({ archivedAt: "2026-08-20T09:00:00.000Z" })), true);
    // The work's own state is untouched by it, which is the whole point of
    // keeping the two apart.
    assert.equal(session({ archivedAt: "2026-08-20T09:00:00.000Z" }).status, "ready");
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

  test("exposes the same complete index to compact searchable controls", () => {
    const index = sessionSearchText(row).toLowerCase();
    for (const term of [
      "harden oauth callbacks",
      "refresh-token fallback",
      "ada lovelace",
      "genosyn/ada/oauth-guard",
      "pull request open",
    ]) {
      assert.ok(index.includes(term), term);
    }
  });

  test("does not match unrelated text or invent fields for removed employees", () => {
    assert.equal(matchesSessionSearch(row, "database migration"), false);
    assert.equal(
      matchesSessionSearch(session({ employee: null, branch: null }), "removed employee"),
      false,
    );
  });
});

/**
 * The activity feed.
 *
 * The server writes one event per thing that happened; the feed shows one row
 * per *call*. Pairing results to calls, joining streamed narration, and
 * keeping only the latest step list are the rules that turn one into the
 * other — and a result matched to the wrong call shows a reviewer the wrong
 * output under the right file name, which is worse than showing nothing.
 */

let nextOrdinal = 1;

function event(
  overrides: Partial<RepositoryWorkSessionEvent> & { kind: RepositoryWorkSessionEvent["kind"] },
): RepositoryWorkSessionEvent {
  const ordinal = overrides.ordinal ?? nextOrdinal++;
  return {
    id: `ev-${ordinal}`,
    turnId: "t1",
    ordinal,
    name: "",
    callId: "",
    summary: "",
    detail: null,
    isError: false,
    createdAt: "2026-08-19T09:00:00.000Z",
    ...overrides,
  };
}

function call(name: string, callId: string, input: Record<string, unknown> = {}) {
  return event({ kind: "tool_use", name, callId, summary: `Called ${name}`, detail: { input } });
}

function result(name: string, callId: string, output = "", isError = false) {
  return event({
    kind: "tool_result",
    name,
    callId,
    summary: isError ? "Failed" : "Done",
    detail: { output },
    isError,
  });
}

function text(value: string) {
  return event({ kind: "text", detail: { text: value } });
}

describe("holding the feed incrementally", () => {
  test("the cursor is the last ordinal held, and zero before anything is", () => {
    assert.equal(lastEventOrdinal([]), 0);
    assert.equal(
      lastEventOrdinal([event({ kind: "text", ordinal: 3 }), event({ kind: "text", ordinal: 7 })]),
      7,
    );
  });

  test("appending nothing new returns the very same array", () => {
    const held = [event({ kind: "text", ordinal: 1 }), event({ kind: "text", ordinal: 2 })];
    assert.equal(appendSessionEvents(held, []), held);
    assert.equal(appendSessionEvents(held, [event({ kind: "text", ordinal: 2 })]), held);
  });

  test("drops rows already held and keeps ordinal order whichever fetch landed first", () => {
    const held = [event({ kind: "text", ordinal: 1 }), event({ kind: "text", ordinal: 2 })];
    const merged = appendSessionEvents(held, [
      event({ kind: "text", ordinal: 5 }),
      event({ kind: "text", ordinal: 2 }),
      event({ kind: "text", ordinal: 3 }),
      event({ kind: "text", ordinal: 3 }),
    ]);
    assert.deepEqual(
      merged.map((row) => row.ordinal),
      [1, 2, 3, 5],
    );
    assert.equal(held.length, 2, "the held array is never mutated");
  });

  test("splits a session's events by turn without reordering them", () => {
    const rows = [
      event({ kind: "text", ordinal: 1, turnId: "t1" }),
      event({ kind: "text", ordinal: 2, turnId: "t2" }),
      event({ kind: "text", ordinal: 3, turnId: "t1" }),
    ];
    const byTurn = eventsByTurn(rows);
    assert.deepEqual(
      byTurn.get("t1")?.map((row) => row.ordinal),
      [1, 3],
    );
    assert.deepEqual(
      byTurn.get("t2")?.map((row) => row.ordinal),
      [2],
    );
    assert.equal(byTurn.get("t3"), undefined);
  });
});

describe("reading event detail without trusting it", () => {
  test("accessors return empty values for detail of the wrong shape", () => {
    const odd = event({ kind: "tool_use", detail: "not an object" });
    assert.deepEqual(toolInput(odd), {});
    assert.equal(toolOutput(odd), "");
    assert.equal(eventSteps(odd), null);
    assert.deepEqual(toolInput(event({ kind: "tool_use", detail: { input: [1, 2] } })), {});
  });

  test("a step list keeps only well-formed steps", () => {
    const steps = eventSteps(
      event({
        kind: "steps",
        detail: {
          steps: [
            { text: "Read the router", status: "completed" },
            { text: "Add the route", status: "in_progress" },
            { text: "Broken", status: "unknown" },
            "not a step",
            { text: 42, status: "pending" },
          ],
        },
      }),
    );
    assert.deepEqual(steps, [
      { text: "Read the router", status: "completed" },
      { text: "Add the route", status: "in_progress" },
    ]);
  });

  test("a command result is unwrapped to what it printed", () => {
    assert.equal(
      commandResultText('{"ran":true,"exitCode":1,"output":"FAIL src/a.test.ts"}'),
      "FAIL src/a.test.ts",
    );
    assert.equal(
      commandResultText('{"ran":false,"reason":"curl is not on the allowed list"}'),
      "curl is not on the allowed list",
    );
    assert.equal(commandResultText("plain text"), "plain text");
    assert.equal(commandResultText("{not json"), "{not json");
    assert.equal(commandResultText('{"exitCode":0}'), '{"exitCode":0}');
  });

  test("every session tool has a family, and anything else is other", () => {
    assert.equal(sessionToolFamily("repository_read_file"), "read");
    assert.equal(sessionToolFamily("repository_edit_file"), "edit");
    assert.equal(sessionToolFamily("repository_write_file"), "write");
    assert.equal(sessionToolFamily("repository_delete_file"), "delete");
    assert.equal(sessionToolFamily("repository_search"), "search");
    assert.equal(sessionToolFamily("repository_glob"), "glob");
    assert.equal(sessionToolFamily("repository_list_files"), "list");
    assert.equal(sessionToolFamily("repository_status"), "status");
    assert.equal(sessionToolFamily("repository_diff"), "diff");
    assert.equal(sessionToolFamily("repository_run_command"), "command");
    assert.equal(sessionToolFamily("repository_commit"), "commit");
    assert.equal(sessionToolFamily("repository_update_steps"), "steps");
    assert.equal(sessionToolFamily("find_tools"), "other");
  });
});

describe("folding events into the feed", () => {
  test("pairs a result with its call by id, even when results land out of order", () => {
    const rows = [
      call("repository_read_file", "a", { path: "src/a.ts" }),
      call("repository_read_file", "b", { path: "src/b.ts" }),
      result("repository_read_file", "b", "contents of b"),
      result("repository_read_file", "a", "contents of a"),
    ];
    const { items } = buildSessionActivity(rows);
    assert.equal(items.length, 2);
    assert.ok(items[0].kind === "tool" && items[1].kind === "tool");
    assert.equal(items[0].call?.callId, "a");
    assert.equal(items[0].result && toolOutput(items[0].result), "contents of a");
    assert.equal(items[1].call?.callId, "b");
    assert.equal(items[1].result && toolOutput(items[1].result), "contents of b");
  });

  test("a call without a result yet stays open", () => {
    const { items } = buildSessionActivity([
      call("repository_run_command", "c", { command: "npm test" }),
    ]);
    assert.ok(items[0].kind === "tool");
    assert.equal(items[0].result, null);
  });

  test("a result with no call id falls back to the oldest open call of the same name", () => {
    const rows = [
      call("repository_status", ""),
      call("repository_diff", ""),
      result("repository_diff", "", "diff"),
      result("repository_status", "", "status"),
    ];
    const { items } = buildSessionActivity(rows);
    assert.ok(items[0].kind === "tool" && items[1].kind === "tool");
    assert.equal(items[0].result && toolOutput(items[0].result), "status");
    assert.equal(items[1].result && toolOutput(items[1].result), "diff");
  });

  test("a result whose call never arrived is still shown rather than dropped", () => {
    const { items } = buildSessionActivity([result("repository_commit", "orphan", "abc")]);
    assert.equal(items.length, 1);
    assert.ok(items[0].kind === "tool");
    assert.equal(items[0].call, null);
    assert.equal(items[0].result?.callId, "orphan");
  });

  test("joins streamed narration and keeps a tool call as a boundary", () => {
    const rows = [
      text("Let me look at "),
      text("the router first."),
      call("repository_read_file", "a", { path: "src/router.ts" }),
      result("repository_read_file", "a", "…"),
      text("Now the fix."),
      event({ kind: "text", detail: { text: "   " } }),
    ];
    const { items } = buildSessionActivity(rows);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["text", "tool", "text"],
    );
    assert.ok(items[0].kind === "text");
    assert.equal(items[0].text, "Let me look at the router first.");
    assert.ok(items[2].kind === "text");
    assert.equal(items[2].text, "Now the fix.");
  });

  test("keeps only the latest step list, and never shows it inline", () => {
    const rows = [
      event({
        kind: "steps",
        detail: {
          steps: [
            { text: "Read", status: "in_progress" },
            { text: "Fix", status: "pending" },
          ],
        },
      }),
      call("repository_read_file", "a", { path: "src/a.ts" }),
      event({
        kind: "steps",
        detail: {
          steps: [
            { text: "Read", status: "completed" },
            { text: "Fix", status: "in_progress" },
          ],
        },
      }),
    ];
    const { steps, items } = buildSessionActivity(rows);
    assert.deepEqual(steps, [
      { text: "Read", status: "completed" },
      { text: "Fix", status: "in_progress" },
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["tool"],
    );
    assert.equal(buildSessionActivity([]).steps, null);
  });

  test("compaction, retries, progress and a stop are one system line each", () => {
    const rows = [
      event({ kind: "compact", summary: "Dropped 3 older tool results" }),
      event({ kind: "retry", summary: "Model call retried (1 of 3)" }),
      event({ kind: "progress", summary: "40% — editing" }),
      event({ kind: "stopped", summary: "Stopped by a Member" }),
    ];
    const { items } = buildSessionActivity(rows);
    assert.deepEqual(
      items.map((item) => (item.kind === "system" ? item.event.kind : item.kind)),
      ["compact", "retry", "progress", "stopped"],
    );
  });

  test("counts calls, distinct files touched, commands and commits — skipping failures", () => {
    const rows = [
      call("repository_read_file", "r1", { path: "src/a.ts" }),
      result("repository_read_file", "r1"),
      call("repository_edit_file", "e1", { path: "src/a.ts" }),
      result("repository_edit_file", "e1"),
      call("repository_edit_file", "e2", { path: "src/a.ts" }),
      result("repository_edit_file", "e2"),
      call("repository_write_file", "w1", { path: "src/b.ts" }),
      result("repository_write_file", "w1"),
      call("repository_delete_file", "d1", { path: "src/c.ts" }),
      result("repository_delete_file", "d1", "old_string was not found", true),
      call("repository_run_command", "c1", { command: "npm test" }),
      result("repository_run_command", "c1"),
      call("repository_run_command", "c2", { command: "npm run lint" }),
      result("repository_run_command", "c2", "refused", true),
      call("repository_commit", "k1", { message: "Fix" }),
      result("repository_commit", "k1"),
    ];
    const { summary } = buildSessionActivity(rows);
    assert.deepEqual(summary, { toolCalls: 8, filesEdited: 2, commandsRun: 1, commits: 1 });
    assert.equal(
      describeSessionActivity(summary),
      "8 tool calls · 2 files edited · 1 command run · 1 commit",
    );
  });

  test("the one-line summary drops what did not happen and handles singulars", () => {
    assert.equal(
      describeSessionActivity({ toolCalls: 0, filesEdited: 0, commandsRun: 0, commits: 0 }),
      "No tool calls",
    );
    assert.equal(
      describeSessionActivity({ toolCalls: 1, filesEdited: 0, commandsRun: 0, commits: 0 }),
      "1 tool call",
    );
    assert.equal(
      describeSessionActivity({ toolCalls: 14, filesEdited: 3, commandsRun: 2, commits: 0 }),
      "14 tool calls · 3 files edited · 2 commands run",
    );
  });
});
