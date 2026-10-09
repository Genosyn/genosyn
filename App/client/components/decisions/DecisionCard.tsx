import React from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Clock3,
  GitBranch,
  Lightbulb,
  MessageSquarePlus,
} from "lucide-react";
import { decisionHeadline } from "../../../shared/decisionSummary";
import { api, Company, Decision, DecisionUrgency } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Menu, MenuHeader, MenuItem } from "@/components/ui/Menu";
import { clsx } from "@/components/ui/clsx";
import { DecisionDetails } from "@/components/decisions/DecisionDetails";
import { DecisionDiscussButton } from "@/components/decisions/DecisionDiscussButton";
import { DecisionDiscussion } from "@/components/decisions/DecisionDiscussion";
import { DetailsButton, focusAfterRemoval } from "@/components/decisions/StackRow";
import { useDecisionDiscussionOpen } from "@/components/decisions/useDecisionDiscussion";
import { ReviewTimeline } from "@/components/decisions/ReviewTimeline";
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

type SnoozeDuration = "one_hour" | "one_day" | "two_days" | "one_week" | "one_month";

const SNOOZE_OPTIONS: { duration: SnoozeDuration; label: string }[] = [
  { duration: "one_hour", label: "1 hour" },
  { duration: "one_day", label: "1 day" },
  { duration: "two_days", label: "2 days" },
  { duration: "one_week", label: "1 week" },
  { duration: "one_month", label: "1 month" },
];

export type DecisionAction = "answer" | "dismiss" | "snooze";

/** The look of one answer, by its tone and whether it is picked. */
function optionClass(tone: Decision["options"][number]["tone"], checked: boolean): string {
  if (checked && tone === "danger")
    return "border-rose-500 bg-rose-50 text-rose-800 ring-1 ring-rose-500 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200";
  if (checked)
    return "border-indigo-500 bg-indigo-50 text-indigo-800 ring-1 ring-indigo-500 dark:border-indigo-400 dark:bg-indigo-500/10 dark:text-indigo-100";
  if (tone === "danger")
    return "border-slate-200 bg-white text-rose-700 hover:border-rose-300 hover:bg-rose-50/50 dark:border-slate-700 dark:bg-slate-900 dark:text-rose-300 dark:hover:border-rose-500/40";
  if (tone === "primary")
    return "border-indigo-200 bg-white text-slate-900 hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-indigo-500/40 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-indigo-500/10";
  return "border-slate-200 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600 dark:hover:bg-slate-800/60";
}

/**
 * A waiting question as one short row: who asks, the question, one plain line
 * about it, what the employee recommends, and the answers. Everything else —
 * the full reason, the context, what each choice means, where it came from —
 * is behind Details.
 *
 * Answering is still two deliberate steps: pick an answer, then confirm it
 * (with guidance, if you have any). Dismiss and Snooze take the question off
 * the stack in the same click.
 */
