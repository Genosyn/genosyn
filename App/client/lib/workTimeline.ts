import type {
  WorkEmployeeSummary,
  WorkEntry,
  WorkEntryDigest,
  WorkEntryKind,
  WorkEntryRun,
} from "./api";

/**
 * The presentation rules behind Home's AI Employee work timeline.
 *
 * Everything here is a pure function on data the server already decided, and
 * it lives in `lib/` rather than in the component for one reason: client tests
 * in this repo have no DOM and cannot render, so logic worth pinning has to be
 * reachable without React. What each row *says* — and where it goes when you
 * click it — is exactly the part worth pinning.
 *
 * The component owns colour, icons, and layout. This file owns wording,
 * grouping, and destinations.
 */

/** How a kind is announced, and its chip colours. */
export type WorkKindMeta = {
  label: string;
  /**
   * Tailwind classes for the row's 28px chip. Every tone carries a `dark:`
   * partner — a light-only tone renders as an invisible chip on a dark page,
   * which is how the revenue timeline learned to state this rule out loud.
   */
  tone: string;
};

export const WORK_KIND_META: Record<WorkEntryKind, WorkKindMeta> = {
  run: {
    label: "Routine run",
    tone: "bg-indigo-50 text-indigo-600 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20",
  },
  chat: {
    label: "Conversation",
    tone: "bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20",
  },
  work_session: {
    label: "Repository work",
    tone: "bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20",
  },
  approval: {
    label: "Approval required",
    tone: "bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  },
  wakeup: {
    label: "Wakeup",
    tone: "bg-teal-50 text-teal-600 ring-teal-100 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-500/20",
  },
  lesson: {
    label: "Lesson",
    tone: "bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20",
  },
  effect: {
    label: "Change",
    tone: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
};

/** Every kind, in the order the union declares them. Table-driven tests use it. */
export const WORK_ENTRY_KINDS: readonly WorkEntryKind[] = [
  "run",
  "chat",
  "work_session",
  "approval",
  "wakeup",
  "lesson",
  "effect",
];

export type WorkDayGroup = { key: string; label: string; items: WorkEntry[] };

/**
 * The small set of states Home needs to describe an employee at a glance.
 *
 * `working` is intentionally narrow: a missing `endedAt` does not make an
 * ordinary chat reply, Wakeup, or ledger row live forever. Only source rows
 * that carry an explicit in-flight state qualify. A pending Approval is
 * separate because the employee is waiting for a Member, not still working.
 */
export type EmployeeWorkState = "working" | "waiting" | "recent" | "quiet";

export type EmployeeWorkSummary = {
  employeeId: string;
  state: EmployeeWorkState;
  /** The newest explicitly in-flight row, when there is one. */
  currentEntry: WorkEntryDigest | null;
  /** The newest pending Approval, when there is one. */
  waitingEntry: WorkEntryDigest | null;
  /** The newest row of any kind. */
  latestEntry: WorkEntryDigest | null;
  entryCount: number;
};

/** Whether a row represents work that is still happening right now. */
export function isWorkEntryActive(entry: WorkEntry): boolean {
  return entry.active;
}

/** Whether the employee has stopped at a human gate and is waiting. */
export function isWorkEntryWaiting(entry: WorkEntry): boolean {
  return (
    entry.kind === "approval" &&
    entry.endedAt === null &&
    entry.detail.trim().toLowerCase() === "pending"
  );
}

/**
 * One employee's status from a newest-first timeline response.
 *
 * Working takes precedence over waiting: an employee can have an old pending
 * Approval and still be making progress elsewhere. Waiting takes precedence
 * over merely recent work so the roster does not make a human gate look idle.
 */
export function summarizeEmployeeWork(
  employeeId: string,
  entries: WorkEntry[],
  rollup?: WorkEmployeeSummary,
  window?: { nowIso: string; hours?: number },
): EmployeeWorkSummary {
  const own = entries.filter((entry) => entry.employee.id === employeeId);
  const resolveDigest = (
    value: WorkEntryDigest | null,
    matches: (entry: WorkEntry) => boolean = () => true,
  ): WorkEntryDigest | null =>
    value ? (own.find((entry) => entry.id === value.id && matches(entry)) ?? value) : null;
  const currentEntry = rollup
    ? resolveDigest(rollup.current, (entry) => entry.active === rollup.current?.active)
    : (own.find(isWorkEntryActive) ?? null);
  const waitingEntry = rollup
    ? resolveDigest(rollup.waiting, isWorkEntryWaiting)
    : (own.find(isWorkEntryWaiting) ?? null);
  const latest = rollup ? resolveDigest(rollup.latest) : (own[0] ?? null);
  const latestEntry =
    latest && window && !isWorkInsideWindow(latest.at, window.nowIso, window.hours) ? null : latest;
  const state: EmployeeWorkState = currentEntry
    ? "working"
    : waitingEntry
      ? "waiting"
      : latestEntry
        ? "recent"
        : "quiet";
  return {
    employeeId,
    state,
    currentEntry,
    waitingEntry,
    latestEntry,
    entryCount: rollup?.entryCount ?? own.length,
  };
}

/** Whether a timestamp still belongs in the rolling work-history window. */
export function isWorkInsideWindow(atIso: string, nowIso: string, hours = 24): boolean {
  const at = new Date(atIso).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(at) || Number.isNaN(now)) return true;
  return at >= now - hours * 60 * 60 * 1000;
}

/**
 * Count the rows the rolling list can still claim truthfully.
 *
 * At the server's snapshot time, `total` includes hidden rows beyond the
 * response limit. Once the local clock advances, their timestamps are unknown.
 * If one visible row has aged out, every hidden row is older; even before that,
 * a hidden row may already have crossed the boundary. Fall back to the visible
 * count instead of showing a precise but stale overflow total.
 */
export function workDisplayEntryCount(
  total: number,
  returned: number,
  visible: number,
  snapshotUntilIso: string,
  nowIso: string,
): number {
  const snapshotUntil = new Date(snapshotUntilIso).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(snapshotUntil) || Number.isNaN(now) || now > snapshotUntil) return visible;
  return Math.max(visible, total - (returned - visible));
}

