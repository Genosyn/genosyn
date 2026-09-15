import React from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Info,
  ListChecks,
  MessageSquarePlus,
} from "lucide-react";
import { api, Company, Decision, DecisionUrgency } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { DecisionSourceLine } from "@/components/decisions/DecisionSource";
import { DecisionDiscussButton } from "@/components/decisions/DecisionDiscussButton";
import { ReviewTimeline, ReviewTimelineItem } from "@/components/decisions/ReviewTimeline";
import { formatRelative } from "@/components/decisions/relative";

const URGENCY_BADGE: Record<DecisionUrgency, { label: string; cls: string } | null> = {
  high: {
    label: "Urgent",
    cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  },
  normal: null,
  low: {
    label: "Low priority",
    cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
};

/** A pending question, shown as the story so far followed by one clear choice. */
export function DecisionCard({
  company,
  decision,
  onResolved,
  canAnswer = true,
}: {
  company: Company;
  decision: Decision;
  onResolved: (announcement?: string) => Promise<void> | void;
  canAnswer?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const submitting = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [contextOpen, setContextOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dismissing, setDismissing] = React.useState(false);
  const [guidanceOpen, setGuidanceOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const base = `/api/companies/${company.id}/decisions/${decision.id}`;
  const fieldId = React.useId();
  const badge = URGENCY_BADGE[decision.urgency];
  const selected = decision.options.find((option) => option.id === selectedId);
  const employeeName = decision.employee?.name ?? "The AI Employee";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || (!dismissing && !selected)) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (dismissing) {
        await api.post(`${base}/dismiss`, note.trim() ? { reason: note.trim() } : {});
      } else {
        await api.post(`${base}/decide`, {
          optionId: selected!.id,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }
      // The refreshed row records pickup status; submitting cannot promise that
      // the employee has started or that any proposed action has succeeded.
      await onResolved(
        dismissing
          ? `Decision “${decision.title}” dismissed.`
          : `Decision “${decision.title}” answered.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <li id={`decision-${decision.id}`} className="scroll-mt-4 px-4 py-5 sm:px-5">
      <article aria-labelledby={`${fieldId}-title`} className="min-w-0">
        <header className="flex min-w-0 items-center gap-2">
          {decision.employee ? (
            <Avatar
              name={decision.employee.name}
              kind="ai"
              size="sm"
              src={employeeAvatarUrl(company.id, decision.employee.id, decision.employee.avatarKey)}
            />
          ) : (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <GitBranch size={12} />
            </span>
          )}
          <div className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-200">{employeeName}</span>
            <span> · asked {formatRelative(decision.createdAt)}</span>
            {decision.assignee && <span> · for {decision.assignee.name}</span>}
          </div>
          {badge && (
            <span
              className={clsx(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                badge.cls,
              )}
            >
              {badge.label}
            </span>
          )}
        </header>

        <h3
          id={`${fieldId}-title`}
          className="mt-3 break-words text-base font-semibold leading-snug text-slate-900 dark:text-slate-100"
        >
          {decision.title}
        </h3>

        <ReviewTimeline className="mt-5">
          <ReviewTimelineItem icon={Info} title="What happened">
            <DecisionSourceLine company={company} decision={decision} />
            <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/50">
              {decision.body ? (
                <>
                  <div
                    id={`${fieldId}-context`}
                    className={clsx(
                      "break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300",
                      contextOpen ? "max-h-[32rem] overflow-auto" : "max-h-36 overflow-hidden",
                    )}
                  >
                    <ChatMarkdown content={decision.body} />
                  </div>
                  <button
                    type="button"
                    onClick={() => setContextOpen((value) => !value)}
                    aria-expanded={contextOpen}
                    aria-controls={`${fieldId}-context`}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {contextOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    {contextOpen ? "Show less" : "Read the full context"}
                  </button>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                  No context was included. Ask {employeeName} for the details you need before
                  choosing.
                </p>
              )}
            </div>
            {decision.routedToEmployee && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span>Routed to {decision.routedToEmployee.name} (AI)</span>
              </div>
            )}
          </ReviewTimelineItem>

          <ReviewTimelineItem icon={ListChecks} title="What do you need to decide?" tone="accent">
            <form onSubmit={submit} aria-labelledby={`${fieldId}-title`}>
              <fieldset disabled={busy || !canAnswer} aria-describedby={`${fieldId}-choice-help`}>
                <legend className="sr-only">Choose one answer</legend>
                <p
                  id={`${fieldId}-choice-help`}
                  className="mb-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400"
                >
                  {canAnswer
                    ? "Choose one answer. Nothing is recorded until you confirm it below."
                    : `This is assigned to ${decision.assignee?.name ?? "another Member"}. You can read the choices, but only that Member or an owner or admin can answer.`}
                </p>
                {decision.options.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {decision.options.map((option, index) => {
                      const checked = !dismissing && selectedId === option.id;
                      const optionId = `${fieldId}-option-${index}`;
                      return (
                        <label
                          key={option.id}
                          htmlFor={optionId}
                          className={clsx(
                            "relative min-w-0 cursor-pointer rounded-lg border p-3 text-left transition focus-within:outline-none focus-within:ring-2 focus-within:ring-indigo-500/30",
                            busy && "cursor-wait opacity-60",
                            checked && option.tone === "danger"
                              ? "border-rose-400 bg-rose-50 dark:border-rose-500 dark:bg-rose-500/10"
                              : checked
                                ? "border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-500/10"
                                : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600 dark:hover:bg-slate-800/60",
                          )}
                        >
                          <input
                            id={optionId}
                            type="radio"
                            name={`${fieldId}-answer`}
                            value={option.id}
                            checked={checked}
                            aria-describedby={option.detail ? `${optionId}-detail` : undefined}
                            onChange={() => {
                              setSelectedId(option.id);
                              setDismissing(false);
                              setError(null);
                            }}
                            className="sr-only"
                          />
                          <span className="flex min-w-0 items-start gap-2">
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="break-words text-sm font-medium text-slate-900 dark:text-slate-100">
                                  {option.label}
                                </span>
                                {option.tone === "primary" && (
                                  <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                                    Recommended
                                  </span>
                                )}
                                {option.tone === "danger" && (
                                  <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                                    Destructive action
                                  </span>
                                )}
                              </span>
                              {option.detail && (
                                <span
                                  id={`${optionId}-detail`}
                                  className="mt-1 block break-words text-xs leading-relaxed text-slate-500 dark:text-slate-400"
                                >
                                  {option.detail}
                                </span>
                              )}
                            </span>
                            {checked && (
                              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white dark:bg-indigo-500">
                                <Check size={12} />
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    This decision has no available answers. Ask {employeeName} for a new decision or
                    dismiss this one.
                  </p>
                )}
              </fieldset>

              {canAnswer && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setGuidanceOpen((value) => !value)}
                  aria-expanded={guidanceOpen}
                  aria-controls={`${fieldId}-guidance`}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline disabled:opacity-60 dark:text-indigo-400"
                >
                  <MessageSquarePlus size={13} />
                  {guidanceOpen
                    ? "Hide guidance"
                    : note.trim()
                      ? "Edit guidance"
                      : dismissing
                        ? "Add a reason"
                        : "Add guidance"}
                </button>
              )}

              {canAnswer && guidanceOpen && (
                <div id={`${fieldId}-guidance`} className="mt-4">
                  <label
                    htmlFor={`${fieldId}-note`}
                    className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-200"
                  >
                    {dismissing ? "Reason for dismissing" : `Guidance for ${employeeName}`}{" "}
                    <span className="font-normal text-slate-500 dark:text-slate-400">
                      (optional)
                    </span>
                  </label>
                  <textarea
                    id={`${fieldId}-note`}
                    value={note}
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={
                      dismissing
                        ? "Add a reason if it will help the team understand this dismissal."
                        : "Add names, links, corrections, or instructions for this answer."
                    }
                    rows={3}
                    maxLength={4000}
                    className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              )}

              {canAnswer && dismissing && (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    Dismiss this decision?
                  </span>{" "}
                  It will leave the stack without recording an answer or starting follow-up work.
                </div>
              )}

              {canAnswer && !dismissing && selected && (
                <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Confirming records this answer for {employeeName}. Any required Approvals still
                  apply to the work that follows.
                </p>
              )}

              {canAnswer && <FormError message={error} className="mt-3" />}

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
                {canAnswer &&
                  (dismissing ? (
                    <Button
                      type="submit"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      className="w-full sm:w-auto"
                    >
                      {busy && <Spinner size={14} />}
                      Confirm dismissal
                    </Button>
                  ) : (
                    selected && (
                      <Button
                        type="submit"
                        size="sm"
                        variant={selected.tone === "danger" ? "danger" : "primary"}
                        disabled={busy}
                        className="w-full min-w-0 sm:w-auto"
                        title={`Confirm: ${selected.label}`}
                      >
                        {busy ? <Spinner size={14} /> : <ArrowRight size={14} />}
                        <span className="min-w-0 truncate">Confirm: {selected.label}</span>
                      </Button>
                    )
                  ))}
                <DecisionDiscussButton company={company} decision={decision} disabled={busy} />
                {canAnswer && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setDismissing((value) => !value);
                      setError(null);
                    }}
                    className="w-full sm:ml-auto sm:w-auto"
                  >
                    {dismissing ? "Keep decision" : "Dismiss"}
                  </Button>
                )}
              </div>
            </form>
          </ReviewTimelineItem>
        </ReviewTimeline>
      </article>
    </li>
  );
}
