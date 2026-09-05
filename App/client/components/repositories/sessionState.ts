import {
  REVISABLE_WORK_SESSION_STATUSES,
  RepositoryWorkSession,
  RepositoryWorkSessionEvent,
  RepositoryWorkSessionStatus,
  RepositoryWorkSessionStep,
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

/** The three stable sections in the AI work inbox, in display order. */
export const SESSION_INBOX_GROUP_ORDER = ["in_progress", "review", "completed"] as const;

export type SessionInboxGroup = (typeof SESSION_INBOX_GROUP_ORDER)[number];

export const SESSION_INBOX_GROUP_LABEL: Record<SessionInboxGroup, string> = {
  in_progress: "In progress",
  review: "Needs attention",
  completed: "Completed",
};

/** Which inbox section owns a session status. */
export function sessionInboxGroup(status: RepositoryWorkSessionStatus): SessionInboxGroup {
  if (status === "running") return "in_progress";
  if (status === "published" || status === "discarded") return "completed";
  return "review";
}

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
   * File the session away, or take it back out — the same button either way,
   * because the two are one decision with the flag flipped.
   *
   * Offered at every status except a turn in flight. Archiving touches no
   * branch and ends nothing, so there is no state where it is destructive;
   * hiding running work behind a filter, on the other hand, is the one thing
   * an inbox must never do.
   */
  archive: boolean;
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
  /**
   * A forge Connection can speak for this remote's host, so there is an API to
   * open a pull request through. This is not "the remote is on github.com" any
   * more: a self-hosted Forgejo the company connected is just as answerable,
   * and a github.com remote is only answerable because github.com is the one
   * host Genosyn knows without being told. The server decides — the browser
   * never sees a Connection's base URL — and sends the answer on the row.
   */
  pullRequests: boolean;
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
 * `remote` and `pullRequests` are separate because a self-hosted GitLab remote
 * can be pushed to and cannot be given a pull request from here, and offering
 * the button anyway would be a lie. `admin` is separate again because it is about
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
    pullRequest: reviewable && repo.remote && repo.pullRequests && repo.admin,
    pullRequestIsUpdate: !!session.pullRequestUrl,
    // Not while a turn is in flight: it owns the worktree, and throwing the
    // branch away underneath it makes the turn fail on a directory that
    // vanished — reported afterwards as if the employee had broken something.
    discard:
      session.status !== "published" &&
      session.status !== "discarded" &&
      session.status !== "running",
    revise: canRevise(session.status),
    archive: session.status !== "running",
    remoteNeedsAdmin: reviewable && repo.remote && !repo.admin,
  };
}

