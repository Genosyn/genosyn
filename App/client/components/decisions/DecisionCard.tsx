import React from "react";
import { ArrowRight, ChevronDown, ChevronUp, GitBranch } from "lucide-react";
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

/** Shared review form: reading or selecting an option never submits a decision. */
export function DecisionCard({
  company,
  decision,
  onResolved,
}: {
  company: Company;
  decision: Decision;
  onResolved: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const submitting = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [contextOpen, setContextOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dismissing, setDismissing] = React.useState(false);
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
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <li id={`decision-${decision.id}`} className="scroll-mt-4 px-4 py-5 sm:px-5">
      <div className="mb-3 flex items-center gap-2">
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
      </div>

      <h3
        id={`${fieldId}-title`}
        className="break-words text-base font-semibold leading-snug text-slate-900 dark:text-slate-100"
      >
        {decision.title}
      </h3>
      <DecisionSourceLine company={company} decision={decision} className="mt-2" />
      {decision.expiresAt && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Expires {formatRelative(decision.expiresAt)}
        </p>
      )}
      {decision.routedToEmployee && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Routed to {decision.routedToEmployee.name} (AI)
        </p>
      )}

      <div className="mt-4 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
        <div className="mb-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
          Context from {employeeName}
        </div>
        {decision.body ? (
          <>
            <div
              id={`${fieldId}-context`}
              className={clsx(
                "break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300",
                contextOpen ? "max-h-96 overflow-auto" : "max-h-32 overflow-hidden",
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
              {contextOpen ? "Show less context" : "Read full context"}
            </button>
          </>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No context was included. Use Discuss to ask for the details you need before choosing.
          </p>
        )}
      </div>

      <form onSubmit={submit} aria-labelledby={`${fieldId}-title`} className="mt-4">
        <fieldset disabled={busy}>
          <legend className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
            Choose what should happen next
          </legend>
          <div className="space-y-2">
            {decision.options.map((option, index) => {
              const checked = !dismissing && selectedId === option.id;
              const optionId = `${fieldId}-option-${index}`;
              return (
                <label
                  key={option.id}
                  className={clsx(
                    "flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-indigo-500/30",
                    busy && "cursor-wait opacity-60",
                    checked
                      ? "border-indigo-400 bg-indigo-50/70 dark:border-indigo-500 dark:bg-indigo-500/10"
                      : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600",
                  )}
                >
                  <input
                    type="radio"
                    name={`${fieldId}-choice`}
                    value={option.id}
                    checked={checked}
                    onChange={() => {
                      setSelectedId(option.id);
                      setDismissing(false);
                      setError(null);
                    }}
                    aria-labelledby={`${optionId}-label`}
                    aria-describedby={option.detail ? `${optionId}-detail` : undefined}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        id={`${optionId}-label`}
                        className="break-words text-sm font-medium text-slate-900 dark:text-slate-100"
                      >
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
                </label>
              );
            })}
          </div>
        </fieldset>

        <label
          htmlFor={`${fieldId}-note`}
          className="mb-1.5 mt-4 block text-xs font-medium text-slate-700 dark:text-slate-200"
        >
          Details for {employeeName} <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <textarea
          id={`${fieldId}-note`}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add names, links, corrections, or instructions needed for your choice."
          rows={2}
          maxLength={4000}
          className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />

        <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
          {dismissing ? (
            <>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                Dismiss this decision?
              </span>{" "}
              It will leave the stack without sending a choice or starting follow-up work.
            </>
          ) : selected ? (
            <>
              Sending your decision gives {employeeName} your choice and details for follow-up. Any
              required Approvals still apply.
            </>
          ) : (
            <>
              Select an option, add any details it needs, then send your decision. Selecting an
              option alone does nothing.
            </>
          )}
        </div>
        <FormError message={error} className="mt-3" />

        <div className="mt-3 flex flex-wrap items-start gap-2">
          <Button
            type="submit"
            size="sm"
            variant={dismissing ? "secondary" : selected?.tone === "danger" ? "danger" : "primary"}
            disabled={busy || (!dismissing && !selected)}
          >
            {busy ? <Spinner size={14} /> : !dismissing && <ArrowRight size={14} />}
            {dismissing ? "Confirm dismissal" : "Send decision"}
          </Button>
          <DecisionDiscussButton company={company} decision={decision} disabled={busy} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDismissing((value) => !value);
              setError(null);
            }}
            className="sm:ml-auto"
          >
            {dismissing ? "Keep decision" : "Dismiss…"}
          </Button>
        </div>
      </form>
    </li>
  );
}
