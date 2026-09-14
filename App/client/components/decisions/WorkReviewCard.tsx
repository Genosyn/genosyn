import React from "react";
import {
  AlertTriangle,
  Check,
  CircleDot,
  ExternalLink,
  ListChecks,
  Repeat,
  ShieldCheck,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Approval, type Company, type HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ApprovalDiscussButton } from "@/components/decisions/ApprovalDiscussButton";
import { ReviewTimeline, ReviewTimelineItem } from "@/components/decisions/ReviewTimeline";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { formatRelative } from "@/components/decisions/relative";

function workReview(approval: HomeApproval) {
  return approval.review?.kind === "work" ? approval.review : null;
}

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

function WorkTimeline({
  company,
  approval,
  outcome,
}: {
  company: Company;
  approval: HomeApproval;
  outcome?: React.ReactNode;
}) {
  const review = workReview(approval);
  const source = sourceHref(company, approval);
  if (!review) {
    return (
      <FormError message="This work review could not be displayed. Refresh before deciding." />
    );
  }
  return (
    <ReviewTimeline>
      <ReviewTimelineItem icon={CircleDot} title="What happened">
        <div className="break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          <ChatMarkdown content={review.context} />
        </div>
        {source && (
          <Link
            to={source.href}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <ExternalLink size={12} /> {source.label}
          </Link>
        )}
      </ReviewTimelineItem>
      <ReviewTimelineItem icon={ListChecks} title="What the AI Employee recommends" tone="accent">
        <div className="break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          <ChatMarkdown content={review.plan} />
        </div>
      </ReviewTimelineItem>
      {outcome}
    </ReviewTimeline>
  );
}

/** A concrete work Approval, rendered as context → plan → one clear choice. */
export function WorkReviewCard({
  company,
  approval,
  onResolved,
}: {
  company: Company;
  approval: HomeApproval;
  onResolved: (announcement?: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = React.useState<"approve" | "reject" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const acting = React.useRef(false);

  async function decide(action: "approve" | "reject") {
    if (acting.current) return;
    acting.current = true;
    setBusy(action);
    setError(null);
    try {
      const result = await api.post<Approval & { executeError?: string }>(
        `/api/companies/${company.id}/approvals/${approval.id}/${action}`,
        { reviewRevision: workReview(approval)?.revision },
      );
      if (result.executeError || result.status === "execution_failed") {
        const message =
          result.errorMessage ||
          "The approved work could not start. Inspect its outcome before trying again.";
        if (result.status === "execution_failed") {
          await onResolved(
            `Work review “${approval.title ?? "Proposed work"}” moved to history after it failed.`,
          );
        } else {
          setError(message);
        }
        return;
      }
      await onResolved(
        action === "approve"
          ? `Work review “${approval.title ?? "Proposed work"}” approved.`
          : `Work review “${approval.title ?? "Proposed work"}” declined.`,
      );
    } catch (err) {
      setError(errorMessage(err, "Could not record this review"));
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  return (
    <li id={`review-${approval.id}`} className="scroll-mt-4 px-4 py-5 sm:px-5">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-1 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          <ShieldCheck size={13} /> Work needs your review
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          {approval.employee?.name ?? "Deleted AI Employee"} ·{" "}
          {formatRelative(approval.requestedAt)}
        </span>
      </div>
      <h3 className="mb-5 break-words text-base font-semibold leading-snug text-slate-900 dark:text-slate-100">
        {approval.title ?? "Review proposed work"}
      </h3>
      <WorkTimeline company={company} approval={approval} />
      <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
        Approve &amp; start authorizes only the work shown above. Existing Grants, Policies, Checks,
        and action Approvals still apply.
      </p>
      <FormError message={error} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy !== null} onClick={() => void decide("approve")}>
          {busy === "approve" ? <Spinner size={14} /> : <Check size={14} />} Approve &amp; start
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
          disabled={busy !== null}
          onClick={() => void decide("reject")}
        >
          {busy === "reject" ? <Spinner size={14} /> : <X size={14} />} Don’t do this
        </Button>
      </div>
    </li>
  );
}

/** Keep source, approved plan, and actual result together in history. */
export function WorkReviewOutcome({ company, approval }: { company: Company; approval: Approval }) {
  const routine = routineHref(company, approval);
  const runHref =
    routine && approval.outcomeRunId
      ? `${routine}?run=${encodeURIComponent(approval.outcomeRunId)}`
      : null;
  const outcomeUnverified =
    approval.status === "approved" && !approval.outcomeSummary && !approval.outcomeRunId;
  const status = {
    pending: "Waiting",
    executing: "Work in progress",
    approved: outcomeUnverified ? "Work outcome unverified" : "Work finished",
    execution_failed: "Work failed",
    rejected: "Not approved",
    expired: "Expired",
  }[approval.status];
  const outcome = (
    <ReviewTimelineItem
      icon={
        outcomeUnverified
          ? AlertTriangle
          : approval.status === "approved"
            ? Check
            : approval.status === "rejected"
              ? X
              : Repeat
      }
      title={status}
      meta={formatRelative(approval.decidedAt ?? approval.requestedAt)}
      tone={
        outcomeUnverified
          ? "warning"
          : approval.status === "approved"
            ? "success"
            : approval.status === "execution_failed"
              ? "danger"
              : "neutral"
      }
    >
      {approval.status === "executing" && (
        <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <Spinner size={14} /> The AI Employee is doing the approved work.
        </p>
      )}
      {approval.outcomeSummary && (
        <div className="break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          <ChatMarkdown content={approval.outcomeSummary} />
        </div>
      )}
      {outcomeUnverified && (
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          The Approval completed, but no Run or outcome report was recorded. Inspect the source
          before treating the work as finished.
        </p>
      )}
      {runHref && (
        <Link
          to={runHref}
          className="mt-2 inline-flex text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Open AI work, Effects, and Checks
        </Link>
      )}
      {approval.status === "rejected" && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The proposed work did not start.
        </p>
      )}
      {approval.status === "execution_failed" && (
        <FormError message={approval.errorMessage ?? "The approved work could not finish."} />
      )}
    </ReviewTimelineItem>
  );

  return (
    <li
      id={`review-${approval.id}`}
      className="scroll-mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <article aria-labelledby={`review-${approval.id}-title`}>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <h3
            id={`review-${approval.id}-title`}
            className="text-sm font-semibold text-slate-800 dark:text-slate-100"
          >
            {approval.title ?? "Proposed work"}
          </h3>
          <span>· {approval.employee?.name ?? "Deleted AI Employee"}</span>
        </div>
        <WorkTimeline company={company} approval={approval} outcome={outcome} />
      </article>
    </li>
  );
}
