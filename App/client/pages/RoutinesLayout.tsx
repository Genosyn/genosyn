import React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import {
  api,
  Company,
  Employee,
  RoutineFolder,
  RoutineFolderTree,
  RoutineWithMeta,
} from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useDialog } from "../components/ui/Dialog";
import { useLiveRefetch } from "../components/CompanySocket";
import { childrenByParent } from "../lib/routineFolders";

/**
 * Routines section shell — every scheduled routine in the company, in one
 * place. Routines belong to an AI employee, and until now that was the only
 * way to reach them: "what is scheduled around here?" meant opening each
 * employee in turn. The sidebar keeps the roster as a *filter* rather than a
 * hierarchy, so the whole company's schedule is the default view.
 *
 * Folders are the second filter, and the one that scales. Past a few dozen
 * routines neither "all of them" nor "one employee's" is a useful view, so the
 * sidebar carries a company-wide filing tree: a routine sits in at most one
 * folder, folders nest, and selecting one narrows the list to that folder and
 * everything beneath it. Tags (M27) remain the cross-cutting axis on top.
 *
 * The routine list is loaded once here and shared with both children, because
 * the detail page resolves its routine out of it (`:empSlug/:routineSlug` —
 * a routine slug is only unique per employee, so it takes both segments).
 */
export default function RoutinesLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [routines, setRoutines] = React.useState<RoutineWithMeta[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [tree, setTree] = React.useState<RoutineFolderTree | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [rows, roster, folderTree] = await Promise.all([
        api.get<RoutineWithMeta[]>(`/api/companies/${company.id}/routines`),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
        api.get<RoutineFolderTree>(`/api/companies/${company.id}/routine-folders`),
      ]);
      setRoutines(rows);
      setEmployees(roster);
      setTree(folderTree);
    } catch {
      setRoutines([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  useLiveRefetch(["routine", "run"], refresh);

  const ctx = React.useMemo<RoutinesContext>(
    () => ({
      routines: routines ?? [],
      employees,
      folders: tree?.folders ?? [],
      unfiledCount: tree?.unfiledCount ?? 0,
      maxFolderDepth: tree?.maxDepth ?? 5,
      loading: routines === null,
      refresh,
    }),
    [routines, employees, tree, refresh],
  );

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          routines={routines}
          employees={employees}
          folders={tree?.folders ?? []}
          unfiledCount={tree?.unfiledCount ?? 0}
          maxFolderDepth={tree?.maxDepth ?? 5}
          onNew={() => navigate(`/c/${company.slug}/routines/new`)}
          onChanged={refresh}
        />
      }
    >
      <Outlet context={ctx} />
    </ContextualLayout>
  );
}

export type RoutinesContext = {
  routines: RoutineWithMeta[];
  /** Full roster — a routine can be created for an employee that has none yet. */
  employees: Employee[];
  /** Flat folder list; each row carries its own `parentId` and `depth`. */
  folders: RoutineFolder[];
  /** Routines in no folder at all. */
  unfiledCount: number;
  /** How deep folders may nest, so the UI can hide "New subfolder" at the floor. */
  maxFolderDepth: number;
  loading: boolean;
  refresh: () => Promise<void>;
};

