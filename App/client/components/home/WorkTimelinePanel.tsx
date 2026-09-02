import React from "react";
import { Link } from "react-router-dom";
import {
  AlarmClock,
  ChevronRight,
  CircleDashed,
  Clock3,
  GitCommitHorizontal,
  Lightbulb,
  MessageSquare,
  Play,
  ShieldCheck,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { RunChecksChip, RunOutcomeChip, RunStatusChip } from "@/components/routines/RunViews";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { api } from "@/lib/api";
import type { Company, Employee, WorkEntry, WorkEntryKind, WorkTimeline } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { shouldOpenEventInPlace } from "@/lib/inPlaceLink";
import {
  groupWorkByDay,
  workClock,
  workEffectOverflowLabel,
  workEmptyTitle,
  workEntryHref,
  workOverflowLabel,
  WORK_KIND_META,
} from "@/lib/workTimeline";

/**
 * Home's AI Employee work timeline — everything the roster did in the last 24
 * hours, newest first, with a picker to narrow it to one employee.
 *
 * ## Why this panel is not a queue
 *
 * Every other panel on Home hides when it is empty because every other panel
 * is a queue, and an empty queue is not news. This one is a record. It sits
 * *below* the all-clear rather than inside it, because a night of clean
 * autonomous work and "Nothing needs you right now" are both true at once, and
 * folding the record into the queue predicate would hide the day behind the
 * sentence. It still hides itself when the window is genuinely empty — the
 * rule survives; only the reason it fires is different.
 *
 * The one exception is a deliberately chosen employee. Once the reader has
 * picked a name, a vanishing panel reads as a bug rather than as quiet, so a
 * selected employee with nothing to show gets a sentence saying so and keeps
 * its picker.
 *
 * ## Its own fetch, its own errors
 *
 * Home's own `reload` swallows failures so a transient blip never blanks the
 * page. That is right for an aggregate that is mostly counts and wrong here: a
 * silently empty timeline is indistinguishable from a quiet day, which is the
 * one thing this panel must never say by accident. So it owns its request, its
 * spinner, and an inline error — never a toast; there isn't one in this app.
 */
export function WorkTimelinePanel({
  company,
  employees,
  onOpenRun,
}: {
  company: Company;
  /** Home already loads the roster for the todo peek pickers — reuse it. */
  employees: Employee[];
  onOpenRun: (entry: WorkEntry) => void;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [data, setData] = React.useState<WorkTimeline | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const query = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : "";
    try {
      const next = await api.get<WorkTimeline>(
        `/api/companies/${company.id}/work-timeline${query}`,
      );
      setData(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load what your AI employees have been doing."));
    }
  }, [company.id, employeeId]);

  React.useEffect(() => {
    // Blank between employees so the body shows its spinner rather than one
    // employee's work under another's name.
    setData(null);
    setError(null);
    void load();
  }, [load]);

  /**
   * Deliberately not subscribed to `audit`. That kind is company-wide with no
   * scope and ~150 write seams feed it, so it fires on essentially every
   * mutation in the company. A Run finishing already publishes `run`, and the
   * refetch brings its effects with it. There is no `conversation` kind in the
   * registry, so chat rows arrive on the next matching frame or on tab focus.
   */
  useLiveRefetch(["run", "routine", "approval", "employee"], load);

  const selected = employees.find((e) => e.id === employeeId) ?? null;
  const entries = data?.entries ?? [];

  // Nothing chosen and nothing done: say nothing at all. This is the rule every
  // Home panel follows, applied at the only point where it is true here.
  if (!employeeId && data !== null && entries.length === 0 && !error) return null;
  if (employees.length === 0) return null;

  const groups = groupWorkByDay(entries);
  const overflow = data ? workOverflowLabel(entries.length, data.entryCount) : null;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="text-slate-400 dark:text-slate-500">
          <Clock3 size={15} />
        </span>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {selected ? `What ${selected.name} did` : "What your AI employees did"}
        </h2>
        <span className="text-xs text-slate-400 dark:text-slate-500">Last 24 hours</span>
        {data !== null && data.entryCount > 0 && (
          <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {data.entryCount}
          </span>
        )}
        <Select
          aria-label="AI employee"
          className="ml-auto h-8 w-44 text-xs"
          containerClassName="ml-auto w-44"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
        >
          <option value="">All AI employees</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Link
          to={
            selected
              ? `/c/${company.slug}/employees/${selected.slug}`
              : `/c/${company.slug}/employees`
          }
          className="flex shrink-0 items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {selected ? "Open employee" : "All employees"} <ChevronRight size={12} />
        </Link>
      </div>

      {error ? (
        <div className="px-4 py-4">
          <FormError message={error} />
        </div>
      ) : data === null ? (
        <div className="flex min-h-[10rem] items-center justify-center">
          <Spinner size={20} />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex min-h-[10rem] flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {workEmptyTitle(selected?.name ?? null, 24)}
          </span>
          <span className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
            Routine runs, chat replies, repository work, approvals they asked for, and the lessons
            they took away all appear here as they happen.
          </span>
        </div>
      ) : (
        <div className="max-h-[32rem] overflow-y-auto">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-400">
                {group.label}
              </div>
              <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
                {group.items.map((entry, index) => (
                  <TimelineRow
                    key={entry.id}
                    company={company}
                    entry={entry}
                    showEmployee={!employeeId}
                    lastInGroup={index === group.items.length - 1}
                    onOpenRun={onOpenRun}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {overflow && (
        <div className="border-t border-slate-100 px-4 py-2 text-center text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
          {overflow}
        </div>
      )}
    </section>
  );
}

const KIND_ICON: Record<WorkEntryKind, React.ReactNode> = {
  run: <Play size={13} />,
  chat: <MessageSquare size={13} />,
  work_session: <GitCommitHorizontal size={13} />,
  approval: <ShieldCheck size={13} />,
  wakeup: <AlarmClock size={13} />,
  lesson: <Lightbulb size={13} />,
  effect: <CircleDashed size={13} />,
};

/**
 * One row: a chip on a rail, the headline, and a meta line under it.
 *
 * The rail is drawn per row and skipped on the last of a day group rather than
 * as one continuous border on the list — a single border would overhang the
 * sticky day header that follows it.
 */
function TimelineRow({
  company,
  entry,
  showEmployee,
  lastInGroup,
  onOpenRun,
}: {
  company: Company;
  entry: WorkEntry;
  showEmployee: boolean;
  lastInGroup: boolean;
  onOpenRun: (entry: WorkEntry) => void;
}) {
  const meta = WORK_KIND_META[entry.kind];
  const href = workEntryHref(entry, company.slug);
  const effectOverflow = workEffectOverflowLabel(entry);

  const body = (
    <>
      {!lastInGroup && (
        // `left` is the row's own padding (1rem) plus half the 28px chip
        // (0.875rem); `top` clears the chip; the negative `bottom` carries the
        // line across the divider into the next row's padding so it meets the
        // chip below instead of stopping short of it.
        <span
          aria-hidden="true"
          className="absolute -bottom-3.5 left-[1.875rem] top-[2.625rem] w-px bg-slate-200 dark:bg-slate-700"
        />
      )}
      <span
        aria-hidden="true"
        title={meta.label}
        className={clsx(
          "relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1",
          meta.tone,
        )}
      >
        {KIND_ICON[entry.kind]}
      </span>
      <span className="min-w-0 flex-1">
        {/* Wraps rather than shrinks: a run carries up to three chips, and on a
            phone `flex-1` on the title let them squeeze it to nothing. The
            basis is the width below which the chips move to their own line. */}
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 grow basis-48 truncate text-sm text-slate-900 dark:text-slate-100">
            {entry.title}
          </span>
          {entry.run && <RunStatusChip status={entry.run.status} size="xs" />}
          {entry.run?.outcomeVerdict && (
            <RunOutcomeChip
              verdict={entry.run.outcomeVerdict}
              note={entry.run.outcomeNote}
              size="xs"
            />
          )}
          {entry.run?.checksVerdict && (
            <RunChecksChip verdict={entry.run.checksVerdict} size="xs" />
          )}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
          <span className="tabular-nums">{workClock(entry.at)}</span>
          {showEmployee && (
            <span className="flex items-center gap-1">
              <Avatar
                name={entry.employee.name}
                kind="ai"
                size="xs"
                src={employeeAvatarUrl(company.id, entry.employee.id, entry.employee.avatarKey)}
              />
              {entry.employee.name}
            </span>
          )}
          {entry.detail && <span className="truncate">{entry.detail}</span>}
        </span>
        {entry.effects.length > 0 && (
          <span className="mt-2 block border-l border-slate-100 pl-3 dark:border-slate-800">
            {entry.effects.map((effect, i) => (
              <span
                key={`${effect.at}-${effect.action}-${i}`}
                className="mt-1 flex items-center gap-2 text-[11px] first:mt-0"
              >
                <code className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {effect.action}
                </code>
                {(effect.targetLabel || effect.targetType) && (
                  <span className="truncate text-slate-500 dark:text-slate-400">
                    {effect.targetLabel || effect.targetType}
                  </span>
                )}
              </span>
            ))}
            {effectOverflow && (
              <span className="mt-1 block text-[11px] text-slate-400 dark:text-slate-500">
                {effectOverflow}
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );

  const rowClass =
    "relative flex gap-3 px-4 py-3 transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40";

  if (!href) {
    return <li className={rowClass}>{body}</li>;
  }

  // A run opens the Routines page's own viewer over Home; everything else is an
  // ordinary navigation. Either way the anchor survives, so ⌘-click, middle
  // click and the status-bar preview all keep working.
  return (
    <li>
      <Link
        to={href}
        className={rowClass}
        onClick={(event) => {
          if (entry.kind !== "run" || !entry.run) return;
          if (!shouldOpenEventInPlace(event)) return;
          event.preventDefault();
          onOpenRun(entry);
        }}
      >
        {body}
      </Link>
    </li>
  );
}