export function DecisionCard({
  company,
  decision,
  onResolved,
  onActionStart,
  onActionSettled,
  canAnswer = true,
}: {
  company: Company;
  decision: Decision;
  onResolved: (announcement?: string) => Promise<void> | void;
  onActionStart?: (action: DecisionAction) => void;
  /** Called with the server's row; `leave` puts focus where the row was once it is gone. */
  onActionSettled?: (decision: Decision, action: DecisionAction, leave: () => void) => void;
  canAnswer?: boolean;
}) {
  const [pendingAction, setPendingAction] = React.useState<DecisionAction | null>(null);
  const submitting = React.useRef(false);
  const rowRef = React.useRef<HTMLLIElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [guidanceOpen, setGuidanceOpen] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const base = `/api/companies/${company.id}/decisions/${decision.id}`;
  const fieldId = React.useId();
  const badge = URGENCY_BADGE[decision.urgency];
  const selected = decision.options.find((option) => option.id === selectedId);
  const employeeName = decision.employee?.name ?? "The AI Employee";
  const busy = pendingAction !== null;
  const headline = React.useMemo(() => decisionHeadline(decision), [decision]);
  const [discussing, setDiscussing] = useDecisionDiscussionOpen(decision.id);
  // Focus the message box only when the Member opens it here, not when the
  // step reappears on its own.
  const [focusDiscussion, setFocusDiscussion] = React.useState(false);
  const discussionId = `${fieldId}-discussion`;
  const detailsId = `${fieldId}-details`;

  async function perform(
    action: DecisionAction,
    request: () => Promise<Decision>,
    announcement: string,
  ) {
    if (!canAnswer || submitting.current) return;
    submitting.current = true;
    setPendingAction(action);
    setError(null);
    try {
      onActionStart?.(action);
      const result = await request();
      onActionSettled?.(result, action, focusAfterRemoval(rowRef.current));
      // The refreshed row records pickup status; submitting cannot promise that
      // the employee has started or that any proposed action has succeeded.
      await onResolved(announcement);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setPendingAction(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    await perform(
      "answer",
      () =>
        api.post<Decision>(`${base}/decide`, {
          optionId: selected.id,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      `Decision “${decision.title}” answered.`,
    );
  }

  async function dismiss() {
    await perform(
      "dismiss",
      () => api.post<Decision>(`${base}/dismiss`, {}),
      `Decision “${decision.title}” dismissed. It is in Decision history.`,
    );
  }

  async function snooze(duration: SnoozeDuration, label: string) {
    await perform(
      "snooze",
      () => api.post<Decision>(`${base}/snooze`, { duration }),
      `Decision “${decision.title}” snoozed for ${label}.`,
    );
  }

  return (
    <li
      ref={rowRef}
      id={`decision-${decision.id}`}
      data-stack-row
      className="scroll-mt-4 px-4 py-4 sm:px-5"
    >
      <article aria-labelledby={`${fieldId}-title`} className="min-w-0">
        <header className="flex min-w-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {decision.employee ? (
            <Avatar
              name={decision.employee.name}
              kind="ai"
              size="xs"
              src={employeeAvatarUrl(company.id, decision.employee.id, decision.employee.avatarKey)}
            />
          ) : (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <GitBranch size={11} />
            </span>
          )}
          <p className="min-w-0 flex-1 truncate">
            <span className="font-medium text-slate-700 dark:text-slate-200">{employeeName}</span>
            <span> · asked {formatRelative(decision.createdAt)}</span>
            {decision.assignee && <span> · for {decision.assignee.name}</span>}
            {decision.routedToEmployee && (
              <span> · routed to {decision.routedToEmployee.name} (AI)</span>
            )}
          </p>
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
          {headline.question}
        </h3>
        {headline.summary && (
          <p
            data-decision-summary
            className="mt-1 line-clamp-2 break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300"
          >
            {headline.summary}
          </p>
        )}
        {headline.recommendation && (
          <p
            data-decision-recommendation
            className="mt-1.5 flex min-w-0 items-start gap-1.5 text-sm leading-snug text-slate-700 dark:text-slate-200"
          >
            <Lightbulb
              size={14}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400"
            />
            <span className="min-w-0 break-words">
              <span className="font-medium">Recommends:</span> {headline.recommendation}
            </span>
          </p>
        )}

        {detailsOpen && <DecisionDetails id={detailsId} company={company} decision={decision} />}

        <form onSubmit={submit} aria-labelledby={`${fieldId}-title`} className="mt-3">
          {!canAnswer && (
            <p
              id={`${fieldId}-choice-help`}
              className="mb-2 text-xs text-slate-500 dark:text-slate-400"
            >
              Assigned to {decision.assignee?.name ?? "another Member"}. Only they or an owner or
              admin can answer.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {decision.options.length > 0 ? (
              <div
                role="radiogroup"
                aria-label="Choose one answer"
                aria-describedby={canAnswer ? undefined : `${fieldId}-choice-help`}
                className="flex min-w-0 flex-wrap gap-2"
              >
                {decision.options.map((option, index) => {
                  const checked = selectedId === option.id;
                  const optionId = `${fieldId}-option-${index}`;
                  const disabled = busy || !canAnswer;
                  return (
                    <label
                      key={option.id}
                      htmlFor={optionId}
                      className={clsx(
                        "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition focus-within:ring-2 focus-within:ring-indigo-500/30",
                        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                        optionClass(option.tone, checked),
                      )}
                    >
                      <input
                        id={optionId}
                        type="radio"
                        name={`${fieldId}-answer`}
                        value={option.id}
                        checked={checked}
                        disabled={disabled}
                        aria-describedby={option.detail ? `${optionId}-detail` : undefined}
                        onChange={() => {
                          setSelectedId(option.id);
                          setError(null);
                        }}
                        className="sr-only"
                      />
                      {option.tone === "danger" && (
                        <AlertTriangle size={13} aria-hidden="true" className="shrink-0" />
                      )}
                      {option.tone === "primary" && (
                        <Lightbulb
                          size={13}
                          aria-hidden="true"
                          className="shrink-0 text-indigo-500 dark:text-indigo-400"
                        />
                      )}
                      <span className="min-w-0 break-words">{option.label}</span>
                      {option.tone === "primary" && <span className="sr-only"> (recommended)</span>}
                      {option.tone === "danger" && <span className="sr-only"> (destructive)</span>}
                      {option.detail && (
                        <span id={`${optionId}-detail`} className="sr-only">
                          {option.detail}
                        </span>
                      )}
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
            <div className="flex items-center gap-1 sm:ml-auto">
              <DecisionDiscussButton
                decision={decision}
                open={discussing}
                controls={discussionId}
                disabled={busy}
                onToggle={() => {
                  setFocusDiscussion(!discussing);
                  setDiscussing(!discussing);
                }}
              />
              {canAnswer && (
                <Menu
                  align="right"
                  width={200}
                  trigger={({ ref, onClick, open }) => (
                    <Button
                      ref={ref}
                      type="button"
                      size="sm"
                      variant="ghost"
                      loading={pendingAction === "snooze"}
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        onClick();
                      }}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      className="px-2.5"
                    >
                      <Clock3 size={14} />
                      Snooze
                      <ChevronDown
                        size={13}
                        className={clsx("transition-transform", open && "rotate-180")}
                      />
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuHeader>Snooze for</MenuHeader>
                      {SNOOZE_OPTIONS.map((option) => (
                        <MenuItem
                          key={option.duration}
                          label={option.label}
                          onSelect={() => {
                            close();
                            void snooze(option.duration, option.label);
                          }}
                        />
                      ))}
                    </>
                  )}
                </Menu>
              )}
              {canAnswer && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={pendingAction === "dismiss"}
                  disabled={busy}
                  onClick={() => void dismiss()}
                  title="Take this off the stack without answering. It stays in Decision history."
                  className="px-2.5"
                >
                  Dismiss
                </Button>
              )}
            </div>
          </div>

          {canAnswer && selected && (
            <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 dark:border-indigo-500/20 dark:bg-indigo-500/[0.06]">
              {selected.detail && (
                <p className="break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                  {selected.detail}
                </p>
              )}
              {guidanceOpen && (
                <div id={`${fieldId}-guidance`} className={clsx(selected.detail && "mt-3")}>
                  <label
                    htmlFor={`${fieldId}-note`}
                    className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-200"
                  >
                    Guidance for {employeeName}{" "}
                    <span className="font-normal text-slate-500 dark:text-slate-400">
                      (optional)
                    </span>
                  </label>
                  <textarea
                    id={`${fieldId}-note`}
                    value={note}
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Add names, links, corrections, or instructions for this answer."
                    rows={3}
                    maxLength={4000}
                    className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              )}
              <div
                className={clsx(
                  "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center",
                  (selected.detail || guidanceOpen) && "mt-3",
                )}
              >
                <Button
                  type="submit"
                  size="sm"
                  variant={selected.tone === "danger" ? "danger" : "primary"}
                  loading={pendingAction === "answer"}
                  disabled={busy}
                  className="w-full min-w-0 sm:w-auto"
                  title={`Confirm: ${selected.label}`}
                >
                  <ArrowRight size={14} />
                  <span className="min-w-0 truncate">Confirm: {selected.label}</span>
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setGuidanceOpen((value) => !value)}
                  aria-expanded={guidanceOpen}
                  aria-controls={`${fieldId}-guidance`}
                  className="inline-flex items-center justify-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline disabled:opacity-60 dark:text-indigo-400"
                >
                  <MessageSquarePlus size={13} />
                  {guidanceOpen ? "Hide guidance" : note.trim() ? "Edit guidance" : "Add guidance"}
                </button>
              </div>
            </div>
          )}

          <FormError message={error} className="mt-3" />
        </form>

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
      </article>
    </li>
  );
}
