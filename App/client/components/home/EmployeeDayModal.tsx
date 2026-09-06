import React from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CircleDashed, MessageCircle } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button, buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import type { Company, Employee, WorkEntry, WorkTimeline } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  employeeWorkStatusLabel,
  groupWorkByDay,
  isWorkInsideWindow,
  summarizeEmployeeWork,
  workClock,
  workCountsSentence,
  workDisplayEntryCount,
  workEmptyTitle,
  workEntryHref,
  workEntryLinkLabel,
  workOverflowLabel,
  WORK_WINDOW_HOURS,
} from "@/lib/workTimeline";

import { WorkEntryBlock, WorkStatePill } from "./WorkEntryViews";

/**
 * One AI Employee's day, opened from their circle on Home or from their lane
 * on the day chart.
 *
 * A calendar's day view is the right shape for this: the clock down the left,
 * every hour of the window accounted for, and each thing that happened written
 * out where it happened. It is a popup rather than a page for the same reason
 * the rest of Home's rows are — you come here to read what happened, not to go
 * somewhere — and, as M61 recorded, a second per-employee timeline *page*
 * would be a second copy of this renderer to keep in step.
 *
 * It owns its own request. Home's roster read is capped across every employee
 * at once, so one busy employee could otherwise crowd out the rest of their own
 * day; asking for this employee alone is what makes the window complete.
 */
export function EmployeeDayModal({
  company,
  employee,
  nowIso,
  onClose,
  onOpenRun,
}: {
  company: Company;
  employee: Employee;
  nowIso: string;
  onClose: () => void;
  onOpenRun: (entry: WorkEntry) => void;
}) {
  const [data, setData] = React.useState<WorkTimeline | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef(0);

  const load = React.useCallback(async () => {
    const ticket = ++request.current;
    try {
      const next = await api.get<WorkTimeline>(
        `/api/companies/${company.id}/work-timeline?employeeId=${encodeURIComponent(employee.id)}&limit=200`,
      );
      if (ticket !== request.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (ticket !== request.current) return;
      setError(errorMessage(err, `Could not load ${employee.name}'s work.`));
    }
  }, [company.id, employee.id, employee.name]);

  React.useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  useLiveRefetch(["run", "routine", "approval", "employee", "repository", "employee_work"], load);

  const raw = data?.entries ?? [];
  const entries = raw.filter((entry) => isWorkInsideWindow(entry.at, nowIso));
  const summary = summarizeEmployeeWork(
    employee.id,
    entries,
    data?.employeeSummaries.find((row) => row.employeeId === employee.id),
    { nowIso },
  );
  const groups = groupWorkByDay(entries);
  const counts = workCountsSentence(entries);
  const overflow = data
    ? workOverflowLabel(
        entries.length,
        workDisplayEntryCount(data.entryCount, raw.length, entries.length, data.until, nowIso),
      )
    : null;
  const base = `/c/${company.slug}/employees/${employee.slug}`;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      padded={false}
      title={`${employee.name}'s day`}
      description={`${employee.role} · the last ${WORK_WINDOW_HOURS} hours`}
      footer={
        <>
          <Link
            to={`${base}/settings`}
            className={buttonClassName({ variant: "secondary" })}
            onClick={onClose}
          >
            Employee details <ArrowUpRight size={14} />
          </Link>
          <Link to={`${base}/chat`} className={buttonClassName()} onClick={onClose}>
            <MessageCircle size={14} /> Check in
          </Link>
        </>
      }
    >
      <div className="flex items-start gap-3 border-b border-slate-200/70 px-4 py-4 sm:px-5 dark:border-slate-800">
        <span aria-hidden="true">
          <Avatar
            name={employee.name}
            kind="ai"
            size="lg"
            src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
          />
        </span>
        <div className="min-w-0 flex-1">
          <WorkStatePill state={summary.state} label={employeeWorkStatusLabel(summary, nowIso)} />
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {error
              ? "Their work could not be loaded, so this is not a complete picture."
              : data === null
                ? "Reading back everything the server recorded…"
                : counts
                  ? `In the last ${WORK_WINDOW_HOURS} hours ${employee.name} logged ${counts}.`
                  : workEmptyTitle(employee.name, WORK_WINDOW_HOURS)}
          </p>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-5 sm:px-5">
          <FormError message={error} />
        </div>
      ) : data === null ? (
        <div className="flex min-h-56 items-center justify-center" aria-label="Loading work">
          <Spinner size={20} />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
            <CircleDashed size={18} />
          </span>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {workEmptyTitle(employee.name, WORK_WINDOW_HOURS)}
          </span>
          <span className="max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
            Routine runs, conversations, repository work and every change they record will appear
            here as they happen.
          </span>
        </div>
      ) : (
        <div>
          {groups.map((group) => (
            <section key={group.key}>
              <h3 className="sticky top-0 z-10 border-y border-slate-100 bg-slate-50/95 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 backdrop-blur sm:px-5 dark:border-slate-800 dark:bg-slate-800/95 dark:text-slate-400">
                {group.label}
              </h3>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {group.items.map((entry) => (
                  <li key={entry.id} className="flex gap-3 px-4 py-4 sm:px-5">
                    <time
                      dateTime={entry.at}
                      className="w-14 shrink-0 pt-0.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500"
                    >
                      {workClock(entry.at)}
                    </time>
                    <div className="min-w-0 flex-1 border-l border-slate-100 pl-3 dark:border-slate-800">
                      <WorkEntryBlock entry={entry} nowIso={nowIso} />
                      <EntryAction
                        company={company}
                        entry={entry}
                        onClose={onClose}
                        onOpenRun={onOpenRun}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {overflow && (
            <p className="border-t border-slate-100 px-4 py-3 text-center text-[11px] text-slate-400 sm:px-5 dark:border-slate-800 dark:text-slate-500">
              {overflow}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Where this row goes, when it goes anywhere. A bare ledger row deliberately
 * offers nothing: it records that something changed, and there is no page for
 * "the invoice total was edited" that is not just the invoice.
 */
function EntryAction({
  company,
  entry,
  onClose,
  onOpenRun,
}: {
  company: Company;
  entry: WorkEntry;
  onClose: () => void;
  onOpenRun: (entry: WorkEntry) => void;
}) {
  if (entry.kind === "run" && entry.run) {
    return (
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="mt-2 -ml-2"
        onClick={() => onOpenRun(entry)}
      >
        Open the run log
      </Button>
    );
  }
  const href = workEntryHref(entry, company.slug);
  const label = workEntryLinkLabel(entry);
  if (!href || !label) return null;
  return (
    <Link
      to={href}
      onClick={onClose}
      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 transition hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
    >
      {label} <ArrowUpRight size={12} />
    </Link>
  );
}