/** Short relative time for a timeline row, deterministic when `nowIso` is supplied. */
export function workRelativeTime(iso: string, nowIso = new Date().toISOString()): string {
  const at = new Date(iso).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(at) || Number.isNaN(now)) return "";
  const elapsed = Math.max(0, now - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** The status line underneath one employee bubble. */
export function employeeWorkStatusLabel(
  summary: EmployeeWorkSummary,
  nowIso = new Date().toISOString(),
): string {
  switch (summary.state) {
    case "working":
      return "Working now";
    case "waiting":
      return "Waiting for input";
    case "recent": {
      const relative = summary.latestEntry
        ? workRelativeTime(summary.latestEntry.at, nowIso).toLowerCase()
        : "";
      return relative ? `Active ${relative}` : "Active today";
    }
    case "quiet":
      return "Quiet today";
  }
}

const ACTION_VERBS: Record<string, string> = {
  add: "Added",
  approve: "Approved",
  archive: "Archived",
  assign: "Assigned",
  cancel: "Cancelled",
  comment: "Commented on",
  complete: "Completed",
  connect: "Connected",
  create: "Created",
  delete: "Deleted",
  disconnect: "Disconnected",
  download: "Downloaded",
  edit: "Updated",
  invoke: "Used",
  issue: "Issued",
  link: "Linked",
  read: "Read",
  move: "Moved",
  publish: "Published",
  reject: "Rejected",
  remove: "Removed",
  restore: "Restored",
  schedule: "Scheduled",
  send: "Sent",
  unlink: "Unlinked",
  update: "Updated",
  upload: "Uploaded",
  use: "Used",
  write: "Updated",
};

function readableWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
}

/** An effect-ledger action split into the two words a sentence needs. */
function splitWorkAction(action: string, targetType: string): { verb: string; target: string } {
  const actionParts = action.split(/[.:/]/).filter(Boolean);
  const operation = readableWords(actionParts.at(-1) ?? action);
  const target = readableWords(targetType || actionParts.at(-2) || "record");
  const verb =
    ACTION_VERBS[operation] ?? `${operation.charAt(0).toUpperCase()}${operation.slice(1)}`;
  return { verb, target };
}

/** Turn an effect-ledger action such as `invoice.create` into reader-facing copy. */
export function humanizeWorkAction(action: string, targetType: string): string {
  const { verb, target } = splitWorkAction(action, targetType);
  return [verb, target].filter(Boolean).join(" ");
}

