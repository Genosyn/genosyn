import React from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { Plus, Workflow } from "lucide-react";
import { ContextualLayout } from "../components/AppShell";
import { api, Company, Pipeline } from "../lib/api";

/**
 * Pipelines section shell. Sidebar lists all pipelines for the company; the
 * outlet renders either the index (empty state + "New" CTA), the new-pipeline
 * form, or a single pipeline's editor.
 */
export default function PipelinesLayout({ company }: { company: Company }) {
  const [pipelines, setPipelines] = React.useState<Pipeline[]>([]);
  const [loading, setLoading] = React.useState(true);
  const params = useParams();

  const refresh = React.useCallback(async () => {
    try {
      const rows = await api.get<Pipeline[]>(
        `/api/companies/${company.id}/pipelines`,
      );
      setPipelines(rows);
    } finally {
      setLoading(false);
    }
  }, [company.id]);

  React.useEffect(() => {
    refresh();
  }, [refresh, params.pSlug]);

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          pipelines={pipelines}
          loading={loading}
        />
      }
    >
      <Outlet context={{ pipelines, refresh } satisfies PipelinesContext} />
    </ContextualLayout>
  );
}

export type PipelinesContext = {
  pipelines: Pipeline[];
  refresh: () => Promise<void>;
};

function Sidebar({
  company,
  pipelines,
  loading,
}: {
  company: Company;
  pipelines: Pipeline[];
  loading: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Pipelines
        </div>
        <Link
          to={`/c/${company.slug}/pipelines/new`}
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          title="New pipeline"
          aria-label="New pipeline"
        >
          <Plus size={16} />
        </Link>
      </div>
      <nav className="mt-2 flex-1 space-y-0.5 px-2 pb-4">
        {loading ? (
          <div className="px-3 py-2 text-xs text-slate-400">Loading…</div>
        ) : pipelines.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
            No pipelines yet.
          </div>
        ) : (
          pipelines.map((p) => (
            <NavLink
              key={p.id}
              to={`/c/${company.slug}/pipelines/${p.slug}`}
              className={({ isActive }) =>
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
                (isActive
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
              }
            >
              <Workflow size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {!p.enabled && (
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                  off
                </span>
              )}
            </NavLink>
          ))
        )}
      </nav>
    </div>
  );
}
