import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight, CircleDashed } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { api } from "@/lib/api";
import type { Company, Employee, WorkEntry, WorkTimeline } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  buildWorkChartLanes,
  employeeWorkStatusLabel,
  isWorkInsideWindow,
  summarizeEmployeeWork,
  workChartWindow,
  workCountsSentence,
  workDisplayEntryCount,
  workOverflowLabel,
  WORK_WINDOW_HOURS,
} from "@/lib/workTimeline";
import type { EmployeeWorkState } from "@/lib/workTimeline";

import { EmployeeDayModal } from "./EmployeeDayModal";
import { WorkDayChart } from "./WorkDayChart";
import { WorkEntryPeekModal } from "./WorkEntryPeekModal";
import { WORK_STATE_DOT } from "./WorkEntryViews";

/**
 * Home's answer to "what is my AI workforce actually doing".
 *
 * Two shapes, and no third. The **roster** is a row of circles — every
 * employee, present on a quiet day too, each carrying the one word that says
 * whether they are working, blocked on a person, recently active, or idle. The
 * **day chart** puts the same window on a clock: one lane per employee, one
 * tile per thing they did, so the shape of a night is readable without
 * reading a single row. Everything else is a popup, because detail asked for
 * is detail worth a whole panel, and detail volunteered is a wall of text.
 *
 * This replaced a scrolling list of server-written fragments — `Ran Nightly
 * digest`, `3 replies`, `pending`, `4 files · +120 · −33` — which said what had
 * happened only to a reader who already knew the product. The sentences live in
 * `lib/workTimeline.ts`; what changed here is that a reader no longer has to
 * assemble them.
 *
 * The panel owns its request and its inline error. Home's aggregate load
 * deliberately swallows transient failures; doing that here would make a failed
 * request indistinguishable from an employee who did no work.
 */