/** Reader-facing detail copy where a source stores a compact status token. */
export function workDetailLabel(entry: Pick<WorkEntry, "kind" | "detail">): string {
  if (entry.kind !== "approval") return entry.detail;
  const approval: Record<string, string> = {
    pending: "Waiting for input",
    executing: "Applying the approved action",
    approved: "Approved",
    execution_failed: "Approved action failed",
    rejected: "Rejected",
    expired: "Expired",
  };
  return approval[entry.detail.trim().toLowerCase()] ?? readableWords(entry.detail);
}

/** Supporting row copy after compact source tokens have been translated. */
export function workDisplayDetail(entry: Pick<WorkEntry, "kind" | "title" | "detail">): string {
  if (entry.kind === "effect") return entry.title === entry.detail ? "" : entry.title;
  return workDetailLabel(entry);
}

export function workDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today" / "Yesterday" / "Tue, 3 Sep". Year only when it is not this one. */
export function workDayLabel(d: Date): string {
  const now = new Date();
  if (workDayKey(d) === workDayKey(now)) return "Today";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (workDayKey(d) === workDayKey(yesterday)) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

/**
 * Consecutive rows on the same calendar day, in the order the server sent.
 *
 * Deliberately consecutive rather than bucketed: the server has already sorted
 * newest-first, and re-bucketing would let a clock-skewed row silently reorder
 * the whole list to keep its day together.
 */
export function groupWorkByDay(entries: WorkEntry[]): WorkDayGroup[] {
  const groups: WorkDayGroup[] = [];
  for (const entry of entries) {
    const d = new Date(entry.at);
    const valid = !Number.isNaN(d.getTime());
    const key = valid ? workDayKey(d) : "unknown";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(entry);
      continue;
    }
    groups.push({ key, label: valid ? workDayLabel(d) : "Undated", items: [entry] });
  }
  return groups;
}

/** Local clock time for a row. Empty when the timestamp will not parse. */
export function workClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Where a row goes when it is clicked, or null when it has nowhere to go.
 *
 * A bare ledger row is the honest null: it records that something changed,
 * and the record is the whole of it — there is no page for "the invoice total
 * was edited" that is not just the invoice.
 */
export function workEntryHref(entry: WorkEntry, companySlug: string): string | null {
  const base = `/c/${companySlug}`;
  switch (entry.kind) {
    case "run":
      if (!entry.run) return null;
      // The rollup knows a routine id but not its slug; the Routines index
      // resolves the id and forwards to that run's history — the shape Home's
      // failed-routines panel already uses.
      return `${base}/routines?${new URLSearchParams({
        routine: entry.run.routineId,
        run: entry.run.id,
      }).toString()}`;
    case "chat":
      return `${base}/employees/${entry.employee.slug}/chat`;
    case "work_session":
      return `${base}/repositories`;
    case "approval":
      return `${base}/approvals`;
    case "wakeup":
    case "lesson":
      return `${base}/employees/${entry.employee.slug}`;
    case "effect":
      return null;
  }
}

/** What the button leading away from an entry should say. */
export function workEntryLinkLabel(entry: Pick<WorkEntry, "kind">): string {
  switch (entry.kind) {
    case "run":
      return "Open the run";
    case "chat":
      return "Open the conversation";
    case "work_session":
      return "Open Repositories";
    case "approval":
      return "Open Approvals";
    case "wakeup":
    case "lesson":
      return "Open the employee";
    case "effect":
      return "";
  }
}

/**
 * What the footer says when the window holds more than the panel drew.
 * Null when everything in the window is on screen.
 */
export function workOverflowLabel(shown: number, total: number): string | null {
  if (total <= shown) return null;
  return `Showing the ${shown} most recent of ${total}`;
}

/** "3 more changes" under a capped effects strip; null when nothing was withheld. */
export function workEffectOverflowLabel(
  entry: WorkEntry,
  shown = entry.effects.length,
): string | null {
  const hidden = entry.effectCount - shown;
  if (hidden <= 0) return null;
  return `${hidden} more ${hidden === 1 ? "change" : "changes"}`;
}

/** The empty-state line, which depends on whether a name was chosen. */
export function workEmptyTitle(employeeName: string | null, hours: number): string {
  const window = hours === 24 ? "the last 24 hours" : `the last ${hours} hours`;
  return employeeName
    ? `${employeeName} has not done anything in ${window}.`
    : `Nothing has been done in ${window}.`;
}

