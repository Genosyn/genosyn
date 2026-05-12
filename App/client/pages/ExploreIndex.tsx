import React from "react";
import { Link } from "react-router-dom";
import {
  BarChart3,
  Database,
  Layers,
  LayoutGrid,
  LineChart,
  Plus,
  Server,
} from "lucide-react";
import { api, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useExplore } from "./ExploreLayout";

/**
 * Explore landing page. Three columns:
 *   1. Data sources — the company's postgres / mysql / clickhouse
 *      connections that Explore can query. Empty state nudges to /settings/integrations.
 *   2. Recent charts.
 *   3. Recent dashboards.
 *
 * Clicking a data source navigates to the chart editor with that
 * connection pre-selected.
 */

type ConnectionRow = {
  id: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
};

export default function ExploreIndex({ company }: { company: Company }) {
  const { charts, dashboards } = useExplore();
  const [connections, setConnections] = React.useState<ConnectionRow[] | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const rows = await api.get<ConnectionRow[]>(
          `/api/companies/${company.id}/explore/connections`,
        );
        setConnections(rows);
      } catch {
        setConnections([]);
      }
    })();
  }, [company.id]);

  const hasConnections = (connections?.length ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            <BarChart3 size={20} className="text-indigo-500" /> Explore
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Self-serve analytics on the databases your team has connected.
            Write a query, pick a chart, save it. Pin saved charts onto
            Dashboards anyone in the company can read.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            to={hasConnections ? `/c/${company.slug}/explore/charts/new` : `/c/${company.slug}/settings/integrations`}
          >
            <Button size="sm">
              <Plus size={14} />
              {hasConnections ? "New chart" : "Connect a database"}
            </Button>
          </Link>
        </div>
      </header>

      {/* Data sources */}
      <section className="mb-10">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Data sources
        </h2>
        {connections === null ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : connections.length === 0 ? (
          <EmptyState
            title="No database connections"
            description="Explore queries Postgres, MySQL, or ClickHouse via the existing integrations. Add one to start querying."
            action={
              <Link to={`/c/${company.slug}/settings/integrations`}>
                <Button size="sm">Open integrations</Button>
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connections.map((c) => (
              <Link
                key={c.id}
                to={`/c/${company.slug}/explore/charts/new?connectionId=${c.id}`}
                className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                  <ProviderIcon provider={c.provider} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {c.label}
                    </span>
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide " +
                        (c.status === "connected"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300")
                      }
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {providerLabel(c.provider)} · {c.accountHint || "—"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent dashboards */}
      <section className="mb-10">
        <h2 className="mb-3 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <span>Recent dashboards</span>
        </h2>
        {dashboards.length === 0 ? (
          <EmptyState
            title="No dashboards yet"
            description="A dashboard is a grid of charts. Build a couple of charts first, then start one from the sidebar."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.slice(0, 6).map((d) => (
              <Link
                key={d.id}
                to={`/c/${company.slug}/explore/dashboards/${d.slug}`}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
                  <LayoutGrid size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {d.title}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {d.cardCount} {d.cardCount === 1 ? "card" : "cards"} · updated{" "}
                    {new Date(d.updatedAt).toLocaleDateString()}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent charts */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Recent charts
        </h2>
        {charts.length === 0 ? (
          <EmptyState
            title="No charts yet"
            description="A chart is a saved SQL query with a visualization. Start one from a data source above."
            action={
              hasConnections ? (
                <Link to={`/c/${company.slug}/explore/charts/new`}>
                  <Button size="sm">New chart</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {charts.slice(0, 9).map((c) => (
              <Link
                key={c.id}
                to={`/c/${company.slug}/explore/charts/${c.slug}`}
                className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                  <VizIcon type={c.vizType} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {c.title}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {c.vizType} · updated{" "}
                    {new Date(c.updatedAt).toLocaleDateString()}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  switch (provider) {
    case "postgres":
      return <Database size={16} />;
    case "mysql":
      return <Server size={16} />;
    case "clickhouse":
      return <Layers size={16} />;
    default:
      return <Database size={16} />;
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "postgres":
      return "Postgres";
    case "mysql":
      return "MySQL";
    case "clickhouse":
      return "ClickHouse";
    default:
      return provider;
  }
}

function VizIcon({ type }: { type: string }) {
  switch (type) {
    case "bar":
      return <BarChart3 size={16} />;
    case "line":
    case "area":
      return <LineChart size={16} />;
    default:
      return <BarChart3 size={16} />;
  }
}
