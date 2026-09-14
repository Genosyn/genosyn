import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Mail,
  Paperclip,
  Pencil,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api, type Approval, type Company, type HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ApprovalDiscussButton } from "@/components/decisions/ApprovalDiscussButton";
import { ReviewTimeline, ReviewTimelineItem } from "@/components/decisions/ReviewTimeline";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { formatRelative } from "@/components/decisions/relative";

function mailReview(approval: HomeApproval) {
  return approval.review?.kind === "mail" ? approval.review : null;
}

type MailReviewDraft = NonNullable<ReturnType<typeof mailReview>>["draft"];
type MailEditSession = { draft: MailReviewDraft; baseRevision: string };

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

function Timeline({
  company,
  approval,
  outcome,
  draftEditor,
}: {
  company: Company;
  approval: HomeApproval;
  outcome?: React.ReactNode;
  draftEditor?: React.ReactNode;
}) {
  const review = mailReview(approval);
  if (!review) {
    return (
      <FormError message="This email review could not be displayed. Refresh and prepare a new email." />
    );
  }
  const href = threadHref(company, approval);
  const aiWorkHref = handoverHref(company, approval);
  const freshSource = freshSourceHref(company, approval);
  return (
    <ReviewTimeline>
      <ReviewTimelineItem
        icon={Mail}
        title="What happened"
        meta={review.source.threadId ? "Customer email" : "Proposed email"}
      >
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {review.context}
        </p>
        {(href || aiWorkHref || freshSource) && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
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
      </ReviewTimelineItem>
      {(review.workSummary || review.steps.length > 0) && (
        <ReviewTimelineItem
          icon={Sparkles}
          title="What the AI Employee reports it did"
          tone="accent"
        >
          {review.workSummary && (
            <div className="break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <ChatMarkdown content={review.workSummary} />
            </div>
          )}
          {review.steps.length > 0 && (
            <ol className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
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
        </ReviewTimelineItem>
      )}
      <ReviewTimelineItem
        icon={FileText}
        title={review.source.threadId ? "Draft reply" : "Draft email"}
        tone="accent"
      >
        {draftEditor ?? <DraftPreview company={company} approval={approval} />}
        <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {outcome
            ? "No email was saved to Gmail or IMAP Drafts before this review was resolved."
            : `${review.source.threadId ? "This reply" : "This email"} exists only in Genosyn. Nothing has been saved to Gmail or IMAP Drafts.`}
        </p>
      </ReviewTimelineItem>
      {outcome}
    </ReviewTimeline>
  );
}

/** Exact, stack-only email with direct Send / Edit / Ask / Discard actions. */
export function MailReviewCard({
  company,
  approval,
  onResolved,
}: {
  company: Company;
  approval: HomeApproval;
  onResolved: (announcement?: string) => Promise<void> | void;
}) {
  const review = mailReview(approval);
  const fallbackTitle = review?.source.threadId ? "Customer reply" : "Email review";
  const [editSession, setEditSession] = React.useState<MailEditSession | null>(null);
  const [stale, setStale] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "reload" | "send" | "discard" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const acting = React.useRef(false);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const editorFormRef = React.useRef<HTMLFormElement>(null);
  const editing = editSession !== null;
  const editingBaseRevision = editSession?.baseRevision ?? null;

  React.useEffect(() => {
    // The edit session is a member-owned working copy. Background refreshes
    // may mark it stale, but only an explicit reload may replace its text.
    if (editingBaseRevision !== null && review?.revision !== editingBaseRevision) setStale(true);
  }, [editingBaseRevision, review?.revision]);
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

  async function decide(action: "approve" | "reject") {
    if (acting.current) return;
    acting.current = true;
    setBusy(action === "approve" ? "send" : "discard");
    setError(null);
    try {
      const result = await api.post<Approval & { executeError?: string }>(
        `/api/companies/${company.id}/approvals/${approval.id}/${action}`,
        { reviewRevision: review?.revision },
      );
      if (result.executeError || result.status === "execution_failed") {
        const message =
          result.errorMessage ||
          "Genosyn could not confirm whether the email completed. Check the source before preparing another email.";
        if (result.status === "execution_failed") {
          await onResolved(
            result.mailDeliveryStatus === "not_sent"
              ? `Email review “${approval.title ?? fallbackTitle}” was not sent and moved to history.`
              : `Email review “${approval.title ?? fallbackTitle}” moved to history with an unverified send outcome.`,
          );
        } else {
          setError(message);
        }
        return;
      }
      await onResolved(
        action === "approve"
          ? `Email review “${approval.title ?? fallbackTitle}” sent.`
          : `Email review “${approval.title ?? fallbackTitle}” discarded.`,
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
    <li id={`review-${approval.id}`} className="scroll-mt-4 px-4 py-5 sm:px-5">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          <Mail size={13} /> Email ready for review
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {approval.employee?.name ?? "Deleted AI Employee"} ·{" "}
          {formatRelative(approval.requestedAt)}
        </span>
      </div>
      <h3 className="mb-5 break-words text-base font-semibold leading-snug text-slate-900 dark:text-slate-100">
        {approval.title ?? fallbackTitle}
      </h3>

      <Timeline
        company={company}
        approval={approval}
        draftEditor={
          editSession ? (
            <form
              ref={editorFormRef}
              aria-label="Edit email"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-500/30 dark:bg-indigo-500/5"
            >
              {stale && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
                >
                  <p>
                    A newer version of this email is available. Your unsaved edits remain below so
                    you can copy them before reloading.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    disabled={busy !== null}
                    onClick={() => void reloadLatest()}
                  >
                    {busy === "reload" && <Spinner size={14} />} Discard edits and reload latest
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
                <Button type="submit" size="sm" disabled={busy !== null || stale}>
                  {busy === "save" ? <Spinner size={14} /> : <CheckCircle2 size={14} />} Save
                  changes
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
          ) : undefined
        }
      />

      <FormError message={error} className="mt-4" />
      {!editing && (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <Button disabled={busy !== null || !review} onClick={() => void decide("approve")}>
            {busy === "send" ? <Spinner size={14} /> : <Send size={14} />} Send now
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
            disabled={busy !== null}
            onClick={() => void decide("reject")}
          >
            {busy === "discard" ? <Spinner size={14} /> : <Trash2 size={14} />} Discard
          </Button>
        </div>
      )}
    </li>
  );
}

export function MailReviewOutcome({ company, approval }: { company: Company; approval: Approval }) {
  const sent = approval.status === "approved" && Boolean(approval.mailOutcome);
  const notSent =
    approval.status === "execution_failed" && approval.mailDeliveryStatus === "not_sent";
  const unverified =
    (approval.status === "approved" && !approval.mailOutcome) ||
    (approval.status === "execution_failed" && !notSent);
  const statusTitle = sent
    ? "Sent"
    : notSent
      ? "Not sent"
      : unverified
        ? "Send outcome unverified"
        : approval.status === "rejected"
          ? "Discarded"
          : approval.status === "executing"
            ? "Sending"
            : approval.status === "expired"
              ? "Expired"
              : "Waiting";
  const outcome = (
    <ReviewTimelineItem
      icon={
        sent
          ? Send
          : unverified || notSent
            ? AlertTriangle
            : approval.status === "rejected"
              ? Trash2
              : CheckCircle2
      }
      title={statusTitle}
      meta={formatRelative(approval.decidedAt ?? approval.requestedAt)}
      tone={sent ? "success" : unverified ? "warning" : notSent ? "danger" : "neutral"}
    >
      {sent && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The exact reviewed email was sent. No mailbox draft was created first.
        </p>
      )}
      {approval.status === "rejected" && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Nothing was saved to the mailbox or sent.
        </p>
      )}
      {approval.status === "execution_failed" && (
        <FormError
          message={
            approval.errorMessage ??
            (notSent
              ? "The email was not sent. Review the source before preparing another email."
              : "Genosyn could not confirm whether the email completed. Check the source before preparing another email.")
          }
        />
      )}
      {approval.status === "approved" && unverified && (
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Genosyn has no record that the mailbox accepted this email. Check the source before
          preparing or sending another email.
        </p>
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
            {approval.title ?? "Email review"}
          </h3>
          <span>· {approval.employee?.name ?? "Deleted AI Employee"}</span>
        </div>
        <Timeline company={company} approval={approval} outcome={outcome} />
      </article>
    </li>
  );
}
