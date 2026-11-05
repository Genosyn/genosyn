import React from "react";
import { Clock3, Play, Square } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { LiveTurnCard } from "@/components/chat/TurnActivity";
import { useFollowedTurn } from "@/components/chat/useFollowedTurn";
import { Avatar } from "@/components/todos/todoShared";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { api, type Todo } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { todoPickupHoldLabel, type TodoPickupView } from "../../../shared/todoPickups";

type Pickups = { active: TodoPickupView | null; recent: TodoPickupView[] };

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
  todo: Pick<Todo, "id" | "status" | "assigneeEmployeeId" | "projectId">;
  companyId: string;
  companySlug: string;
  canEdit: boolean;
}) {
  const [pickups, setPickups] = React.useState<Pickups | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
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

  async function startNow() {
    setStarting(true);
    setError(null);
    try {
      setPickups(await api.post<Pickups>(base, {}));
    } catch (err) {
      setError(errorMessage(err, "Could not start this."));
    } finally {
      setStarting(false);
    }
  }

  const active = pickups?.active ?? null;
  const last = pickups?.recent[0] ?? null;
  const workable = ["backlog", "todo", "in_progress"].includes(todo.status);
  const canStart = canEdit && Boolean(todo.assigneeEmployeeId) && workable && !active;
  if (!pickups && !error) return null;
  if (!active && !canStart && !error) return null;

  return (
    <div className="mt-4 space-y-2" aria-label="AI work on this task">
      <FormError message={error} />
      {active?.status === "running" && (
        <RunningPickup
          key={active.id}
          pickup={active}
          base={base}
          companySlug={companySlug}
          canEdit={canEdit}
          onEnded={() => void load()}
        />
      )}
      {active?.status === "queued" && (
        <QueuedPickup pickup={active} base={base} canEdit={canEdit} onChanged={() => void load()} />
      )}
      {canStart && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={starting}
            onClick={() => void startNow()}
            title="Send its AI Employee to work on this now, with your access"
          >
            <Play size={13} className="mr-1.5" /> Start now
          </Button>
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
  companySlug,
  canEdit,
  onEnded,
}: {
  pickup: TodoPickupView;
  base: string;
  companySlug: string;
  canEdit: boolean;
  onEnded: () => void;
}) {
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
        progress={followed.progress}
        connectionState={followed.connection}
        stopping={stopping}
        onStop={canEdit ? () => void stop() : undefined}
        companySlug={companySlug}
        context={pickup.preparationOnly ? "Preparing only" : null}
        note={stepsNote(pickup)}
        stopError={stopError}
      />
    </div>
  );
}
