import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  Pause,
  Play,
  X,
} from "lucide-react";
import { api, Company, RoutineFolder, RoutineWithMeta, Run } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useDialog } from "../components/ui/Dialog";
import {
  RunLiveModal,
  RunOutcomeChip,
  RunStatusChip,
  overdueFor,
  timeAgo,
  timeUntil,
} from "../components/routines/RunViews";
import { cronHuman } from "../lib/cron";
import { RoutinesContext } from "./RoutinesLayout";
import { folderAndDescendants } from "../lib/routineFolders";
import { TagChips, TagFilterBar } from "../components/TagPicker";

/**
 * Every routine in the company. Filterable by the employee it's assigned to
 * (`?employee=<slug>`), by the folder it's filed in (`?folder=<slug>`, or
 * `?folder=unfiled` for the ones in no folder), and by health.
 *
 * Also the landing spot for the `?routine=<id>&run=<id>` deep links the Home
 * "Failed routines" panel and the Journal emit — those know a routine id but
 * not its slug, so this resolves the id against the loaded list and forwards
 * to the detail page.
 */

type Health = "all" | "active" | "paused" | "attention";

/**
 * The `?folder=` value for "in no folder at all". Never a real folder slug —
 * the server reserves it when minting them (`RESERVED_FOLDER_SLUGS`).
 */
const UNFILED = "unfiled";

/** Matches the `routineIds` cap on `POST /routines/move`. */
const MOVE_BATCH_LIMIT = 200;

/**
 * Anything an operator would want to notice: a run that didn't finish
 * cleanly, an enabled routine whose schedule will never fire, or one whose
 * next run came due a while ago and still hasn't happened.
 *
 * "Never fires" happens when a cron expression passes `node-cron`'s validation
 * on save but `cron-parser` can't compute a next occurrence from it, leaving
 * `nextRunAt` null — the routine looks fine and silently never runs. Overdue
 * usually means the server was down, or the scheduler isn't running.
 */
function needsAttention(r: RoutineWithMeta): boolean {
  const status = r.lastRun?.status;
  if (status === "failed" || status === "timeout" || status === "interrupted") return true;
  if (!r.enabled) return false;
  if (r.nextRunAt === null) return true;
  return overdueFor(r.nextRunAt) !== null;
}

