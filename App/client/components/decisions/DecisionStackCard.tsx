import React from "react";
import { X } from "lucide-react";
import type { Company } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { DecisionCard } from "@/components/decisions/DecisionCard";
import { DecisionOutcome } from "@/components/decisions/DecisionOutcome";
import { MailReviewCard, MailReviewOutcome } from "@/components/decisions/MailReviewCard";
import { WorkReviewCard, WorkReviewOutcome } from "@/components/decisions/WorkReviewCard";
import {
  decisionItem,
  reviewItem,
  type DecisionFollowUps,
  type DecisionStackItem,
} from "@/components/decisions/useDecisionFollowUps";

/** The same slot tells the whole story, from the choice through its outcome. */
export function DecisionStackCard({
  company,
  item,
  followUps,
  onResolved,
  canAnswer = true,
  onEditingChange,
}: {
  company: Company;
  item: DecisionStackItem;
  followUps: DecisionFollowUps;
  onResolved: (announcement?: string) => Promise<void> | void;
  canAnswer?: boolean;
  onEditingChange?: (id: string, editing: boolean) => void;
}) {
  const close = () => {
    followUps.close(item.key);
    void onResolved();
  };
  if (item.kind === "loading") {
    return (
      <li id={item.key} className="space-y-3 px-4 py-5 sm:px-5">
        {item.error ? (
          <FormError message={item.error} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size={14} /> Loading the latest timeline…
          </p>
        )}
        <div className="flex gap-2">
          {item.error && (
            <Button size="sm" variant="secondary" onClick={() => void followUps.refresh()}>
              Retry timeline
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={close}
            aria-label={item.reference.kind === "decision" ? "Close decision" : "Close review"}
          >
            <X size={14} /> Close
          </Button>
        </div>
      </li>
    );
  }
  const refreshNotice = item.refreshError ? (
    <div className="mt-4 space-y-2">
      <FormError message={`Showing the last update. ${item.refreshError}`} />
      <Button size="sm" variant="secondary" onClick={() => void followUps.refresh()}>
        Retry timeline
      </Button>
    </div>
  ) : undefined;
  if (item.kind === "decision") {
    return item.decision.status === "pending" ? (
      <DecisionCard
        company={company}
        decision={item.decision}
        canAnswer={canAnswer}
        onActionStart={() => followUps.remember(item)}
        onActionSettled={(row) => {
          if (row.status === "pending" && Date.parse(row.snoozedUntil ?? "") > Date.now())
            followUps.forget(item.key);
          else followUps.update(decisionItem(row));
        }}
        onResolved={onResolved}
      />
    ) : (
      <DecisionOutcome
        company={company}
        decision={item.decision}
        canRestore={canAnswer}
        onRestored={async (announcement) => {
          followUps.forget(item.key);
          await onResolved(announcement);
        }}
        keepExpanded
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
    onActionStart: () => followUps.remember(item),
    onActionSettled: (row: import("@/lib/api").Approval) => {
      // The mutation response omits the employee and Routine hydration.
      const merged = { ...item.approval, ...row };
      followUps.update(reviewItem(merged, merged));
    },
  };
  return item.approval.kind === "mail_send" ? (
    <MailReviewCard {...props} onEditingChange={onEditingChange} />
  ) : (
    <WorkReviewCard {...props} />
  );
}
