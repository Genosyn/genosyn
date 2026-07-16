import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, ExternalLink } from "lucide-react";
import { MailHandover, mailApi } from "../lib/mail";
import { MailOutletCtx } from "./MailLayout";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Every AI handover on this mailbox — the audit trail for "who asked which
 * employee to do what with which email, and how it went."
 */

const STATUS_STYLE: Record<MailHandover["status"], string> = {
  pending: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  running: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

export default function MailHandovers() {
  const { company, account, changeTick } = useOutletContext<MailOutletCtx>();
  const { toast } = useToast();
  const [handovers, setHandovers] = React.useState<MailHandover[] | null>(null);

  const load = React.useCallback(async () => {
    const res = await mailApi.handovers(company.id, account.id);
    setHandovers(res.handovers);
  }, [company.id, account.id]);

  React.useEffect(() => {
    setHandovers(null);
    load().catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  React.useEffect(() => {
    if (changeTick === 0) return;
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick]);

  const retry = async (h: MailHandover) => {
    try {
      await mailApi.retryHandover(company.id, h.id);
      toast("Retrying", "info");
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-1 flex items-center gap-2">
        <Bot size={18} className="text-slate-400" />
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          AI handovers
        </h1>
      </div>
      <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">
        Threads handed to AI employees on {account.address}, newest first.
      </p>

      {handovers === null ? (
        <div className="flex justify-center py-10">
          <Spinner size={20} />
        </div>
      ) : handovers.length === 0 ? (
        <EmptyState
          title="No handovers yet"
          description='Open a thread and use "Hand to AI", or add a rule that hands new mail to an employee.'
        />
      ) : (
        <ul className="space-y-2">
          {handovers.map((h) => (
            <li
              key={h.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {h.threadSubject || "(no subject)"}
                </span>
                <span
                  className={clsx(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    STATUS_STYLE[h.status],
                  )}
                >
                  {h.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {h.employee?.name ?? "AI employee"} · {h.mode}
                {h.sourceKind === "rule" ? " · via rule" : ""} ·{" "}
                {new Date(h.createdAt).toLocaleString()}
              </div>
              {h.instruction && (
                <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                  {h.instruction}
                </div>
              )}
              {(h.resultSummary || h.errorMessage) && (
                <div
                  className={clsx(
                    "mt-2 whitespace-pre-wrap break-words text-xs",
                    h.status === "failed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-slate-600 dark:text-slate-400",
                  )}
                >
                  {h.errorMessage || h.resultSummary}
                </div>
              )}
              <div className="mt-2 flex items-center gap-3">
                <Link
                  to={`/c/${company.slug}/mail/t/${h.threadId}`}
                  className="flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Open thread <ExternalLink size={11} />
                </Link>
                {h.status === "failed" && (
                  <Button size="sm" variant="ghost" onClick={() => retry(h)}>
                    Retry
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
