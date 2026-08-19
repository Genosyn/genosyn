import React from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Mic, Video } from "lucide-react";
import {
  MEETING_STATUS_LABELS,
  MEETING_STATUS_TONES,
  PROVIDER_LABELS,
  formatClock,
  formatDuration,
  type ConferenceProvider,
  type Meeting,
  type MeetingStatus,
} from "../../lib/meetings";
import { clsx } from "../ui/clsx";

/**
 * The small shared pieces the Meetings pages all repeat — a status chip, a
 * provider chip, a meeting row. Extracted here rather than copied into four
 * pages, which is the rule AGENTS.md §7 states: extract a component before you
 * extract a class.
 */

export function StatusChip({ status }: { status: MeetingStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        MEETING_STATUS_TONES[status],
      )}
    >
      {MEETING_STATUS_LABELS[status]}
    </span>
  );
}

export function ProviderChip({ provider }: { provider: ConferenceProvider }) {
  if (provider === "none") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-700/40 dark:text-slate-300 dark:ring-slate-600">
      <Video size={11} /> {PROVIDER_LABELS[provider]}
    </span>
  );
}

/** A recorded meeting, as it appears in a list. */
export function MeetingRow({ meeting, to }: { meeting: Meeting; to: string }) {
  const when = meeting.scheduledStartAt ?? meeting.startedAt ?? meeting.createdAt;
  const at = new Date(when);
  const span =
    meeting.durationMs > 0
      ? formatDuration(meeting.durationMs)
      : meeting.scheduledStartAt && meeting.scheduledEndAt
        ? formatDuration(
            new Date(meeting.scheduledEndAt).getTime() -
              new Date(meeting.scheduledStartAt).getTime(),
          )
        : "";

  return (
    <Link
      to={to}
      className="flex items-start gap-3 px-4 py-3 transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600 ring-1 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20">
        <CalendarDays size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {meeting.title || "Untitled meeting"}
          </span>
          <StatusChip status={meeting.status} />
          {meeting.transcriptState === "ready" && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500">
              <Mic size={11} /> transcript
            </span>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            {at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
            {formatClock(when)}
          </span>
          {span && <span className="tabular-nums">{span}</span>}
          <ProviderChip provider={meeting.conferenceProvider} />
        </span>
        {meeting.summaryText && (
          <span className="mt-1 line-clamp-2 block text-xs text-slate-500 dark:text-slate-400">
            {meeting.summaryText}
          </span>
        )}
      </span>
    </Link>
  );
}

/** The dashed panel every Meetings page uses for "nothing here" and errors. */
export function Panel({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {body && (
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">{body}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
