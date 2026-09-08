import React from "react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { FormError } from "@/components/ui/FormError";
import { clsx } from "@/components/ui/clsx";
import { api } from "@/lib/api";
import type { Company, Employee, WorkEntry, WorkTimeline } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  employeeWorkStatusLabel,
  isWorkInsideWindow,
  summarizeEmployeeWork,
} from "@/lib/workTimeline";
import type { EmployeeWorkState } from "@/lib/workTimeline";

import { EmployeeDayModal } from "./EmployeeDayModal";
import { WORK_STATE_DOT } from "./WorkEntryViews";

/**
 * Home's compact employee rail. Work stays behind each bubble, whose status
 * comes from the server rollup even when another employee fills the result cap.
 * The selected employee loads their own calendar day only after it is opened.
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
  const [openEmployee, setOpenEmployee] = React.useState<Employee | null>(null);
  const [clockIso, setClockIso] = React.useState(() => new Date().toISOString());
  const request = React.useRef(0);

  const load = React.useCallback(async () => {
    const ticket = ++request.current;
    try {
      // Only the rollups are needed for the bubbles; details load on demand.
      const next = await api.get<WorkTimeline>(
        `/api/companies/${company.id}/work-timeline?limit=1`,
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
    setOpenEmployee(null);
    void load();
    return () => {
      request.current += 1;
    };
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
    // The relative labels and the rolling cutoff are presentation
    // state; advance them locally instead of polling the timeline union.
    const timer = window.setInterval(() => setClockIso(new Date().toISOString()), 60_000);
    return () => window.clearInterval(timer);
  }, [company.id]);

  React.useEffect(() => {
    if (openEmployee && !employees.some((employee) => employee.id === openEmployee.id)) {
      setOpenEmployee(null);
    }
  }, [employees, openEmployee]);

  if (employees.length === 0) {
    if (!employeeLoadError) return null;
    return (
      <aside className="order-first w-full md:order-last md:w-28 md:shrink-0">
        <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">
          AI employee work
        </h2>
        <div className="mt-4">
          <FormError message={employeeLoadError} />
        </div>
      </aside>
    );
  }

  const nowIso = clockIso;
  const status: WorkDataStatus = error ? "unavailable" : data ? "ready" : "loading";
  const rollups = new Map((data?.employeeSummaries ?? []).map((row) => [row.employeeId, row]));
  const raw = data?.entries ?? [];
  const entries = raw.filter((entry) => isWorkInsideWindow(entry.at, nowIso));
  const summaries = employees.map((employee) =>
    summarizeEmployeeWork(employee.id, entries, rollups.get(employee.id), { nowIso }),
  );
  return (
    <aside
      aria-label="AI employee work"
      className="order-first min-w-0 md:sticky md:top-8 md:order-last md:w-24 md:shrink-0 md:self-start"
    >
      <h2 className="sr-only">AI employee work</h2>
      <div
        role="group"
        aria-label="Open an AI employee's day"
        className="flex gap-1 overflow-x-auto py-1 [&>button:first-child]:ml-auto md:max-h-[calc(100vh-8rem)] md:flex-col md:items-center md:overflow-y-auto md:[&>button:first-child]:ml-0"
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
            onSelect={() => setOpenEmployee(employee)}
          />
        ))}
      </div>

      {error && <FormError message={error} />}

      {openEmployee && (
        <EmployeeDayModal
          company={company}
          employee={openEmployee}
          nowIso={nowIso}
          onClose={() => setOpenEmployee(null)}
          onOpenRun={(entry) => {
            setOpenEmployee(null);
            onOpenRun(entry);
          }}
        />
      )}
    </aside>
  );
}

type WorkDataStatus = "loading" | "ready" | "unavailable";

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
      aria-haspopup="dialog"
      title={`${name} · ${role} · ${status}`}
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