function Sidebar({
  company,
  routines,
  employees,
  folders,
  unfiledCount,
  maxFolderDepth,
  onNew,
  onChanged,
}: {
  company: Company;
  routines: RoutineWithMeta[] | null;
  employees: Employee[];
  folders: RoutineFolder[];
  unfiledCount: number;
  maxFolderDepth: number;
  onNew: () => void;
  onChanged: () => Promise<void>;
}) {
  const location = useLocation();
  const dialog = useDialog();
  const base = `/c/${company.slug}/routines`;
  const params = new URLSearchParams(location.search);
  const activeEmployee = params.get("employee");
  const activeFolder = params.get("folder");
  const onIndex = location.pathname === base;
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());

  const countFor = (slug: string) =>
    (routines ?? []).filter((r) => r.employee?.slug === slug).length;

  // Only employees that actually own routines earn a filter row — a roster of
  // twenty with one routine between them would bury the thing you came for.
  const withRoutines = employees.filter((e) => countFor(e.slug) > 0);

  const childrenOf = React.useMemo(() => childrenByParent(folders), [folders]);

  async function createFolder(parent: RoutineFolder | null) {
    const name = await dialog.prompt({
      title: parent ? `New folder in “${parent.name}”` : "New folder",
      message: parent
        ? "Nested folders let you split a big area into the work inside it."
        : "Folders group routines by the work they belong to.",
      placeholder: "Finance",
      confirmLabel: "Create folder",
    });
    if (!name?.trim()) return;
    try {
      await api.post(`/api/companies/${company.id}/routine-folders`, {
        name: name.trim(),
        parentId: parent?.id ?? null,
      });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t create that folder" });
    }
  }

  async function renameFolder(folder: RoutineFolder) {
    const name = await dialog.prompt({
      title: "Rename folder",
      message: "Links to this folder keep working — the name changes, the address doesn’t.",
      defaultValue: folder.name,
      confirmLabel: "Rename",
    });
    if (!name?.trim() || name.trim() === folder.name) return;
    try {
      await api.patch(`/api/companies/${company.id}/routine-folders/${folder.id}`, {
        name: name.trim(),
      });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t rename that folder" });
    }
  }

  async function moveFolderToTop(folder: RoutineFolder) {
    try {
      await api.patch(`/api/companies/${company.id}/routine-folders/${folder.id}`, {
        parentId: null,
      });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t move that folder" });
    }
  }

  async function removeFolder(folder: RoutineFolder) {
    // Say exactly where the contents land. "Delete folder?" on its own reads
    // like it takes the routines with it, which is the one thing it never does.
    const parent = folders.find((f) => f.id === folder.parentId) ?? null;
    const destination = parent ? `“${parent.name}”` : "Unfiled";
    const contents: string[] = [];
    if (folder.routineCount > 0) {
      contents.push(`${folder.routineCount} routine${folder.routineCount === 1 ? "" : "s"}`);
    }
    const subfolders = childrenOf.get(folder.id)?.length ?? 0;
    if (subfolders > 0) contents.push(`${subfolders} subfolder${subfolders === 1 ? "" : "s"}`);
    const ok = await dialog.confirm({
      title: `Delete “${folder.name}”?`,
      message: contents.length
        ? `${contents.join(" and ")} will move to ${destination}. Nothing is deleted.`
        : "The folder is empty, so nothing else changes.",
      confirmLabel: "Delete folder",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/routine-folders/${folder.id}`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete that folder" });
    }
  }

  function renderFolder(folder: RoutineFolder): React.ReactNode {
    const kids = childrenOf.get(folder.id) ?? [];
    const isCollapsed = collapsed.has(folder.id);
    const active = onIndex && activeFolder === folder.slug;
    const atDepthLimit = folder.depth >= maxFolderDepth;

    return (
      <div key={folder.id}>
        <div
          className={
            "group flex items-center gap-1 rounded-md pr-1 " +
            (active
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
          }
          // Indentation comes from depth rather than nested padding so a deep
          // folder still leaves room for its name.
          style={{ paddingLeft: `${(folder.depth - 1) * 12}px` }}
        >
          <button
            type="button"
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              })
            }
            className={
              "shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 " +
              (kids.length === 0 ? "invisible" : "")
            }
            aria-label={isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <NavLink
            to={`${base}?folder=${encodeURIComponent(folder.slug)}`}
            className="flex min-w-0 flex-1 items-center gap-2 py-2 text-sm"
            title={folder.path}
          >
            {active ? (
              <FolderOpen size={14} className="shrink-0" />
            ) : (
              <Folder size={14} className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {folder.totalRoutineCount}
            </span>
          </NavLink>
          <Menu
            align="right"
            width={210}
            trigger={({ ref, onClick }) => (
              <button
                ref={ref}
                onClick={onClick}
                className="shrink-0 rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                title={`Actions for ${folder.name}`}
                aria-label={`Actions for ${folder.name}`}
              >
                <MoreHorizontal size={13} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<FolderPlus size={14} />}
                  label={atDepthLimit ? `Nesting limit (${maxFolderDepth})` : "New subfolder"}
                  onSelect={() => {
                    close();
                    if (!atDepthLimit) void createFolder(folder);
                  }}
                  className={atDepthLimit ? "cursor-not-allowed opacity-50" : undefined}
                />
                <MenuItem
                  icon={<Pencil size={14} />}
                  label="Rename"
                  onSelect={() => {
                    close();
                    void renameFolder(folder);
                  }}
                />
                {folder.parentId && (
                  <MenuItem
                    icon={<Folder size={14} />}
                    label="Move to top level"
                    onSelect={() => {
                      close();
                      void moveFolderToTop(folder);
                    }}
                  />
                )}
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  label="Delete folder"
                  className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                  onSelect={() => {
                    close();
                    void removeFolder(folder);
                  }}
                />
              </>
            )}
          </Menu>
        </div>
        {!isCollapsed && kids.map(renderFolder)}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <CalendarClock size={14} /> Routines
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void createFolder(null)}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="New folder"
            aria-label="New folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={onNew}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="New routine"
            aria-label="New routine"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <NavLink
          to={base}
          end
          className={
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
            (onIndex && !activeEmployee && !activeFolder
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
          }
        >
          <CalendarClock size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">All routines</span>
          {routines !== null && (
            <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {routines.length}
            </span>
          )}
        </NavLink>

        <div className="flex items-center justify-between px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          <span className="flex items-center gap-2">
            <Folder size={12} /> Folders
          </span>
          <button
            onClick={() => void createFolder(null)}
            className="rounded p-0.5 hover:text-slate-700 dark:hover:text-slate-200"
            title="New folder"
            aria-label="New top-level folder"
          >
            <Plus size={12} />
          </button>
        </div>

        {folders.length === 0 ? (
          <p className="px-3 pb-1 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
            No folders yet. Group routines by the work they belong to — Finance,
            Support, Month-end.
          </p>
        ) : (
          <>
            {(childrenOf.get(null) ?? []).map(renderFolder)}
            <NavLink
              to={`${base}?folder=unfiled`}
              className={
                "mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
                (onIndex && activeFolder === "unfiled"
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
              }
            >
              <Inbox size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">Unfiled</span>
              <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {unfiledCount}
              </span>
            </NavLink>
          </>
        )}

        {withRoutines.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <Users size={12} /> Assigned to
            </div>
            {withRoutines.map((e) => {
              const active = onIndex && activeEmployee === e.slug;
              return (
                <NavLink
                  key={e.id}
                  to={`${base}?employee=${e.slug}`}
                  className={
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
                    (active
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
                  }
                >
                  <Avatar
                    name={e.name}
                    src={employeeAvatarUrl(company.id, e.id, e.avatarKey)}
                    kind="ai"
                    size="xs"
                  />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {countFor(e.slug)}
                  </span>
                </NavLink>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
