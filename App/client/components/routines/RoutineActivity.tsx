import React from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarCheck, Clock3, Radio } from "lucide-react";
import { api, type Company, type RoutineWithMeta, type Run } from "@/lib/api";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import {
  formatDuration,
  RunChecksChip,
  RunOutcomeChip,
  RunStatusChip,
  timeAgo,
} from "@/components/routines/RunViews";

export type RoutineActivityRun = Pick<
  Run,
  | "id"
  | "routineId"
  | "status"
  | "errorKind"
  | "startedAt"
  | "finishedAt"
  | "exitCode"
  | "attempt"
  | "retryAt"
  | "continuationPending"
  | "continuationCount"
  | "continuationStopReason"
  | "missedSlots"
  | "outcomeVerdict"
  | "checksVerdict"
>;

export type RoutineActivityData = {
  running: RoutineActivityRun[];
  today: { routineId: string; runCount: number; latestRun: RoutineActivityRun }[];
};

/** Local calendar boundaries, including the shorter/longer days around DST. */
function todayRange() {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Recent work is independent of Routine.lastRun, which can hide earlier Runs. */
export function RoutineActivity({
  company,
  routines,
}: {
  company: Company;
  routines: RoutineWithMeta[];
}) {
  const [snapshot, setSnapshot] = React.useState<{
    from: string;
    data: RoutineActivityData;
  } | null>(null);
  const [error, setError] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const requestId = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const id = ++requestId.current;
    const range = todayRange();
    try {
      const data = await api.get<RoutineActivityData>(
        `/api/companies/${company.id}/routines/activity?${new URLSearchParams(range)}`,
      );
      if (id !== requestId.current) return;
      setSnapshot({ from: range.from, data });
      setError(false);
    } catch {
      if (id !== requestId.current) return;
      setError(true);
    }
  }, [company.id]);

  React.useEffect(() => {
    void refresh();
    // Socket events cover ordinary changes. Polling also handles reconnects,
    // advancing elapsed times, and a page left open across local midnight.
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      requestId.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);
  useLiveRefetch(["routine", "run"], refresh);

  const byId = new Map(routines.map((routine) => [routine.id, routine]));
  const data = snapshot?.from === todayRange().from ? snapshot.data : null;
  const running = data?.running.filter((run) => byId.has(run.routineId)) ?? [];
  const today = data?.today.filter((item) => byId.has(item.routineId)) ?? [];
  const runCount = today.reduce((count, item) => count + item.runCount, 0);

  if (error) {
    return (
      <div className="mb-6 space-y-2">
        <FormError message="Couldn’t load recent Runs. Try again to see what’s running and what ran today." />
        <Button variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div
        role="status"
        className="mb-6 rounded-xl border border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
      >
        Loading recent Runs…
      </div>
    );
  }

  return (
    <div className="mb-8 space-y-6">
      {running.length > 0 && (
        <section aria-labelledby="running-now-heading">
          <div className="mb-3 flex items-center gap-2">
            <Radio size={16} className="text-indigo-500" />
            <h2
              id="running-now-heading"
              className="text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              Running now
            </h2>
            <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-xs tabular-nums text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
              {running.length}
            </span>
          </div>
          <ul className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
            {running.map((run) => (
              <ActivityRow
                key={run.id}
                company={company}
                routine={byId.get(run.routineId)!}
                run={run}
              />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="ran-today-heading">
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <CalendarCheck size={16} className="text-slate-400" />
          <h2
            id="ran-today-heading"
            className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            Ran today
          </h2>
          {today.length > 0 && (
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {today.length} {today.length === 1 ? "routine" : "routines"} · {runCount}{" "}
              {runCount === 1 ? "Run" : "Runs"}
            </span>
          )}
          <span className="text-xs text-slate-400 sm:ml-auto dark:text-slate-500">
            Your local time
          </span>
        </div>
        {today.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
            No routines have finished a Run today
            {routines.length === 0 ? " with these filters" : ""}.
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {(expanded ? today : today.slice(0, 5)).map((item) => (
                <ActivityRow
                  key={item.routineId}
                  company={company}
                  routine={byId.get(item.routineId)!}
                  run={item.latestRun}
                  runCount={item.runCount}
                />
              ))}
            </ul>
            {today.length > 5 && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-3 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {expanded ? "Show fewer" : `Show all ${today.length} routines`}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ActivityRow({
  company,
  routine,
  run,
  runCount,
}: {
  company: Company;
  routine: RoutineWithMeta;
  run: RoutineActivityRun;
  runCount?: number;
}) {
  const running = run.status === "running";
  const employee = routine.employee;
  const href = employee
    ? `/c/${company.slug}/routines/${employee.slug}/${routine.slug}?run=${encodeURIComponent(run.id)}`
    : `/c/${company.slug}/routines?routine=${encodeURIComponent(routine.id)}&run=${encodeURIComponent(run.id)}`;
  const endedAt = run.finishedAt ?? run.startedAt;
  return (
    <li className="min-w-0">
      <Link
        to={href}
        aria-label={`${routine.name}: ${running ? "view live Run" : "view latest Run"}`}
        className="group flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition hover:border-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-indigo-500/50"
      >
        <div className="min-w-0 flex-1 basis-48">
          <div
            className="truncate text-sm font-medium text-slate-900 group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-300"
            title={routine.name}
          >
            {routine.name}
          </div>
          {employee && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Avatar
                name={employee.name}
                src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
                kind="ai"
                size="xs"
              />
              <span className="truncate">{employee.name}</span>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <RunStatusChip status={run.status} errorKind={run.errorKind} size="xs" />
          {run.continuationPending && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Continuation scheduled
            </span>
          )}
          {!run.continuationPending && (run.continuationCount ?? 0) > 0 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              continuation {run.continuationCount}
            </span>
          )}
          {!running && run.status !== "reviewed" && run.outcomeVerdict && (
            <RunOutcomeChip verdict={run.outcomeVerdict} size="xs" />
          )}
          {!running && run.status !== "reviewed" && run.checksVerdict && (
            <RunChecksChip verdict={run.checksVerdict} size="xs" />
          )}
        </div>
        <div
          className="flex items-center gap-1.5 text-xs tabular-nums text-slate-500 dark:text-slate-400"
          title={new Date(running ? run.startedAt : endedAt).toLocaleString()}
        >
          <Clock3 size={12} className="shrink-0" />
          {running ? (
            `Started ${timeAgo(run.startedAt)}`
          ) : (
            <span>
              {runCount && runCount > 1 ? `${runCount} Runs · latest ` : ""}
              {new Date(endedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              · {formatDuration(run.startedAt, run.finishedAt)}
            </span>
          )}
        </div>
        <ArrowUpRight
          size={14}
          className="ml-auto shrink-0 text-slate-400 group-hover:text-indigo-500"
        />
      </Link>
    </li>
  );
}
