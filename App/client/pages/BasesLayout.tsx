import React from "react";
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ChevronDown,
  Database,
  Edit3,
  Plus,
  Search,
  Table as TableIcon,
  Trash2,
} from "lucide-react";
import {
  api,
  Base as BaseT,
  BaseDetail as BaseDetailT,
  BaseTable,
  Company,
} from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { BaseIcon, baseAccent } from "../components/BaseIcons";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

export type BasesContextValue = {
  bases: BaseT[];
  reload: () => Promise<void>;
  /** Full detail (base + tables) for the base currently in the URL, or null. */
  activeDetail: BaseDetailT | null;
  /** Re-fetch the active base's detail — used after table mutations. */
  reloadActive: () => Promise<void>;
};

export const BasesContext = React.createContext<BasesContextValue | null>(null);

export function useBases(): BasesContextValue {
  const ctx = React.useContext(BasesContext);
  if (!ctx) throw new Error("useBases must be used inside BasesLayout");
  return ctx;
}

export default function BasesLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const dialog = useDialog();
  const [bases, setBases] = React.useState<BaseT[] | null>(null);
  const [activeDetail, setActiveDetail] = React.useState<BaseDetailT | null>(
    null,
  );

  // Parse the active base + table slugs off the URL. `useParams()` won't work
  // from the layout level because this component renders *outside* the child
  // <Route path=":baseSlug">, so we match the pathname by hand.
  const { activeBaseSlug, activeTableSlug } = React.useMemo(() => {
    const prefix = `/c/${company.slug}/bases/`;
    if (!location.pathname.startsWith(prefix)) {
      return { activeBaseSlug: null, activeTableSlug: null };
    }
    const rest = location.pathname.slice(prefix.length).split("/").filter(Boolean);
    if (rest.length === 0 || rest[0] === "new") {
      return { activeBaseSlug: null, activeTableSlug: null };
    }
    return {
      activeBaseSlug: rest[0] ?? null,
      activeTableSlug: rest[1] ?? null,
    };
  }, [company.slug, location.pathname]);

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<BaseT[]>(`/api/companies/${company.id}/bases`);
      setBases(list);
    } catch {
      setBases([]);
    }
  }, [company.id]);

  const reloadActive = React.useCallback(async () => {
    if (!activeBaseSlug) {
      setActiveDetail(null);
      return;
    }
    try {
      const d = await api.get<BaseDetailT>(
        `/api/companies/${company.id}/bases/${activeBaseSlug}`,
      );
      setActiveDetail(d);
    } catch {
      setActiveDetail(null);
    }
  }, [activeBaseSlug, company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  React.useEffect(() => {
    reloadActive();
  }, [reloadActive]);

  const ctx = React.useMemo<BasesContextValue>(
    () => ({
      bases: bases ?? [],
      reload,
      activeDetail,
      reloadActive,
    }),
    [bases, reload, activeDetail, reloadActive],
  );

  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!bases) return null;
    const q = query.trim().toLowerCase();
    if (!q) return bases;
    return bases.filter((b) => b.name.toLowerCase().includes(q));
  }, [bases, query]);

  async function addTable(base: BaseT, currentTables: BaseTable[]) {
    const name = await dialog.prompt({
      title: "New table",
      placeholder: "Table name",
      defaultValue: `Table ${currentTables.length + 1}`,
      confirmLabel: "Create",
    });
    if (!name) return;
    try {
      const t = await api.post<BaseTable>(
        `/api/companies/${company.id}/bases/${base.slug}/tables`,
        { name },
      );
      await reloadActive();
      await reload();
      navigate(`/c/${company.slug}/bases/${base.slug}/${t.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function renameTable(base: BaseT, t: BaseTable) {
    const name = await dialog.prompt({
      title: "Rename table",
      defaultValue: t.name,
      confirmLabel: "Rename",
    });
    if (!name || name === t.name) return;
    try {
      await api.patch(
        `/api/companies/${company.id}/bases/${base.slug}/tables/${t.id}`,
        { name },
      );
      await reloadActive();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteTable(
    base: BaseT,
    t: BaseTable,
    currentTables: BaseTable[],
  ) {
    const ok = await dialog.confirm({
      title: `Delete "${t.name}"?`,
      message: "This table and all its rows will be removed.",
      confirmLabel: "Delete table",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(
        `/api/companies/${company.id}/bases/${base.slug}/tables/${t.id}`,
      );
      await reloadActive();
      await reload();
      const remaining = currentTables.filter((x) => x.id !== t.id);
      if (remaining[0]) {
        navigate(`/c/${company.slug}/bases/${base.slug}/${remaining[0].slug}`, {
          replace: true,
        });
      } else {
        navigate(`/c/${company.slug}/bases/${base.slug}`, { replace: true });
      }
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

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
            {filtered.map((b) => {
              const isActive = b.slug === activeBaseSlug;
              const tables =
                isActive && activeDetail?.base.id === b.id
                  ? activeDetail.tables
                  : null;
              return (
                <li key={b.id}>
                  <NavLink
                    to={`/c/${company.slug}/bases/${b.slug}`}
                    className={({ isActive: linkActive }) =>
                      "flex items-center gap-2 rounded-md px-2 py-2 text-sm " +
                      (linkActive
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
                    }
                    end
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
                        {b.tableCount ?? 0}{" "}
                        {(b.tableCount ?? 0) === 1 ? "table" : "tables"}
                      </span>
                    </span>
                  </NavLink>

                  {isActive && (
                    <div className="ml-3 mt-0.5 border-l border-slate-200 pl-2 dark:border-slate-700">
                      {tables === null ? (
                        <div className="flex py-2 pl-2">
                          <Spinner size={12} />
                        </div>
                      ) : tables.length === 0 ? (
                        <div className="px-2 py-1 text-[11px] text-slate-400 dark:text-slate-500">
                          No tables yet
                        </div>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {tables.map((t) => (
                            <TableRow
                              key={t.id}
                              base={b}
                              table={t}
                              active={activeTableSlug === t.slug}
                              canDelete={tables.length > 1}
                              onClick={() =>
                                navigate(
                                  `/c/${company.slug}/bases/${b.slug}/${t.slug}`,
                                )
                              }
                              onRename={() => renameTable(b, t)}
                              onDelete={() => deleteTable(b, t, tables)}
                            />
                          ))}
                        </ul>
                      )}
                      <button
                        onClick={() =>
                          addTable(b, tables ?? [])
                        }
                        className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                      >
                        <Plus size={11} /> Add table
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
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

function TableRow({
  base,
  table,
  active,
  canDelete,
  onClick,
  onRename,
  onDelete,
}: {
  base: BaseT;
  table: BaseTable;
  active: boolean;
  canDelete: boolean;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  void base;
  return (
    <li className="group relative">
      <button
        onClick={onClick}
        className={clsx(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px]",
          active
            ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800",
        )}
      >
        <TableIcon
          size={11}
          className={clsx(
            "shrink-0",
            active
              ? "text-indigo-500 dark:text-indigo-400"
              : "text-slate-400 dark:text-slate-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{table.name}</span>
      </button>
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <Menu
          width={160}
          trigger={({ ref, onClick: toggle, open }) => (
            <button
              ref={ref}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              className={clsx(
                "rounded p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700",
                open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              aria-label="Table actions"
            >
              <ChevronDown size={11} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Edit3 size={12} />}
                label="Rename"
                onSelect={() => {
                  onRename();
                  close();
                }}
              />
              {canDelete && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 size={12} className="text-red-500" />}
                    label={<span className="text-red-600">Delete</span>}
                    onSelect={() => {
                      onDelete();
                      close();
                    }}
                  />
                </>
              )}
            </>
          )}
        </Menu>
      </div>
    </li>
  );
}
