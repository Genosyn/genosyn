import React from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarCheck, Clock3, Hourglass, OctagonX, Radio } from "lucide-react";
import { api, type Company, type RoutinePriority, type RoutineWithMeta, type Run } from "@/lib/api";
import { isRunPaused } from "@/lib/runStatus";
import { movedUpNote, QUEUE_ORDER_NOTE, queuePlace } from "@/lib/routinePriority";
import { QueuePlaceBadge, RoutinePriorityChip } from "@/components/routines/RoutinePriorityChip";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import {
  formatDuration,
  RunChecksChip,
  RunOutcomeChip,
  RunStatusChip,
  runFollowUpLabel,
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
  | "followUpRun"
  | "missedSlots"
  | "outcomeVerdict"
  | "checksVerdict"
>;

/** A Run waiting to start, or one paused for a restart that resumes when it can. */
export type RoutineActivityQueuedRun = RoutineActivityRun &
  Required<Pick<Run, "queuedAt" | "pauseCount" | "pausedAt">> & {
    /** Its Routine's priority when the server listed it. */
    priority?: RoutinePriority;
    /**
     * Its place among the company's Runs waiting to start, 1 being next up.
     * Null for work a Standdown holds; missing from an older server.
     */
    position?: number | null;
  };

export type RoutineActivityData = {
  running: RoutineActivityRun[];
  /** The first waiting Runs, in the order they will start; `queuedCount` counts every one. */
  queued: RoutineActivityQueuedRun[];
  queuedCount: number;
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

/**
 * What is running, what waits to start, and what ran today. Recent work is
 * independent of Routine.lastRun, which can hide earlier Runs.
 */
export function RoutineActivity({
  company,
  routines,
}: {
  company: Company;
  routines: RoutineWithMeta[];
}) {
  const [snapshot, setSnapshot] = React.useState<{
    companyId: string;
    from: string;
    data: RoutineActivityData;
  } | null>(null);
  const [errorCompanyId, setErrorCompanyId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const refreshRef = React.useRef<(() => Promise<void>) | null>(null);
  const refresh = React.useCallback(() => refreshRef.current?.(), []);

  React.useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let pending = false;
    const load = async () => {
      if (disposed) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      const range = todayRange();
      try {
        const data = await api.get<RoutineActivityData>(
          `/api/companies/${company.id}/routines/activity?${new URLSearchParams(range)}`,
        );
        if (disposed) return;
        setSnapshot({ companyId: company.id, from: range.from, data });
        setErrorCompanyId(null);
      } catch {
        if (!disposed) setErrorCompanyId(company.id);
      } finally {
        inFlight = false;
        // Keep the reply visible even when reads are slower than polling or
        // live events. Those refreshes need only one follow-up, not competing
        // requests that continually invalidate each other's result.
        if (pending && !disposed) {
          pending = false;
          void load();
        }
      }
    };
    refreshRef.current = load;
    // StrictMode tears down its first setup immediately. Avoid issuing a read
    // for that discarded lifecycle; its guarded microtask simply does nothing.
    queueMicrotask(() => void load());
    // Socket events cover ordinary changes. Polling also handles reconnects,
    // advancing elapsed times, and a page left open across local midnight.
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      disposed = true;
      refreshRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [company.id]);
  useLiveRefetch(["routine", "run"], refresh);

  const byId = new Map(routines.map((routine) => [routine.id, routine]));
  const data = snapshot?.companyId === company.id && snapshot.from === todayRange().from
    ? snapshot.data
    : null;
  const running = data?.running.filter((run) => byId.has(run.routineId)) ?? [];
  const queued = data?.queued.filter((run) => byId.has(run.routineId)) ?? [];
  // The reply lists the first waiting Runs; a longer queue still says how long.
  const queuedBeyondList = data ? Math.max(0, data.queuedCount - data.queued.length) : 0;
  const today = data?.today.filter((item) => byId.has(item.routineId)) ?? [];
  const runCount = today.reduce((count, item) => count + item.runCount, 0);

  async function retry() {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  if (errorCompanyId === company.id) {
    return (
      <div className="mb-6 space-y-2">
        <FormError message="Couldn’t load recent Runs. Try again to see what’s running and what ran today." />
        <Button variant="secondary" loading={retrying} onClick={() => void retry()}>
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
      <section aria-labelledby="running-now-heading">
        <div className="mb-3 flex items-center gap-2">
          <Radio size={16} className="text-indigo-500" />
          <h2
            id="running-now-heading"
            className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            Running now
          </h2>
          {running.length > 0 && (
            <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-xs tabular-nums text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
              {running.length}
            </span>
          )}
        </div>
        {running.length === 0 ? (
          <EmptyActivity>Nothing is running right now.</EmptyActivity>
        ) : (
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
        )}
      </section>

      <section aria-labelledby="queued-heading">
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Hourglass size={16} className="text-slate-400" />
          <h2
            id="queued-heading"
            className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            Queued
          </h2>
          {queued.length + queuedBeyondList > 0 && (
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {queued.length + queuedBeyondList}
            </span>
          )}
          <span className="text-xs text-slate-400 sm:ml-auto dark:text-slate-500">
            {QUEUE_ORDER_NOTE}
          </span>
        </div>
        {queued.length === 0 && queuedBeyondList === 0 ? (
          <EmptyActivity>Nothing is waiting to start.</EmptyActivity>
        ) : (
          <>
            <ul className="space-y-2">
              {queued.map((run) => (
                <ActivityRow
                  key={run.id}
                  company={company}
                  routine={byId.get(run.routineId)!}
                  run={run}
                />
              ))}
            </ul>
            {queuedBeyondList > 0 && (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                Showing the first {queued.length} of {queued.length + queuedBeyondList} queued Runs.
              </p>
            )}
          </>
        )}
      </section>

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
          <EmptyActivity>No routines have finished a Run today.</EmptyActivity>
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

function EmptyActivity({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {children}
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
  run: RoutineActivityRun | RoutineActivityQueuedRun;
  runCount?: number;
}) {
  const running = run.status === "running";
  const waiting = run.status === "queued" ? (run as RoutineActivityQueuedRun) : null;
  // A Run paused for a restart has worked already; it waits to resume.
  const paused = waiting ? isRunPaused(waiting) : false;
  const waitingSince = waiting
    ? ((paused ? waiting.pausedAt : waiting.queuedAt) ?? run.startedAt)
    : null;
  const employee = routine.employee;
  const hrefForRun = (id: string) =>
    employee
      ? `/c/${company.slug}/routines/${employee.slug}/${routine.slug}?run=${encodeURIComponent(id)}`
      : `/c/${company.slug}/routines?routine=${encodeURIComponent(routine.id)}&run=${encodeURIComponent(id)}`;
  const endedAt = run.finishedAt ?? run.startedAt;
  // A Standdown defers queued work rather than cancelling it; say so where it waits.
  const standdownTitle =
    waiting && routine.standdown
      ? `${routine.standdown.scope === "company" ? "Company" : routine.standdown.scope === "employee" ? "AI Employee" : "Routine"} Standdown: ${routine.standdown.reason}`
      : null;
  // The queue reads the Routine's priority when it orders, so the Routine's is
  // the one to show; a waiting Run's own copy only covers a list newer than it.
  const priority = routine.priority ?? waiting?.priority;
  const place = waiting ? queuePlace(waiting.position) : null;
  const movedUp =
    waiting && !paused ? movedUpNote({ priority, queuedAt: waiting.queuedAt }, Date.now()) : null;
  return (
    <li className="min-w-0">
      <Link
        to={hrefForRun(run.id)}
        aria-label={`${routine.name}: ${running ? "view live Run" : waiting ? "view queued Run" : "view latest Run"}${place ? `, ${place.next ? "next up" : `${place.label} in the queue`}` : ""}`}
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
          <QueuePlaceBadge place={place} />
          <RunStatusChip
            status={run.status}
            errorKind={run.errorKind}
            pauseCount={waiting?.pauseCount}
            size="xs"
          />
          {(waiting || running) && <RoutinePriorityChip priority={priority} />}
          {movedUp && <span className="text-xs text-slate-500 dark:text-slate-400">{movedUp}</span>}
          {standdownTitle && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-500/10 dark:text-red-300"
              title={standdownTitle}
            >
              <OctagonX size={11} aria-hidden="true" /> Stood down
            </span>
          )}
          {(run.attempt ?? 1) > 1 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              attempt {run.attempt}
            </span>
          )}
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
          {!running && !waiting && run.status !== "reviewed" && run.outcomeVerdict && (
            <RunOutcomeChip verdict={run.outcomeVerdict} size="xs" />
          )}
          {!running && !waiting && run.status !== "reviewed" && run.checksVerdict && (
            <RunChecksChip verdict={run.checksVerdict} size="xs" />
          )}
        </div>
        <div
          className="flex items-center gap-1.5 text-xs tabular-nums text-slate-500 dark:text-slate-400"
          title={new Date(waitingSince ?? (running ? run.startedAt : endedAt)).toLocaleString()}
        >
          <Clock3 size={12} className="shrink-0" />
          {running ? (
            `Started ${timeAgo(run.startedAt)}`
          ) : waitingSince ? (
            `${paused ? "Paused" : "Queued"} ${timeAgo(waitingSince)}`
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
      {run.followUpRun && run.followUpRun.id !== run.id && (
        <Link
          to={hrefForRun(run.followUpRun.id)}
          className="mt-1 inline-block px-4 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {runFollowUpLabel(run.followUpRun)} · Open{" "}
          {run.followUpRun.triggerKind === "continuation" ? "continuation" : "follow-up Run"}
        </Link>
      )}
    </li>
  );
}
