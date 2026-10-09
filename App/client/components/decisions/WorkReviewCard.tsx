import React from "react";
import { Check, ExternalLink, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { parseDecisionContext } from "../../../shared/decisionContext";
import { firstSentence } from "../../../shared/decisionSummary";
import { api, type Approval, type Company, type HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ApprovalDiscussButton } from "@/components/decisions/ApprovalDiscussButton";
import { DecisionContextSections } from "@/components/decisions/DecisionContext";
import {
  CloseRowButton,
  DetailSection,
  DetailsButton,
  DetailsPanel,
  StatusIcon,
  StatusText,
  focusAfterRemoval,
} from "@/components/decisions/StackRow";
import { workReviewStatusLine } from "@/components/decisions/stackStatus";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { formatRelative } from "@/components/decisions/relative";

function workReview(approval: HomeApproval) {
  return approval.review?.kind === "work" ? approval.review : null;
}

export type WorkReviewAction = "approve" | "reject";

function routineHref(company: Company, approval: HomeApproval): string | null {
  return approval.employee && approval.routine
    ? `/c/${company.slug}/routines/${approval.employee.slug}/${approval.routine.slug}`
    : null;
}

function sourceHref(
  company: Company,
  approval: HomeApproval,
): { href: string; label: string } | null {
  const review = workReview(approval);
  const routine = routineHref(company, approval);
  if (routine) {
    return review?.source.runId
      ? {
          href: `${routine}?run=${encodeURIComponent(review.source.runId)}`,
          label: "Open source Run",
        }
      : { href: routine, label: `Open ${approval.routine!.name}` };
  }
  if (review?.source.mailThreadId) {
    const account = review.source.mailAccountId
      ? `?${new URLSearchParams({ account: review.source.mailAccountId })}`
      : "";
    const handover = review.source.mailHandoverId
      ? `#handover-${encodeURIComponent(review.source.mailHandoverId)}`
      : "";
    return {
      href: `/c/${company.slug}/mail/t/${encodeURIComponent(review.source.mailThreadId)}${account}${handover}`,
      label: "Open source email",
    };
  }
  if (review?.source.conversationId && approval.employee) {
    return {
      href: `/c/${company.slug}/employees/${approval.employee.slug}/chat?conversation=${encodeURIComponent(review.source.conversationId)}`,
      label: "Open source conversation",
    };
  }
  return null;
}

/** The one plain line under a work plan's title: why it needs a person, or what happened. */
function workSummary(approval: HomeApproval): string | null {
  const review = workReview(approval);
  if (!review) return null;
  const context = parseDecisionContext(review.context);
  return firstSentence(context.reason ?? context.sections[0]?.body ?? "") || null;
}

/** Why, what happened, the full plan, and where it came from — inside Details. */
function WorkDetails({
  id,
  company,
  approval,
  outcome,
}: {
  id: string;
  company: Company;
  approval: HomeApproval;
  outcome?: React.ReactNode;
}) {
  const review = workReview(approval);
  const source = sourceHref(company, approval);
  const context = React.useMemo(() => parseDecisionContext(review?.context), [review?.context]);
  if (!review) {
    return (
      <DetailsPanel id={id}>
        <FormError message="This work review could not be displayed. Refresh before deciding." />
      </DetailsPanel>
    );
  }
  return (
    <DetailsPanel id={id}>
      {outcome}
      {context.reason && (
        <DetailSection title="Why it needs you">
          <ChatMarkdown content={context.reason} />
        </DetailSection>
      )}
      {context.sections.length > 0 && (
        <DetailSection title="What happened">
          <DecisionContextSections sections={context.sections} heading="What happened" />
        </DetailSection>
      )}
      <DetailSection title="The plan">
        <ChatMarkdown content={review.plan} />
        <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Approve &amp; start authorizes only this plan. Existing Grants, Policies, Checks, and
          action Approvals still apply.
        </p>
      </DetailSection>
      {source && (
        <Link
          to={source.href}
          className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          <ExternalLink size={12} /> {source.label}
        </Link>
      )}
    </DetailsPanel>
  );
}

/**
 * Proposed work as one short row: the title, why it needs a person, the plan
 * in a line or two, and Approve & start / Request changes / Don’t do this.
 * The full plan, the context and the source are behind Details.
 */
export function WorkReviewCard({
  company,
  approval,
  onResolved,
  onActionStart,
  onActionSettled,
  grouped = false,
}: {
  company: Company;
  approval: HomeApproval;
  onResolved: (announcement?: string) => Promise<void> | void;
  onActionStart?: (action: WorkReviewAction) => void;
  /** Called with the server's row; `leave` puts focus where the row was once it is gone. */
  onActionSettled?: (approval: Approval, action: WorkReviewAction, leave: () => void) => void;
  /** Under a group's "2 work plans to review" heading, which already says what it is. */
  grouped?: boolean;
}) {
  const [busy, setBusy] = React.useState<WorkReviewAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const acting = React.useRef(false);
  const rowRef = React.useRef<HTMLLIElement>(null);
  const fieldId = React.useId();
  const detailsId = `${fieldId}-details`;
  const review = workReview(approval);
  const summary = workSummary(approval);
  const plan = review ? firstSentence(review.plan, 220) : null;

  async function decide(action: WorkReviewAction) {
    if (acting.current) return;
    acting.current = true;
    setBusy(action);
    setError(null);
    try {
      onActionStart?.(action);
      const result = await api.post<Approval & { executeError?: string }>(
        `/api/companies/${company.id}/approvals/${approval.id}/${action}`,
        { reviewRevision: review?.revision },
      );
      // Action responses carry outcome fields; retain the hydrated source links.
      onActionSettled?.({ ...approval, ...result }, action, focusAfterRemoval(rowRef.current));
      if (result.executeError || result.status === "execution_failed") {
        const message =
          result.errorMessage ||
          "The approved work could not start. Inspect its outcome before trying again.";
        if (result.status === "execution_failed") {
          await onResolved(
            `Work review “${approval.title ?? "Proposed work"}” could not finish. Its outcome is available.`,
          );
        } else {
          setError(message);
        }
        return;
      }
      await onResolved(
        action === "approve"
          ? `Work review “${approval.title ?? "Proposed work"}” approved.`
          : `Work review “${approval.title ?? "Proposed work"}” declined. It is in Decision history.`,
      );
    } catch (err) {
      setError(errorMessage(err, "Could not record this review"));
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  return (
    <li
      ref={rowRef}
      id={`review-${approval.id}`}
      data-stack-row
      className="scroll-mt-4 px-4 py-4 sm:px-5"
    >
      <article aria-labelledby={`${fieldId}-title`} className="min-w-0">
        <header className="flex min-w-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <ShieldCheck size={11} aria-hidden="true" />
          </span>
          <p className="min-w-0 flex-1 truncate">
            {grouped ? (
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {approval.employee?.name ?? "Deleted AI Employee"}
              </span>
            ) : (
              <>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  Work to review
                </span>
                <span> · {approval.employee?.name ?? "Deleted AI Employee"}</span>
              </>
            )}
            <span> · {formatRelative(approval.requestedAt)}</span>
          </p>
          <DetailsButton
            size="xs"
            open={detailsOpen}
            controls={detailsId}
            onToggle={() => setDetailsOpen((open) => !open)}
          />
        </header>
        <h3
          id={`${fieldId}-title`}
          tabIndex={-1}
          data-row-focus
          className="mt-1 break-words text-[15px] font-semibold leading-snug text-slate-900 focus:outline-none dark:text-slate-100"
        >
          {approval.title ?? "Review proposed work"}
        </h3>
        {summary && (
          <p className="mt-1 line-clamp-2 break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            {summary}
          </p>
        )}
        {plan && (
          <p
            data-work-plan
            className="mt-1.5 line-clamp-2 break-words text-sm leading-snug text-slate-700 dark:text-slate-200"
          >
            <span className="font-medium">Plan:</span> {plan}
          </p>
        )}
        {!review && (
          <FormError
            message="This work review could not be displayed. Refresh before deciding."
            className="mt-2"
          />
        )}
        {detailsOpen && review && (
          <WorkDetails id={detailsId} company={company} approval={approval} />
        )}
        <FormError message={error} className="mt-3" />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={busy === "approve"}
            disabled={busy !== null}
            onClick={() => void decide("approve")}
            title="Authorizes only this plan. Grants, Policies, Checks and action Approvals still apply."
          >
            <Check size={14} /> Approve &amp; start
          </Button>
          <ApprovalDiscussButton
            company={company}
            approval={approval}
            label="Request changes"
            disabled={busy !== null}
          />
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
            loading={busy === "reject"}
            disabled={busy !== null}
            onClick={() => void decide("reject")}
            title="Decline the plan. It stays in Decision history."
          >
            <X size={14} /> Don’t do this
          </Button>
        </div>
      </article>
    </li>
  );
}

/**
 * Reviewed work as one status line — Approved, Done, Couldn’t finish,
 * Declined — with the reported outcome, the plan and its context behind
 * Details. Close (on the active stack) takes it off; History keeps it.
 */
export function WorkReviewOutcome({
  company,
  approval,
  onClose,
  refreshNotice,
}: {
  company: Company;
  approval: Approval;
  onClose?: () => void;
  refreshNotice?: React.ReactNode;
}) {
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const fieldId = React.useId();
  const detailsId = `${fieldId}-details`;
  const status = workReviewStatusLine(approval);
  const routine = routineHref(company, approval);
  const runHref =
    routine && approval.outcomeRunId
      ? `${routine}?run=${encodeURIComponent(approval.outcomeRunId)}`
      : null;
  const outcome =
    approval.outcomeSummary || runHref || approval.status === "execution_failed" ? (
      <DetailSection title="Reported outcome">
        {approval.outcomeSummary && <ChatMarkdown content={approval.outcomeSummary} />}
        {approval.status === "execution_failed" && (
          <FormError message={approval.errorMessage ?? "The approved work could not finish."} />
        )}
        {runHref && (
          <Link
            to={runHref}
            className="mt-1.5 inline-flex text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Open AI work, Effects, and Checks
          </Link>
        )}
      </DetailSection>
    ) : null;
  return (
    <li id={`review-${approval.id}`} data-stack-row className="scroll-mt-4 px-4 py-3.5 sm:px-5">
      <article aria-labelledby={`${fieldId}-title`} className="min-w-0">
        <div className="flex min-w-0 items-start gap-3">
          <StatusIcon status={status} />
          <div className="min-w-0 flex-1">
            <h3
              id={`${fieldId}-title`}
              tabIndex={-1}
              data-row-focus
              className="line-clamp-2 break-words text-sm font-semibold leading-snug text-slate-900 focus:outline-none dark:text-slate-100"
            >
              {approval.title ?? "Proposed work"}
            </h3>
            <StatusText status={status} className="mt-0.5" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
              <span className="mr-1 text-xs text-slate-500 dark:text-slate-400">
                Work · {approval.employee?.name ?? "Deleted AI Employee"} ·{" "}
                {formatRelative(approval.decidedAt ?? approval.requestedAt)}
              </span>
              <DetailsButton
                open={detailsOpen}
                controls={detailsId}
                onToggle={() => setDetailsOpen((open) => !open)}
              />
            </div>
          </div>
          {onClose && <CloseRowButton label="Close review" onClose={onClose} />}
        </div>
        {detailsOpen && (
          <WorkDetails id={detailsId} company={company} approval={approval} outcome={outcome} />
        )}
        {refreshNotice}
      </article>
    </li>
  );
}
