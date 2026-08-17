import React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock3 } from "lucide-react";
import { Decision } from "../../lib/api";
import { ChatMarkdown } from "../ChatMarkdown";
import { Spinner } from "../ui/Spinner";
import { clsx } from "../ui/clsx";
import { formatDuration } from "./relative";

/**
 * What happened *after* somebody answered.
 *
 * Pressing a button used to be the end of the story on screen: the row moved to
 * "decided" and whatever the employee then did was invisible until you went
 * looking through its journal. Now answering starts a work session immediately,
 * so the row can show the rest of it — running, then the employee's own report.
 *
 * A failed or skipped pickup is not a failed decision, and the copy is careful
 * about that: the answer is recorded either way, and the wording says what will
 * still happen (the employee reads it on its next run) rather than implying the
 * answer was lost.
 */

const STYLES = {
  running: {
    label: "Working on it now",
    cls: "border-indigo-200 bg-indigo-50/60 text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200",
  },
  done: {
    label: "Picked it up",
    cls: "border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100",
  },
  failed: {
    label: "Couldn't carry on",
    cls: "border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100",
  },
  skipped: {
    label: "Not started",
    cls: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
  },
} as const;

export function DecisionPickup({
  decision,
  className,
}: {
  decision: Decision;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  if (decision.pickupStatus === "none") return null;
  const style = STYLES[decision.pickupStatus];
  const summary = decision.pickupSummary ?? "";
  const took =
    decision.pickupStartedAt && decision.pickupFinishedAt
      ? formatDuration(decision.pickupStartedAt, decision.pickupFinishedAt)
      : null;

  return (
    <div className={clsx("rounded-lg border px-2.5 py-2 text-xs", style.cls, className)}>
      <div className="flex items-center gap-1.5 font-medium">
        {decision.pickupStatus === "running" ? (
          <Spinner size={12} />
        ) : decision.pickupStatus === "done" ? (
          <CheckCircle2 size={13} />
        ) : decision.pickupStatus === "failed" ? (
          <AlertTriangle size={13} />
        ) : (
          <Clock3 size={13} />
        )}
        <span>
          {decision.employee?.name ?? "Your AI employee"} · {style.label}
        </span>
        {took && decision.pickupStatus !== "running" && (
          <span className="font-normal opacity-70">· took {took}</span>
        )}
        {summary && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-0.5 font-medium hover:underline"
          >
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {open ? "Hide" : decision.pickupStatus === "done" ? "Read report" : "Details"}
          </button>
        )}
      </div>
      {decision.pickupStatus === "running" && (
        <p className="mt-1 opacity-80">
          They were started with your answer — no waiting for their next routine.
        </p>
      )}
      {open && summary && (
        <div className="mt-2 max-h-64 overflow-auto rounded-md bg-white/70 p-2 text-slate-700 dark:bg-slate-900/50 dark:text-slate-200">
          <ChatMarkdown content={summary} />
        </div>
      )}
    </div>
  );
}
