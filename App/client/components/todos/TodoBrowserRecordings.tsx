import React from "react";
import { Video } from "lucide-react";

import { RunBrowserRecordingsPane, visibleBrowserRecordings } from "@/components/routines/RunViews";
import { api, type RunBrowserRecording } from "@/lib/api";

type TodoRecording = RunBrowserRecording & { pickupId: string | null };

type TodoRecordings = {
  byPickup: Map<string, TodoRecording[]>;
  withheld: Set<string>;
};

const EMPTY: TodoRecordings = { byPickup: new Map(), withheld: new Set() };
const POLL_MS = 4_000;

/**
 * The browser recordings of a Todo's work, by the pickup each belongs with. It looks
 * again while one is still being written, and whenever `version` changes. `live` keeps
 * looking while a session runs, because it may open the browser at any moment, and
 * `enabled` is false when no session has worked this Todo, so there's nothing to ask.
 */
export function useTodoBrowserRecordings(
  companyId: string,
  todoId: string,
  version: unknown,
  { enabled = true, live = false }: { enabled?: boolean; live?: boolean } = {},
): TodoRecordings {
  const [state, setState] = React.useState<TodoRecordings>(EMPTY);
  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    if (!enabled) {
      setState(EMPTY);
      return;
    }
    const load = async () => {
      try {
        const answer = await api.get<{
          recordings: TodoRecording[];
          withheldPickupIds: string[];
        }>(`/api/companies/${companyId}/todos/${todoId}/browser-recordings`);
        if (cancelled) return;
        const byPickup = new Map<string, TodoRecording[]>();
        for (const recording of answer.recordings) {
          if (!recording.pickupId) continue;
          byPickup.set(recording.pickupId, [
            ...(byPickup.get(recording.pickupId) ?? []),
            recording,
          ]);
        }
        setState({ byPickup, withheld: new Set(answer.withheldPickupIds) });
        const unfinished = answer.recordings.some(
          (recording) => recording.status === "recording" || recording.status === "finalizing",
        );
        if (unfinished || live) timer = window.setTimeout(() => void load(), POLL_MS);
      } catch {
        // A recording is extra. The report it sits under reads fine without it.
        if (!cancelled) setState(EMPTY);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [companyId, todoId, version, enabled, live]);
  return state;
}

/** What one pickup's report shows of its browser work: the video, or that one exists. */
export function PickupBrowserRecording({
  companyId,
  todoId,
  pickupId,
  recordings,
}: {
  companyId: string;
  todoId: string;
  pickupId: string;
  recordings: TodoRecordings;
}) {
  const mine = visibleBrowserRecordings(recordings.byPickup.get(pickupId));
  if (mine.length > 0) {
    return (
      <RunBrowserRecordingsPane
        companyId={companyId}
        baseUrl={`/api/companies/${companyId}/todos/${todoId}/browser-recordings`}
        recordings={mine}
        className="mt-2 max-h-[420px] min-h-[240px]"
      />
    );
  }
  if (recordings.withheld.has(pickupId)) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <Video size={12} aria-hidden="true" />
        Browser recording saved. Only owners and admins can watch it, because it shows the whole
        screen.
      </p>
    );
  }
  return null;
}
