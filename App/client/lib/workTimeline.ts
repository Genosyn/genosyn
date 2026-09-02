import type { WorkEntry, WorkEntryKind } from "./api";

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
    label: "Approval asked",
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

/** "3 more" under a capped effects strip; null when nothing was withheld. */
export function workEffectOverflowLabel(entry: WorkEntry): string | null {
  const hidden = entry.effectCount - entry.effects.length;
  if (hidden <= 0) return null;
  return `${hidden} more`;
}

/** The empty-state line, which depends on whether a name was chosen. */
export function workEmptyTitle(employeeName: string | null, hours: number): string {
  const window = hours === 24 ? "the last 24 hours" : `the last ${hours} hours`;
  return employeeName
    ? `${employeeName} has not done anything in ${window}.`
    : `Nothing has been done in ${window}.`;
}