// ─────────────────────────── plain English ──────────────────────────────────
//
// Everything below turns one entry into sentences. The panel used to print the
// server's own compact strings — `Ran Nightly digest`, `3 replies`, `pending`,
// `4 files · +120 · −33` — beside a coloured chip whose meaning was the legend
// nobody had. A reader had to already know the product to know what happened.
// These functions answer, in order: who did it, what they did it to, when, how
// long it took, what it changed, and how it ended.

/** The window every surface here describes. The server's own default. */
export const WORK_WINDOW_HOURS = 24;

/** "a", "b and c" — an Oxford-comma-free list, because these are prose. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function pluralNoun(noun: string): string {
  const words = noun.split(" ");
  const last = words[words.length - 1] ?? "";
  if (!last) return noun;
  const plural = /(?:s|x|z|ch|sh)$/.test(last)
    ? `${last}es`
    : /[^aeiou]y$/.test(last)
      ? `${last.slice(0, -1)}ies`
      : `${last}s`;
  return [...words.slice(0, -1), plural].join(" ");
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function capitalize(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/** A model- or human-written fragment, made to stand as its own sentence. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?…。！？]$/.test(trimmed) ? capitalize(trimmed) : `${capitalize(trimmed)}.`;
}

/**
 * How long a piece of work took, in words rather than in a duration format.
 *
 * Empty when the source recorded no end, which is not the same as zero — and
 * empty for a zero-length span too, because that is what a source that stamps
 * one instant looks like. A repository turn windows on the moment it finished,
 * so reading its span as a duration would report every one of them as having
 * taken "under a minute".
 */
export function workDurationLabel(startIso: string, endIso: string | null): string {
  if (!endIso) return "";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  const rest = minutes % 60;
  const hourPart = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest ? `${hourPart} ${rest} ${rest === 1 ? "minute" : "minutes"}` : hourPart;
}

/**
 * The ledger rows under one entry, counted and named: "created 2 invoices,
 * sent an email and made 4 other changes".
 *
 * Grouped in first-appearance order because `effects` arrive oldest-first and
 * a run's ledger reads as a sequence. The tail stays honest about both kinds
 * of omission — groups this phrase did not name, and rows the server capped
 * before sending.
 */
export function workEffectPhrase(
  entry: Pick<WorkEntry, "effects" | "effectCount">,
  maxGroups = 3,
): string {
  const groups = new Map<string, { verb: string; target: string; count: number }>();
  for (const effect of entry.effects) {
    const { verb, target } = splitWorkAction(effect.action, effect.targetType);
    const key = `${verb}|${target}`;
    const seen = groups.get(key);
    if (seen) seen.count += 1;
    else groups.set(key, { verb, target, count: 1 });
  }
  const ordered = [...groups.values()];
  const shown = ordered.slice(0, maxGroups);
  const withheld =
    ordered.slice(maxGroups).reduce((total, group) => total + group.count, 0) +
    Math.max(0, entry.effectCount - entry.effects.length);
  const parts = shown.map((group) =>
    group.count === 1
      ? `${group.verb.toLowerCase()} ${withArticle(group.target)}`
      : `${group.verb.toLowerCase()} ${group.count} ${pluralNoun(group.target)}`,
  );
  if (withheld > 0) {
    parts.push(`made ${withheld} other ${withheld === 1 ? "change" : "changes"}`);
  }
  return joinList(parts);
}

/** A concise qualification of the reported outcome, independent of its wording. */
function runOutcomeSentence(run: WorkEntryRun): string {
  const verdict =
    run.outcomeVerdict === "off_goal"
      ? "The result did not meet the routine's acceptance criteria"
      : run.outcomeVerdict === "unclear"
        ? "A grader could not confirm whether the goal was met"
        : run.outcomeVerdict === "unverified"
          ? "The outcome has not been verified"
          : "";
  const check = run.checksVerdict === "failed" ? "a required Check failed" : "";
  return asSentence([verdict, check].filter(Boolean).join("; "));
}

/** The absence of a report never means that no work happened. */
function runFallbackSentence(run: WorkEntryRun | null, active: boolean): string {
  if (active) return "This routine is still running. Its outcome will appear when it finishes.";
  switch (run?.status) {
    case "failed":
      return "This run failed. Open the run log for details.";
    case "timeout":
      return "This run ran out of time before it finished.";
    case "skipped":
      return "This routine did not run because no AI Model was assigned.";
    case "interrupted":
      return "This run was interrupted before it finished.";
    default:
      return "No outcome summary is available for this run.";
  }
}

