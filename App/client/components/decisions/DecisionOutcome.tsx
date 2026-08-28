import React from "react";
import { Check, ChevronDown, ChevronUp, CircleSlash, Clock } from "lucide-react";
import { Company, Decision, DecisionStatus } from "../../lib/api";
import { ChatMarkdown } from "../ChatMarkdown";
import { clsx } from "../ui/clsx";
import { DecisionPickup } from "./DecisionPickup";
import { DecisionSourceLine } from "./DecisionSource";
import { formatRelative } from "./relative";

/**
 * An answered row: what was asked, what was chosen, and what the employee did
 * with it.
 *
 * The last part is the reason this is a component rather than a line of text.
 * A decision is a fork in somebody's work, so "we chose Send it" is only half
 * the record — the half that matters a week later is whether it actually got
 * sent. The pickup session's report is that half, and it lives one click away
 * on the row that caused it instead of in the employee's journal.
 */

const RESOLVED_STYLE: Record<Exclude<DecisionStatus, "pending">, { label: string; cls: string }> = {
  decided: {
    label: "decided",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  },
  cancelled: {
    label: "dismissed",
    cls: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  },
  expired: {
    label: "expired",
    cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  },
};

export function DecisionOutcome({
  company,
  decision,
}: {
  company: Company;
  decision: Decision;
}) {
  const [open, setOpen] = React.useState(false);
  const status = decision.status as Exclude<DecisionStatus, "pending">;
  const style = RESOLVED_STYLE[status];
  const Icon = status === "decided" ? Check : status === "expired" ? Clock : CircleSlash;
  const expandable = Boolean(decision.body) || decision.pickupStatus !== "none";

  return (
    <li className="rounded-lg border border-slate-100 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={clsx(
            "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            style.cls,
          )}
        >
          {style.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
          {decision.title}
        </span>
        {decision.chosenOptionLabel && (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
            <Icon size={11} /> {decision.chosenOptionLabel}
          </span>
        )}
        <span className="shrink-0 text-slate-400 dark:text-slate-500">
          {formatRelative(decision.decidedAt ?? decision.createdAt)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="truncate">{decision.employee?.name ?? "(deleted employee)"} asked</span>
        {/* An AI decider under a policy rule takes the human's slot in the
            record — the same line, because it is the same fact: who answered. */}
        {decision.decidedByEmployee ? (
          <span className="truncate">
            · Answered by {decision.decidedByEmployee.name} (AI)
          </span>
        ) : (
          decision.decidedBy && (
            <span className="truncate">
              · {status === "decided" ? "answered" : "closed"} by {decision.decidedBy.name}
            </span>
          )
        )}
        <DecisionSourceLine company={company} decision={decision} />
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {open ? "Hide" : "What happened"}
          </button>
        )}
      </div>

      {decision.note && (
        <p className="mt-1 truncate text-[11px] italic text-slate-500 dark:text-slate-400">
          &ldquo;{decision.note}&rdquo;
        </p>
      )}

      <DecisionPickup decision={decision} className="mt-2" />

      {open && decision.body && (
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            The context they stacked
          </div>
          <ChatMarkdown content={decision.body} />
        </div>
      )}
    </li>
  );
}
