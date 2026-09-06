import React from "react";
import {
  AlarmClock,
  CircleDashed,
  GitCommitHorizontal,
  Lightbulb,
  MessageSquare,
  Play,
  ShieldCheck,
} from "lucide-react";

import { RunChecksChip, RunOutcomeChip, RunStatusChip } from "@/components/routines/RunViews";
import { clsx } from "@/components/ui/clsx";
import type { WorkEntry, WorkEntryKind } from "@/lib/api";
import {
  humanizeWorkAction,
  workClock,
  workEffectOverflowLabel,
  workNarrative,
  workRelativeTime,
  WORK_KIND_META,
} from "@/lib/workTimeline";
import type { EmployeeWorkState } from "@/lib/workTimeline";

/**
 * How one piece of AI Employee work is drawn, wherever it appears.
 *
 * The panel, the day chart's popup and an employee's own day all say the same
 * thing about the same entry, and they used to say it three slightly different
 * ways. The wording itself is in `lib/workTimeline.ts`, which is testable
 * without a DOM; this file owns only the icons, the colour and the layout.
 */

const WORK_KIND_ICON: Record<WorkEntryKind, React.ReactNode> = {
  run: <Play size={13} />,
  chat: <MessageSquare size={13} />,
  work_session: <GitCommitHorizontal size={13} />,
  approval: <ShieldCheck size={13} />,
  wakeup: <AlarmClock size={13} />,
  lesson: <Lightbulb size={13} />,
  effect: <CircleDashed size={13} />,
};

/**
 * The filled tone a tile carries on the day chart, where the bar itself is the
 * only thing carrying the kind. Deliberately the saturated partner of
 * `WORK_KIND_META.tone`, which is a pale chip behind an icon.
 */
export const WORK_KIND_TILE: Record<WorkEntryKind, string> = {
  run: "bg-indigo-500 hover:bg-indigo-600 dark:bg-indigo-500/80 dark:hover:bg-indigo-400",
  chat: "bg-sky-500 hover:bg-sky-600 dark:bg-sky-500/80 dark:hover:bg-sky-400",
  work_session: "bg-violet-500 hover:bg-violet-600 dark:bg-violet-500/80 dark:hover:bg-violet-400",
  approval: "bg-amber-500 hover:bg-amber-600 dark:bg-amber-500/80 dark:hover:bg-amber-400",
  wakeup: "bg-teal-500 hover:bg-teal-600 dark:bg-teal-500/80 dark:hover:bg-teal-400",
  lesson: "bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-500/80 dark:hover:bg-emerald-400",
  effect: "bg-slate-400 hover:bg-slate-500 dark:bg-slate-500/80 dark:hover:bg-slate-400",
};

/** The dot that says how an employee is doing, on a circle or inside a pill. */
export const WORK_STATE_DOT: Record<EmployeeWorkState, string> = {
  working: "bg-emerald-500",
  waiting: "bg-amber-500",
  recent: "bg-sky-500",
  quiet: "bg-slate-300 dark:bg-slate-600",
};

const WORK_STATE_PILL: Record<EmployeeWorkState, string> = {
  working:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20",
  waiting:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  recent:
    "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20",
  quiet:
    "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
};

/** An employee's state in words, never in colour alone. */
export function WorkStatePill({ state, label }: { state: EmployeeWorkState; label: string }) {
  return (
    <span
      className={clsx(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset",
        WORK_STATE_PILL[state],
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          WORK_STATE_DOT[state],
          state === "working" && "motion-safe:animate-pulse",
        )}
      />
      {label}
    </span>
  );
}

/** The kind, named and coloured. The legend under the chart uses the same map. */
function WorkKindChip({ kind }: { kind: WorkEntryKind }) {
  const meta = WORK_KIND_META[kind];
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
        meta.tone,
      )}
    >
      {WORK_KIND_ICON[kind]}
      {meta.label}
    </span>
  );
}

/**
 * The entry in sentences: what the employee did, what it was working on, how
 * long it took, what it changed, and how it ended.
 */
function WorkEntryNarrative({ entry, nowIso }: { entry: WorkEntry; nowIso: string }) {
  const narrative = workNarrative(entry, { nowIso });
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium leading-6 text-slate-900 dark:text-slate-100">
        {narrative.headline}
      </p>
      {narrative.body.length > 0 && (
        <p className="mt-1 text-[13px] leading-6 text-slate-600 dark:text-slate-300">
          {narrative.body.join(" ")}
        </p>
      )}
    </div>
  );
}

/** The Run's three verdict axes, reusing the Routines views' own chips. */
function WorkRunChips({ entry }: { entry: WorkEntry }) {
  if (!entry.run) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <RunStatusChip status={entry.run.status} size="xs" />
      {entry.run.outcomeVerdict && (
        <RunOutcomeChip verdict={entry.run.outcomeVerdict} note={entry.run.outcomeNote} size="xs" />
      )}
      {entry.run.checksVerdict && <RunChecksChip verdict={entry.run.checksVerdict} size="xs" />}
    </span>
  );
}

/**
 * The individual records the entry touched, listed rather than summarised.
 *
 * The narrative already counts them ("created 2 invoices"); this is for the
 * reader who wants to know *which* two. Capped by the server, and the count it
 * sent stays honest about the rest.
 */
function WorkEffectList({ entry }: { entry: WorkEntry }) {
  const shown = entry.effects;
  if (shown.length === 0) return null;
  const overflow = workEffectOverflowLabel(entry, shown.length);
  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
        What changed
      </p>
      <ul className="mt-1.5 space-y-1">
        {shown.map((effect, index) => (
          <li
            key={`${effect.at}-${effect.action}-${index}`}
            className="flex items-baseline gap-2 text-[12px] leading-5"
          >
            <span className="w-12 shrink-0 tabular-nums text-slate-400 dark:text-slate-500">
              {workClock(effect.at)}
            </span>
            <span className="min-w-0 text-slate-600 dark:text-slate-300">
              {humanizeWorkAction(effect.action, effect.targetType)}
              {effect.targetLabel && (
                <span className="text-slate-400 dark:text-slate-500">
                  {` · ${effect.targetLabel}`}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {overflow && (
        <p className="mt-1.5 pl-14 text-[11px] text-slate-400 dark:text-slate-500">{overflow}</p>
      )}
    </div>
  );
}

/**
 * One entry as a full block: when it happened, what kind it was, the sentences,
 * the Run verdicts, and the records it touched. Used inside the popup a chart
 * tile opens and inside an employee's own day.
 */
export function WorkEntryBlock({
  entry,
  nowIso,
  showEffects = true,
}: {
  entry: WorkEntry;
  nowIso: string;
  showEffects?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <WorkKindChip kind={entry.kind} />
        <WorkRunChips entry={entry} />
        {entry.active && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
            happening now
          </span>
        )}
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          {workRelativeTime(entry.at, nowIso)}
        </span>
      </div>
      <div className="mt-2">
        <WorkEntryNarrative entry={entry} nowIso={nowIso} />
      </div>
      {showEffects && <WorkEffectList entry={entry} />}
    </div>
  );
}
