import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Database, Plus, Search } from "lucide-react";
import { api, Base as BaseT, Company } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { BaseIcon, baseAccent } from "../components/BaseIcons";

export type BasesContextValue = {
  bases: BaseT[];
  reload: () => Promise<void>;
};

export const BasesContext = React.createContext<BasesContextValue | null>(null);

export function useBases(): BasesContextValue {
  const ctx = React.useContext(BasesContext);
  if (!ctx) throw new Error("useBases must be used inside BasesLayout");
  return ctx;
}

export default function BasesLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [bases, setBases] = React.useState<BaseT[] | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<BaseT[]>(`/api/companies/${company.id}/bases`);
      setBases(list);
    } catch {
      setBases([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const ctx = React.useMemo(
    () => ({ bases: bases ?? [], reload }),
    [bases, reload],
  );

  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!bases) return null;
    const q = query.trim().toLowerCase();
    if (!q) return bases;
    return bases.filter((b) => b.name.toLowerCase().includes(q));
  }, [bases, query]);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Database size={14} /> Bases
        </div>
        <button
          onClick={() => navigate(`/c/${company.slug}/bases/new`)}
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          title="New base"
        >
          <Plus size={14} />
        </button>
      </div>
      {bases && bases.length > 3 && (
        <div className="relative border-b border-slate-100 px-2 py-2 dark:border-slate-800">
          <Search
            size={13}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter bases…"
            className="w-full rounded-md border border-slate-200 bg-slate-50 py-1 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200"
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered === null ? (
          <div className="flex justify-center p-4">
            <Spinner size={16} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            {query ? "No matches." : "No bases yet."}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((b) => (
              <li key={b.id}>
                <NavLink
                  to={`/c/${company.slug}/bases/${b.slug}`}
                  className={({ isActive }) =>
                    "flex items-center gap-2 rounded-md px-2 py-2 text-sm " +
                    (isActive
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
                  }
                >
                  <span
                    className={
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md " +
                      baseAccent(b.color, "tile")
                    }
                  >
                    <BaseIcon name={b.icon} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {b.name}
                    </span>
                    <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">
                      {b.tableCount ?? 0} {(b.tableCount ?? 0) === 1 ? "table" : "tables"}
                    </span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <BasesContext.Provider value={ctx}>
      <ContextualLayout sidebar={sidebar}>
        <Outlet />
      </ContextualLayout>
    </BasesContext.Provider>
  );
}
