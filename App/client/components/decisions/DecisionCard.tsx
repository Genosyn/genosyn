import React from "react";
import { ChevronDown, ChevronUp, GitBranch, X } from "lucide-react";
import { api, Company, Decision, DecisionOption, DecisionUrgency } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { Avatar, employeeAvatarUrl } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { ChatMarkdown } from "../ChatMarkdown";
import { FormError } from "../ui/FormError";
import { Spinner } from "../ui/Spinner";
import { clsx } from "../ui/clsx";
import { DecisionSourceLine } from "./DecisionSource";
import { formatRelative } from "./relative";

/**
 * One row of the Decision Stack: the question an AI employee asked, where it
 * asked it from, its context, and a button per option.
 *
 * Shared by Home (where the stack is the first thing on the page) and the
 * Decisions page, because the interaction is identical in both and a second
 * copy would be the one that forgets to disable its buttons mid-flight.
 *
 * The context body is collapsed by default. An employee is told to paste the
 * whole draft in there, so an expanded stack of five would push everything else
 * off the screen — but the draft is also exactly what you need to decide, so it
 * is one click away and never a navigation. It renders as markdown: the model
 * writes headings, quoted drafts and links, and showing the raw `**` and `>`
 * markers made a drafted email read like a diff of one.
 */

const URGENCY_BADGE: Record<DecisionUrgency, { label: string; cls: string } | null> = {
  high: {
    label: "Urgent",
    cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  },
  normal: null,
  low: {
    label: "Whenever",
    cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
};

function optionVariant(option: DecisionOption): "primary" | "secondary" | "danger" {
  if (option.tone === "primary") return "primary";
  if (option.tone === "danger") return "danger";
  return "secondary";
}

export function DecisionCard({
  company,
  decision,
  onResolved,
}: {
  company: Company;
  decision: Decision;
  /** Called after the row leaves `pending`, so the owner can refetch. */
  onResolved: () => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const base = `/api/companies/${company.id}/decisions/${decision.id}`;
  const badge = URGENCY_BADGE[decision.urgency];
  // Worth surfacing up front rather than in a tooltip: a one-liner explaining
  // what an option actually costs is the reason the employee wrote it.
  const hasDetails = decision.options.some((o) => o.detail);

  async function choose(option: DecisionOption) {
    setBusy(option.id);
    setError(null);
    try {
      await api.post(`${base}/decide`, {
        optionId: option.id,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      // Say nothing on the way out: `onResolved()` refetches and the row
      // leaves the stack, which is the answer landing. Never promise the work
      // started either — the session is kicked off after this responds, and on
      // an install with no AI Model connected it never starts at all.
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy("__dismiss");
    setError(null);
    try {
      await api.post(`${base}/dismiss`, note.trim() ? { reason: note.trim() } : {});
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {decision.employee ? (
          <Avatar
            name={decision.employee.name}
            kind="ai"
            size="sm"
            src={employeeAvatarUrl(company.id, decision.employee.id, decision.employee.avatarKey)}
          />
        ) : (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
            <GitBranch size={12} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {decision.title}
            </span>
            {badge && (
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  badge.cls,
                )}
              >
                {badge.label}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {decision.employee?.name ?? "(deleted employee)"} · asked{" "}
            {formatRelative(decision.createdAt)}
            {decision.assignee ? ` · for ${decision.assignee.name}` : ""}
            {decision.expiresAt ? ` · moot ${formatRelative(decision.expiresAt)}` : ""}
          </div>
          <DecisionSourceLine company={company} decision={decision} className="mt-1" />

          {/* The toggle renders even with no context body, because it is also
              what reveals the note field — a question with nothing to read is
              still one you might want to answer in your own words. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {open ? "Hide details" : decision.body ? "Show context" : "Add a note"}
          </button>
          {open && decision.body && (
            <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
              <ChatMarkdown content={decision.body} />
            </div>
          )}

          {open && (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note for them (optional)"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          )}

          <FormError message={error} className="mt-2" />

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {decision.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={optionVariant(option)}
                disabled={busy !== null}
                title={option.detail ?? undefined}
                onClick={() => choose(option)}
              >
                {busy === option.id ? <Spinner size={12} /> : null}
                {option.label}
              </Button>
            ))}
            <button
              type="button"
              onClick={dismiss}
              disabled={busy !== null}
              title="Dismiss without choosing"
              aria-label={`Dismiss ${decision.title}`}
              className="ml-auto rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              {busy === "__dismiss" ? <Spinner size={13} /> : <X size={15} />}
            </button>
          </div>

          {hasDetails && (
            <dl className="mt-2 space-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {decision.options
                .filter((o) => o.detail)
                .map((option) => (
                  <div key={option.id} className="flex gap-1.5">
                    <dt className="shrink-0 font-medium text-slate-600 dark:text-slate-300">
                      {option.label}
                    </dt>
                    <dd className="min-w-0">— {option.detail}</dd>
                  </div>
                ))}
            </dl>
          )}
        </div>
      </div>
    </li>
  );
}