/** How an Approval ended, in a sentence. */
function approvalStatusSentence(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "pending":
      return "Nobody has answered yet, so that piece of work is still on hold.";
    case "executing":
      return "A Member approved it, and the server is applying the action now.";
    case "approved":
      return "A Member approved it.";
    case "execution_failed":
      return "A Member approved it, but the action failed when the server replayed it.";
    case "rejected":
      return "A Member rejected it, so the action never ran.";
    case "expired":
      return "Nobody answered in time, so the request expired.";
    default:
      return status ? `Its status is ${readableWords(status)}.` : "";
  }
}

/**
 * One entry as prose: a headline sentence, then up to three supporting ones.
 *
 * Routine entries lead with their reported outcome. The employee, Routine and
 * duration stay in a quiet context line so the result remains easy to find.
 * Other kinds keep the employee as their grammatical subject.
 */
export type WorkNarrative = {
  /** The outcome, or a factual description when no outcome is available. */
  headline: string;
  /** Routine and employee context, separate from the result. */
  context?: string;
  /** Supporting context or a qualification of the reported outcome. */
  body: string[];
};

export function workNarrative(entry: WorkEntry, opts: { nowIso?: string } = {}): WorkNarrative {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const who = entry.employee.name;
  const clock = workClock(entry.at);
  const when = clock ? ` at ${clock}` : "";
  const subject = entry.subject.trim();
  const named = subject ? `“${subject}”` : "";
  const took = workDurationLabel(entry.at, entry.endedAt);
  const forSoFar = workDurationLabel(entry.at, nowIso);
  const stat = workDisplayDetail(entry);
  const effects = entry.kind === "run" ? "" : workEffectPhrase(entry);
  const body: string[] = [];
  let clause = "";

  switch (entry.kind) {
    case "run": {
      const run = entry.run;
      const completed = !entry.active && run?.status === "completed";
      // A report is a result only after completion. A stale or partial report
      // must not make a live, skipped or failed Run look like finished work.
      const summary = completed ? run.summary?.trim() : "";
      const headline = summary ? asSentence(summary) : runFallbackSentence(run, entry.active);
      if (completed) {
        const outcome = runOutcomeSentence(run);
        if (outcome) body.push(outcome);
      } else if (!entry.active && run?.checksVerdict === "failed") {
        body.push("A required Check failed.");
      }
      const routine = subject || run?.routineName.trim() || "Routine";
      const duration = entry.active ? forSoFar && `${forSoFar} so far` : took;
      return {
        headline,
        context: [who, routine, duration].filter(Boolean).join(" · "),
        body,
      };
    }
    case "chat": {
      const thread = named || "a conversation";
      clause = entry.active
        ? `is working on a reply in ${thread}, started ${workRelativeTime(entry.at, nowIso).toLowerCase()}.`
        : `replied in ${thread}${when}${stat ? ` (${stat})` : ""}.`;
      if (entry.active && stat && stat !== "Working on a reply")
        body.push(`Progress so far: ${stat}.`);
      if (effects) body.push(`In that thread it ${effects}.`);
      break;
    }
    case "work_session": {
      const repository = named || "a repository";
      clause = entry.active
        ? `is working in ${repository}, started${when}${forSoFar ? `, ${forSoFar} so far` : ""}.`
        : `worked in ${repository}${when}${took ? ` for ${took}` : ""}${stat ? ` (${stat})` : ""}.`;
      if (effects) body.push(`It ${effects}.`);
      break;
    }
    case "approval": {
      clause = `stopped and asked for approval${when}: ${named || "an action it could not take on its own"}.`;
      const status = approvalStatusSentence(entry.detail);
      if (status) body.push(status);
      break;
    }
    case "wakeup": {
      clause = `woke itself up${when} to follow something through.`;
      if (stat) body.push(asSentence(stat));
      break;
    }
    case "lesson": {
      clause = `took a lesson from a graded run${when}${subject ? `: ${subject}` : ""}.`;
      if (stat) body.push(`What it will do differently: ${asSentence(stat)}`);
      break;
    }
    case "effect": {
      const action = humanizeWorkAction(entry.detail, "");
      clause = `${action.charAt(0).toLowerCase()}${action.slice(1)}${named ? ` ${named}` : ""}${when}.`;
      break;
    }
  }

  return { headline: `${who} ${clause}`, body };
}

