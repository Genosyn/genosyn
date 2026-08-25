import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  Bot,
  Check,
  FileText,
  MailX,
  Receipt,
  RefreshCw,
  Reply,
  Sparkles,
  Star,
  Tag,
} from "lucide-react";

import { MailAnalysis, MailAnalysisAction, mailApi } from "../lib/mail";
import {
  CATEGORY_TONE_CLASSES,
  analysisActionConfirm,
  analysisActionDetail,
  analysisActionHint,
  analysisCategoryLabel,
  analysisCategoryTone,
} from "../lib/mailAnalysis";
import { clsx } from "../components/ui/clsx";
import { useDialog } from "../components/ui/Dialog";
import { Spinner } from "../components/ui/Spinner";

/**
 * What the AI made of this email, and the buttons it earned.
 *
 * The card sits above the conversation because triage is the first thing a
 * Member does with a new email and the last thing they should have to hunt
 * for. It is deliberately quiet when there is nothing to say: an email that
 * needs no action shows its summary and no button row at all.
 *
 * Every button runs server-side with the Member's own authority. The label is
 * the employee's words; the line under it is what the server verified, so the
 * thing being approved is the checked one.
 */

const ACTION_ICONS: Record<MailAnalysisAction["kind"], React.ReactNode> = {
  draft_reply: <Reply size={13} />,
  create_invoice: <Receipt size={13} />,
  create_estimate: <FileText size={13} />,
  unsubscribe: <MailX size={13} />,
  thread_action: <Tag size={13} />,
  hand_over: <Bot size={13} />,
};

function iconFor(action: MailAnalysisAction): React.ReactNode {
  if (action.kind === "thread_action") {
    if (action.action === "archive") return <Archive size={13} />;
    if (action.action === "star") return <Star size={13} />;
  }
  return ACTION_ICONS[action.kind] ?? <Sparkles size={13} />;
}

export function MailAnalysisCard({
  analysis,
  companyId,
  companySlug,
  onChanged,
}: {
  analysis: MailAnalysis;
  companyId: string;
  companySlug: string;
  /** Reload the thread — a draft reply and a triage action both change it. */
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const [row, setRow] = React.useState(analysis);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);

  React.useEffect(() => setRow(analysis), [analysis]);

  const run = async (action: MailAnalysisAction) => {
    if (busyId || retrying || action.executedAt) return;
    const confirmation = analysisActionConfirm(action);
    if (confirmation) {
      const ok = await dialog.confirm({
        title: confirmation.title,
        // A handover's instruction is a paragraph, so newlines have to survive.
        message: <span className="block whitespace-pre-wrap">{confirmation.message}</span>,
        confirmLabel: confirmation.confirmLabel,
      });
      if (!ok) return;
    }
    setBusyId(action.id);
    try {
      const result = await mailApi.runAnalysisAction(companyId, row.id, action.id);
      // The button going struck-through is the confirmation; a navigation or
      // a new draft on the thread is the rest of it.
      setRow(result.analysis);
      onChanged();
      if (result.navigateTo) navigate(`/c/${companySlug}${result.navigateTo}`);
    } catch (err) {
      void dialog.error(err, { title: `Couldn\u2019t run \u201C${action.label}\u201D` });
    } finally {
      setBusyId(null);
    }
  };

  const retry = async () => {
    if (retrying || busyId) return;
    setRetrying(true);
    try {
      const result = await mailApi.analyzeMessage(companyId, row.messageId);
      // A second failure shows in the card itself, where the first one is.
      setRow(result.analysis);
    } catch (err) {
      void dialog.error(err, { title: "Couldn\u2019t read this email again" });
    } finally {
      setRetrying(false);
    }
  };

  if (row.status === "running") {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
        <Spinner size={13} />
        Reading this email…
      </div>
    );
  }

  if (row.status === "failed") {
    return (
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-slate-300 dark:text-slate-600" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {row.errorMessage || "This email couldn’t be analysed."}
          </p>
        </div>
        <button
          onClick={() => void retry()}
          disabled={retrying}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 dark:text-indigo-400"
        >
          {retrying ? <Spinner size={12} /> : <RefreshCw size={12} />} Try again
        </button>
      </div>
    );
  }

  const tone = CATEGORY_TONE_CLASSES[analysisCategoryTone(row.category)];

  return (
    <div className="mb-3 rounded-xl border border-violet-200 bg-violet-50/50 p-4 shadow-sm dark:border-violet-500/25 dark:bg-violet-500/5">
      <div className="flex items-start gap-2.5">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {row.category && (
              <span
                className={clsx(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  tone,
                )}
              >
                {analysisCategoryLabel(row.category)}
              </span>
            )}
            <span className="text-[11px] font-medium uppercase tracking-wide text-violet-500/80 dark:text-violet-300/70">
              AI summary
            </span>
            <button
              onClick={() => void retry()}
              disabled={retrying || busyId !== null}
              title="Read this email again"
              className="ml-auto rounded p-1 text-violet-400 hover:bg-violet-100 hover:text-violet-600 disabled:opacity-50 dark:hover:bg-violet-500/15 dark:hover:text-violet-200"
            >
              {retrying ? <Spinner size={12} /> : <RefreshCw size={12} />}
            </button>
          </div>
          <p className="text-sm text-slate-700 dark:text-slate-200">{row.summary}</p>

          {row.actions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {row.actions.map((action) => {
                const spent = Boolean(action.executedAt);
                const detail = analysisActionDetail(action);
                return (
                  <button
                    key={action.id}
                    disabled={spent || busyId !== null || retrying}
                    onClick={() => void run(action)}
                    title={spent ? "Already done" : analysisActionHint(action)}
                    className={clsx(
                      "inline-flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
                      spent
                        ? "cursor-default border-slate-200 text-slate-400 line-through dark:border-slate-800 dark:text-slate-600"
                        : "border-violet-200 bg-white text-violet-700 hover:bg-violet-100 disabled:opacity-60 dark:border-violet-500/30 dark:bg-slate-950 dark:text-violet-200 dark:hover:bg-violet-500/15",
                    )}
                  >
                    <span className="mt-0.5 shrink-0">
                      {busyId === action.id ? (
                        <Spinner size={13} />
                      ) : spent ? (
                        <Check size={13} />
                      ) : (
                        iconFor(action)
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block">{action.label}</span>
                      {detail && !spent && (
                        <span className="block max-w-[240px] truncate text-[10px] font-normal text-violet-500/80 dark:text-violet-300/70">
                          {detail}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
