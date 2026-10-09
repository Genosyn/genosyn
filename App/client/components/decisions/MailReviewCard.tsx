import React from "react";
import { CheckCircle2, ExternalLink, Mail, Paperclip, Pencil, Send, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { oneLine } from "../../../shared/decisionSummary";
import { api, type Approval, type Company, type HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ApprovalDiscussButton } from "@/components/decisions/ApprovalDiscussButton";
import {
  CloseRowButton,
  DetailSection,
  DetailsButton,
  DetailsPanel,
  StatusIcon,
  StatusText,
  focusAfterRemoval,
} from "@/components/decisions/StackRow";
import { mailReviewStatusLine } from "@/components/decisions/stackStatus";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { formatRelative } from "@/components/decisions/relative";

function mailReview(approval: HomeApproval) {
  return approval.review?.kind === "mail" ? approval.review : null;
}

type MailReviewDraft = NonNullable<ReturnType<typeof mailReview>>["draft"];
type MailEditSession = { draft: MailReviewDraft; baseRevision: string };
export type MailReviewAction = "approve" | "reject";

function threadHref(company: Company, approval: HomeApproval): string | null {
  const review = mailReview(approval);
  return review?.source.threadId
    ? `/c/${company.slug}/mail/t/${encodeURIComponent(review.source.threadId)}?${new URLSearchParams({ account: review.source.accountId })}`
    : null;
}

function handoverHref(company: Company, approval: HomeApproval): string | null {
  const review = mailReview(approval);
  const href = threadHref(company, approval);
  return review?.source.mailHandoverId && href
    ? `${href}#handover-${encodeURIComponent(review.source.mailHandoverId)}`
    : null;
}

function freshSourceHref(
  company: Company,
  approval: HomeApproval,
): { href: string; label: string } | null {
  const review = mailReview(approval);
  if (!review || review.source.threadId) return null;
  if (approval.employee && approval.routine) {
    const routine = `/c/${company.slug}/routines/${approval.employee.slug}/${approval.routine.slug}`;
    return review.source.runId
      ? {
          href: `${routine}?run=${encodeURIComponent(review.source.runId)}`,
          label: "Open source Run",
        }
      : { href: routine, label: `Open ${approval.routine.name}` };
  }
  if (review.source.conversationId && approval.employee) {
    return {
      href: `/c/${company.slug}/employees/${approval.employee.slug}/chat?conversation=${encodeURIComponent(review.source.conversationId)}`,
      label: "Open source conversation",
    };
  }
  return null;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) return `${Math.ceil(sizeBytes / 1_024)} KB`;
  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
}