/** The whole narrative as one string, for a tooltip or an accessible label. */
export function workNarrativeText(entry: WorkEntry, opts: { nowIso?: string } = {}): string {
  const narrative = workNarrative(entry, opts);
  return [narrative.context, narrative.headline, ...narrative.body].filter(Boolean).join(" ");
}

/**
 * What a set of entries adds up to: "6 routine runs, 2 conversations and 41
 * recorded changes". Empty when there is nothing to count.
 */
export function workCountsSentence(entries: WorkEntry[]): string {
  const count = (kind: WorkEntryKind) => entries.filter((entry) => entry.kind === kind).length;
  const runs = count("run");
  const chats = count("chat");
  const sessions = count("work_session");
  const approvals = count("approval");
  const wakeups = count("wakeup");
  const lessons = count("lesson");
  // Routine ledgers include reads and tool calls, which are not work outcomes.
  // Their contribution is the Run above; retain change counts for other kinds.
  const changes = entries.reduce(
    (total, entry) =>
      total + (entry.kind === "effect" ? 1 : entry.kind === "run" ? 0 : entry.effectCount),
    0,
  );
  const parts: string[] = [];
  if (runs) parts.push(`${runs} routine ${runs === 1 ? "run" : "runs"}`);
  if (chats) parts.push(`${chats} ${chats === 1 ? "conversation" : "conversations"}`);
  if (sessions) parts.push(`${sessions} repository ${sessions === 1 ? "session" : "sessions"}`);
  if (approvals) parts.push(`${approvals} approval ${approvals === 1 ? "request" : "requests"}`);
  if (wakeups) parts.push(`${wakeups} ${wakeups === 1 ? "wakeup" : "wakeups"}`);
  if (lessons) parts.push(`${lessons} ${lessons === 1 ? "lesson" : "lessons"}`);
  if (changes) parts.push(`${changes} recorded ${changes === 1 ? "change" : "changes"}`);
  return joinList(parts);
}

// ───────────────────────────── the day chart ────────────────────────────────
//
// One lane per employee, time running left to right. Geometry lives here for
// the same reason the wording does: percentages, clamping and overlap packing
// are the parts that break silently, and they are unreachable inside the JSX.

export type WorkChartWindow = { startMs: number; endMs: number };

/** The chart's span: `hours` back from now, ending now. */
export function workChartWindow(nowIso: string, hours = WORK_WINDOW_HOURS): WorkChartWindow {
  const parsed = new Date(nowIso).getTime();
  const endMs = Number.isNaN(parsed) ? Date.now() : parsed;
  return { startMs: endMs - hours * 3_600_000, endMs };
}

export type WorkChartTick = { key: string; leftPct: number; label: string };

/**
 * Hour marks across the axis, on local hour boundaries so they read as clock
 * times rather than as "5 hours and 12 minutes ago". Stepped through a `Date`
 * rather than by adding milliseconds, so a DST change does not slide every
 * later label half an hour off its own line.
 */
export function workChartTicks(window: WorkChartWindow, stepHours = 3): WorkChartTick[] {
  const span = window.endMs - window.startMs;
  if (span <= 0 || stepHours <= 0) return [];
  const cursor = new Date(window.startMs);
  cursor.setMinutes(0, 0, 0);
  while (cursor.getTime() < window.startMs || cursor.getHours() % stepHours !== 0) {
    cursor.setHours(cursor.getHours() + 1);
    if (cursor.getTime() > window.endMs) return [];
  }
  const ticks: WorkChartTick[] = [];
  while (cursor.getTime() <= window.endMs) {
    const at = cursor.getTime();
    ticks.push({
      key: String(at),
      leftPct: ((at - window.startMs) / span) * 100,
      label: cursor.toLocaleTimeString(undefined, { hour: "numeric" }),
    });
    cursor.setHours(cursor.getHours() + stepHours);
  }
  return ticks;
}

export type WorkChartTile = {
  entry: WorkEntry;
  /** Percent of the lane's width, already clamped inside it. */
  leftPct: number;
  widthPct: number;
  /** The source recorded a moment, not a span, so the width is only legibility. */
  instant: boolean;
};

/**
 * Place one entry on the axis, or return null when it falls outside the window.
 *
 * Work still in flight runs to the right edge — that is what "still running"
 * looks like — and a row whose source records no end is a marker at its own
 * moment rather than a bar of invented length.
 */
