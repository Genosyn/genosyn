import React from "react";
import { api, Company, Decision, Me } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { DecisionCard } from "../components/decisions/DecisionCard";
import { DecisionOutcome } from "../components/decisions/DecisionOutcome";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { clsx } from "../components/ui/clsx";

/**
 * The Decision Stack in full — every question an AI employee raised for a
 * human, what is still waiting, and what happened to the ones already answered.
 *
 * The Home page shows the top of this stack; this page is where you come to
 * work through it. The split that matters is **assigned to you** versus
 * **anyone can answer**: an employee that named a Member did so because that
 * person holds the context, and burying those in one long list is how a
 * question addressed to somebody specific sits for three days.
 *
 * History is kept on the same page rather than behind a tab because the most
 * common question about a decided row — "did it actually go out?" — is now
 * answerable here: answering starts the employee's work session, and its report
 * comes back onto the row.
 */

type Filter = "all" | "decided" | "cancelled" | "expired";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decided", label: "Answered" },
  { id: "cancelled", label: "Dismissed" },
  { id: "expired", label: "Expired" },
];

export default function Decisions({ company, me }: { company: Company; me: Me }) {
  const [rows, setRows] = React.useState<Decision[] | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<Decision[]>(`/api/companies/${company.id}/decisions`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the decisions"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    reload();
  }, [reload]);

  // Live: the pickup session writes its progress to the same rows, so a
  // decision answered on this page fills in its own outcome without a refresh.
  useLiveRefetch("decision", reload);

  const pending = rows?.filter((r) => r.status === "pending") ?? [];
  const mine = pending.filter((r) => r.assignee?.id === me.id);
  const anyone = pending.filter((r) => r.assignee?.id !== me.id);
  const history = rows?.filter((r) => r.status !== "pending") ?? [];
  const shown = history.filter((r) => filter === "all" || r.status === filter);
  const working = history.filter((r) => r.pickupStatus === "running").length;

  return (
    <div className="page-shell p-8">
      <TopBar title="Decisions" />
      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No decisions waiting"
          description="When an AI employee reaches a fork it shouldn't take alone — a reply it could send, a post it could publish — it stacks the question here with the options it will act on. Answering one starts them working again straight away."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {pending.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {pending.length === 1
                ? "One AI employee is blocked on you."
                : `${pending.length} questions are blocking your AI employees.`}{" "}
              Answering starts them working again immediately — nothing waits for their next
              routine.
            </p>
          )}

          {mine.length > 0 && (
            <Section title={`Assigned to you (${mine.length})`}>
              <Stack>
                {mine.map((d) => (
                  <DecisionCard key={d.id} company={company} decision={d} onResolved={reload} />
                ))}
              </Stack>
            </Section>
          )}

          <Section
            title={
              mine.length > 0
                ? `Anyone can answer (${anyone.length})`
                : `Waiting on you (${anyone.length})`
            }
          >
            {anyone.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {mine.length > 0
                  ? "Nothing else open to the whole company."
                  : "Nothing waiting — your AI employees are unblocked."}
              </div>
            ) : (
              <Stack>
                {anyone.map((d) => (
                  <DecisionCard key={d.id} company={company} decision={d} onResolved={reload} />
                ))}
              </Stack>
            )}
          </Section>

          {history.length > 0 && (
            <section>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Already answered
                </div>
                {working > 0 && (
                  <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                    {working} being worked on now
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilter(f.id)}
                      className={clsx(
                        "rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                        filter === f.id
                          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                          : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              {shown.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Nothing in this state yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {shown.map((d) => (
                    <DecisionOutcome key={d.id} company={company} decision={d} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </div>
      {children}
    </section>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {children}
    </ul>
  );
}