function DraftPreview({ company, approval }: { company: Company; approval: HomeApproval }) {
  const review = mailReview(approval);
  if (!review) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950/40">
      <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2">
          <dt className="font-medium text-slate-600 dark:text-slate-300">To</dt>
          <dd className="min-w-0 break-words text-slate-700 dark:text-slate-200">
            {review.draft.to}
          </dd>
        </div>
        {review.draft.cc && (
          <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2">
            <dt className="font-medium text-slate-600 dark:text-slate-300">Cc</dt>
            <dd className="min-w-0 break-words text-slate-700 dark:text-slate-200">
              {review.draft.cc}
            </dd>
          </div>
        )}
        {review.draft.bcc && (
          <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2">
            <dt className="font-medium text-slate-600 dark:text-slate-300">Bcc</dt>
            <dd className="min-w-0 break-words text-slate-700 dark:text-slate-200">
              {review.draft.bcc}
            </dd>
          </div>
        )}
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2">
          <dt className="font-medium text-slate-600 dark:text-slate-300">Subject</dt>
          <dd className="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">
            {review.draft.subject}
          </dd>
        </div>
      </dl>
      <div className="whitespace-pre-wrap break-words border-t border-slate-100 px-3 py-3 text-sm leading-relaxed text-slate-700 dark:border-slate-800 dark:text-slate-200">
        {review.draft.bodyText}
      </div>
      {review.attachments.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-3 dark:border-slate-800">
          <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Attachments</p>
          <ul className="space-y-1.5">
            {review.attachments.map((attachment, index) => (
              <li
                key={`${attachment.filename}-${index}`}
                className="flex min-w-0 items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
              >
                <Paperclip size={14} className="shrink-0 text-slate-400" />
                <a
                  href={`/api/companies/${company.id}/approvals/${approval.id}/mail-review/attachments/${attachment.index}`}
                  download={attachment.filename}
                  className="min-w-0 truncate font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {attachment.filename}
                </a>
                <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {formatFileSize(attachment.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The story behind an email, inside its Details: what happened, what the AI
 * Employee did first, and the exact email with its attachments.
 */
function MailDetails({
  id,
  company,
  approval,
  settled,
  problem,
}: {
  id: string;
  company: Company;
  approval: HomeApproval;
  settled?: boolean;
  /** What went wrong with the send, for a failed outcome. */
  problem?: string | null;
}) {
  const review = mailReview(approval);
  if (!review) {
    return (
      <DetailsPanel id={id}>
        <FormError message="This email review could not be displayed. Refresh and prepare a new email." />
      </DetailsPanel>
    );
  }
  const href = threadHref(company, approval);
  const aiWorkHref = handoverHref(company, approval);
  const freshSource = freshSourceHref(company, approval);
  const employee = approval.employee?.name ?? "The AI Employee";
  return (
    <DetailsPanel id={id}>
      {problem && (
        <DetailSection title="What went wrong">
          <FormError message={problem} />
        </DetailSection>
      )}
      <DetailSection title={review.source.threadId ? "The customer email" : "Why this email"}>
        <p className="whitespace-pre-wrap">{review.context}</p>
        {(href || aiWorkHref || freshSource) && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {href && (
              <Link
                to={href}
                className="inline-flex text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open original email
              </Link>
            )}
            {aiWorkHref && (
              <Link
                to={aiWorkHref}
                className="inline-flex text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open AI work
              </Link>
            )}
            {freshSource && (
              <Link
                to={freshSource.href}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                <ExternalLink size={12} /> {freshSource.label}
              </Link>
            )}
          </div>
        )}
      </DetailSection>
      {(review.workSummary || review.steps.length > 0) && (
        <DetailSection title={`What ${employee} did first`}>
          {review.workSummary && <ChatMarkdown content={review.workSummary} />}
          {review.steps.length > 0 && (
            <ol className="mt-2 space-y-2">
              {review.steps.map((step, index) => (
                <li key={`${step.title}-${index}`} className="flex gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      {step.title}
                    </span>
                    {step.detail && (
                      <div className="text-xs leading-relaxed">
                        <ChatMarkdown content={step.detail} />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </DetailSection>
      )}
      <DetailSection title={review.source.threadId ? "The reply" : "The email"}>
        <DraftPreview company={company} approval={approval} />
        <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {settled
            ? "No email was saved to Gmail or IMAP Drafts before this review was resolved."
            : `${review.source.threadId ? "This reply" : "This email"} exists only in Genosyn. Nothing has been saved to Gmail or IMAP Drafts.`}
        </p>
      </DetailSection>
    </DetailsPanel>
  );
}

/** "To ana@acme.test · Re: Pricing" — who it goes to and what it says, on one line. */
function Envelope({ approval }: { approval: HomeApproval }) {
  const review = mailReview(approval);
  if (!review) return null;
  return (
    <p className="mt-1 truncate text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium text-slate-700 dark:text-slate-200">To</span>{" "}
      <span data-mail-to>{review.draft.to || "—"}</span>
      {review.draft.subject && (
        <>
          <span className="text-slate-400 dark:text-slate-500"> · </span>
          <span data-mail-subject>{review.draft.subject}</span>
        </>
      )}
    </p>
  );
}

/**
 * An email ready to send, as one short row: who it is for, the subject, the
 * first lines, and Send now / Edit email / Ask employee to edit / Discard.
 * The source, what the employee did first, and the full email are behind
 * Details. Each email is its own gate: grouping never sends two at once.
 */
export function MailReviewCard({
  company,
  approval,
  onResolved,
  onActionStart,
  onActionSettled,
  onEditingChange,
  grouped = false,
}: {
  company: Company;
  approval: HomeApproval;
  onResolved: (announcement?: string) => Promise<void> | void;
  onActionStart?: (action: MailReviewAction) => void;
  /** Called with the server's row; `leave` puts focus where the row was once it is gone. */
  onActionSettled?: (approval: Approval, action: MailReviewAction, leave: () => void) => void;
  onEditingChange?: (approvalId: string, editing: boolean) => void;
  /** Under a group's "3 emails to review" heading, which already says what it is. */
  grouped?: boolean;
}) {
  const review = mailReview(approval);
  const fallbackTitle = review?.source.threadId ? "Customer reply" : "Email review";
  const [editSession, setEditSession] = React.useState<MailEditSession | null>(null);
  const [stale, setStale] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "reload" | "send" | "discard" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const acting = React.useRef(false);
  const rowRef = React.useRef<HTMLLIElement>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const editorFormRef = React.useRef<HTMLFormElement>(null);
  const fieldId = React.useId();
  const detailsId = `${fieldId}-details`;
  const editing = editSession !== null;
  const editingBaseRevision = editSession?.baseRevision ?? null;

  React.useEffect(() => {
    // The edit session is a member-owned working copy. Background refreshes
    // may mark it stale, but only an explicit reload may replace its text.
    if (editingBaseRevision !== null && review?.revision !== editingBaseRevision) setStale(true);
  }, [editingBaseRevision, review?.revision]);
  React.useEffect(() => {
    onEditingChange?.(approval.id, editing);
    return () => onEditingChange?.(approval.id, false);
  }, [approval.id, editing, onEditingChange]);
  function returnFocusToEditButton() {
    window.requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  function startEditing() {
    if (!review) return;
    setEditSession({ draft: { ...review.draft }, baseRevision: review.revision });
    setStale(false);
    setError(null);
  }

  function stopEditing() {
    setEditSession(null);
    setStale(false);
  }

  async function decide(action: MailReviewAction) {
    if (acting.current) return;
    acting.current = true;
    setBusy(action === "approve" ? "send" : "discard");
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
          "Genosyn could not confirm whether the email completed. Check the source before preparing another email.";
        if (result.status === "execution_failed") {
          await onResolved(
            result.mailDeliveryStatus === "not_sent"
              ? `Email review “${approval.title ?? fallbackTitle}” was not sent. Its outcome is available.`
              : `Email review “${approval.title ?? fallbackTitle}” has an unverified send outcome.`,
          );
        } else {
          setError(message);
        }
        return;
      }
      await onResolved(
        action === "approve"
          ? `Email review “${approval.title ?? fallbackTitle}” sent.`
          : `Email review “${approval.title ?? fallbackTitle}” discarded. It is in Decision history.`,
      );
    } catch (err) {
      setError(
        errorMessage(
          err,
          action === "approve" ? "Could not send the email" : "Could not discard the email",
        ),
      );
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  async function save() {
    const session = editSession;
    if (!session || acting.current) return;
    // The form owns the working copy while it is open. Reading its controls
    // directly means unrelated React renders cannot replace freshly typed
    // text before Save captures the member's exact review.
    const form = editorFormRef.current;
    const fields = form ? new FormData(form) : null;
    const workingDraft = fields
      ? {
          to: String(fields.get("to") ?? ""),
          cc: String(fields.get("cc") ?? ""),
          bcc: String(fields.get("bcc") ?? ""),
          subject: String(fields.get("subject") ?? ""),
          bodyText: String(fields.get("bodyText") ?? ""),
        }
      : session.draft;
    setEditSession({ ...session, draft: workingDraft });
    acting.current = true;
    setBusy("save");
    setError(null);
    try {
      await api.patch<Approval>(
        `/api/companies/${company.id}/approvals/${approval.id}/mail-review`,
        { expectedRevision: session.baseRevision, ...workingDraft },
      );
      stopEditing();
      await onResolved();
      returnFocusToEditButton();
    } catch (err) {
      const message = errorMessage(err, "Could not save the email");
      if (message.includes("changed while you were editing")) {
        setStale(true);
        // Load the newer server revision behind the isolated edit session.
        // If that read fails, the explicit reload action below remains a safe
        // retry and the member's working copy is still untouched.
        try {
          await onResolved();
        } catch {
          // Keep the more useful conflict explanation visible.
        }
        setError(`${message} Your unsaved text remains available above.`);
      } else {
        setError(message);
      }
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  async function reloadLatest() {
    if (acting.current) return;
    acting.current = true;
    setBusy("reload");
    setError(null);
    try {
      await onResolved();
      stopEditing();
      returnFocusToEditButton();
    } catch (err) {
      setError(errorMessage(err, "Could not reload the latest email"));
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
            <Mail size={11} aria-hidden="true" />
          </span>
          <p className="min-w-0 flex-1 truncate">
            {grouped ? (
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {approval.employee?.name ?? "Deleted AI Employee"}
              </span>
            ) : (
              <>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  Email to review
                </span>
                <span> · {approval.employee?.name ?? "Deleted AI Employee"}</span>
              </>
            )}
            <span> · {formatRelative(approval.requestedAt)}</span>
          </p>
          {!editing && (
            <DetailsButton
              size="xs"
              open={detailsOpen}
              controls={detailsId}
              onToggle={() => setDetailsOpen((open) => !open)}
            />
          )}
        </header>
        <h3
          id={`${fieldId}-title`}
          tabIndex={-1}
          data-row-focus
          className="mt-1 break-words text-[15px] font-semibold leading-snug text-slate-900 focus:outline-none dark:text-slate-100"
        >
          {approval.title ?? fallbackTitle}
        </h3>
        {review ? (
          <>
            <Envelope approval={approval} />
            {!editing && review.draft.bodyText.trim() && (
              <p
                data-mail-preview
                className="mt-1 line-clamp-2 break-words text-sm leading-relaxed text-slate-500 dark:text-slate-400"
              >
                {oneLine(review.draft.bodyText)}
              </p>
            )}
          </>
        ) : (
          <FormError
            message="This email review could not be displayed. Refresh and prepare a new email."
            className="mt-2"
          />
        )}
        {detailsOpen && !editing && (
          <MailDetails id={detailsId} company={company} approval={approval} />
        )}

        {editSession && (
          <form
            ref={editorFormRef}
            aria-label="Edit email"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="mt-3 space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-500/30 dark:bg-indigo-500/5"
          >
            {stale && (
              <div
                role="alert"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
              >
                <p>
                  A newer version of this email is available. Your unsaved edits remain below so you
                  can copy them before reloading.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  loading={busy === "reload"}
                  disabled={busy !== null}
                  onClick={() => void reloadLatest()}
                >
                  Discard edits and reload latest
                </Button>
              </div>
            )}
            <Input
              label="To"
              name="to"
              defaultValue={editSession.draft.to}
              disabled={busy !== null}
              autoFocus
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Cc"
                name="cc"
                defaultValue={editSession.draft.cc}
                disabled={busy !== null}
              />
              <Input
                label="Bcc"
                name="bcc"
                defaultValue={editSession.draft.bcc}
                disabled={busy !== null}
              />
            </div>
            <Input
              label="Subject"
              name="subject"
              defaultValue={editSession.draft.subject}
              disabled={busy !== null}
            />
            <Textarea
              label="Email"
              name="bodyText"
              className="min-h-[220px]"
              defaultValue={editSession.draft.bodyText}
              disabled={busy !== null}
              hint="Saving updates this Genosyn review only. It does not create a mailbox draft."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                loading={busy === "save"}
                disabled={busy !== null || stale}
              >
                <CheckCircle2 size={14} /> Save changes
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  stopEditing();
                  setError(null);
                  returnFocusToEditButton();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        <FormError message={error} className="mt-3" />
        {!editing && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={busy === "send"}
              disabled={busy !== null || !review}
              onClick={() => void decide("approve")}
            >
              <Send size={14} /> Send now
            </Button>
            <Button
              ref={editButtonRef}
              size="sm"
              variant="secondary"
              disabled={busy !== null || !review}
              onClick={startEditing}
            >
              <Pencil size={14} /> Edit email
            </Button>
            <ApprovalDiscussButton
              company={company}
              approval={approval}
              label="Ask employee to edit"
              disabled={busy !== null}
            />
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
              loading={busy === "discard"}
              disabled={busy !== null}
              onClick={() => void decide("reject")}
              title="Don't send it. It stays in Decision history."
            >
              <Trash2 size={14} /> Discard
            </Button>
          </div>
        )}
      </article>
    </li>
  );
}

/**
 * A reviewed email as one status line — Sending, Sent, Not sent, Discarded —
 * with its story and the exact email behind Details. Close (on the active
 * stack) takes it off; History keeps it.
 */
export function MailReviewOutcome({
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
  const status = mailReviewStatusLine(approval);
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
              {approval.title ?? "Email review"}
            </h3>
            <StatusText status={status} className="mt-0.5" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
              <span className="mr-1 text-xs text-slate-500 dark:text-slate-400">
                Email · {approval.employee?.name ?? "Deleted AI Employee"} ·{" "}
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
          <MailDetails
            id={detailsId}
            company={company}
            approval={approval}
            settled
            problem={
              approval.status === "execution_failed"
                ? (approval.errorMessage ??
                  (approval.mailDeliveryStatus === "not_sent"
                    ? "The email was not sent. Review the source before preparing another email."
                    : "Genosyn could not confirm whether the email completed. Check the source before preparing another email."))
                : null
            }
          />
        )}
        {refreshNotice}
      </article>
    </li>
  );
}
