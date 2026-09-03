import React from "react";
import { Link } from "react-router-dom";
import {
  AlarmClock,
  ArrowUpRight,
  ChevronRight,
  CircleDashed,
  GitCommitHorizontal,
  Lightbulb,
  MessageCircle,
  MessageSquare,
  Play,
  ShieldCheck,
  UsersRound,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { RunChecksChip, RunOutcomeChip, RunStatusChip } from "@/components/routines/RunViews";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { api } from "@/lib/api";
import type { Company, Employee, WorkEntry, WorkEntryKind, WorkTimeline } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { shouldOpenEventInPlace } from "@/lib/inPlaceLink";
import {
  employeeWorkFocus,
  employeeWorkStatusLabel,
  groupWorkByDay,
  humanizeWorkAction,
  isWorkInsideWindow,
  summarizeEmployeeWork,
  workDisplayDetail,
  workDisplayEntryCount,
  workDisplayTitle,
  workEffectOverflowLabel,
  workEmptyTitle,
  workEntryHref,
  workOverflowLabel,
  workRelativeTime,
  WORK_KIND_META,
} from "@/lib/workTimeline";
import type { EmployeeWorkState, EmployeeWorkSummary } from "@/lib/workTimeline";

/**
 * Home's human-readable view of the AI workforce.
 *
 * The roster is the navigation. Every employee remains visible as a bubble,
 * including on a quiet day, and each bubble says whether that person is
 * working, waiting for input, recently active, or quiet. Selecting one keeps
 * the employee in context: their current or latest work is featured beside a
 * direct Check in action, with the server-written work timeline underneath.
 *
 * The timeline still owns its request and inline error. Home's aggregate load
 * deliberately swallows transient failures; doing that here would make a
 * failed request indistinguishable from an employee who did no work.
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
  const [employeeId, setEmployeeId] = React.useState("");
  const [rosterData, setRosterData] = React.useState<WorkTimeline | null>(null);
  const [selectedData, setSelectedData] = React.useState<WorkTimeline | null>(null);
  const [rosterError, setRosterError] = React.useState<string | null>(null);
  const [selectedError, setSelectedError] = React.useState<string | null>(null);
  const [clockIso, setClockIso] = React.useState(() => new Date().toISOString());
  const rosterRequest = React.useRef(0);
  const selectedRequest = React.useRef(0);

  const loadRoster = React.useCallback(async () => {
    const request = ++rosterRequest.current;
    try {
      const next = await api.get<WorkTimeline>(`/api/companies/${company.id}/work-timeline`);
      if (request !== rosterRequest.current) return;
      setRosterData(next);
      setRosterError(null);
    } catch (err) {
      if (request !== rosterRequest.current) return;
      setRosterError(errorMessage(err, "Could not load your AI employees' recent work."));
    }
  }, [company.id]);

  const loadEmployee = React.useCallback(
    async (nextEmployeeId: string) => {
      const request = ++selectedRequest.current;
      try {
        const next = await api.get<WorkTimeline>(
          `/api/companies/${company.id}/work-timeline?employeeId=${encodeURIComponent(nextEmployeeId)}`,
        );
        if (request !== selectedRequest.current) return;
        setSelectedData(next);
        setSelectedError(null);
      } catch (err) {
        if (request !== selectedRequest.current) return;
        setSelectedError(errorMessage(err, "Could not load this employee's recent work."));
      }
    },
    [company.id],
  );

  React.useEffect(() => {
    selectedRequest.current += 1;
    setEmployeeId("");
    setRosterData(null);
    setSelectedData(null);
    setRosterError(null);
    setSelectedError(null);
    void loadRoster();
  }, [loadRoster]);

  React.useEffect(() => {
    if (!employeeId) {
      selectedRequest.current += 1;
      setSelectedData(null);
      setSelectedError(null);
      return;
    }
    setSelectedData(null);
    setSelectedError(null);
    void loadEmployee(employeeId);
  }, [employeeId, loadEmployee]);

  const refresh = React.useCallback(() => {
    void loadRoster();
    if (employeeId) void loadEmployee(employeeId);
  }, [employeeId, loadEmployee, loadRoster]);

  /**
   * `audit` remains intentionally absent. It is a company-wide fire hose;
   * completed Runs already publish `run`, and tab focus catches the few source
   * rows without a dedicated resource frame.
   */
  useLiveRefetch(
    ["run", "routine", "approval", "employee", "repository", "employee_work"],
    refresh,
  );

  React.useEffect(() => {
    const onFocus = () => {
      setClockIso(new Date().toISOString());
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  React.useEffect(() => {
    setClockIso(new Date().toISOString());
    // Relative labels and the rolling 24-hour cutoff are presentation state;
    // advance them locally instead of polling the full timeline union.
    const timer = window.setInterval(() => setClockIso(new Date().toISOString()), 60_000);
    return () => window.clearInterval(timer);
  }, [company.id]);

  const selected = employees.find((employee) => employee.id === employeeId) ?? null;
  React.useEffect(() => {
    if (employeeId && employees.length > 0 && !selected) setEmployeeId("");
  }, [employeeId, employees.length, selected]);

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

  const data = selected ? selectedData : rosterData;
  const error = selected ? selectedError : rosterError;
  const rosterEntries = rosterData?.entries ?? [];
  const nowIso = clockIso;
  const rosterSummaries = new Map(
    (rosterData?.employeeSummaries ?? []).map((summary) => [summary.employeeId, summary]),
  );
  const summaries = employees.map((employee) =>
    summarizeEmployeeWork(employee.id, rosterEntries, rosterSummaries.get(employee.id), { nowIso }),
  );
  const selectedRollup = selected
    ? (selectedData?.employeeSummaries.find((summary) => summary.employeeId === selected.id) ??
      rosterSummaries.get(selected.id))
    : undefined;
  const selectedSummary = selected
    ? summarizeEmployeeWork(selected.id, selectedData?.entries ?? rosterEntries, selectedRollup, {
        nowIso,
      })
    : null;
  const rosterStatus: WorkDataStatus = rosterError
    ? "unavailable"
    : rosterData
      ? "ready"
      : "loading";
  const selectedStatus: WorkDataStatus = selectedError
    ? "unavailable"
    : selectedData
      ? "ready"
      : rosterData
        ? "ready"
        : "loading";
  const workingCount = summaries.filter((summary) => summary.state === "working").length;
  const waitingCount = summaries.filter((summary) => summary.state === "waiting").length;
  const activeCount = summaries.filter((summary) => summary.state !== "quiet").length;
  const teamState: EmployeeWorkState = workingCount
    ? "working"
    : waitingCount
      ? "waiting"
      : activeCount
        ? "recent"
        : "quiet";
  const teamStatus = workingCount
    ? `${workingCount} working now`
    : waitingCount
      ? `${waitingCount} waiting for input`
      : activeCount
        ? `${activeCount} active today`
        : "Quiet today";
  const rawEntries = data?.entries ?? [];
  const entries = rawEntries.filter((entry) => isWorkInsideWindow(entry.at, nowIso));
  const displayEntryCount = data
    ? workDisplayEntryCount(data.entryCount, rawEntries.length, entries.length, data.until, nowIso)
    : 0;
  const groups = groupWorkByDay(entries);
  const overflow = data ? workOverflowLabel(entries.length, displayEntryCount) : null;

  return (
    <section
      aria-labelledby="employee-work-title"
      className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="px-5 pb-5 pt-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="employee-work-title"
              className="text-base font-semibold text-slate-950 dark:text-slate-50"
            >
              AI employee work
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              See who is working now, what changed, and where to check in.
            </p>
          </div>
          <Link
            to={`/c/${company.slug}/employees`}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            Manage employees <ChevronRight size={13} />
          </Link>
        </div>

        <div
          role="group"
          aria-label="Choose an AI employee"
          className="-mx-2 mt-5 flex gap-1 overflow-x-auto px-2 pb-1"
        >
          <TeamWorkBubble
            selected={!selected}
            state={rosterStatus === "ready" ? teamState : "quiet"}
            status={
              rosterStatus === "ready"
                ? teamStatus
                : rosterStatus === "loading"
                  ? "Loading work"
                  : "Status unavailable"
            }
            onSelect={() => setEmployeeId("")}
          />
          {employees.map((employee, index) => {
            const summary = summaries[index];
            return (
              <EmployeeWorkBubble
                key={employee.id}
                name={employee.name}
                role={employee.role}
                avatarSrc={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
                state={rosterStatus === "ready" ? summary.state : "quiet"}
                status={
                  rosterStatus === "ready"
                    ? employeeWorkStatusLabel(summary, nowIso)
                    : rosterStatus === "loading"
                      ? "Loading work"
                      : "Status unavailable"
                }
                selected={employee.id === employeeId}
                onSelect={() => setEmployeeId(employee.id)}
              />
            );
          })}
        </div>
      </div>

      <div className="border-t border-slate-100 dark:border-slate-800">
        <div className="grid lg:grid-cols-[19rem_minmax(0,1fr)]">
          <div className="border-b border-slate-100 bg-slate-50/70 p-5 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-950/30">
            {selected && selectedSummary ? (
              <EmployeeSpotlight
                company={company}
                employee={selected}
                summary={selectedSummary}
                nowIso={nowIso}
                status={selectedStatus}
              />
            ) : (
              <TeamSpotlight
                employees={employees}
                summaries={summaries}
                workingCount={workingCount}
                waitingCount={waitingCount}
                activeCount={activeCount}
                status={rosterStatus}
                onSelect={setEmployeeId}
              />
            )}
          </div>

          <div className="min-w-0">
            <div className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {selected ? `${selected.name}'s recent work` : "Recent work"}
              </h3>
              <span className="text-xs text-slate-400 dark:text-slate-500">Last 24 hours</span>
              {data !== null && displayEntryCount > 0 && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {displayEntryCount}
                </span>
              )}
            </div>

            {error ? (
              <div className="px-5 py-5">
                <FormError message={error} />
              </div>
            ) : data === null ? (
              <div className="flex min-h-64 items-center justify-center" aria-label="Loading work">
                <Spinner size={20} />
              </div>
            ) : entries.length === 0 ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
                  <CircleDashed size={18} />
                </span>
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {workEmptyTitle(selected?.name ?? null, 24)}
                </span>
                <span className="max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
                  Routine runs, conversations, repository work, and meaningful changes will appear
                  here as they happen.
                </span>
              </div>
            ) : (
              <div className="max-h-[38rem] overflow-y-auto">
                {groups.map((group) => (
                  <div key={group.key}>
                    <div className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-800/95 dark:text-slate-400">
                      {group.label}
                    </div>
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {group.items.map((entry, index) => (
                        <TimelineRow
                          key={entry.id}
                          company={company}
                          entry={entry}
                          nowIso={nowIso}
                          showEmployee={!selected}
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
              <div className="border-t border-slate-100 px-5 py-2.5 text-center text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                {overflow}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

const STATE_DOT: Record<EmployeeWorkState, string> = {
  working: "bg-emerald-500 ring-emerald-100 dark:ring-emerald-900",
  waiting: "bg-amber-500 ring-amber-100 dark:ring-amber-900",
  recent: "bg-sky-500 ring-sky-100 dark:ring-sky-900",
  quiet: "bg-slate-300 ring-slate-100 dark:bg-slate-600 dark:ring-slate-800",
};

const STATE_PILL: Record<EmployeeWorkState, string> = {
  working:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20",
  waiting:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  recent:
    "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20",
  quiet:
    "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
};

type WorkDataStatus = "loading" | "ready" | "unavailable";

/** Exported so the roster's accessible contract can be rendered in Node tests. */
export function EmployeeWorkBubble({
  name,
  role,
  avatarSrc,
  state,
  status,
  selected,
  onSelect,
}: {
  name: string;
  role: string;
  avatarSrc: string | null;
  state: EmployeeWorkState;
  status: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${name}, ${role}, ${status}`}
      onClick={onSelect}
      className={clsx(
        "group flex w-[7.25rem] shrink-0 flex-col items-center rounded-xl px-2 py-2 text-center transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40",
        selected
          ? "bg-indigo-50/80 dark:bg-indigo-500/10"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "relative rounded-full p-1 ring-2 transition",
          selected
            ? "bg-white ring-indigo-500 dark:bg-slate-900"
            : "bg-transparent ring-transparent group-hover:ring-slate-200 dark:group-hover:ring-slate-700",
        )}
      >
        <Avatar name={name} kind="ai" size="xl" src={avatarSrc} />
        <span
          aria-hidden="true"
          className={clsx(
            "absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-white ring-2 dark:border-slate-900",
            STATE_DOT[state],
            state === "working" && "motion-safe:animate-pulse",
          )}
        />
      </span>
      <span className="mt-2 w-full truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
        {name}
      </span>
      <span className="mt-0.5 w-full truncate text-[10px] text-slate-500 dark:text-slate-400">
        {status}
      </span>
    </button>
  );
}

function TeamWorkBubble({
  selected,
  state,
  status,
  onSelect,
}: {
  selected: boolean;
  state: EmployeeWorkState;
  status: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Everyone, ${status}`}
      onClick={onSelect}
      className={clsx(
        "group flex w-[7.25rem] shrink-0 flex-col items-center rounded-xl px-2 py-2 text-center transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40",
        selected
          ? "bg-indigo-50/80 dark:bg-indigo-500/10"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "relative flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full bg-slate-100 text-slate-600 ring-2 transition dark:bg-slate-800 dark:text-slate-300",
          selected
            ? "ring-indigo-500"
            : "ring-transparent group-hover:ring-slate-200 dark:group-hover:ring-slate-700",
        )}
      >
        <UsersRound size={25} />
        <span
          aria-hidden="true"
          className={clsx(
            "absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ring-2 dark:border-slate-900",
            STATE_DOT[state],
            state === "working" && "motion-safe:animate-pulse",
          )}
        />
      </span>
      <span className="mt-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
        Everyone
      </span>
      <span className="mt-0.5 w-full truncate text-[10px] text-slate-500 dark:text-slate-400">
        {status}
      </span>
    </button>
  );
}

function EmployeeSpotlight({
  company,
  employee,
  summary,
  nowIso,
  status: dataStatus,
}: {
  company: Company;
  employee: Employee;
  summary: EmployeeWorkSummary;
  nowIso: string;
  status: WorkDataStatus;
}) {
  const focus = dataStatus === "ready" ? employeeWorkFocus(summary) : null;
  const focusDetail = focus ? workDisplayDetail(focus) : "";
  const status =
    dataStatus === "ready"
      ? employeeWorkStatusLabel(summary, nowIso)
      : dataStatus === "loading"
        ? "Loading work"
        : "Status unavailable";
  const displayState = dataStatus === "ready" ? summary.state : "quiet";
  const focusLabel =
    summary.state === "working"
      ? "Current work"
      : summary.state === "waiting"
        ? "Waiting on"
        : "Most recent";
  const base = `/c/${company.slug}/employees/${employee.slug}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3">
        <span aria-hidden="true">
          <Avatar
            name={employee.name}
            kind="ai"
            size="xl"
            src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
          />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-950 dark:text-slate-50">
            {employee.name}
          </h3>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{employee.role}</p>
        </div>
      </div>

      <span
        className={clsx(
          "mt-4 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset",
          STATE_PILL[displayState],
        )}
      >
        <span className={clsx("h-1.5 w-1.5 rounded-full", STATE_DOT[displayState])} />
        {status}
      </span>

      <div className="mt-5 min-h-28 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
          {dataStatus !== "ready" ? "Work status" : focus ? focusLabel : "Today"}
        </p>
        {dataStatus !== "ready" ? (
          <p className="mt-2 text-sm leading-5 text-slate-500 dark:text-slate-400">
            {dataStatus === "loading"
              ? "Checking current and recent work…"
              : "Recent work could not be loaded."}
          </p>
        ) : focus ? (
          <>
            <p className="mt-2 text-sm font-medium leading-5 text-slate-900 dark:text-slate-100">
              {workDisplayTitle(focus)}
            </p>
            {focusDetail && (
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {focusDetail}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {WORK_KIND_META[focus.kind].label} · {workRelativeTime(focus.at, nowIso)}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm leading-5 text-slate-500 dark:text-slate-400">
            No recorded work in the last 24 hours.
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 lg:mt-auto lg:pt-5">
        <Link to={`${base}/chat`} className={buttonClassName({ size: "sm" })}>
          <MessageCircle size={14} /> Check in
        </Link>
        <Link
          to={`${base}/settings`}
          className={buttonClassName({ variant: "secondary", size: "sm" })}
        >
          Employee details <ArrowUpRight size={13} />
        </Link>
      </div>
    </div>
  );
}

/** Exported so loading and failure copy can be pinned without a browser DOM. */
export function TeamSpotlight({
  employees,
  summaries,
  workingCount,
  waitingCount,
  activeCount,
  status,
  onSelect,
}: {
  employees: Employee[];
  summaries: EmployeeWorkSummary[];
  workingCount: number;
  waitingCount: number;
  activeCount: number;
  status: WorkDataStatus;
  onSelect: (employeeId: string) => void;
}) {
  const working = summaries.filter((summary) => summary.state === "working");
  const headline =
    status === "loading"
      ? "Loading your team's work…"
      : status === "unavailable"
        ? "Work status is unavailable"
        : workingCount
          ? `${workingCount} ${workingCount === 1 ? "employee is" : "employees are"} working now`
          : waitingCount
            ? `${waitingCount} ${waitingCount === 1 ? "employee needs" : "employees need"} input`
            : "No one is working right now";

  return (
    <div className="flex h-full flex-col">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20">
        <UsersRound size={18} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-slate-950 dark:text-slate-50">Your team</h3>
      <p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-300">{headline}</p>
      {status === "ready" ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {activeCount} of {employees.length} working, waiting, or recently active
        </p>
      ) : (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {status === "loading"
            ? "Checking current and recent work."
            : "The timeline request did not complete."}
        </p>
      )}

      {status === "ready" && working.length > 0 ? (
        <div className="mt-5 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
            Working now
          </p>
          {working.slice(0, 3).map((summary) => {
            const employee = employees.find((row) => row.id === summary.employeeId);
            if (!employee || !summary.currentEntry) return null;
            return (
              <button
                key={summary.employeeId}
                type="button"
                onClick={() => onSelect(summary.employeeId)}
                className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-200 hover:bg-indigo-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-500/30 dark:hover:bg-indigo-500/5"
              >
                <span className="block truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {employee.name}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {summary.currentEntry.title}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-5 rounded-xl border border-dashed border-slate-200 px-3 py-3 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {status === "ready"
            ? "Select an employee above to see their latest work and start a check-in."
            : status === "loading"
              ? "Employee bubbles will update as soon as work is loaded."
              : "You can still select an employee above and check in directly."}
        </p>
      )}
    </div>
  );
}

const KIND_ICON: Record<WorkEntryKind, React.ReactNode> = {
  run: <Play size={14} />,
  chat: <MessageSquare size={14} />,
  work_session: <GitCommitHorizontal size={14} />,
  approval: <ShieldCheck size={14} />,
  wakeup: <AlarmClock size={14} />,
  lesson: <Lightbulb size={14} />,
  effect: <CircleDashed size={14} />,
};

function TimelineRow({
  company,
  entry,
  nowIso,
  showEmployee,
  lastInGroup,
  onOpenRun,
}: {
  company: Company;
  entry: WorkEntry;
  nowIso: string;
  showEmployee: boolean;
  lastInGroup: boolean;
  onOpenRun: (entry: WorkEntry) => void;
}) {
  const meta = WORK_KIND_META[entry.kind];
  const href = workEntryHref(entry, company.slug);
  const shownEffects = entry.effects.slice(0, 3);
  const effectOverflow = workEffectOverflowLabel(entry, shownEffects.length);
  const displayDetail = workDisplayDetail(entry);
  const absoluteTime = new Date(entry.at);
  const absoluteLabel = Number.isNaN(absoluteTime.getTime())
    ? undefined
    : absoluteTime.toLocaleString();

  const body = (
    <>
      {!lastInGroup && (
        <span
          aria-hidden="true"
          className="absolute -bottom-4 left-9 top-12 w-px bg-slate-200 dark:bg-slate-700"
        />
      )}
      <span
        aria-hidden="true"
        title={meta.label}
        className={clsx(
          "relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1",
          meta.tone,
        )}
      >
        {KIND_ICON[entry.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          {showEmployee && (
            <>
              <span className="flex min-w-0 items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                <span aria-hidden="true">
                  <Avatar
                    name={entry.employee.name}
                    kind="ai"
                    size="xs"
                    src={employeeAvatarUrl(company.id, entry.employee.id, entry.employee.avatarKey)}
                  />
                </span>
                <span className="truncate">{entry.employee.name}</span>
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>{meta.label}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={entry.at} title={absoluteLabel} className="tabular-nums">
            {workRelativeTime(entry.at, nowIso)}
          </time>
        </span>

        <span className="mt-1.5 flex flex-wrap items-start gap-2">
          <span className="min-w-0 grow basis-48 text-sm font-medium leading-5 text-slate-900 dark:text-slate-100">
            {workDisplayTitle(entry)}
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

        {displayDetail && (
          <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">
            {displayDetail}
          </span>
        )}

        {shownEffects.length > 0 && (
          <span className="mt-3 block space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
            {shownEffects.map((effect, index) => (
              <span
                key={`${effect.at}-${effect.action}-${index}`}
                className="flex items-start gap-2 text-[11px] leading-4"
              >
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500" />
                <span className="text-slate-600 dark:text-slate-300">
                  {humanizeWorkAction(effect.action, effect.targetType)}
                  {effect.targetLabel && (
                    <span className="text-slate-400 dark:text-slate-500">
                      {` · ${effect.targetLabel}`}
                    </span>
                  )}
                </span>
              </span>
            ))}
            {effectOverflow && (
              <span className="block pl-3 text-[11px] text-slate-400 dark:text-slate-500">
                {effectOverflow}
              </span>
            )}
          </span>
        )}
      </span>
      {href && (
        <ChevronRight
          aria-hidden="true"
          size={15}
          className="mt-2 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500 dark:text-slate-600 dark:group-hover:text-slate-400"
        />
      )}
    </>
  );

  const rowClass =
    "group relative flex gap-3 px-5 py-4 transition-colors hover:bg-slate-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/40 dark:hover:bg-slate-800/40";

  if (!href) return <li className={rowClass}>{body}</li>;

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
