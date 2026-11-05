import React from "react";
import { Link } from "react-router-dom";
import { CircleDot, Hourglass, ListTodo } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import type { Company, Employee, EmployeeWorkQueue } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  TODO_PICKUP_TRIGGER_LABEL,
  TODO_WAIT_LABEL,
  todoPickupHoldLabel,
  type EmployeeTodoQueue as TodoQueue,
  type TodoQueueItem,
} from "../../../shared/todoPickups";

const SHOWN = 5;

function placeInLine(position: number | null): string | null {
  if (!position) return null;
  return position === 1 ? "Next up" : `Number ${position} in line`;
}

/**
 * The Todos on an AI Employee's plate: what it's working on, what's next and why it
 * hasn't started, and what's waiting on someone. It reads the queue the heartbeat
 * runs from, so what it says is what will happen. A Todo in a Project you can't open
 * isn't listed or counted.
 */
export function EmployeeTodoQueue({
  company,
  employee,
  onNavigate,
  className,
}: {
  company: Company;
  employee: Employee;
  onNavigate?: () => void;
  className?: string;
}) {
  const [queue, setQueue] = React.useState<TodoQueue | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const request = React.useRef(0);
  const headingId = React.useId();

  const load = React.useCallback(async () => {
    const ticket = ++request.current;
    try {
      const next = await api.get<EmployeeWorkQueue>(
        `/api/companies/${company.id}/employees/${employee.id}/work-queue`,
      );
      if (ticket !== request.current) return;
      setQueue(
        next.todos ?? { running: [], queued: [], queuedCount: 0, waiting: [], waitingCount: 0 },
      );
      setError(null);
    } catch (err) {
      if (ticket !== request.current) return;
      setError(errorMessage(err, "Could not load this employee's Todos."));
    }
  }, [company.id, employee.id]);

  React.useEffect(() => {
    setQueue(null);
    setError(null);
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);
  useLiveRefetch(["todo", "employee", "standdown"], load);

  const retry = async () => {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  };

  const nothing =
    queue && queue.running.length === 0 && queue.queuedCount === 0 && queue.waitingCount === 0;

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex items-center justify-between gap-3">
        <h3
          id={headingId}
          className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
        >
          <ListTodo size={16} className="text-slate-400" aria-hidden="true" />
          Todos
        </h3>
        {queue && !error && (
          <span
            className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
            aria-live="polite"
          >
            {queue.queuedCount} queued · {queue.waitingCount} waiting
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
        It works one Todo at a time, highest priority first. A waiting Todo starts by itself when
        the answer arrives.
      </p>
      {error ? (
        <div className="mt-3">
          <FormError message={error} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            loading={retrying}
            onClick={() => void retry()}
          >
            Try again
          </Button>
        </div>
      ) : !queue ? (
        <div
          className="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
          role="status"
        >
          <Spinner size={14} /> Loading Todos…
        </div>
      ) : nothing ? (
        <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Nothing queued or waiting.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          <Group
            label="Working now"
            icon={<CircleDot size={12} aria-hidden="true" />}
            items={queue.running}
            total={queue.running.length}
            company={company}
            onNavigate={onNavigate}
            describe={(item) =>
              item.pickup ? TODO_PICKUP_TRIGGER_LABEL[item.pickup.trigger] : null
            }
          />
          <Group
            label="Queued"
            icon={<ListTodo size={12} aria-hidden="true" />}
            items={queue.queued}
            total={queue.queuedCount}
            company={company}
            onNavigate={onNavigate}
            describe={(item) =>
              item.pickup
                ? [placeInLine(item.pickup.position), todoPickupHoldLabel(item.pickup.hold)]
                    .filter(Boolean)
                    .join(" · ")
                : null
            }
          />
          <Group
            label="Waiting"
            icon={<Hourglass size={12} aria-hidden="true" />}
            items={queue.waiting}
            total={queue.waitingCount}
            company={company}
            onNavigate={onNavigate}
            describe={(item) =>
              item.waiting
                ? [TODO_WAIT_LABEL[item.waiting.on], item.waiting.reason].filter(Boolean).join(": ")
                : null
            }
          />
        </div>
      )}
    </section>
  );
}

function Group({
  label,
  icon,
  items,
  total,
  company,
  onNavigate,
  describe,
}: {
  label: string;
  icon: React.ReactNode;
  items: TodoQueueItem[];
  total: number;
  company: Company;
  onNavigate?: () => void;
  describe: (item: TodoQueueItem) => string | null;
}) {
  const [expanded, setExpanded] = React.useState(false);
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, SHOWN);
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </p>
      <ul aria-label={label} className="divide-y divide-slate-100 dark:divide-slate-800">
        {visible.map((item) => {
          const line = describe(item);
          return (
            <li key={item.todoId} className="py-2 first:pt-0 last:pb-0">
              <Link
                to={`/c/${company.slug}/tasks/p/${item.projectSlug}?todo=${encodeURIComponent(item.todoId)}`}
                onClick={onNavigate}
                className="break-words text-sm font-medium text-slate-800 transition hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-400"
              >
                <span className="mr-1.5 text-xs tabular-nums text-slate-400">{item.ref}</span>
                {item.title}
              </Link>
              {line && (
                <p className="mt-0.5 break-words text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {line}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > SHOWN && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show fewer" : `Show ${items.length - SHOWN} more`}
        </Button>
      )}
      {total > items.length && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Showing the first {items.length} of {total}.
        </p>
      )}
    </div>
  );
}
