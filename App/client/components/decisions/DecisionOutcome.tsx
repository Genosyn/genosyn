import React from "react";
import { RotateCcw } from "lucide-react";
import { api, Company, Decision } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { DecisionDetails } from "./DecisionDetails";
import { DecisionDiscussButton } from "./DecisionDiscussButton";
import { DecisionDiscussion } from "./DecisionDiscussion";
import { CloseRowButton, DetailsButton, StatusIcon, StatusText } from "./StackRow";
import { answeredBy, decisionStatusLine } from "./stackStatus";
import { useDecisionDiscussionOpen } from "./useDecisionDiscussion";
import { ReviewTimeline } from "./ReviewTimeline";
import { formatRelative } from "./relative";

/**
 * A Decision that has left the waiting stack, as one status line under its
 * question: "You chose “Bid” · Alex is on it", then "Done · Registered on
 * BidNet". The answer, the employee's report and its full log, and the
 * original context are behind Details. The same row reads the same on Home,
 * in the active stack (with Close) and in History (with Undismiss).
 */
export function DecisionOutcome({
  company,
  decision,
  onRestored,
  canRestore,
  onClose,
  refreshNotice,
  viewerId,
}: {
  company: Company;
  decision: Decision;
  onRestored: (announcement?: string) => Promise<void> | void;
  canRestore: boolean;
  onClose?: () => void;
  refreshNotice?: React.ReactNode;
  /** Who is reading, so their own answer reads "You chose". */
  viewerId?: string | null;
}) {
  const [restoring, setRestoring] = React.useState(false);
  const [restoreError, setRestoreError] = React.useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const restoringRef = React.useRef(false);
  const fieldId = React.useId();
  const status = decisionStatusLine(decision, viewerId);
  const employeeName = decision.employee?.name ?? "Deleted AI Employee";
  const mayRestore =
    decision.status === "cancelled" && decision.decidedByUserId !== null && canRestore;
  const [discussing, setDiscussing] = useDecisionDiscussionOpen(decision.id);
  // Answering swaps the pending row for this one, and a discussion already
  // open stays open — but only a press here moves focus into it.
  const [focusDiscussion, setFocusDiscussion] = React.useState(false);
  const discussionId = `${fieldId}-discussion`;
  const detailsId = `${fieldId}-details`;

  async function restore() {
    if (!mayRestore || restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    setRestoreError(null);
    try {
      await api.post(`/api/companies/${company.id}/decisions/${decision.id}/restore`, {});
      await onRestored(`Decision “${decision.title}” restored to the stack.`);
    } catch (err) {
      setRestoreError(errorMessage(err));
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }
  }

  return (
    <li id={`decision-${decision.id}`} data-stack-row className="scroll-mt-4 px-4 py-3.5 sm:px-5">
      <article aria-labelledby={`${fieldId}-title`} className="min-w-0">
        <div className="flex min-w-0 items-start gap-3">
          <StatusIcon status={status} />
          <div className="min-w-0 flex-1">
            <h3
              id={`${fieldId}-title`}
              tabIndex={-1}
              data-row-focus
              title={decision.title}
              className="line-clamp-2 break-words text-sm font-semibold leading-snug text-slate-900 focus:outline-none dark:text-slate-100"
            >
              {decision.title}
            </h3>
            <StatusText status={status} className="mt-0.5" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
              <span data-row-meta className="mr-1 text-xs text-slate-500 dark:text-slate-400">
                {/* Once the line says how it went, the answer itself moves here. */}
                {decision.status === "decided" &&
                  decision.pickupStatus !== "none" &&
                  decision.pickupStatus !== "running" && (
                    <>
                      {answeredBy(decision, viewerId)} chose “
                      {decision.chosenOptionLabel ?? "an answer"}” ·{" "}
                    </>
                  )}
                {employeeName} · {formatRelative(decision.decidedAt ?? decision.createdAt)}
              </span>
              <DetailsButton
                open={detailsOpen}
                controls={detailsId}
                onToggle={() => setDetailsOpen((open) => !open)}
              />
              <DecisionDiscussButton
                decision={decision}
                open={discussing}
                controls={discussionId}
                disabled={restoring}
                onToggle={() => {
                  setFocusDiscussion(!discussing);
                  setDiscussing(!discussing);
                }}
              />
              {mayRestore && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={restoring}
                  onClick={() => void restore()}
                >
                  <RotateCcw size={14} />
                  Undismiss
                </Button>
              )}
            </div>
          </div>
          {onClose && <CloseRowButton label="Close decision" onClose={onClose} />}
        </div>

        {detailsOpen && (
          <DecisionDetails
            id={detailsId}
            company={company}
            decision={decision}
            viewerId={viewerId}
          />
        )}

        {discussing && decision.employee && (
          <ReviewTimeline className="mt-4">
            <DecisionDiscussion
              id={discussionId}
              company={company}
              decision={decision}
              employee={decision.employee}
              autoFocus={focusDiscussion}
            />
          </ReviewTimeline>
        )}

        {refreshNotice}
        <FormError message={restoreError} className="mt-3" />
      </article>
    </li>
  );
}
