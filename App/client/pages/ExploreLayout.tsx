import React from "react";
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  BarChart3,
  LayoutGrid,
  LineChart as LineIcon,
  Plus,
  Search,
} from "lucide-react";
import { api, Company } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";

/**
 * Explore section sidebar. Two lists: Charts and Dashboards. Mirrors the
 * Bases sidebar shape (search-filter when there are more than a handful,
 * inline create button) so users move between the two without re-learning.
 */

export type ChartListItem = {
  id: string;
  slug: string;
  title: string;
  vizType: string;
  updatedAt: string;
};

export type DashboardListItem = {
  id: string;
  slug: string;
  title: string;
  cardCount: number;
  updatedAt: string;
};

export type ExploreContextValue = {
  charts: ChartListItem[];
  dashboards: DashboardListItem[];
  reload: () => Promise<void>;
};

export const ExploreContext = React.createContext<ExploreContextValue | null>(null);

export function useExplore(): ExploreContextValue {
  const ctx = React.useContext(ExploreContext);
  if (!ctx) throw new Error("useExplore must be used inside ExploreLayout");
  return ctx;
}

export default function ExploreLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const dialog = useDialog();
  const [charts, setCharts] = React.useState<ChartListItem[] | null>(null);
  const [dashboards, setDashboards] = React.useState<DashboardListItem[] | null>(null);
  const [query, setQuery] = React.useState("");

  const reload = React.useCallback(async () => {
    try {
      const [c, d] = await Promise.all([
        api.get<ChartListItem[]>(`/api/companies/${company.id}/explore/charts`),
        api.get<DashboardListItem[]>(`/api/companies/${company.id}/explore/dashboards`),
      ]);
      setCharts(c);
      setDashboards(d);
    } catch {
      setCharts([]);
      setDashboards([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function newDashboard() {
    const title = await dialog.prompt({
      title: "New dashboard",
      placeholder: "Dashboard title",
      confirmLabel: "Create",
    });
    if (!title) return;
    try {
      const d = await api.post<{ slug: string }>(
        `/api/companies/${company.id}/explore/dashboards`,
        { title },
      );
      await reload();
      navigate(`/c/${company.slug}/explore/dashboards/${d.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const ctx = React.useMemo<ExploreContextValue>(
    () => ({
      charts: charts ?? [],
      dashboards: dashboards ?? [],
      reload,
    }),
    [charts, dashboards, reload],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { charts: charts ?? [], dashboards: dashboards ?? [] };
    return {
      charts: (charts ?? []).filter((c) => c.title.toLowerCase().includes(q)),
      dashboards: (dashboards ?? []).filter((d) =>
        d.title.toLowerCase().includes(q),
      ),
    };
  }, [charts, dashboards, query]);

  const totalCount = (charts?.length ?? 0) + (dashboards?.length ?? 0);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <NavLink
          to={`/c/${company.slug}/explore`}
          end
          className={({ isActive }) =>
            "flex items-center gap-2 text-xs font-semibold uppercase tracking-wider " +
            (isActive
              ? "text-indigo-600 dark:text-indigo-400"
              : "text-slate-500 dark:text-slate-400")
          }
        >
          <BarChart3 size={14} /> Explore
        </NavLink>
      </div>

      {totalCount > 4 && (
        <div className="relative border-b border-slate-100 px-2 py-2 dark:border-slate-800">
          <Search
            size={13}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded-md border border-slate-200 bg-slate-50 py-1 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        <SidebarSection
          label="Charts"
          icon={<LineIcon size={12} />}
          onNew={() => navigate(`/c/${company.slug}/explore/charts/new`)}
          newTitle="New chart"
        >
          {charts === null ? (
            <div className="flex justify-center p-2"><Spinner size={14} /></div>
          ) : filtered.charts.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-slate-400 dark:text-slate-500">
              {query ? "No matches." : "No charts yet."}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.charts.map((c) => (
                <li key={c.id}>
                  <NavLink
                    to={`/c/${company.slug}/explore/charts/${c.slug}`}
                    className={({ isActive }) =>
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm " +
                      (isActive
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
                    }
                  >
                    <VizGlyph type={c.vizType} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>

        <SidebarSection
          label="Dashboards"
          icon={<LayoutGrid size={12} />}
          onNew={newDashboard}
          newTitle="New dashboard"
        >
          {dashboards === null ? (
            <div className="flex justify-center p-2"><Spinner size={14} /></div>
          ) : filtered.dashboards.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-slate-400 dark:text-slate-500">
              {query ? "No matches." : "No dashboards yet."}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.dashboards.map((d) => (
                <li key={d.id}>
                  <NavLink
                    to={`/c/${company.slug}/explore/dashboards/${d.slug}`}
                    className={({ isActive }) =>
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm " +
                      (isActive
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
                    }
                  >
                    <LayoutGrid
                      size={12}
                      className="shrink-0 text-slate-400 dark:text-slate-500"
                    />
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    <span className="ml-1 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {d.cardCount}
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>
      </div>
    </div>
  );

  // Suppress unused-import warning while we're inside the layout — `location`
  // exists for future "auto-select first chart on visit" wiring.
  void location;

  return (
    <ExploreContext.Provider value={ctx}>
      <ContextualLayout sidebar={sidebar}>
        <Outlet />
      </ContextualLayout>
    </ExploreContext.Provider>
  );
}

function SidebarSection({
  label,
  icon,
  onNew,
  newTitle,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  onNew: () => void;
  newTitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          {icon}
          {label}
        </span>
        <button
          onClick={onNew}
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title={newTitle}
          aria-label={newTitle}
        >
          <Plus size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

function VizGlyph({ type }: { type: string }) {
  switch (type) {
    case "bar":
      return <BarChart3 size={12} className="shrink-0 text-indigo-400" />;
    case "line":
    case "area":
      return <LineIcon size={12} className="shrink-0 text-indigo-400" />;
    case "pie":
      return (
        <div className="h-3 w-3 shrink-0 rounded-full border-[3px] border-indigo-400 border-r-transparent" />
      );
    case "scalar":
      return (
        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center text-[10px] font-semibold text-indigo-400">
          #
        </span>
      );
    default:
      return (
        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center text-[10px] font-semibold text-indigo-400">
          ≡
        </span>
      );
  }
}
