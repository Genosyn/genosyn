import React from "react";
import { Link } from "react-router-dom";
import { Check, ExternalLink, X } from "lucide-react";

import { approvalCopy } from "@/components/approvals/approvalCopy";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button, buttonClassName } from "@/components/ui/Button";
import { useBackgroundAction, useDialog } from "@/components/ui/Dialog";
import { Modal } from "@/components/ui/Modal";
import { clsx } from "@/components/ui/clsx";
import { api } from "@/lib/api";
import type { Approval, Company, HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * Deciding a pending approval from Home.
 *
 * The row on Home used to link to `/approvals` — an inbox that does not even
 * know which row you clicked. Worse, the row itself never showed `summary`,
 * which is the part that says what the employee actually wants to do. So the
 * only way to find out was to leave the page, and the only way to decide was
 * to leave it twice.
 *
 * Everything shown here is already in the Home payload; there is nothing to
 * fetch. `approvalCopy` is shared with the inbox so the same gate is never
 * worded two ways, and it carries the consequence sentence — a modal with an
 * Approve button in it is exactly where "what happens if I press this" has to
 * be on screen rather than in a code comment.
 */

export function ApprovalPeekModal({
  company,
  approval,
  onClose,
  onDecided,
}: {
  company: Company;
  approval: HomeApproval;
  onClose: () => void;
  onDecided: () => void;
}) {
  const copy = approvalCopy(approval);
  const Icon = copy.Icon;
  const dialog = useDialog();
  const background = useBackgroundAction();
  const [busy, setBusy] = React.useState(false);

  // Approval details can name external actions and their arguments, so the
  // server only serves the list to owners and admins. A Member sees the row
  // (the count was never the sensitive part) but cannot decide it.
  const canDecide = company.role === "owner" || company.role === "admin";

  function decide(action: "approve" | "reject") {
    setBusy(true);
    onClose();
    background(
      () =>
        api.post<Approval & { executeError?: string }>(
          `/api/companies/${company.id}/approvals/${approval.id}/${action}`,
        ),
      {
        title: "Couldn’t record the decision",
        error: (err) => `${errorMessage(err)} The approval is still pending.`,
        onSuccess: (updated) => {
          onDecided();
          if (action === "approve" && updated.executeError) {
            void dialog.error(updated.executeError, { title: "Approved, but the action failed" });
          }
        },
        onError: onDecided,
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      description={copy.subtitle}
      size="md"
      footer={
        <>
          <Link
            to={`/c/${company.slug}/approvals`}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
            onClick={onClose}
          >
            <ExternalLink size={14} /> Approvals inbox
          </Link>
          {canDecide && (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("reject")}>
                <X size={14} /> Reject
              </Button>
              <Button size="sm" disabled={busy} onClick={() => decide("approve")}>
                <Check size={14} /> Approve
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <Icon size={18} className={clsx(copy.iconClass)} />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          {approval.employee && (
            <div className="flex items-center gap-2">
              <Avatar
                name={approval.employee.name}
                kind="ai"
                size="sm"
                src={employeeAvatarUrl(company.id, approval.employee.id, null)}
              />
              <span className="text-sm text-slate-700 dark:text-slate-200">
                {approval.employee.name}
                {approval.routine ? ` · ${approval.routine.name}` : ""}
              </span>
            </div>
          )}

          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              What was requested
            </div>
            {/* Plain text, deliberately. This is model-written prose that may
                quote a URL or a header; nothing promises it is markdown, and
                rendering it as markdown would let it style itself. */}
            <p className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
              {approval.summary ?? copy.subtitle}
            </p>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {copy.consequence}
          </div>

          {!canDecide && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Approval requests can contain sensitive external-action details, so only a company
              owner or admin can decide them.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