/** Whether a session has been filed away out of the inbox. */
export function isArchived(session: Pick<RepositoryWorkSession, "archivedAt">): boolean {
  return session.archivedAt !== null;
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

/**
 * Split a session list into the inbox's stable sections.
 *
 * Every section is present even when empty, and rows retain the established
 * session ordering within it. The input is never mutated.
 */
export function groupSessions(
  sessions: readonly RepositoryWorkSession[],
): Record<SessionInboxGroup, RepositoryWorkSession[]> {
  const groups: Record<SessionInboxGroup, RepositoryWorkSession[]> = {
    in_progress: [],
    review: [],
    completed: [],
  };
  for (const session of sortSessions([...sessions])) {
    groups[sessionInboxGroup(session.status)].push(session);
  }
  return groups;
}

/** The complete search index shared by the desktop inbox and compact switcher. */
export function sessionSearchText(session: RepositoryWorkSession): string {
  return [
    session.title,
    session.instruction,
    session.employee?.name ?? "",
    session.branch ?? "",
    SESSION_STATUS_LABEL[session.status],
  ].join(" ");
}

/** Whether a session matches the inbox's free-text search. */
export function matchesSessionSearch(session: RepositoryWorkSession, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return sessionSearchText(session).toLowerCase().includes(needle);
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

// ───────────────────────── the activity feed ─────────────────────────

/**
 * The live record of a turn, as the feed shows it.
 *
 * The server writes one append-only event per thing that happened — a tool
 * call, its result, a stretch of narration, a step-list update — and the
 * client reads them incrementally by ordinal. What a person wants to see is
 * not that stream but a list of *calls*: each tool call as one row that fills
 * in when its result lands, narration as prose between them, the step list
 * once (its latest state), and the rest as one-line notes. The functions
 * below do that folding, so the component only renders.
 */

/** The last ordinal a list of events holds — the cursor for the next fetch. */
export function lastEventOrdinal(events: readonly RepositoryWorkSessionEvent[]): number {
  return events.length === 0 ? 0 : events[events.length - 1].ordinal;
}

/**
 * Add a fetched page to the events already held.
 *
 * Returns the very same array when nothing was new, so a state setter can
 * bail out and a memo keyed on it stays put. Duplicates are dropped by
 * ordinal — two fetches overlapping in flight both return the same rows —
 * and the result is kept in ordinal order whichever landed first.
 */
export function appendSessionEvents(
  current: RepositoryWorkSessionEvent[],
  incoming: readonly RepositoryWorkSessionEvent[],
): RepositoryWorkSessionEvent[] {
  if (incoming.length === 0) return current;
  const held = new Set(current.map((event) => event.ordinal));
  const fresh: RepositoryWorkSessionEvent[] = [];
  for (const event of incoming) {
    if (held.has(event.ordinal)) continue;
    held.add(event.ordinal);
    fresh.push(event);
  }
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((a, b) => a.ordinal - b.ordinal);
}

/** The session's events split by the turn they belong to, order preserved. */
export function eventsByTurn(
  events: readonly RepositoryWorkSessionEvent[],
): Map<string, RepositoryWorkSessionEvent[]> {
  const byTurn = new Map<string, RepositoryWorkSessionEvent[]>();
  for (const event of events) {
    const list = byTurn.get(event.turnId);
    if (list) list.push(event);
    else byTurn.set(event.turnId, [event]);
  }
  return byTurn;
}

/** What kind of thing a tool does — the feed picks its icon from this. */
export type SessionToolFamily =
  | "read"
  | "edit"
  | "write"
  | "delete"
  | "search"
  | "glob"
  | "list"
  | "status"
  | "diff"
  | "command"
  | "commit"
  | "steps"
  | "other";

export function sessionToolFamily(name: string): SessionToolFamily {
  switch (name) {
    case "repository_read_file":
      return "read";
    case "repository_edit_file":
      return "edit";
    case "repository_write_file":
      return "write";
    case "repository_delete_file":
      return "delete";
    case "repository_search":
      return "search";
    case "repository_glob":
      return "glob";
    case "repository_list_files":
      return "list";
    case "repository_status":
      return "status";
    case "repository_diff":
      return "diff";
    case "repository_run_command":
      return "command";
    case "repository_commit":
      return "commit";
    case "repository_update_steps":
      return "steps";
    default:
      return "other";
  }
}

function detailRecord(event: RepositoryWorkSessionEvent): Record<string, unknown> | null {
  const detail = event.detail;
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : null;
}

/** The narration a `text` event carries. */
export function eventText(event: RepositoryWorkSessionEvent): string {
  const text = detailRecord(event)?.text;
  return typeof text === "string" ? text : "";
}

/** The arguments a `tool_use` event was called with. */
export function toolInput(event: RepositoryWorkSessionEvent): Record<string, unknown> {
  const input = detailRecord(event)?.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** The clipped output a `tool_result` event carries. */
export function toolOutput(event: RepositoryWorkSessionEvent): string {
  const output = detailRecord(event)?.output;
  return typeof output === "string" ? output : "";
}

const STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** The step list a `steps` event carries, or null when it is not one. */
export function eventSteps(event: RepositoryWorkSessionEvent): RepositoryWorkSessionStep[] | null {
  const steps = detailRecord(event)?.steps;
  if (!Array.isArray(steps)) return null;
  const out: RepositoryWorkSessionStep[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const { text, status } = step as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || typeof status !== "string" || !STEP_STATUSES.has(status)) {
      continue;
    }
    out.push({ text, status: status as RepositoryWorkSessionStep["status"] });
  }
  return out;
}

/**
 * What a `repository_run_command` result prints.
 *
 * The tool answers the model with a JSON object — `output`, `exitCode`,
 * `timedOut`, or `ran: false` with a `reason` — because the model needs the
 * exit code as a number. A person needs the output as text and the rest as
 * the row's one-line summary, so this unwraps it and falls back to the raw
 * text for anything that is not that shape.
 */
export function commandResultText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    const record = parsed as Record<string, unknown>;
    if (record.ran === false && typeof record.reason === "string") return record.reason;
    if (typeof record.output === "string") return record.output;
    return raw;
  } catch {
    return raw;
  }
}

