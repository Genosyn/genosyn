import React from "react";
import { Check, Repeat, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Approval, type Company, type HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { approvalCopy } from "@/components/approvals/approvalCopy";
import { formatRelative } from "@/components/decisions/relative";

function routineHref(company: Company, approval: HomeApproval): string | null {
  return approval.employee && approval.routine
    ? `/c/${company.slug}/routines/${approval.employee.slug}/${approval.routine.slug}`
    : null;
}

/** Keep the result beside the plan so an approved request does not vanish. */
export function WorkReviewOutcome({ company, approval }: { company: Company; approval: Approval }) {
  const copy = approvalCopy(approval);
  const sourceHref = routineHref(company, approval);
  const status = {
    pending: "Waiting for approval",
    executing: "In progress",
    approved: "Work finished",
    execution_failed: "Work failed",
    rejected: "Declined",
    expired: "Expired",
  }[approval.status];
  return (
    <li
      id={`work-review-${approval.id}`}
      className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {approval.status === "executing" ? <Spinner size={12} /> : <ShieldCheck size={12} />}
          {status}
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          {approval.employee?.name ?? "Deleted AI Employee"} ·{" "}
          {formatRelative(approval.decidedAt ?? approval.requestedAt)}
        </span>
      </div>
      <h3 className="mt-2 break-words text-sm font-medium text-slate-900 dark:text-slate-100">
        {copy.title}
      </h3>
      {sourceHref && approval.outcomeRunId && (
        <Link
          to={`${sourceHref}?run=${approval.outcomeRunId}`}
          className="mt-2 inline-flex text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Open Run and Checks
        </Link>
      )}
      {approval.outcomeSummary && (
        <div className="mt-3 break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          <div className="mb-1 text-xs font-medium">Reported outcome</div>
          <div className="max-h-64 overflow-auto">
            <ChatMarkdown content={approval.outcomeSummary} />
          </div>
        </div>
      )}
      {approval.status === "executing" && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The AI Employee is working on this plan. Its result will appear here.
        </p>
      )}
      {approval.status === "approved" && !approval.outcomeSummary && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The AI Employee finished without a report. Review its results before relying on the
          outcome.
        </p>
      )}
      {approval.status === "rejected" && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The proposed work was declined and did not start.
        </p>
      )}
      {approval.status === "execution_failed" && (
        <FormError
          message={
            approval.errorMessage ||
            "The approved work could not finish. Review the result before requesting another attempt."
          }
          className="mt-3"
        />
      )}
      <details className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer font-medium text-indigo-600 dark:text-indigo-400">
          Review proposed work
        </summary>
        <div className="mt-2 max-h-80 overflow-auto break-words rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
          <ChatMarkdown content={copy.subtitle} />
        </div>
      </details>
    </li>
  );
}

/** A privileged work Approval shares the inbox, but never the Decision endpoint. */
export function WorkReviewCard({
  company,
  approval,
  onResolved,
}: {
  company: Company;
  approval: HomeApproval;
  onResolved: () => void;
}) {
  const [choice, setChoice] = React.useState<"approve" | "reject" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const submitting = React.useRef(false);
  const canReview = company.role === "owner" || company.role === "admin";
  const copy = approvalCopy(approval);
  const sourceHref = routineHref(company, approval);

  async function submit() {
    if (!choice || !canReview || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<Approval & { executeError?: string }>(
        `/api/companies/${company.id}/approvals/${approval.id}/${choice}`,
      );
      if (result.executeError || result.status === "execution_failed") {
        setFailed(true);
        setError(
          result.executeError || result.errorMessage || "The approved work could not start.",
        );
        setBusy(false);
        return;
      }
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
      submitting.current = false;
      setBusy(false);
    }
  }

  if (!canReview) return null;

  return (
    <li id={`work-review-${approval.id}`} className="scroll-mt-4 px-4 py-5 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-1 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          <ShieldCheck size={13} /> Work needs your approval
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          {approval.employee?.name ?? "Deleted AI Employee"} · requested{" "}
          {formatRelative(approval.requestedAt)}
        </span>
      </div>
      <h3 className="break-words text-base font-semibold leading-snug text-slate-900 dark:text-slate-100">
        {copy.title}
      </h3>
      {sourceHref && (
        <Link
          to={sourceHref}
          className="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          <Repeat size={12} className="shrink-0" />
          <span className="min-w-0 truncate">Routine: {approval.routine!.name}</span>
        </Link>
      )}
      <div className="mt-3 max-h-96 overflow-auto break-words rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
        <ChatMarkdown content={copy.subtitle} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {choice === "reject"
          ? "Declining closes this request. The proposed work will not start."
          : copy.consequence}
      </p>
      <FormError message={error} className="mt-3" />
      {failed ? (
        <Link
          to={`/c/${company.slug}/approvals`}
          className="mt-3 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400"
        >
          View Approval status
        </Link>
      ) : choice ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={choice === "approve" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? (
              <Spinner size={14} />
            ) : choice === "approve" ? (
              <Check size={14} />
            ) : (
              <X size={14} />
            )}
            {choice === "approve" ? "Confirm and start work" : "Confirm decline"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setChoice(null);
              setError(null);
            }}
          >
            Go back
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setChoice("approve")}>
            <Check size={14} /> Approve work
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setChoice("reject")}>
            <X size={14} /> Decline
          </Button>
        </div>
      )}
    </li>
  );
}
