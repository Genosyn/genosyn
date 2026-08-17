import React from "react";
import { Check, CircleSlash, Clock, GitBranch } from "lucide-react";
import { api, Company, Decision, DecisionStatus } from "../lib/api";
import { DecisionCard, formatRelative } from "../components/DecisionCard";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { clsx } from "../components/ui/clsx";

/**
 * The Decision Stack in full — every question an AI employee raised for a
 * human, pending first, then what was already decided.
 *
 * The Home page shows the top of this stack; this page is where you come to
 * work through it, and to check what was decided last week and why.
 */

const RESOLVED_STYLE: Record<Exclude<DecisionStatus, "pending">, { label: string; cls: string }> = {
  decided: {
    label: "decided",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  },
  cancelled: {
    label: "dismissed",
    cls: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  },
  expired: {
    label: "expired",
    cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  },
};

export default function Decisions({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<Decision[] | null>(null);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<Decision[]>(`/api/companies/${company.id}/decisions`));
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
    }
    // `toast` is stable for the life of the provider; including it would churn
    // the callback and re-subscribe the socket on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  React.useEffect(() => {
    setRows(null);
    reload();
  }, [reload]);

  useLiveRefetch("decision", reload);

  const pending = rows?.filter((r) => r.status === "pending") ?? [];
  const history = rows?.filter((r) => r.status !== "pending") ?? [];

  return (
    <div className="page-shell p-8">
      <TopBar title="Decisions" />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No decisions waiting"
          description="When an AI employee reaches a fork it shouldn't take alone — a reply it could send, a post it could publish — it stacks the question here with the options it will act on."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Waiting on you ({pending.length})
            </div>
            {pending.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Nothing waiting — your AI employees are unblocked.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {pending.map((d) => (
                  <DecisionCard key={d.id} company={company} decision={d} onResolved={reload} />
                ))}
              </ul>
            )}
          </section>

          {history.length > 0 && (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Decided
              </div>
              <ul className="flex flex-col gap-1">
                {history.map((d) => {
                  const style = RESOLVED_STYLE[d.status as Exclude<DecisionStatus, "pending">];
                  const Icon =
                    d.status === "decided" ? Check : d.status === "expired" ? Clock : CircleSlash;
                  return (
                    <li key={d.id}>
                      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
                        <span
                          className={clsx(
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                            style.cls,
                          )}
                        >
                          {style.label}
                        </span>
                        <GitBranch size={12} className="text-violet-500" />
                        <span className="truncate text-slate-700 dark:text-slate-200">
                          {d.title}
                        </span>
                        {d.chosenOptionLabel && (
                          <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                            <Icon size={11} /> {d.chosenOptionLabel}
                          </span>
                        )}
                        <span className="text-slate-400 dark:text-slate-500">·</span>
                        <span className="truncate text-slate-500 dark:text-slate-400">
                          {d.employee?.name ?? "(deleted employee)"}
                        </span>
                        {d.note && (
                          <span className="truncate text-slate-500 dark:text-slate-400">
                            · &ldquo;{d.note}&rdquo;
                          </span>
                        )}
                        <span className="ml-auto text-slate-400 dark:text-slate-500">
                          {formatRelative(d.decidedAt ?? d.createdAt)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