export type SessionActivityItem =
  | {
      kind: "tool";
      key: string;
      /** The call. Null only for a result whose call never arrived. */
      call: RepositoryWorkSessionEvent | null;
      /** The result, once it has landed. */
      result: RepositoryWorkSessionEvent | null;
    }
  | { kind: "text"; key: string; text: string }
  | { kind: "system"; key: string; event: RepositoryWorkSessionEvent };

export type SessionActivitySummary = {
  toolCalls: number;
  /** Distinct paths edited, written, or deleted by a call that did not fail. */
  filesEdited: number;
  commandsRun: number;
  commits: number;
};

export type SessionActivity = {
  /** The latest step list, or null when the employee never wrote one. */
  steps: RepositoryWorkSessionStep[] | null;
  items: SessionActivityItem[];
  summary: SessionActivitySummary;
};

/**
 * Fold one turn's events into what the feed renders.
 *
 * A `tool_result` is matched to its `tool_use` by `callId`, not by position:
 * read-only calls run concurrently on the server, so results arrive in
 * whatever order they finish. A result whose call carried no id is matched
 * to the oldest open call of the same name. Consecutive narration is joined
 * — the server flushes it in pieces so it streams, and the pieces are one
 * paragraph.
 */
export function buildSessionActivity(
  events: readonly RepositoryWorkSessionEvent[],
): SessionActivity {
  const items: SessionActivityItem[] = [];
  let steps: RepositoryWorkSessionStep[] | null = null;
  const openByCallId = new Map<string, number>();
  const openByName = new Map<string, number[]>();

  for (const event of events) {
    switch (event.kind) {
      case "tool_use": {
        items.push({ kind: "tool", key: event.id, call: event, result: null });
        const index = items.length - 1;
        if (event.callId) openByCallId.set(event.callId, index);
        else {
          const queue = openByName.get(event.name);
          if (queue) queue.push(index);
          else openByName.set(event.name, [index]);
        }
        break;
      }
      case "tool_result": {
        let index: number | undefined;
        if (event.callId && openByCallId.has(event.callId)) {
          index = openByCallId.get(event.callId);
          openByCallId.delete(event.callId);
        } else {
          index = openByName.get(event.name)?.shift();
        }
        const item = index === undefined ? undefined : items[index];
        if (item && item.kind === "tool" && !item.result) item.result = event;
        else items.push({ kind: "tool", key: event.id, call: null, result: event });
        break;
      }
      case "text": {
        const text = eventText(event);
        if (!text.trim()) break;
        const last = items[items.length - 1];
        if (last && last.kind === "text") last.text += text;
        else items.push({ kind: "text", key: event.id, text });
        break;
      }
      case "steps": {
        steps = eventSteps(event) ?? steps;
        break;
      }
      default:
        items.push({ kind: "system", key: event.id, event });
    }
  }

  const summary: SessionActivitySummary = {
    toolCalls: 0,
    filesEdited: 0,
    commandsRun: 0,
    commits: 0,
  };
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || !item.call) continue;
    summary.toolCalls += 1;
    const family = sessionToolFamily(item.call.name);
    const failed = item.result?.isError === true;
    if (family === "command" && !failed) summary.commandsRun += 1;
    if (family === "commit" && !failed) summary.commits += 1;
    if ((family === "edit" || family === "write" || family === "delete") && !failed) {
      const path = toolInput(item.call).path;
      paths.add(typeof path === "string" && path ? path : item.call.id);
    }
  }
  summary.filesEdited = paths.size;

  return { steps, items, summary };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "14 tool calls · 3 files edited · 2 commands run" — the collapsed feed's one line. */
export function describeSessionActivity(summary: SessionActivitySummary): string {
  if (summary.toolCalls === 0) return "No tool calls";
  const parts = [plural(summary.toolCalls, "tool call")];
  if (summary.filesEdited > 0) parts.push(`${plural(summary.filesEdited, "file")} edited`);
  if (summary.commandsRun > 0) parts.push(`${plural(summary.commandsRun, "command")} run`);
  if (summary.commits > 0) parts.push(plural(summary.commits, "commit"));
  return parts.join(" · ");
}
