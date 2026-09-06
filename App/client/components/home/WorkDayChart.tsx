import React from "react";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { clsx } from "@/components/ui/clsx";
import type { Company, Employee, WorkEntry } from "@/lib/api";
import {
  workChartTicks,
  workNarrativeText,
  WORK_ENTRY_KINDS,
  WORK_KIND_META,
} from "@/lib/workTimeline";
import type { WorkChartLane, WorkChartWindow } from "@/lib/workTimeline";

import { WORK_KIND_TILE } from "./WorkEntryViews";

/**
 * The whole roster's day on one axis — one lane per AI Employee, time running
 * left to right, one tile per thing they did.
 *
 * A list answers "what happened"; it cannot answer "were they all working at
 * four in the morning, or did one of them do everything". Lanes make the shape
 * of a day legible at a glance: who overlapped, who was idle, what ran long,
 * and which single tile is the forty-minute run in a row of two-second ledger
 * rows. Every tile opens the same popup, because a bar is only useful if you
 * can ask it what it was.
 *
 * Geometry — clamping, percentages, and the overlap packing that keeps a short
 * tile from vanishing under a long one — lives in `lib/workTimeline.ts` where
 * it can be tested without a DOM. This file owns colour and layout.
 */
export function WorkDayChart({
  company,
  lanes,
  window: chartWindow,
  nowIso,
  onOpenEntry,
  onOpenEmployee,
}: {
  company: Company;
  lanes: WorkChartLane<Employee>[];
  window: WorkChartWindow;
  nowIso: string;
  onOpenEntry: (entry: WorkEntry) => void;
  onOpenEmployee: (employee: Employee) => void;
}) {
  const ticks = workChartTicks(chartWindow);

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[34rem]">
          <div className="flex items-end gap-3 pb-1">
            <div className="w-32 shrink-0 sm:w-40" />
            <div className="relative h-4 flex-1">
              {ticks.map((tick) => (
                <span
                  key={tick.key}
                  style={{ left: `${tick.leftPct}%` }}
                  className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-slate-400 dark:text-slate-500"
                >
                  {tick.label}
                </span>
              ))}
              <span className="absolute right-0 whitespace-nowrap bg-white pl-1 text-[10px] font-semibold text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                now
              </span>
            </div>
          </div>

          <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
            {lanes.map((lane) => (
              <ChartLane
                key={lane.employee.id}
                company={company}
                lane={lane}
                ticks={ticks}
                nowIso={nowIso}
                onOpenEntry={onOpenEntry}
                onOpenEmployee={onOpenEmployee}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Outside the scroller on purpose: the legend is prose, and prose that
          has to be scrolled sideways on a phone is worse than prose that wraps. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {WORK_ENTRY_KINDS.map((kind) => (
          <li
            key={kind}
            className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400"
          >
            <span className={clsx("h-2 w-4 rounded-sm", WORK_KIND_TILE[kind])} />
            {WORK_KIND_META[kind].label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartLane({
  company,
  lane,
  ticks,
  nowIso,
  onOpenEntry,
  onOpenEmployee,
}: {
  company: Company;
  lane: WorkChartLane<Employee>;
  ticks: { key: string; leftPct: number }[];
  nowIso: string;
  onOpenEntry: (entry: WorkEntry) => void;
  onOpenEmployee: (employee: Employee) => void;
}) {
  const employee = lane.employee;
  const tracks = lane.tracks.length > 0 ? lane.tracks : [[]];

  return (
    <div className="flex items-stretch gap-3 border-b border-slate-100 last:border-b-0 dark:border-slate-800/70">
      <button
        type="button"
        onClick={() => onOpenEmployee(employee)}
        title={`Open ${employee.name}'s day`}
        className="flex w-32 shrink-0 items-center gap-2 px-2.5 py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/40 sm:w-40 dark:hover:bg-slate-800/50"
      >
        <span aria-hidden="true" className="relative">
          <Avatar
            name={employee.name}
            kind="ai"
            size="sm"
            src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
          />
          {lane.active && (
            <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white bg-emerald-500 motion-safe:animate-pulse dark:border-slate-900" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-slate-800 dark:text-slate-200">
            {employee.name}
          </span>
          <span className="block truncate text-[10px] text-slate-400 dark:text-slate-500">
            {lane.entries.length === 0
              ? "quiet"
              : `${lane.entries.length} ${lane.entries.length === 1 ? "item" : "items"}`}
          </span>
        </span>
      </button>

      <div className="relative min-w-0 flex-1 py-2 pr-1">
        {ticks.map((tick) => (
          <span
            key={tick.key}
            aria-hidden="true"
            style={{ left: `${tick.leftPct}%` }}
            className="absolute inset-y-0 w-px bg-slate-100 dark:bg-slate-800"
          />
        ))}
        {lane.entries.length === 0 && (
          <p className="absolute inset-0 flex items-center text-[11px] italic text-slate-300 dark:text-slate-600">
            Nothing recorded
          </p>
        )}
        {tracks.map((track, index) => (
          <div key={index} className="relative h-3.5 [&+&]:mt-1">
            {track.map((tile) => (
              <button
                key={tile.entry.id}
                type="button"
                onClick={() => onOpenEntry(tile.entry)}
                title={workNarrativeText(tile.entry, { nowIso })}
                aria-label={workNarrativeText(tile.entry, { nowIso })}
                style={{ left: `${tile.leftPct}%`, width: `${tile.widthPct}%` }}
                className={clsx(
                  "absolute inset-y-0 rounded-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
                  WORK_KIND_TILE[tile.entry.kind],
                  // A moment has no length, so its tile is a marker sized for
                  // the pointer rather than a bar claiming a duration.
                  tile.instant && "rounded-full",
                  tile.entry.active && "motion-safe:animate-pulse",
                )}
              />
            ))}
          </div>
        ))}
        {lane.hidden > 0 && (
          <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
            {lane.hidden} more overlapping — open {employee.name}&apos;s day to see them
          </p>
        )}
      </div>
    </div>
  );
}
