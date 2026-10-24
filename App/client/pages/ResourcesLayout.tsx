import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Library,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ContextualLayout } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import {
  RailIconButton,
  SectionRailHeader,
  SectionRailLinks,
  railHeadingClassName,
} from "../components/SectionRail";
import { useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { ButtonSpinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { api, type Company, type ResourceFolder, type ResourceFolderTree } from "../lib/api";
import {
  deleteFolderMessage,
  RESOURCE_DRAG_TYPE,
  readResourceDrag,
  resourceFolderHref,
  UNFILED_FOLDER_PARAM,
} from "../lib/resourceFolders";
import { childrenByParent } from "../lib/routineFolders";

export type ResourcesOutletCtx = {
  company: Company;
  /** The library's folder tree, flat; each row carries its parent and depth. */
  folders: ResourceFolder[];
  /** Resources filed in no folder. */
  unfiledCount: number;
  /** How deep folders may nest, so "New subfolder" can say when it is out of room. */
  maxFolderDepth: number;
  /** Null until the first read of the tree lands. */
  foldersLoaded: boolean;
  refreshFolders: () => Promise<void>;
  /** Ask for a folder name and make it — top-level when `parent` is null. */
  createFolder: (parent: ResourceFolder | null) => Promise<void>;
  /** File one Resource in a folder (null unfiles it), reporting a failure itself. */
  moveResource: (slug: string, folderId: string | null) => Promise<boolean>;
};

/**
 * Sidebar + layout for `/c/:slug/resources/*`: the library as files and
 * folders. The rail holds the folder tree — All resources, the nested folders
 * with their counts, and Unfiled — and a Resource dragged onto any of them is
 * filed there. Below it sit the section's fixed pages from the subpage
 * catalogue (`lib/subpages.ts`), the ⌘K palette's source too.
 */
export default function ResourcesLayout({ company }: { company: Company }) {
  // A company switch discards the old tree before the new one loads.
  return <CompanyResourcesLayout key={company.id} company={company} />;
}

function CompanyResourcesLayout({ company }: { company: Company }) {
  const dialog = useDialog();
  const [tree, setTree] = React.useState<ResourceFolderTree | null>(null);

  const refreshFolders = React.useCallback(async () => {
    try {
      setTree(await api.get<ResourceFolderTree>(`/api/companies/${company.id}/resource-folders`));
    } catch {
      // The library still works unfiled; the next change or visit retries.
      setTree((current) => current ?? { folders: [], unfiledCount: 0, maxDepth: 5 });
    }
  }, [company.id]);

  React.useEffect(() => {
    void refreshFolders();
  }, [refreshFolders]);
  useLiveRefetch("resource", refreshFolders);

  const createFolder = React.useCallback(
    async (parent: ResourceFolder | null) => {
      const name = await dialog.prompt({
        title: parent ? `New folder in “${parent.name}”` : "New folder",
        message: parent
          ? "Nest folders to split a big topic into the material inside it."
          : "Folders hold Resources the way a drive holds files — one folder each.",
        placeholder: "Research",
        confirmLabel: "Create folder",
      });
      if (!name?.trim()) return;
      try {
        await api.post(`/api/companies/${company.id}/resource-folders`, {
          name: name.trim(),
          parentId: parent?.id ?? null,
        });
        await refreshFolders();
      } catch (err) {
        void dialog.error(err, { title: "Couldn’t create that folder" });
      }
    },
    [company.id, dialog, refreshFolders],
  );

  const moveResource = React.useCallback(
    async (slug: string, folderId: string | null) => {
      try {
        await api.patch(`/api/companies/${company.id}/resources/${slug}`, { folderId });
        await refreshFolders();
        return true;
      } catch (err) {
        void dialog.error(err, { title: "Couldn’t move that resource" });
        return false;
      }
    },
    [company.id, dialog, refreshFolders],
  );

  const ctx = React.useMemo<ResourcesOutletCtx>(
    () => ({
      company,
      folders: tree?.folders ?? [],
      unfiledCount: tree?.unfiledCount ?? 0,
      maxFolderDepth: tree?.maxDepth ?? 5,
      foldersLoaded: tree !== null,
      refreshFolders,
      createFolder,
      moveResource,
    }),
    [company, tree, refreshFolders, createFolder, moveResource],
  );

  return (
    <ContextualLayout sidebar={<Sidebar ctx={ctx} />}>
      <Outlet context={ctx} />
    </ContextualLayout>
  );
}

function Sidebar({ ctx }: { ctx: ResourcesOutletCtx }) {
  const { company, folders, unfiledCount, maxFolderDepth, createFolder, moveResource } = ctx;
  const location = useLocation();
  const dialog = useDialog();
  const base = `/c/${company.slug}/resources`;
  const onIndex = location.pathname === base;
  const activeFolder = onIndex ? new URLSearchParams(location.search).get("folder") : null;
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);
  const childrenOf = React.useMemo(() => childrenByParent(folders), [folders]);
  const total =
    unfiledCount +
    (childrenOf.get(null) ?? []).reduce((sum, folder) => sum + folder.totalResourceCount, 0);

  async function newTopLevelFolder() {
    setCreating(true);
    try {
      await createFolder(null);
    } finally {
      setCreating(false);
    }
  }

  async function renameFolder(folder: ResourceFolder) {
    const name = await dialog.prompt({
      title: "Rename folder",
      message: "Links to this folder keep working — the name changes, the address doesn’t.",
      defaultValue: folder.name,
      confirmLabel: "Rename",
    });
    if (!name?.trim() || name.trim() === folder.name) return;
    try {
      await api.patch(`/api/companies/${company.id}/resource-folders/${folder.id}`, {
        name: name.trim(),
      });
      await ctx.refreshFolders();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t rename that folder" });
    }
  }

  async function moveFolder(folder: ResourceFolder, parentId: string | null) {
    try {
      await api.patch(`/api/companies/${company.id}/resource-folders/${folder.id}`, {
        parentId,
      });
      await ctx.refreshFolders();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t move that folder" });
    }
  }

  async function removeFolder(folder: ResourceFolder) {
    const message = deleteFolderMessage(folder, folders);
    if (message) {
      const ok = await dialog.confirm({
        title: `Delete “${folder.name}”?`,
        message,
        confirmLabel: "Delete folder",
        variant: "danger",
      });
      if (!ok) return;
    }
    try {
      await api.del(`/api/companies/${company.id}/resource-folders/${folder.id}`);
      await ctx.refreshFolders();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete that folder" });
    }
  }

  function renderFolder(folder: ResourceFolder): React.ReactNode {
    const kids = childrenOf.get(folder.id) ?? [];
    const isCollapsed = collapsed.has(folder.id);
    const active = activeFolder === folder.slug;
    const atDepthLimit = folder.depth >= maxFolderDepth;
    return (
      <div key={folder.id}>
        <DropRow
          active={active}
          onDropResource={(slug, from) => {
            if (from !== folder.id) void moveResource(slug, folder.id);
          }}
          // Indentation from depth, not nested padding, so a deep folder keeps
          // room for its name.
          indent={folder.depth - 1}
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
            className={clsx(
              "shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200",
              kids.length === 0 && "invisible",
            )}
            aria-label={isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <NavLink
            to={resourceFolderHref(company.slug, folder)}
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
              {folder.totalResourceCount}
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
                      void moveFolder(folder, null);
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
        </DropRow>
        {!isCollapsed && kids.map(renderFolder)}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SectionRailHeader
        section="resources"
        label="Resources"
        actions={
          <RailIconButton
            label="New folder"
            onClick={() => void newTopLevelFolder()}
            disabled={creating}
            aria-busy={creating || undefined}
          >
            {creating ? <ButtonSpinner size={16} /> : <FolderPlus size={16} />}
          </RailIconButton>
        }
      />
      <div className="flex-1 overflow-y-auto p-2">
        <NavLink
          to={base}
          end
          className={clsx(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
            onIndex && !activeFolder
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800",
          )}
        >
          <Library size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">All resources</span>
          {ctx.foldersLoaded && (
            <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {total}
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
            onClick={() => void newTopLevelFolder()}
            disabled={creating}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="New folder"
            aria-label="New top-level folder"
          >
            <Plus size={14} />
          </button>
        </div>

        {folders.length === 0 ? (
          <p className="px-3 pb-1 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
            No folders yet. File Resources by topic — Research, Playbooks, Customers.
          </p>
        ) : (
          <>
            {(childrenOf.get(null) ?? []).map(renderFolder)}
            <DropRow
              active={activeFolder === UNFILED_FOLDER_PARAM}
              onDropResource={(slug, from) => {
                if (from !== null) void moveResource(slug, null);
              }}
            >
              <NavLink
                to={resourceFolderHref(company.slug, "unfiled")}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm"
              >
                <Inbox size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">Unfiled</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                  {unfiledCount}
                </span>
              </NavLink>
            </DropRow>
          </>
        )}
      </div>
      <nav
        aria-label="Resources settings"
        className="shrink-0 space-y-0.5 border-t border-slate-100 p-2 dark:border-slate-800"
      >
        <SectionRailLinks section="resources" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );
}

/**
 * A sidebar row a Resource card can be dropped on. It lights up while a card
 * is over it, so the place it will land is never a guess.
 */
function DropRow({
  active,
  indent = 0,
  onDropResource,
  children,
}: {
  active: boolean;
  indent?: number;
  onDropResource: (slug: string, fromFolderId: string | null) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = React.useState(false);
  return (
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const dragged = readResourceDrag(event.dataTransfer);
        if (!dragged) return;
        event.preventDefault();
        onDropResource(dragged.slug, dragged.folderId);
      }}
      className={clsx(
        "group flex items-center gap-1 rounded-md pr-1",
        over
          ? "bg-indigo-100 text-indigo-800 ring-2 ring-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-200 dark:ring-indigo-500/40"
          : active
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
      style={indent ? { paddingLeft: `${indent * 12}px` } : undefined}
    >
      {children}
    </div>
  );
}
