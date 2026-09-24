import React from "react";
import { Link } from "react-router-dom";
import { Clock3, ListOrdered } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import type {
  Company,
  Employee,
  EmployeeQueueItem,
  EmployeeWorkQueue as WorkQueue,
} from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { workRelativeTime } from "@/lib/workTimeline";

/** The employee's live Routine queue stays independent of the calendar date. */
export function EmployeeWorkQueue({
  company,
  employee,
  nowIso,
  onClose,
}: {
  company: Company;
  employee: Employee;
  nowIso: string;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<WorkQueue | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const request = React.useRef(0);
  const headingId = React.useId();
  const load = React.useCallback(async () => {
    const ticket = ++request.current;
    try {
      const next = await api.get<WorkQueue>(
        `/api/companies/${company.id}/employees/${employee.id}/work-queue`,
      );
      if (ticket !== request.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (ticket !== request.current) return;
      setError(errorMessage(err, "Could not load the work queue."));
    }
  }, [company.id, employee.id]);

  React.useEffect(() => {
    setData(null);
    setError(null);
    setExpanded(false);
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      request.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);
  useLiveRefetch(["run", "routine", "employee", "standdown"], load);

  const currentData = data?.employeeId === employee.id ? data : null;
  const visiblePending = expanded
    ? (currentData?.pending ?? [])
    : (currentData?.pending.slice(0, 5) ?? []);
  const routineBase = `/c/${company.slug}/routines/${employee.slug}`;

  return (
    <section
      aria-labelledby={headingId}
      className="border-b border-slate-200 px-4 py-4 sm:px-5 dark:border-slate-800"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id={headingId}
          className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
        >
          <ListOrdered size={16} className="text-slate-400" aria-hidden="true" />
          Work queue
        </h3>
        {currentData && !error && (
          <span
            className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
            aria-live="polite"
          >
            {currentData.pendingCount} pending
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
        Routines run one at a time. This queue always shows the current work.
      </p>
      {error ? (
        <div className="mt-3">
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
      ) : !currentData ? (
        <div
          className="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
          role="status"
        >
          <Spinner size={14} /> Loading work queue…
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {currentData.current && (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3 dark:border-indigo-500/20 dark:bg-indigo-500/5">
              <p className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                Working now
              </p>
              <QueueRoutine
                item={currentData.current}
                routineBase={routineBase}
                onClose={onClose}
                active
              />
            </div>
          )}
          {currentData.pending.length > 0 ? (
            <ol
              aria-label="Pending Routines"
              className="divide-y divide-slate-100 dark:divide-slate-800"
            >
              {visiblePending.map((item) => (
                <li key={item.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span
                    aria-label={`Queue position ${item.position}`}
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[11px] font-medium tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  >
                    {item.position}
                  </span>
                  <div className="min-w-0 flex-1">
                    <QueueRoutine item={item} routineBase={routineBase} onClose={onClose} />
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {item.triggerKind === "retry"
                        ? "Retry"
                        : item.triggerKind === "continuation"
                          ? "Continuation"
                          : "Queued"}
                      {" · "}
                      <time
                        dateTime={item.queuedAt}
                        title={new Date(item.queuedAt).toLocaleString()}
                      >
                        {workRelativeTime(item.queuedAt, nowIso)}
                      </time>
                    </p>
                    {item.availableAt && Date.parse(item.availableAt) > Date.parse(nowIso) && (
                      <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
                        <Clock3 size={12} className="mt-1 shrink-0" aria-hidden="true" />
                        <span>
                          Waiting until{" "}
                          <time dateTime={item.availableAt}>
                            {new Date(item.availableAt).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        </span>
                      </p>
                    )}
                    {item.blockedReason && (
                      <p className="mt-1 break-words text-xs leading-5 text-amber-700 dark:text-amber-400">
                        {item.blockedReason}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              No Routines waiting.
            </p>
          )}
          {currentData.pending.length > 5 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? "Show fewer" : `Show ${currentData.pending.length - 5} more`}
            </Button>
          )}
          {currentData.pendingCount > currentData.pending.length && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Showing the first {visiblePending.length} of {currentData.pendingCount} pending
              Routines.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function QueueRoutine({
  item,
  routineBase,
  onClose,
  active = false,
}: {
  item: EmployeeQueueItem;
  routineBase: string;
  onClose: () => void;
  active?: boolean;
}) {
  const query = active && item.runId ? `?run=${encodeURIComponent(item.runId)}` : "";
  return (
    <Link
      to={`${routineBase}/${item.routine.slug}${query}`}
      onClick={onClose}
      className="break-words text-sm font-medium text-slate-800 transition hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-400"
    >
      {item.routine.name}
    </Link>
  );
}
