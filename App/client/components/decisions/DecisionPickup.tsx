import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { pickupReportOf } from "../../../shared/decisionSummary";
import { Decision } from "../../lib/api";
import { ChatMarkdown } from "../ChatMarkdown";
import { Spinner } from "../ui/Spinner";
import { formatDuration } from "./relative";

/**
 * What happened *after* somebody answered, inside a row's Details.
 *
 * Answering starts a work session immediately, and the session narrates as it
 * goes. People need its report — what the employee did and where it landed —
 * not every line it wrote on the way, so the report leads and the full log
 * waits behind its own toggle.
 *
 * A failed or skipped pickup is not a failed decision: the answer is recorded
 * either way, and the summary says what will still happen.
 */
export function DecisionPickup({ decision }: { decision: Decision }) {
  const [logOpen, setLogOpen] = React.useState(false);
  const logId = React.useId();
  if (decision.pickupStatus === "none") return null;
  const employee = decision.employee?.name ?? "The AI Employee";
  const { report, log } = pickupReportOf(decision);
  const took =
    decision.pickupStartedAt && decision.pickupFinishedAt
      ? formatDuration(decision.pickupStartedAt, decision.pickupFinishedAt)
      : null;

  if (decision.pickupStatus === "running") {
    return (
      <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
        <Spinner size={13} /> {employee} started with your answer and is working on it now.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {decision.pickupStatus === "done" ? (
        report ? (
          <div data-pickup-report className="text-slate-700 dark:text-slate-200">
            <ChatMarkdown content={report} />
          </div>
        ) : (
          <p className="text-slate-600 dark:text-slate-300">
            {employee} finished without a report.
          </p>
        )
      ) : (
        log && (
          <div className="text-slate-700 dark:text-slate-200">
            <ChatMarkdown content={log} />
          </div>
        )
      )}
      {(took || (decision.pickupStatus === "done" && log)) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          {took && <span>Took {took}</span>}
          {decision.pickupStatus === "done" && log && (
            <button
              type="button"
              onClick={() => setLogOpen((open) => !open)}
              aria-expanded={logOpen}
              aria-controls={logId}
              className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {logOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {logOpen ? "Hide the full log" : "Show the full log"}
            </button>
          )}
        </div>
      )}
      {logOpen && log && (
        <div
          id={logId}
          className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-white p-2.5 text-xs leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
        >
          <ChatMarkdown content={log} />
        </div>
      )}
    </div>
  );
}
