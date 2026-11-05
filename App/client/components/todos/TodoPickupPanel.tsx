import React from "react";
import { Clock3, Hourglass, Play, Square } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { LiveTurnCard } from "@/components/chat/TurnActivity";
import {
  PickupBrowserRecording,
  useTodoBrowserRecordings,
} from "@/components/todos/TodoBrowserRecordings";
import { useFollowedTurn } from "@/components/chat/useFollowedTurn";
import { Avatar } from "@/components/todos/todoShared";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { api, type Todo } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { todoStanding } from "../../../shared/todoStanding";
import {
  TODO_WAIT_LABEL,
  todoPickupHoldLabel,
  type TodoPickupView,
} from "../../../shared/todoPickups";

type Pickups = {
  active: TodoPickupView | null;
  recent: TodoPickupView[];
  viewerIsReviewer?: boolean;
};

function shortWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What this reader is not shown of the steps, when it is not everything. */
function stepsNote(pickup: TodoPickupView): string | null {
  if (pickup.access !== "steps") return null;
  const whose = pickup.requester ? `${pickup.requester.name}'s` : "another Member's";
  return `It works with ${whose} access, so you see its steps but not what they read.`;
}

/**
 * The AI Employee working this Todo right now, or the session waiting its turn,
 * with the same live card a direct chat shows. When nothing is running it offers
 * Start now, for a Todo that sat after a blocked pass or was assigned before its
 * employee had an AI Model.
 */
