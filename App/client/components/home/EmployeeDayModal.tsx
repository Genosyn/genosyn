import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  MessageCircle,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button, buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import type { Company, Employee, WorkEntry, WorkTimeline } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { clsx } from "@/components/ui/clsx";
import {
  shiftWorkCalendarDate,
  workCalendarDate,
  workCalendarHours,
  workCalendarWindow,
} from "@/lib/workCalendar";
import {
  workClock,
  workCountsSentence,
  workEntryHref,
  workEntryLinkLabel,
  workOverflowLabel,
} from "@/lib/workTimeline";

import { WorkEntryBlock } from "./WorkEntryViews";

/** One local calendar day, fetched independently so other employees cannot crowd it out. */
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
  const today = workCalendarDate(nowIso);
  const earliestDay = shiftWorkCalendarDate(today, -6);
  const [selectedDay, setSelectedDay] = React.useState(today);
  const day = selectedDay < earliestDay ? earliestDay : selectedDay;
  const { since, until } = workCalendarWindow(day);
  const calendarRef = React.useRef<HTMLDivElement>(null);
  const scrolledDay = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const ticket = ++request.current;
    try {
      const query = new URLSearchParams({ employeeId: employee.id, since, until, limit: "200" });
      const next = await api.get<WorkTimeline>(
        `/api/companies/${company.id}/work-timeline?${query}`,
      );
      if (ticket !== request.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (ticket !== request.current) return;
      setError(errorMessage(err, `Could not load ${employee.name}'s work.`));
    }
  }, [company.id, employee.id, employee.name, since, until]);

  React.useEffect(() => {
    setData(null);
    setError(null);
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  useLiveRefetch(["run", "routine", "approval", "employee", "repository", "employee_work"], load);

  // Never display yesterday's response under today's heading while a request changes.
  const currentData = data?.since === since && data?.until === until ? data : null;
  const entries = currentData?.entries ?? [];
  const hours = workCalendarHours(day, entries);
  const counts = workCountsSentence(entries);
  const overflow = currentData ? workOverflowLabel(entries.length, currentData.entryCount) : null;
  const dayLabel = new Date(since).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ");
  const firstWorkHour = hours.find((hour) => hour.entries.length > 0)?.key;

  React.useEffect(() => {
    if (!currentData || scrolledDay.current === day) return;
    scrolledDay.current = day;
    calendarRef.current
      ?.querySelector('[data-first-work="true"]')
      ?.scrollIntoView({ block: "start" });
  }, [currentData, day]);

  const base = `/c/${company.slug}/employees/${employee.slug}`;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      padded={false}
      title={`${employee.name}'s day`}
      description={`${employee.role} · Daily work timeline`}
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
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-4 sm:px-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <span aria-hidden="true">
            <Avatar
              name={employee.name}
              kind="ai"
              size="lg"
              src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
            />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{dayLabel}</h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Times in {timezone}</p>
          </div>
        </div>
        <div
          className="mt-4 flex flex-wrap items-center justify-between gap-2"
          role="group"
          aria-label="Choose a work day"
        >
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-2"
              aria-label="Previous day"
              disabled={day <= earliestDay}
              onClick={() => setSelectedDay(shiftWorkCalendarDate(day, -1))}
            >
              <ChevronLeft size={16} />
            </Button>
            <label className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 dark:border-slate-700">
              <CalendarDays size={14} className="text-slate-400" aria-hidden="true" />
              <span className="sr-only">Work day</span>
              <input
                type="date"
                value={day}
                min={earliestDay}
                max={today}
                onChange={(event) => {
                  if (
                    event.target.validity.valid &&
                    event.target.value >= earliestDay &&
                    event.target.value <= today
                  )
                    setSelectedDay(event.target.value);
                }}
                className="min-w-0 bg-transparent text-xs text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-slate-200 dark:[color-scheme:dark]"
              />
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-2"
              aria-label="Next day"
              disabled={day >= today}
              onClick={() => setSelectedDay(shiftWorkCalendarDate(day, 1))}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={day === today}
            onClick={() => setSelectedDay(today)}
          >
            Today
          </Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400" aria-live="polite">
          {error
            ? "Work is unavailable for this day."
            : !currentData
              ? "Loading the day’s work…"
              : counts
                ? `${overflow ? "Showing" : "Recorded"} ${counts}.`
                : "No work recorded on this day."}
        </p>
        {overflow && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {overflow}. Showing the most recent work.
          </p>
        )}
      </div>

      {error ? (
        <div className="px-4 py-5 sm:px-5">
          <FormError message={error} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      ) : currentData === null ? (
        <div className="flex min-h-56 items-center justify-center" aria-label="Loading work">
          <Spinner size={20} />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
            <CircleDashed size={18} />
          </span>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No work recorded on this day
          </span>
          <span className="max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
            Routine runs, conversations, repository work and every change they record will appear
            here when recorded. Choose another day to see earlier work.
          </span>
        </div>
      ) : (
        <div ref={calendarRef} aria-label={`${employee.name}'s hourly work timeline`}>
          {hours.map((hour) => {
            const isCurrentHour =
              day === today &&
              Date.parse(nowIso) >= Date.parse(hour.at) &&
              Date.parse(nowIso) < Date.parse(hour.at) + 3_600_000;
            return (
              <section
                key={hour.key}
                data-first-work={hour.key === firstWorkHour ? "true" : undefined}
                aria-label={hour.label}
                className="flex scroll-mt-56"
              >
                <time
                  dateTime={hour.at}
                  className={clsx(
                    "w-20 shrink-0 px-2 pt-3 text-right text-[11px] tabular-nums sm:w-24 sm:px-3",
                    isCurrentHour
                      ? "font-semibold text-indigo-600 dark:text-indigo-400"
                      : "text-slate-400 dark:text-slate-500",
                  )}
                >
                  {hour.label}
                  {isCurrentHour && <span className="mt-1 block text-[10px]">Now</span>}
                </time>
                <div
                  className={clsx(
                    "min-h-14 min-w-0 flex-1 border-l border-t border-slate-100 px-3 py-2 sm:px-4 dark:border-slate-800",
                    isCurrentHour && "bg-indigo-50/40 dark:bg-indigo-500/5",
                  )}
                >
                  {hour.entries.length > 0 && (
                    <ul className="space-y-2">
                      {hour.entries.map((entry) => (
                        <li
                          key={entry.id}
                          className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <time
                            dateTime={entry.at}
                            className="mb-2 block text-[11px] font-medium tabular-nums text-slate-500 dark:text-slate-400"
                          >
                            {workClock(entry.at)}
                            {entry.endedAt && Date.parse(entry.endedAt) > Date.parse(entry.at)
                              ? ` – ${workClock(entry.endedAt)}`
                              : ""}
                          </time>
                          <WorkEntryBlock entry={entry} nowIso={nowIso} />
                          <EntryAction
                            company={company}
                            entry={entry}
                            onClose={onClose}
                            onOpenRun={onOpenRun}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            );
          })}
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
