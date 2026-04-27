import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus, Workflow } from "lucide-react";
import { Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { PipelinesContext } from "./PipelinesLayout";

export default function PipelinesIndex({ company }: { company: Company }) {
  const { pipelines } = useOutletContext<PipelinesContext>();
  return (
    <div className="mx-auto max-w-5xl p-6">
      <Breadcrumbs items={[{ label: company.name, to: `/c/${company.slug}` }, { label: "Pipelines" }]} />
      <TopBar
        title="Pipelines"
        right={
          <Link to={`/c/${company.slug}/pipelines/new`}>
            <Button>
              <Plus size={14} /> New pipeline
            </Button>
          </Link>
        }
      />
      {pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines yet"
          description="Pipelines automate work between Genosyn primitives — channels, tasks, bases, employees — and the outside world. Build one from triggers (Webhook, Schedule, Manual) and actions (Send a message, Add task, Add record, Ask employee, …)."
          action={
            <Link to={`/c/${company.slug}/pipelines/new`}>
              <Button>
                <Plus size={14} /> Create your first pipeline
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {pipelines.map((p) => (
            <Link
              key={p.id}
              to={`/c/${company.slug}/pipelines/${p.slug}`}
              className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300 hover:shadow dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700"
            >
              <div className="flex items-center gap-2">
                <Workflow size={16} className="text-indigo-600" />
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {p.name}
                </span>
                {!p.enabled && (
                  <span className="ml-auto rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    disabled
                  </span>
                )}
              </div>
              {p.description && (
                <div className="mt-1 line-clamp-2 text-sm text-slate-500 dark:text-slate-400">
                  {p.description}
                </div>
              )}
              <div className="mt-3 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                <span>{p.graph.nodes.length} node{p.graph.nodes.length === 1 ? "" : "s"}</span>
                {p.cronExpr && <span>cron: <code className="font-mono">{p.cronExpr}</code></span>}
                {p.lastRunAt && (
                  <span>
                    last run {new Date(p.lastRunAt).toLocaleString()}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
