import React from "react";
import { Link } from "react-router-dom";
import { PlugZap, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { clsx } from "@/components/ui/clsx";
import { api, type Employee } from "@/lib/api";
import { readinessTone, type DataRoom, type DataRoomJob } from "@/lib/dataRooms";
import { DATA_ROOM_PURPOSE_LABELS } from "../../../shared/dataRooms";

/** What a Member who is not an owner or admin sees instead of a data room page. */
export function OwnersOnlyNote() {
  return (
    <div className="page-shell p-4 sm:p-8">
      <EmptyState
        title="Owners and admins run data rooms"
        description="Data rooms hold the company's most sensitive documents, so only owners and admins can open them. Ask one of them if you need something from a room."
      />
    </div>
  );
}

export function RoomStatusBadge({ room }: { room: Pick<DataRoom, "status"> }) {
  return room.status === "open" ? (
    <Badge tone="success" dot>
      Open
    </Badge>
  ) : (
    <Badge tone="neutral" dot>
      Closed
    </Badge>
  );
}

export function PurposeBadge({ room }: { room: Pick<DataRoom, "purpose"> }) {
  return <Badge tone="neutral">{DATA_ROOM_PURPOSE_LABELS[room.purpose]}</Badge>;
}

const METER_TONE = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
} as const;

/** A readiness score as a thin bar and a number. */
export function ReadinessMeter({ score, className }: { score: number; className?: string }) {
  const tone = readinessTone(score);
  return (
    <div className={clsx("flex items-center gap-3", className)}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label="Readiness"
      >
        <div
          className={clsx("h-full rounded-full", METER_TONE[tone])}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {score}%
      </span>
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

/** Said once at the top of a room whose AI Employee cannot think yet, with the way to fix it. */
export function ModelMissingCallout({
  companySlug,
  employee,
}: {
  companySlug: string;
  employee: NonNullable<DataRoom["aiEmployee"]>;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/25 dark:bg-amber-500/10">
      <div className="flex items-start gap-3">
        <PlugZap size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {employee.name} has no connected AI Model
          </div>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            Briefs, readiness reviews and drafted answers wait until one is connected. Guests can
            still read and ask — you answer them yourself.
          </p>
        </div>
      </div>
      <Link
        to={`/c/${companySlug}/employees/${employee.slug}/settings/model`}
        className={buttonClassName({
          variant: "secondary",
          size: "sm",
          className: "shrink-0 self-start sm:self-auto",
        })}
      >
        Connect a model
      </Link>
    </div>
  );
}

/** "Briefing…", "Drafting…", or the failure, for one piece of AI work. */
export function AiWorkBadge({ job, working }: { job: DataRoomJob | null; working: string }) {
  if (!job) return null;
  if (job.status === "queued" || job.status === "running") {
    return (
      <Badge tone="ai" icon={<Sparkles />}>
        {working}
      </Badge>
    );
  }
  if (job.status === "failed") {
    return (
      <Badge tone="danger" title={job.error}>
        AI work failed
      </Badge>
    );
  }
  return null;
}

/** The company's AI Employees, for choosing who works a room. */
export function useEmployees(companyId: string): Employee[] | null {
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  React.useEffect(() => {
    let live = true;
    api
      .get<Employee[]>(`/api/companies/${companyId}/employees`)
      .then((rows) => {
        if (live) setEmployees(rows);
      })
      .catch(() => {
        if (live) setEmployees([]);
      });
    return () => {
      live = false;
    };
  }, [companyId]);
  return employees;
}

/** "3 documents", "1 guest". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
