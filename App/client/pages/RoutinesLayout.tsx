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
  Radio,
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
import { ContextualLayout, sidebarLinkClassName } from "../components/AppShell";
import { ScheduleTimeZone } from "../components/ScheduleTimeZone";
import {
  RailIconButton,
  SectionRailHeader,
  SectionRailLinks,
  railHeadingClassName,
} from "../components/SectionRail";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useDialog } from "../components/ui/Dialog";
import { useLiveRefetch } from "../components/CompanySocket";
import { STANDDOWNS_CHANGED_EVENT } from "@/components/StanddownBanner";
import { newRoutinePath } from "../lib/newItemPath";
import { childrenByParent } from "../lib/routineFolders";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";

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
 * Above them, **Running** is the work rather than the list: Runs under way,
 * Runs waiting in the queue, and what ran today, for every Routine.
 *
 * The routine list is loaded once here and shared with the children, because
 * the detail page resolves its routine out of it (`:empSlug/:routineSlug` —
 * a routine slug is only unique per employee, so it takes both segments) and
 * the Running page names each Run's routine and employee from it.
 */
export default function RoutinesLayout({ company }: { company: Company }) {
  // A company switch must discard the old snapshot and editor immediately,
  // before this company's first request or a previous company's late reply.
  return <CompanyRoutinesLayout key={company.id} company={company} />;
}

type RoutineRefreshRequest = {
  promise: Promise<void>;
  queued: { promise: Promise<void>; complete: () => void } | null;
};

function CompanyRoutinesLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = React.useState<{
    routines: RoutineWithMeta[];
    employees: Employee[];
    tree: RoutineFolderTree;
  } | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const mounted = React.useRef(true);
  const inFlight = React.useRef<RoutineRefreshRequest | null>(null);

  const refresh = React.useCallback(
    function refreshRoutines(): Promise<void> {
      if (!mounted.current) return Promise.resolve();
      if (inFlight.current) {
        if (!inFlight.current.queued) {
          let complete!: () => void;
          const promise = new Promise<void>((resolve) => {
            complete = resolve;
          });
          inFlight.current.queued = { promise, complete };
        }
        // A caller refreshing after a write needs the next read, not a snapshot
        // that may have been captured before its mutation. Do not await later
        // notifications too: busy Runs must not keep this caller waiting forever.
        return inFlight.current.queued.promise;
      }
      const request: RoutineRefreshRequest = {
        queued: null,
        promise: Promise.resolve(),
      };
      inFlight.current = request;
      setRefreshing(true);
      request.promise = Promise.all([
        api.get<RoutineWithMeta[]>(`/api/companies/${company.id}/routines`),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
        api.get<RoutineFolderTree>(`/api/companies/${company.id}/routine-folders`),
      ])
        .then(([routines, employees, tree]) => {
          if (inFlight.current !== request) return;
          setSnapshot({ routines, employees, tree });
          setLoadError(null);
        })
        .catch((error: unknown) => {
          if (inFlight.current !== request) return;
          // A failed roster or folder read is not evidence that Routines were
          // deleted. Keep the exact mounted editor and last coherent sidebar.
          setLoadError(errorMessage(error, "The request failed."));
        })
        .finally(() => {
          if (inFlight.current !== request) {
            request.queued?.complete();
            return;
          }
          inFlight.current = null;
          setRefreshing(false);
          // Coalesce notifications while preserving a refresh requested after
          // a write. Publish each completed snapshot even during a busy Run.
          if (request.queued) {
            const { complete } = request.queued;
            void refreshRoutines().then(complete, complete);
          }
        });
      return request.promise;
    },
    [company.id],
  );

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      inFlight.current?.queued?.complete();
      inFlight.current = null;
    };
  }, [refresh]);

  useLiveRefetch(["routine", "run", "standdown"], refresh);

  React.useEffect(() => {
    window.addEventListener(STANDDOWNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(STANDDOWNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const ctx = React.useMemo<RoutinesContext>(
    () => ({
      routines: snapshot?.routines ?? [],
      employees: snapshot?.employees ?? [],
      folders: snapshot?.tree.folders ?? [],
      unfiledCount: snapshot?.tree.unfiledCount ?? 0,
      maxFolderDepth: snapshot?.tree.maxDepth ?? 5,
      loading: snapshot === null,
      loadError,
      refresh,
    }),
    [snapshot, loadError, refresh],
  );

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          routines={snapshot?.routines ?? null}
          employees={ctx.employees}
          folders={ctx.folders}
          unfiledCount={ctx.unfiledCount}
          maxFolderDepth={ctx.maxFolderDepth}
          onNew={(href) => navigate(href)}
          onChanged={refresh}
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {loadError && (
          <div
            role="alert"
            className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
          >
            <div className="min-w-0 flex-1">
              <p>
                {snapshot
                  ? "Could not refresh Routines. Your last loaded data and edits are still shown."
                  : "Could not load Routines."}
              </p>
              <p>{loadError}</p>
            </div>
            <Button variant="secondary" onClick={() => void refresh()} loading={refreshing}>
              {refreshing ? "Retrying…" : "Try again"}
            </Button>
          </div>
        )}
        {snapshot ? (
          // Every Routine here is scheduled in the company's time zone, so the
          // schedule picker previews and labels its times there.
          <ScheduleTimeZone timeZone={company.timezone}>
            <Outlet context={ctx} />
          </ScheduleTimeZone>
        ) : (
          !loadError && (
            <div className="p-6">
              <Spinner />
            </div>
          )
        )}
      </div>
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
  /** A failed refresh cannot establish that a missing resource was deleted. */
  loadError: string | null;
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
  /** Open the new-routine form at `href`, carrying this list's folder and employee. */
  onNew: (href: string) => void;
  onChanged: () => Promise<void>;
}) {
  const location = useLocation();
  const dialog = useDialog();
  const base = `/c/${company.slug}/routines`;
  const params = new URLSearchParams(location.search);
  const activeEmployee = params.get("employee");
  const activeFolder = params.get("folder");
  const onIndex = location.pathname === base;
  const onRunning = location.pathname === `${base}/running`;
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = React.useState<null | "header" | "section">(null);

  const countFor = (slug: string) =>
    (routines ?? []).filter((r) => r.employee?.slug === slug).length;

  // Only employees that actually own routines earn a filter row — a roster of
  // twenty with one routine between them would bury the thing you came for.
  const withRoutines = employees.filter((e) => countFor(e.slug) > 0);

  const childrenOf = React.useMemo(() => childrenByParent(folders), [folders]);

  async function createFolder(parent: RoutineFolder | null, from?: "header" | "section") {
    const name = await dialog.prompt({
      title: parent ? `New folder in “${parent.name}”` : "New folder",
      message: parent
        ? "Nested folders let you split a big area into the work inside it."
        : "Folders group routines by the work they belong to.",
      placeholder: "Finance",
      confirmLabel: "Create folder",
    });
    if (!name?.trim()) return;
    if (from) setCreatingFolder(from);
    try {
      await api.post(`/api/companies/${company.id}/routine-folders`, {
        name: name.trim(),
        parentId: parent?.id ?? null,
      });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t create that folder" });
    } finally {
      if (from) setCreatingFolder(null);
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
    // An empty folder holds nothing to lose or move, so it goes in one click;
    // one with routines or subfolders still says where they will end up.
    if (contents.length > 0) {
      const ok = await dialog.confirm({
        title: `Delete “${folder.name}”?`,
        message: `${contents.join(" and ")} will move to ${destination}. Nothing is deleted.`,
        confirmLabel: "Delete folder",
        variant: "danger",
      });
      if (!ok) return;
    }
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
      <SectionRailHeader
        section="routines"
        label="Routines"
        actions={
          <>
            <RailIconButton
              label="New folder"
              onClick={() => void createFolder(null, "header")}
              disabled={creatingFolder !== null}
              aria-busy={creatingFolder === "header" || undefined}
            >
              {creatingFolder === "header" ? <ButtonSpinner size={16} /> : <FolderPlus size={16} />}
            </RailIconButton>
            <RailIconButton
              label="New routine"
              onClick={() =>
                onNew(
                  newRoutinePath(company.slug, {
                    folder: onIndex ? activeFolder : null,
                    employee: onIndex ? activeEmployee : null,
                  }),
                )
              }
            >
              <Plus size={16} />
            </RailIconButton>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto p-2">
        {/* What runs now, what waits in the queue, and what ran today — the
            work, apart from the list of every Routine beneath it. */}
        <NavLink
          to={`${base}/running`}
          className={
            sidebarLinkClassName(onRunning)
          }
        >
          <Radio size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Running</span>
        </NavLink>
        <NavLink
          to={base}
          end
          className={
            sidebarLinkClassName(onIndex && !activeEmployee && !activeFolder)
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

        <div
          className={`flex items-center justify-between pb-0.5 pl-2.5 pr-0.5 pt-4 ${railHeadingClassName}`}
        >
          <span className="flex items-center gap-1.5">
            <Folder size={13} aria-hidden="true" /> Folders
          </span>
          <button
            onClick={() => void createFolder(null, "section")}
            disabled={creatingFolder !== null}
            aria-busy={creatingFolder === "section" || undefined}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="New folder"
            aria-label="New top-level folder"
          >
            {creatingFolder === "section" ? <ButtonSpinner size={14} /> : <Plus size={14} />}
          </button>
        </div>

        {folders.length === 0 ? (
          <p className="px-2.5 pb-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            No folders yet. Group routines by the work they belong to — Finance, Support, Month-end.
          </p>
        ) : (
          <>
            {(childrenOf.get(null) ?? []).map(renderFolder)}
            <NavLink
              to={`${base}?folder=unfiled`}
              className={`mt-0.5 ${sidebarLinkClassName(onIndex && activeFolder === "unfiled")}`}
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
            <div className={`flex items-center gap-1.5 pb-1 pl-2.5 pt-4 ${railHeadingClassName}`}>
              <Users size={13} aria-hidden="true" /> Assigned to
            </div>
            {withRoutines.map((e) => {
              const active = onIndex && activeEmployee === e.slug;
              return (
                <NavLink
                  key={e.id}
                  to={`${base}?employee=${e.slug}`}
                  className={
                    sidebarLinkClassName(active)
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
      {/* The section's fixed pages (Routines → AI access), drawn from the
          subpage catalogue the ⌘K palette searches, pinned below the filters. */}
      <nav
        aria-label="Routines settings"
        className="shrink-0 space-y-0.5 border-t border-slate-100 p-2 dark:border-slate-800"
      >
        <SectionRailLinks section="routines" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );
}