export function TodoPickupPanel({
  todo,
  companyId,
  companySlug,
  canEdit,
}: {
  todo: Pick<
    Todo,
    | "id"
    | "status"
    | "assigneeEmployeeId"
    | "projectId"
    | "waitingOn"
    | "waitingReason"
    | "waitingSince"
    | "waitingCheckAt"
    | "heldToLimits"
    | "assignee"
    | "reviewer"
  >;
  companyId: string;
  companySlug: string;
  canEdit: boolean;
}) {
  const [pickups, setPickups] = React.useState<Pickups | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const dialog = useDialog();
  const base = `/api/companies/${companyId}/todos/${todo.id}/pickups`;
  const ticket = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const next = await api.get<Pickups>(base);
      if (mine === ticket.current) setPickups(next);
    } catch (err) {
      if (mine === ticket.current) setError(errorMessage(err, "Could not load this work."));
    }
  }, [base]);

  React.useEffect(() => {
    setPickups(null);
    setError(null);
    void load();
  }, [load]);
  useLiveRefetch("todo", () => void load(), todo.projectId);

  /** Going past a Todo's limits is the one thing here that's asked first. */
  async function lendsAccess(): Promise<boolean> {
    return dialog.confirm({
      title: "Use your access for this session?",
      message:
        "Outside words, like an email, may be on its thread, and they stay there. For this one session its AI Employee can do what you can, and anything it sends waits for approval. It goes back to its limits after.",
      confirmLabel: "Use my access",
    });
  }

  async function startNow(withMyAccess = false) {
    if (withMyAccess && !(await lendsAccess())) return;
    setStarting(true);
    setError(null);
    try {
      setPickups(await api.post<Pickups>(base, withMyAccess ? { withMyAccess } : {}));
    } catch (err) {
      setError(errorMessage(err, "Could not start this."));
    } finally {
      setStarting(false);
    }
  }

  async function stopWaiting(withMyAccess = false) {
    if (withMyAccess && !(await lendsAccess())) return;
    setStarting(true);
    setError(null);
    try {
      setPickups(
        await api.post<Pickups>(
          `/api/companies/${companyId}/todos/${todo.id}/stop-waiting`,
          withMyAccess ? { withMyAccess } : {},
        ),
      );
    } catch (err) {
      setError(errorMessage(err, "Could not end the wait."));
    } finally {
      setStarting(false);
    }
  }

  // A queued check-back while it waits is the wait, already shown.
  const waiting = todo.waitingOn ?? null;
  const active = pickups?.active ?? null;
  const shownActive = waiting && active?.status === "queued" ? null : active;
  const last = pickups?.recent[0] ?? null;
  const workable = ["backlog", "todo", "in_progress"].includes(todo.status);
  const canStart = canEdit && Boolean(todo.assigneeEmployeeId) && workable && !active && !waiting;
  if (!pickups && !error) return null;
  const standing = pickups
    ? todoStanding({
        status: todo.status,
        assignee: todo.assignee
          ? { kind: todo.assignee.kind, name: todo.assignee.name || "Someone" }
          : null,
        reviewerName: todo.reviewer?.name ?? null,
        viewerIsReviewer: pickups.viewerIsReviewer === true,
        waitingOn: waiting,
        waitingSince: todo.waitingSince ?? null,
        waitingCheckAt: todo.waitingCheckAt ?? null,
        workingSince: active?.status === "running" ? active.startedAt : null,
        queued: active?.status === "queued" && !waiting,
      })
    : null;
  const held = todo.heldToLimits === true;
  const access = held ? "within its limits" : "with your access";

  return (
    <div className="mt-4 space-y-2" aria-label="AI work on this task">
      <FormError message={error} />
      {standing && (
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{standing}</p>
      )}
      {waiting && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
          <Hourglass
            size={14}
            aria-hidden
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300"
          />
          <div className="min-w-0 flex-1 text-xs">
            <div className="font-medium text-slate-800 dark:text-slate-100">
              {TODO_WAIT_LABEL[waiting]}
            </div>
            {todo.waitingReason && (
              <div className="break-words text-slate-600 dark:text-slate-300">
                {todo.waitingReason}
              </div>
            )}
            <div className="text-slate-500 dark:text-slate-400">
              {todo.waitingSince && `Since ${shortWhen(todo.waitingSince)}.`}
              {todo.waitingCheckAt && ` Checks back ${shortWhen(todo.waitingCheckAt)}.`}
            </div>
            {canEdit && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={starting}
                  onClick={() => void stopWaiting()}
                  title={`Send its AI Employee back to this now, ${access}`}
                >
                  Stop waiting
                </Button>
                {held && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={starting}
                    onClick={() => void stopWaiting(true)}
                    title="Send its AI Employee back to this now, with what you can do, for this session"
                  >
                    Use my access
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {held && canEdit && (canStart || waiting) && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          An outside email or a limited session started this, so its AI Employee works within limits
          here, whoever asks. It can read and prepare, and a comment or a new assignee doesn&apos;t
          change that. Only Use my access does, for one session.
        </p>
      )}
      {shownActive?.status === "running" && (
        <RunningPickup
          key={shownActive.id}
          companyId={companyId}
          todoId={todo.id}
          pickup={shownActive}
          base={base}
          companySlug={companySlug}
          canEdit={canEdit}
          onEnded={() => void load()}
        />
      )}
      {shownActive?.status === "queued" && (
        <QueuedPickup
          pickup={shownActive}
          base={base}
          canEdit={canEdit}
          onChanged={() => void load()}
        />
      )}
      {canStart && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={starting}
            onClick={() => void startNow()}
            title={`Send its AI Employee to work on this now, ${access}`}
          >
            <Play size={13} className="mr-1.5" /> Start now
          </Button>
          {held && (
            <Button
              size="sm"
              variant="secondary"
              loading={starting}
              onClick={() => void startNow(true)}
              title="Send its AI Employee to work on this now, with what you can do, for this session"
            >
              Use my access
            </Button>
          )}
          {last?.status === "failed" && last.error && (
            <span className="min-w-0 text-xs text-slate-500 dark:text-slate-400">
              Last try: {last.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function QueuedPickup({
  pickup,
  base,
  canEdit,
  onChanged,
}: {
  pickup: TodoPickupView;
  base: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [stopping, setStopping] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const name = pickup.employee?.name ?? "The AI Employee";
  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await api.post(`${base}/${pickup.id}/stop`, {});
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Could not stop this."));
      setStopping(false);
    }
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
      <Clock3 size={14} aria-hidden className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" />
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium text-slate-800 dark:text-slate-200">{name} will pick this up</div>
        <div className="text-slate-500 dark:text-slate-400">{todoPickupHoldLabel(pickup.hold)}</div>
        <FormError message={error} className="mt-1" />
      </div>
      {canEdit && (
        <Button size="sm" variant="secondary" loading={stopping} onClick={() => void stop()}>
          <Square size={12} className="mr-1" /> Stop
        </Button>
      )}
    </div>
  );
}

function RunningPickup({
  pickup,
  base,
  companyId,
  todoId,
  companySlug,
  canEdit,
  onEnded,
}: {
  pickup: TodoPickupView;
  base: string;
  companyId: string;
  todoId: string;
  companySlug: string;
  canEdit: boolean;
  onEnded: () => void;
}) {
  const recordings = useTodoBrowserRecordings(companyId, todoId, pickup.id, { live: true });
  const [stopping, setStopping] = React.useState(false);
  const [stopError, setStopError] = React.useState<string | null>(null);
  const streamUrl = React.useCallback(
    (after: number) => `${base}/${pickup.id}/activity/stream?after=${after}`,
    [base, pickup.id],
  );
  const followed = useFollowedTurn({
    streamUrl,
    turnId: pickup.id,
    startedAt: Date.parse(pickup.startedAt) || null,
    onEnd: () => onEnded(),
  });
  const name = pickup.employee?.name ?? "AI Employee";
  async function stop() {
    setStopping(true);
    setStopError(null);
    try {
      await api.post(`${base}/${pickup.id}/stop`, {});
    } catch (err) {
      setStopping(false);
      setStopError(errorMessage(err, `Could not stop ${name}`));
    }
  }
  return (
    <div data-todo-pickup={pickup.id}>
      <LiveTurnCard
        authorName={name}
        avatar={<Avatar name={name} size={24} kind="ai" />}
        live={followed.live}
        streamingReply={followed.text || null}
        blockImages={pickup.preparationOnly}
        progress={followed.progress}
        connectionState={followed.connection}
        stopping={stopping}
        onStop={canEdit ? () => void stop() : undefined}
        companySlug={companySlug}
        context={
          pickup.preparationOnly
            ? pickup.withBrowser
              ? "Preparing, with the browser"
              : "Preparing only"
            : null
        }
        note={stepsNote(pickup)}
        stopError={stopError}
      />
      <PickupBrowserRecording
        companyId={companyId}
        todoId={todoId}
        pickupId={pickup.id}
        recordings={recordings}
      />
    </div>
  );
}