export default function RoutinesIndex({ company }: { company: Company }) {
  const { routines, folders, loading, refresh } = useOutletContext<RoutinesContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [health, setHealth] = React.useState<Health>("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [selecting, setSelecting] = React.useState(false);
  const [activeRun, setActiveRun] = React.useState<{
    routine: RoutineWithMeta;
    run: Run;
  } | null>(null);
  const dialog = useDialog();
  const navigate = useNavigate();
  const handledDeepLinkRef = React.useRef(false);

  const employeeSlug = searchParams.get("employee");
  const folderSlug = searchParams.get("folder");
  const selectedTagId = searchParams.get("tag");
  const employee = routines.find((r) => r.employee?.slug === employeeSlug)?.employee ?? null;
  const folder = folders.find((f) => f.slug === folderSlug) ?? null;
  const unfiledView = folderSlug === UNFILED;
  // A bookmark to a folder somebody has since deleted. Without this the filter
  // silently falls through and shows the whole company, which reads as "this
  // folder contains everything" rather than "this folder is gone".
  const missingFolder = !!folderSlug && !unfiledView && !folder && !loading;

  // Deep link from Home / Journal: `?routine=<id>&run=<id>`. Resolve the id to
  // a slug pair and hand off to the detail page. Handled once, then stripped so
  // navigating back here doesn't bounce again.
  React.useEffect(() => {
    if (handledDeepLinkRef.current || loading) return;
    const routineId = searchParams.get("routine");
    if (!routineId) return;
    handledDeepLinkRef.current = true;
    const runId = searchParams.get("run");
    const target = routines.find((r) => r.id === routineId);
    if (!target || !target.employee) {
      void dialog.error("That routine no longer exists.", {
        title: "Couldn’t open that routine",
      });
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("routine");
          next.delete("run");
          return next;
        },
        { replace: true },
      );
      return;
    }
    const qs = runId ? `?run=${encodeURIComponent(runId)}` : "";
    navigate(
      `/c/${company.slug}/routines/${target.employee.slug}/${target.slug}${qs}`,
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, routines]);

  // Leaving a folder (or the list reloading without it) should not keep a
  // stale selection alive behind the new filter.
  React.useEffect(() => {
    setSelected(new Set());
  }, [folderSlug, employeeSlug]);

  async function triggerRun(r: RoutineWithMeta) {
    try {
      const run = await api.post<Run>(`/api/companies/${company.id}/routines/${r.id}/run`);
      setActiveRun({ routine: r, run });
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the run" });
    }
  }

  /**
   * File routines into a folder (or out of every folder with `null`).
   *
   * Sent in chunks because the endpoint caps one request at
   * {@link MOVE_BATCH_LIMIT} ids — "Select all" on a company with hundreds of
   * routines would otherwise come back as a bare "ValidationError". Each chunk
   * is still all-or-nothing server-side, which is the guarantee that matters:
   * no request half-applies.
   */
  async function moveRoutines(routineIds: string[], folderId: string | null) {
    if (routineIds.length === 0) return;
    try {
      for (let i = 0; i < routineIds.length; i += MOVE_BATCH_LIMIT) {
        await api.post(`/api/companies/${company.id}/routines/move`, {
          routineIds: routineIds.slice(i, i + MOVE_BATCH_LIMIT),
          folderId,
        });
      }
      setSelected(new Set());
      await refresh();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t move those routines" });
    }
  }

  /** Create a folder from the move menu, so filing never dead-ends on "none exist". */
  async function moveToNewFolder(routineIds: string[]) {
    const name = await dialog.prompt({
      title: routineIds.length === 1 ? "Move to a new folder" : `Move ${routineIds.length} routines`,
      message: "Name the folder to create and file them into.",
      placeholder: "Finance",
      confirmLabel: "Create and move",
    });
    if (!name?.trim()) return;
    try {
      const created = await api.post<RoutineFolder>(
        `/api/companies/${company.id}/routine-folders`,
        { name: name.trim(), parentId: null },
      );
      await moveRoutines(routineIds, created.id);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t create that folder" });
    }
  }

  // A folder shows what is filed in it *and* in everything nested beneath it —
  // otherwise a parent reads as empty the moment you nest anything in it.
  const folderScope = React.useMemo(
    () => (folder ? folderAndDescendants(folders, folder.id) : null),
    [folder, folders],
  );

  const scoped = routines.filter((r) => {
    if (employeeSlug && r.employee?.slug !== employeeSlug) return false;
    if (unfiledView) return r.folderId === null;
    if (folderScope) return r.folderId !== null && folderScope.has(r.folderId);
    return true;
  });

  const availableTags = React.useMemo(() => {
    const byId = new Map(
      routines.flatMap((routine) => routine.tags ?? []).map((tag) => [tag.id, tag]),
    );
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [routines]);

  const counts = {
    all: scoped.length,
    active: scoped.filter((r) => r.enabled).length,
    paused: scoped.filter((r) => !r.enabled).length,
    attention: scoped.filter(needsAttention).length,
  };

  const shown = scoped.filter((r) => {
    if (selectedTagId && !(r.tags ?? []).some((tag) => tag.id === selectedTagId)) return false;
    if (health === "active") return r.enabled;
    if (health === "paused") return !r.enabled;
    if (health === "attention") return needsAttention(r);
    return true;
  });

  const shownIds = shown.map((r) => r.id);
  const selectedIds = shownIds.filter((id) => selected.has(id));
  const allShownSelected = shownIds.length > 0 && selectedIds.length === shownIds.length;

  // Creating from inside a folder should land there, not in the unfiled pile.
  const newRoutineHref = `/c/${company.slug}/routines/new${
    folder ? `?folder=${encodeURIComponent(folder.slug)}` : ""
  }`;

  const title = folder
    ? folder.name
    : unfiledView
      ? "Unfiled routines"
      : employee
        ? `${employee.name}'s routines`
        : "Routines";

  return (
    <div className="page-shell p-6">
      <Breadcrumbs
        items={[
          { label: "Routines", to: `/c/${company.slug}/routines` },
          ...(folder
            ? folder.path
                .split("/")
                .map((segment) => ({ label: segment }))
            : unfiledView
              ? [{ label: "Unfiled" }]
              : []),
          ...(employee ? [{ label: employee.name }] : []),
        ]}
      />
      <TopBar
        title={title}
        right={
          <div className="flex items-center gap-2">
            {routines.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => {
                  setSelecting((v) => !v);
                  setSelected(new Set());
                }}
              >
                {selecting ? (
                  <>
                    <X size={14} /> Done
                  </>
                ) : (
                  <>
                    <FolderInput size={14} /> Organize
                  </>
                )}
              </Button>
            )}
            <Button onClick={() => navigate(newRoutineHref)}>New routine</Button>
          </div>
        }
      />

      {folder && (
        <p className="-mt-2 mb-4 text-sm text-slate-500 dark:text-slate-400">
          {folder.routineCount === folder.totalRoutineCount
            ? `${folder.totalRoutineCount} routine${folder.totalRoutineCount === 1 ? "" : "s"} in this folder.`
            : `${folder.totalRoutineCount} routines here and in nested folders (${folder.routineCount} filed directly).`}
        </p>
      )}

      {loading ? (
        <Spinner />
      ) : missingFolder ? (
        <EmptyState
          title="That folder no longer exists"
          description="It may have been deleted or renamed away. Its routines were never deleted — they moved up to the parent folder, or to Unfiled."
          action={
            <Button variant="secondary" onClick={() => navigate(`/c/${company.slug}/routines`)}>
              All routines
            </Button>
          }
        />
      ) : routines.length === 0 ? (
        <EmptyState
          title="No routines yet"
          description="A routine is recurring work an AI employee performs on a schedule — a morning digest, a weekly report, an hourly inbox sweep."
          action={<Button onClick={() => navigate(newRoutineHref)}>New routine</Button>}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["paused", "Paused"],
                ["attention", "Needs attention"],
              ] as Array<[Health, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setHealth(key)}
                className={
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition " +
                  (health === key
                    ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")
                }
              >
                {key === "attention" && counts.attention > 0 && (
                  <AlertTriangle size={12} className="text-amber-500" />
                )}
                {label}
                <span className="tabular-nums text-slate-400 dark:text-slate-500">
                  {counts[key]}
                </span>
              </button>
            ))}
          </div>

          <TagFilterBar
            tags={availableTags}
            selectedId={selectedTagId}
            onSelect={(tagId) =>
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                if (tagId) next.set("tag", tagId);
                else next.delete("tag");
                return next;
              })
            }
          />

          {selecting && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-2.5 text-sm dark:border-indigo-500/30 dark:bg-indigo-500/10">
              <button
                type="button"
                onClick={() =>
                  setSelected(allShownSelected ? new Set() : new Set(shownIds))
                }
                className="font-medium text-indigo-700 hover:underline dark:text-indigo-300"
              >
                {allShownSelected ? "Clear selection" : `Select all ${shownIds.length}`}
              </button>
              <span className="text-slate-500 dark:text-slate-400">
                {selectedIds.length} selected
              </span>
              <div className="ml-auto">
                <FolderMenu
                  folders={folders}
                  disabled={selectedIds.length === 0}
                  // A batch has no single current folder, so nothing is ticked
                  // and every destination — Unfiled included — stays pickable.
                  currentFolderId={undefined}
                  label="Move to folder"
                  onPick={(folderId) => void moveRoutines(selectedIds, folderId)}
                  onNewFolder={() => void moveToNewFolder(selectedIds)}
                />
              </div>
            </div>
          )}

          {shown.length === 0 ? (
            <EmptyState
              title={folder || unfiledView ? "Nothing filed here" : "Nothing here"}
              description={
                folder
                  ? "Move routines into this folder from the Organize button, or from a routine’s Settings tab."
                  : unfiledView
                    ? "Every routine is filed in a folder."
                    : "No routines match this filter."
              }
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
              {/* Column headers are desktop-only; each row restates its own
                  labels once the grid collapses. */}
              <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 md:grid dark:border-slate-800 dark:text-slate-500">
                <div>Routine</div>
                <div>Assigned to</div>
                <div>Schedule</div>
                <div>Last run</div>
                <div className="w-16" />
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((r) => (
                  <RoutineRow
                    key={r.id}
                    company={company}
                    routine={r}
                    folders={folders}
                    // Only name the folder when the list isn't already one —
                    // repeating "Finance" on every row inside Finance is noise.
                    showFolder={!folder && !unfiledView}
                    selecting={selecting}
                    selected={selected.has(r.id)}
                    onToggleSelected={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                    onMove={(folderId) => void moveRoutines([r.id], folderId)}
                    onNewFolder={() => void moveToNewFolder([r.id])}
                    onRun={() => triggerRun(r)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {activeRun && (
        <RunLiveModal
          key={activeRun.run.id}
          company={company}
          routine={activeRun.routine}
          run={activeRun.run}
          onRetry={() => triggerRun(activeRun.routine)}
          onClose={() => {
            setActiveRun(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Folder picker as a popover. Used both for the bulk bar and for a single row,
 * so the two stay one list with one set of affordances — including "New
 * folder", which is what keeps filing from dead-ending before any exist.
 */
function FolderMenu({
  folders,
  currentFolderId,
  label,
  disabled,
  onPick,
  onNewFolder,
}: {
  folders: RoutineFolder[];
  /** The folder this row is in, or `undefined` for a batch with no one answer. */
  currentFolderId: string | null | undefined;
  label: React.ReactNode;
  disabled?: boolean;
  onPick: (folderId: string | null) => void;
  onNewFolder: () => void;
}) {
  return (
    <Menu
      align="right"
      width={260}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          type="button"
          disabled={disabled}
          onClick={onClick}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <FolderInput size={13} /> {label}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>Move to</MenuHeader>
          {folders.map((f) => (
            <MenuItem
              key={f.id}
              icon={
                f.id === currentFolderId ? <Check size={13} /> : <Folder size={13} />
              }
              active={f.id === currentFolderId}
              label={
                <span style={{ paddingLeft: `${(f.depth - 1) * 10}px` }} title={f.path}>
                  {f.name}
                </span>
              }
              onSelect={() => {
                close();
                if (f.id !== currentFolderId) onPick(f.id);
              }}
            />
          ))}
          {folders.length > 0 && (
            <MenuItem
              icon={currentFolderId === null ? <Check size={13} /> : <Inbox size={13} />}
              active={currentFolderId === null}
              label="Unfiled"
              onSelect={() => {
                close();
                if (currentFolderId !== null) onPick(null);
              }}
            />
          )}
          {folders.length > 0 && <MenuSeparator />}
          <MenuItem
            icon={<FolderPlus size={13} />}
            label="New folder…"
            onSelect={() => {
              close();
              onNewFolder();
            }}
          />
        </>
      )}
    </Menu>
  );
}

function RoutineRow({
  company,
  routine: r,
  folders,
  showFolder,
  selecting,
  selected,
  onToggleSelected,
  onMove,
  onNewFolder,
  onRun,
}: {
  company: Company;
  routine: RoutineWithMeta;
  folders: RoutineFolder[];
  showFolder: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onMove: (folderId: string | null) => void;
  onNewFolder: () => void;
  onRun: () => void;
}) {
  const to = r.employee
    ? `/c/${company.slug}/routines/${r.employee.slug}/${r.slug}`
    : null;
  const brokenSchedule = r.enabled && r.nextRunAt === null;
  const folder = r.folderId ? (folders.find((f) => f.id === r.folderId) ?? null) : null;

  return (
    <li className="grid grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-center md:gap-4 dark:hover:bg-slate-900">
      <div className="flex min-w-0 items-start gap-2">
        {selecting && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800"
            aria-label={`Select ${r.name}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {to ? (
              <Link
                to={to}
                className="truncate font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
              >
                {r.name}
              </Link>
            ) : (
              <span className="truncate font-medium text-slate-900 dark:text-slate-100">
                {r.name}
              </span>
            )}
            {!r.enabled && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <Pause size={9} /> paused
              </span>
            )}
            {r.requiresApproval && (
              <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                approval
              </span>
            )}
          </div>
          {showFolder && folder && (
            <Link
              to={`/c/${company.slug}/routines?folder=${encodeURIComponent(folder.slug)}`}
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-slate-400 hover:text-indigo-600 dark:text-slate-500 dark:hover:text-indigo-400"
              title={folder.path}
            >
              <Folder size={10} className="shrink-0" />
              <span className="truncate">{folder.path}</span>
            </Link>
          )}
          {(r.tags ?? []).length > 0 && (
            <div className="mt-1">
              <TagChips tags={r.tags} limit={3} />
            </div>
          )}
          <div className="mt-0.5 truncate text-xs text-slate-400 md:hidden dark:text-slate-500">
            {cronHuman(r.cronExpr)}
          </div>
        </div>
      </div>

      <div className="min-w-0">
        {r.employee ? (
          <Link
            to={`/c/${company.slug}/employees/${r.employee.slug}`}
            className="flex min-w-0 items-center gap-2 text-sm text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
          >
            <Avatar
              name={r.employee.name}
              src={employeeAvatarUrl(company.id, r.employee.id, r.employee.avatarKey)}
              kind="ai"
              size="xs"
            />
            <span className="truncate">{r.employee.name}</span>
          </Link>
        ) : (
          <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
        )}
      </div>

      <div className="hidden min-w-0 md:block">
        <div className="truncate text-sm text-slate-600 dark:text-slate-300" title={r.cronExpr}>
          {cronHuman(r.cronExpr)}
        </div>
        <div className="truncate text-xs text-slate-400 dark:text-slate-500">
          {brokenSchedule ? (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={10} /> never fires
            </span>
          ) : !r.enabled ? (
            "paused"
          ) : r.nextRunAt && overdueFor(r.nextRunAt) ? (
            <span
              className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"
              title={new Date(r.nextRunAt).toLocaleString()}
            >
              <AlertTriangle size={10} /> overdue by {overdueFor(r.nextRunAt)}
            </span>
          ) : r.nextRunAt ? (
            <span title={new Date(r.nextRunAt).toLocaleString()}>
              next {timeUntil(r.nextRunAt)}
            </span>
          ) : (
            "—"
          )}
        </div>
      </div>

      <div className="min-w-0">
        {r.lastRun ? (
          <div className="flex items-center gap-2">
            <RunStatusChip status={r.lastRun.status} size="xs" />
            {r.lastRun.outcomeVerdict && (
              <RunOutcomeChip verdict={r.lastRun.outcomeVerdict} size="xs" />
            )}
            <span
              className="truncate text-xs text-slate-400 dark:text-slate-500"
              title={new Date(r.lastRun.startedAt).toLocaleString()}
            >
              {timeAgo(r.lastRun.startedAt)}
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">Never run</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 justify-self-start md:justify-self-end">
        {selecting ? (
          <FolderMenu
            folders={folders}
            currentFolderId={r.folderId}
            label="File"
            onPick={onMove}
            onNewFolder={onNewFolder}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={onRun} title="Run now">
            <Play size={14} /> Run
          </Button>
        )}
        {to && (
          <Link
            to={to}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Open routine"
            aria-label={`Open ${r.name}`}
          >
            <CalendarClock size={14} />
          </Link>
        )}
      </div>
    </li>
  );
}
