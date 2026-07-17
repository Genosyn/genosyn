import React from "react";
import { CircleHelp, LayoutDashboard, Plus, Search, Workflow } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { ContextualLayout } from "@/components/AppShell";
import { api, type Company, type Pipeline, type PipelineNodeCatalogEntry } from "@/lib/api";
import {
  type PipelineCatalogResponse,
  type PipelineIntegrationTool,
} from "@/pages/pipelines/pipelineResources";
import { pipelineStatus } from "@/pages/pipelines/pipelineUi";

export type PipelinesContext = {
  pipelines: Pipeline[];
  catalog: PipelineNodeCatalogEntry[];
  integrationTools: Record<string, PipelineIntegrationTool[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export default function PipelinesLayout({ company }: { company: Company }) {
  const [pipelines, setPipelines] = React.useState<Pipeline[]>([]);
  const [catalog, setCatalog] = React.useState<PipelineNodeCatalogEntry[]>([]);
  const [integrationTools, setIntegrationTools] = React.useState<
    Record<string, PipelineIntegrationTool[]>
  >({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const [rows, catalogResponse] = await Promise.all([
        api.get<Pipeline[]>(`/api/companies/${company.id}/pipelines`),
        api.get<PipelineCatalogResponse>(`/api/companies/${company.id}/pipelines/catalog`),
      ]);
      setPipelines(rows);
      setCatalog(catalogResponse.catalog);
      setIntegrationTools(catalogResponse.integrationTools ?? {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [company.id]);

  React.useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const context = React.useMemo<PipelinesContext>(
    () => ({
      pipelines,
      catalog,
      integrationTools,
      loading,
      error,
      refresh,
    }),
    [catalog, error, integrationTools, loading, pipelines, refresh],
  );

  return (
    <ContextualLayout
      sidebar={
        <PipelinesSidebar
          company={company}
          pipelines={pipelines}
          catalog={catalog}
          loading={loading}
          error={error}
          onRetry={refresh}
        />
      }
    >
      <Outlet context={context} />
    </ContextualLayout>
  );
}

function PipelinesSidebar({
  company,
  pipelines,
  catalog,
  loading,
  error,
  onRetry,
}: {
  company: Company;
  pipelines: Pipeline[];
  catalog: PipelineNodeCatalogEntry[];
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return pipelines;
    return pipelines.filter(
      (pipeline) =>
        pipeline.name.toLowerCase().includes(normalized) ||
        pipeline.description.toLowerCase().includes(normalized),
    );
  }, [pipelines, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Pipelines
            </div>
            <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
              Predictable, repeatable automation
            </div>
          </div>
          <Link
            to={`/c/${company.slug}/pipelines/new`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 text-xs font-medium text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
            title="Create a pipeline"
          >
            <Plus size={14} /> New
          </Link>
        </div>
      </div>

      <nav className="space-y-0.5 px-2 pt-2">
        <NavLink
          to={`/c/${company.slug}/pipelines`}
          end
          className={({ isActive }) => sidebarLinkClass(isActive)}
        >
          <LayoutDashboard size={15} className="shrink-0" />
          <span className="flex-1">Overview</span>
          {pipelines.length > 0 && (
            <span className="text-xs tabular-nums text-slate-400">{pipelines.length}</span>
          )}
        </NavLink>
      </nav>

      {pipelines.length > 5 && (
        <div className="px-3 pb-1 pt-3">
          <label className="relative block">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a pipeline"
              aria-label="Find a pipeline"
              className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
            />
          </label>
        </div>
      )}

      <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Your pipelines
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {loading ? (
          <div className="space-y-2 px-1 py-1" aria-label="Loading pipelines">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800"
              />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-500/10 dark:text-rose-200">
            <p>Could not load pipelines.</p>
            <button
              type="button"
              onClick={() => void onRetry()}
              className="mt-2 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-3 text-xs leading-5 text-slate-400 dark:text-slate-500">
            {query ? "No pipelines match your search." : "Create one to get started."}
          </div>
        ) : (
          filtered.map((pipeline) => {
            const status = pipelineStatus(pipeline, catalog);
            return (
              <NavLink
                key={pipeline.id}
                to={`/c/${company.slug}/pipelines/${pipeline.slug}`}
                className={({ isActive }) => sidebarLinkClass(isActive)}
              >
                <Workflow size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{pipeline.name}</span>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`}
                  title={status.label}
                  aria-label={status.label}
                />
              </NavLink>
            );
          })
        )}
      </nav>

      <div className="border-t border-slate-100 p-3 dark:border-slate-800">
        <div className="flex gap-2 rounded-lg bg-slate-50 p-2.5 text-xs leading-5 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <CircleHelp size={15} className="mt-0.5 shrink-0" />
          <span>A pipeline starts with a trigger, then follows each connected step in order.</span>
        </div>
      </div>
    </div>
  );
}

function sidebarLinkClass(isActive: boolean): string {
  return (
    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition " +
    (isActive
      ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200"
      : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
  );
}
