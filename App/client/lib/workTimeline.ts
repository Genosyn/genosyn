import type { WorkEmployeeSummary, WorkEntry, WorkEntryDigest, WorkEntryKind } from "./api";

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

/** The row Home should feature when an employee bubble is selected. */
export function employeeWorkFocus(summary: EmployeeWorkSummary): WorkEntryDigest | null {
  return summary.currentEntry ?? summary.waitingEntry ?? summary.latestEntry;
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

/** Turn an effect-ledger action such as `invoice.create` into reader-facing copy. */
export function humanizeWorkAction(action: string, targetType: string): string {
  const actionParts = action.split(/[.:/]/).filter(Boolean);
  const operation = readableWords(actionParts.at(-1) ?? action);
  const target = readableWords(targetType || actionParts.at(-2) || "record");
  const verb =
    ACTION_VERBS[operation] ?? `${operation.charAt(0).toUpperCase()}${operation.slice(1)}`;
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

/** Human-first title for a timeline row, including standalone Effects. */
export function workDisplayTitle(entry: Pick<WorkEntry, "kind" | "title" | "detail">): string {
  return entry.kind === "effect" ? humanizeWorkAction(entry.detail, "") : entry.title;
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

/**
 * The row's headline, with the employee's name in front when the timeline is
 * showing the whole roster. One employee selected and the name is the panel's
 * subject already, so repeating it on every line is noise.
 */
export function workEntrySummary(entry: WorkEntry, opts: { withEmployee?: boolean } = {}): string {
  return opts.withEmployee ? `${entry.employee.name} — ${entry.title}` : entry.title;
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