export function workChartTile(
  entry: WorkEntry,
  window: WorkChartWindow,
  opts: { nowMs?: number; minWidthPct?: number } = {},
): WorkChartTile | null {
  const span = window.endMs - window.startMs;
  if (span <= 0) return null;
  const startMs = new Date(entry.at).getTime();
  if (Number.isNaN(startMs)) return null;
  const nowMs = opts.nowMs ?? window.endMs;
  const minWidthPct = opts.minWidthPct ?? 1.2;
  const endedMs = entry.endedAt ? new Date(entry.endedAt).getTime() : NaN;
  const instant = !entry.active && (Number.isNaN(endedMs) || endedMs <= startMs);
  const rawEndMs = entry.active ? Math.max(startMs, nowMs) : instant ? startMs : endedMs;
  if (startMs > window.endMs || rawEndMs < window.startMs) return null;

  const from = Math.max(startMs, window.startMs);
  const to = Math.min(Math.max(rawEndMs, from), window.endMs);
  const widthPct = Math.min(100, Math.max(minWidthPct, ((to - from) / span) * 100));
  const leftPct = Math.min(
    Math.max(0, ((from - window.startMs) / span) * 100),
    Math.max(0, 100 - widthPct),
  );
  return { entry, leftPct, widthPct, instant };
}

/**
 * Fit a lane's tiles into non-overlapping tracks, greedily and left to right.
 *
 * A lane could simply overlay them, and then a two-second ledger row sitting
 * inside a forty-minute run would be unclickable and invisible. Tracks past
 * `maxTracks` are counted rather than drawn, so the lane cannot grow without
 * bound on an employee having a busy hour.
 */
export function packWorkChartTracks(
  tiles: WorkChartTile[],
  opts: { maxTracks?: number; gapPct?: number } = {},
): { tracks: WorkChartTile[][]; hidden: number } {
  const maxTracks = opts.maxTracks ?? 3;
  const gapPct = opts.gapPct ?? 0.4;
  const ordered = [...tiles].sort((a, b) =>
    a.leftPct !== b.leftPct ? a.leftPct - b.leftPct : a.entry.id < b.entry.id ? -1 : 1,
  );
  const tracks: WorkChartTile[][] = [];
  let hidden = 0;
  for (const tile of ordered) {
    const track = tracks.find((row) => {
      const last = row[row.length - 1];
      return !last || last.leftPct + last.widthPct + gapPct <= tile.leftPct;
    });
    if (track) {
      track.push(tile);
      continue;
    }
    if (tracks.length < maxTracks) tracks.push([tile]);
    else hidden += 1;
  }
  return { tracks, hidden };
}

export type WorkChartLane<T> = {
  employee: T;
  tracks: WorkChartTile[][];
  /** Tiles the lane could not fit into its tracks. Counted, never dropped silently. */
  hidden: number;
  /** Every entry that landed in the window, newest first. */
  entries: WorkEntry[];
  active: boolean;
};

/**
 * One lane per employee, busiest first: whoever is working now, then whoever
 * worked most recently, then everyone else by name. A quiet employee keeps
 * their lane — an empty row is the honest answer to "what did they do today",
 * and a roster that hides its quiet members is one you cannot count.
 */
export function buildWorkChartLanes<T extends { id: string; name: string }>(
  employees: T[],
  entries: WorkEntry[],
  window: WorkChartWindow,
  opts: { nowMs?: number; maxTracks?: number; minWidthPct?: number } = {},
): WorkChartLane<T>[] {
  const lanes = employees.map((employee) => {
    const own = entries.filter((entry) => entry.employee.id === employee.id);
    const tiles = own
      .map((entry) =>
        workChartTile(entry, window, { nowMs: opts.nowMs, minWidthPct: opts.minWidthPct }),
      )
      .filter((tile): tile is WorkChartTile => tile !== null);
    const { tracks, hidden } = packWorkChartTracks(tiles, { maxTracks: opts.maxTracks });
    return {
      employee,
      tracks,
      hidden,
      entries: own,
      active: own.some((entry) => entry.active),
    };
  });
  return lanes.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const latest = (lane: WorkChartLane<T>) => lane.entries[0]?.at ?? "";
    if (latest(a) !== latest(b)) return latest(a) < latest(b) ? 1 : -1;
    return a.employee.name.localeCompare(b.employee.name);
  });
}
