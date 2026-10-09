import React from "react";
import type { Approval, Company } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { DecisionCard } from "@/components/decisions/DecisionCard";
import { DecisionOutcome } from "@/components/decisions/DecisionOutcome";
import { MailReviewCard, MailReviewOutcome } from "@/components/decisions/MailReviewCard";
import { CloseRowButton } from "@/components/decisions/StackRow";
import { WorkReviewCard, WorkReviewOutcome } from "@/components/decisions/WorkReviewCard";
import {
  decisionItem,
  reviewItem,
  type DecisionFollowUps,
  type DecisionStackItem,
} from "@/components/decisions/useDecisionFollowUps";

/**
 * One slot in the stack, from the question through its outcome.
 *
 * Acting on an item decides what happens to its slot. An answer, a Send or an
 * Approve is followed: the row collapses to a status line that updates as the
 * work goes on, until Close. A Dismiss, a Snooze, a Discard or a Don’t do this
 * has nothing left to follow, so the row leaves the stack in that same click
 * and focus moves to the next row — dismissed and declined items are in
 * History, snoozed ones come back on their own.
 */
export function DecisionStackCard({
  company,
  item,
  followUps,
  onResolved,
  canAnswer = true,
  onEditingChange,
  viewerId,
  grouped = false,
}: {
  company: Company;
  item: DecisionStackItem;
  followUps: DecisionFollowUps;
  onResolved: (announcement?: string) => Promise<void> | void;
  canAnswer?: boolean;
  onEditingChange?: (id: string, editing: boolean) => void;
  /** Who is reading, so their own answer reads "You chose". */
  viewerId?: string | null;
  /** Under a group heading that already names the kind of review. */
  grouped?: boolean;
}) {
  const [retrying, setRetrying] = React.useState(false);
  const close = () => {
    followUps.close(item.key);
    void onResolved();
  };
  const retry = async () => {
    setRetrying(true);
    try {
      await followUps.refresh();
    } finally {
      setRetrying(false);
    }
  };
  if (item.kind === "loading") {
    return (
      <li id={item.key} data-stack-row className="px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            {item.error ? (
              <FormError message={item.error} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Spinner size={14} /> Loading the latest update…
              </p>
            )}
            {item.error && (
              <Button size="sm" variant="secondary" loading={retrying} onClick={() => void retry()}>
                Retry
              </Button>
            )}
          </div>
          <CloseRowButton
            label={item.reference.kind === "decision" ? "Close decision" : "Close review"}
            onClose={close}
          />
        </div>
      </li>
    );
  }
  const refreshNotice = item.refreshError ? (
    <div className="mt-3 space-y-2">
      <FormError message={`Showing the last update. ${item.refreshError}`} />
      <Button size="sm" variant="secondary" loading={retrying} onClick={() => void retry()}>
        Retry
      </Button>
    </div>
  ) : undefined;
  /** Take the row off the stack now and put focus where it was. */
  const leaveNow = (leave: () => void) => {
    followUps.close(item.key);
    leave();
  };
  if (item.kind === "decision") {
    return item.decision.status === "pending" ? (
      <DecisionCard
        company={company}
        decision={item.decision}
        canAnswer={canAnswer}
        onActionStart={(action) => {
          // Only an answer has an outcome to follow.
          if (action === "answer") followUps.remember(item);
        }}
        onActionSettled={(row, action, leave) => {
          if (action === "answer" && row.status !== "pending") {
            followUps.update(decisionItem(row));
          } else if (action === "answer") {
            followUps.forget(item.key);
          } else {
            leaveNow(leave);
          }
        }}
        onResolved={onResolved}
      />
    ) : (
      <DecisionOutcome
        company={company}
        decision={item.decision}
        canRestore={canAnswer}
        viewerId={viewerId}
        onRestored={async (announcement) => {
          followUps.forget(item.key);
          await onResolved(announcement);
        }}
        refreshNotice={refreshNotice}
        onClose={close}
      />
    );
  }
  if (item.outcome && item.outcome.status !== "pending") {
    return item.approval.kind === "mail_send" ? (
      <MailReviewOutcome
        company={company}
        approval={item.outcome}
        onClose={close}
        refreshNotice={refreshNotice}
      />
    ) : (
      <WorkReviewOutcome
        company={company}
        approval={item.outcome}
        onClose={close}
        refreshNotice={refreshNotice}
      />
    );
  }
  const props = {
    company,
    approval: item.approval,
    onResolved,
    onActionStart: (action: "approve" | "reject") => {
      if (action === "approve") followUps.remember(item);
    },
    onActionSettled: (row: Approval, action: "approve" | "reject", leave: () => void) => {
      if (action === "reject" && row.status === "rejected") {
        leaveNow(leave);
        return;
      }
      // The mutation response omits the employee and Routine hydration.
      const merged = { ...item.approval, ...row };
      if (action === "approve") followUps.update(reviewItem(merged, merged));
    },
  };
  return item.approval.kind === "mail_send" ? (
    <MailReviewCard {...props} onEditingChange={onEditingChange} grouped={grouped} />
  ) : (
    <WorkReviewCard {...props} grouped={grouped} />
  );
}