export function WorkTimelinePanel({
  company,
  employees,
  employeeLoadError,
  onOpenRun,
}: {
  company: Company;
  employees: Employee[];
  employeeLoadError?: string | null;
  onOpenRun: (entry: WorkEntry) => void;
}) {
  const [data, setData] = React.useState<WorkTimeline | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [overlay, setOverlay] = React.useState<WorkOverlay | null>(null);
  const [clockIso, setClockIso] = React.useState(() => new Date().toISOString());
  const request = React.useRef(0);

  const load = React.useCallback(async () => {
    const ticket = ++request.current;
    try {
      // The chart draws every employee at once, so it asks for the window's
      // rows rather than the default page of them — a lane missing its middle
      // is worse than no lane at all. The server caps each source long before
      // this, so a larger slice is the same query.
      const next = await api.get<WorkTimeline>(
        `/api/companies/${company.id}/work-timeline?limit=200`,
      );
      if (ticket !== request.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (ticket !== request.current) return;
      setError(errorMessage(err, "Could not load your AI employees' recent work."));
    }
  }, [company.id]);

  React.useEffect(() => {
    setData(null);
    setError(null);
    setOverlay(null);
    void load();
  }, [load]);

  /**
   * `audit` remains intentionally absent. It is a company-wide fire hose;
   * completed Runs already publish `run`, and tab focus catches the few source
   * rows without a dedicated resource frame.
   */
  useLiveRefetch(["run", "routine", "approval", "employee", "repository", "employee_work"], load);

  React.useEffect(() => {
    const onFocus = () => {
      setClockIso(new Date().toISOString());
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  React.useEffect(() => {
    setClockIso(new Date().toISOString());
    // The axis, the relative labels and the rolling cutoff are presentation
    // state; advance them locally instead of polling the timeline union.
    const timer = window.setInterval(() => setClockIso(new Date().toISOString()), 60_000);
    return () => window.clearInterval(timer);
  }, [company.id]);

  const openEmployee = overlay?.kind === "employee" ? overlay.employee : null;
  React.useEffect(() => {
    if (openEmployee && !employees.some((employee) => employee.id === openEmployee.id)) {
      setOverlay(null);
    }
  }, [employees, openEmployee]);

  if (employees.length === 0) {
    if (!employeeLoadError) return null;
    return (
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">
          AI employee work
        </h2>
        <div className="mt-4">
          <FormError message={employeeLoadError} />
        </div>
      </section>
    );
  }

  const nowIso = clockIso;
  const status: WorkDataStatus = error ? "unavailable" : data ? "ready" : "loading";
  const rollups = new Map((data?.employeeSummaries ?? []).map((row) => [row.employeeId, row]));
  const raw = data?.entries ?? [];
  const entries = raw.filter((entry) => isWorkInsideWindow(entry.at, nowIso));
  const overflow = data
    ? workOverflowLabel(
        entries.length,
        workDisplayEntryCount(data.entryCount, raw.length, entries.length, data.until, nowIso),
      )
    : null;
  const summaries = employees.map((employee) =>
    summarizeEmployeeWork(employee.id, entries, rollups.get(employee.id), { nowIso }),
  );
  const workingCount = summaries.filter((summary) => summary.state === "working").length;
  const waitingCount = summaries.filter((summary) => summary.state === "waiting").length;
  const activeCount = summaries.filter((summary) => summary.state !== "quiet").length;
  const chartWindow = workChartWindow(nowIso, WORK_WINDOW_HOURS);
  const lanes = buildWorkChartLanes(employees, entries, chartWindow, {
    nowMs: new Date(nowIso).getTime(),
  });

  return (
    <section
      aria-labelledby="employee-work-title"
      className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="employee-work-title"
            className="text-base font-semibold text-slate-950 dark:text-slate-50"
          >
            AI employee work
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
            {teamSentence({
              status,
              employees: employees.length,
              workingCount,
              waitingCount,
              activeCount,
              entries,
            })}
          </p>
        </div>
        <Link
          to={`/c/${company.slug}/employees`}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          Manage employees <ChevronRight size={13} />
        </Link>
      </div>

      <div
        role="group"
        aria-label="Open an AI employee's day"
        className="-mx-1 mt-4 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {employees.map((employee, index) => (
          <EmployeeWorkBubble
            key={employee.id}
            name={employee.name}
            role={employee.role}
            avatarSrc={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
            state={status === "ready" ? summaries[index].state : "quiet"}
            status={
              status === "ready"
                ? employeeWorkStatusLabel(summaries[index], nowIso)
                : status === "loading"
                  ? "Loading work"
                  : "Status unavailable"
            }
            onSelect={() => setOverlay({ kind: "employee", employee })}
          />
        ))}
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            The last {WORK_WINDOW_HOURS} hours
          </h3>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Every bar is one piece of work. Open one to read what it did.
          </p>
        </div>

        {error ? (
          <FormError message={error} />
        ) : data === null ? (
          <div className="flex min-h-40 items-center justify-center" aria-label="Loading work">
            <Spinner size={20} />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 px-6 py-8 text-center dark:border-slate-700">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
              <CircleDashed size={18} />
            </span>
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Nothing has been done in the last {WORK_WINDOW_HOURS} hours.
            </span>
            <span className="max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
              Routine runs, conversations, repository work and every change your employees record
              will appear here as they happen.
            </span>
          </div>
        ) : (
          <WorkDayChart
            company={company}
            lanes={lanes}
            window={chartWindow}
            nowIso={nowIso}
            onOpenEntry={(entry) => setOverlay({ kind: "entry", entry })}
            onOpenEmployee={(employee) => setOverlay({ kind: "employee", employee })}
          />
        )}

        {overflow && (
          <p className="mt-3 text-center text-[11px] text-slate-400 dark:text-slate-500">
            {overflow} — open an employee to see the rest of their day
          </p>
        )}
      </div>

      {overlay?.kind === "entry" && (
        <WorkEntryPeekModal
          company={company}
          entry={overlay.entry}
          nowIso={nowIso}
          onClose={() => setOverlay(null)}
          onOpenRun={(entry) => {
            // Home owns the run viewer, and only one surface may be over the
            // page at a time — hand it over rather than stacking on top of it.
            setOverlay(null);
            onOpenRun(entry);
          }}
          onOpenEmployeeDay={(employeeId) => {
            const employee = employees.find((row) => row.id === employeeId);
            setOverlay(employee ? { kind: "employee", employee } : null);
          }}
        />
      )}
      {openEmployee && (
        <EmployeeDayModal
          company={company}
          employee={openEmployee}
          nowIso={nowIso}
          onClose={() => setOverlay(null)}
          onOpenRun={(entry) => {
            setOverlay(null);
            onOpenRun(entry);
          }}
        />
      )}
    </section>
  );
}

/** Whichever popup the panel currently has open. Only ever one. */
type WorkOverlay = { kind: "employee"; employee: Employee } | { kind: "entry"; entry: WorkEntry };

type WorkDataStatus = "loading" | "ready" | "unavailable";

/**
 * The line under the heading: who is working, and what the roster added up to.
 *
 * Kept as prose and exported for the same reason the rest of the wording is —
 * a pending request must never read as a quiet team, and a failed one must
 * never read as either.
 */
export function teamSentence({
  status,
  employees,
  workingCount,
  waitingCount,
  activeCount,
  entries,
}: {
  status: WorkDataStatus;
  employees: number;
  workingCount: number;
  waitingCount: number;
  activeCount: number;
  entries: WorkEntry[];
}): string {
  if (status === "loading") return "Reading back what your AI employees have been doing…";
  if (status === "unavailable") {
    return "Recent work could not be loaded, so nothing below is a complete picture.";
  }
  // "1 of 3 employees is working" — the noun counts the roster, the verb
  // counts the ones working, and the two do not agree by accident.
  const roster = employees === 1 ? "employee" : "employees";
  const who = workingCount
    ? `${workingCount} of ${employees} ${roster} ${workingCount === 1 ? "is" : "are"} working right now.`
    : waitingCount
      ? `${waitingCount} ${waitingCount === 1 ? "employee is" : "employees are"} waiting for a person.`
      : activeCount
        ? `${activeCount} of ${employees} ${roster} ${activeCount === 1 ? "has" : "have"} worked in the last ${WORK_WINDOW_HOURS} hours.`
        : "Nobody is working right now.";
  const counts = workCountsSentence(entries);
  return counts
    ? `${who} Between them they logged ${counts}.`
    : `${who} Nothing has been recorded in the last ${WORK_WINDOW_HOURS} hours.`;
}

/**
 * One employee, as a circle.
 *
 * Exported so the roster's accessible contract can be pinned in Node tests:
 * it is a real button, it announces the employee and their state in words
 * rather than in colour, and the avatar subtree stays out of that name.
 */
export function EmployeeWorkBubble({
  name,
  role,
  avatarSrc,
  state,
  status,
  onSelect,
}: {
  name: string;
  role: string;
  avatarSrc: string | null;
  state: EmployeeWorkState;
  status: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${name}, ${role}, ${status}. Open their day.`}
      onClick={onSelect}
      className={clsx(
        "group flex w-[5.5rem] shrink-0 flex-col items-center rounded-xl px-1 py-2 text-center transition",
        "hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-slate-800/60",
      )}
    >
      <span
        aria-hidden="true"
        className="relative rounded-full p-0.5 ring-2 ring-transparent transition group-hover:ring-indigo-300 dark:group-hover:ring-indigo-500/40"
      >
        <Avatar name={name} kind="ai" size="lg" src={avatarSrc} />
        <span
          aria-hidden="true"
          className={clsx(
            "absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white dark:border-slate-900",
            WORK_STATE_DOT[state],
            state === "working" && "motion-safe:animate-pulse",
          )}
        />
      </span>
      <span className="mt-1.5 w-full truncate text-[11px] font-semibold text-slate-900 dark:text-slate-100">
        {name}
      </span>
      <span className="w-full truncate text-[10px] text-slate-500 dark:text-slate-400">
        {status}
      </span>
    </button>
  );
}
