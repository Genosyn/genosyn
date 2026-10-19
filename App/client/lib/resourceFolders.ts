import type { Resource, ResourceFolder } from "./api";
import { childrenByParent, folderAndDescendants } from "./routineFolders";

/**
 * The Resources library as files and folders. The server hands back the tree
 * flat (`GET /resource-folders`); what each view of the page shows is derived
 * here so the page, the sidebar, and the detail page agree on it.
 */

/** `?folder=unfiled` — everything filed in no folder. Never a folder's slug. */
export const UNFILED_FOLDER_PARAM = "unfiled";

/** The drag payload a Resource card carries onto a folder. */
export const RESOURCE_DRAG_TYPE = "application/x-genosyn-resource";

/** What the Resources page is showing. */
export type ResourceFolderView =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "folder"; folder: ResourceFolder }
  /** A `?folder=` naming no folder — deleted, or a stale link. */
  | { kind: "missing"; slug: string };

export function resourceFolderView(
  param: string | null,
  folders: ResourceFolder[],
): ResourceFolderView {
  if (!param) return { kind: "all" };
  if (param === UNFILED_FOLDER_PARAM) return { kind: "unfiled" };
  const folder = folders.find((row) => row.slug === param);
  return folder ? { kind: "folder", folder } : { kind: "missing", slug: param };
}

/** The page address for a view: the folder's slug, or nothing for everything. */
export function resourceFolderHref(
  companySlug: string,
  folder: Pick<ResourceFolder, "slug"> | "unfiled" | null,
): string {
  const base = `/c/${companySlug}/resources`;
  if (!folder) return base;
  const slug = folder === "unfiled" ? UNFILED_FOLDER_PARAM : folder.slug;
  return `${base}?folder=${encodeURIComponent(slug)}`;
}

/**
 * The Resources a view lists. A folder shows what is filed directly in it —
 * its subfolders sit beside them as folders, the way a file browser shows a
 * directory — while a search inside a folder reaches everything beneath it,
 * because "find it somewhere in Research" is what searching a folder means.
 */
export function resourcesInView(
  items: Resource[],
  folders: ResourceFolder[],
  view: ResourceFolderView,
  options: { searching: boolean },
): Resource[] {
  if (view.kind === "all") return items;
  if (view.kind === "missing") return [];
  if (view.kind === "unfiled") return items.filter((item) => !item.folderId);
  if (!options.searching) return items.filter((item) => item.folderId === view.folder.id);
  const subtree = folderAndDescendants(folders, view.folder.id);
  return items.filter((item) => item.folderId !== null && subtree.has(item.folderId));
}

/** The folders shown as tiles above the Resources: a level of the tree. */
export function subfoldersInView(
  folders: ResourceFolder[],
  view: ResourceFolderView,
): ResourceFolder[] {
  if (view.kind === "unfiled" || view.kind === "missing") return [];
  const children = childrenByParent(folders);
  return children.get(view.kind === "folder" ? view.folder.id : null) ?? [];
}

/**
 * A folder's ancestors, top first, ending with the folder itself — the
 * breadcrumb trail. Stops at a missing or repeated parent rather than looping.
 */
export function folderTrail(folders: ResourceFolder[], folderId: string): ResourceFolder[] {
  const byId = new Map(folders.map((row) => [row.id, row]));
  const trail: ResourceFolder[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(folderId) ?? null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    trail.unshift(cursor);
    cursor = cursor.parentId ? (byId.get(cursor.parentId) ?? null) : null;
  }
  return trail;
}

/**
 * The folders a Resource can be moved to, in tree order with their paths, for
 * a picker. Tree order rather than the server's sibling order, so a subfolder
 * reads right under its parent.
 */
export function folderOptions(folders: ResourceFolder[]): { id: string; label: string }[] {
  const children = childrenByParent(folders);
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const folder of children.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      out.push({ id: folder.id, label: folder.path });
      walk(folder.id);
    }
  };
  walk(null);
  return out;
}

/** What a dragged Resource card carries, or null for any other drag. */
export function readResourceDrag(
  data: Pick<DataTransfer, "getData">,
): { slug: string; folderId: string | null } | null {
  try {
    const parsed = JSON.parse(data.getData(RESOURCE_DRAG_TYPE) || "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { slug, folderId } = parsed as { slug?: unknown; folderId?: unknown };
    if (typeof slug !== "string" || !slug) return null;
    return { slug, folderId: typeof folderId === "string" ? folderId : null };
  } catch {
    return null;
  }
}

/**
 * Where the contents of a deleted folder end up, said the way a person would —
 * or null for an empty folder, which holds nothing to lose and goes in one
 * click. "Delete folder?" alone reads as if it took the Resources with it,
 * which it never does.
 */
export function deleteFolderMessage(
  folder: Pick<ResourceFolder, "id" | "resourceCount" | "parentId">,
  folders: ResourceFolder[],
): string | null {
  const subfolders = folders.filter((row) => row.parentId === folder.id).length;
  const contents: string[] = [];
  if (folder.resourceCount > 0) {
    contents.push(`${folder.resourceCount} resource${folder.resourceCount === 1 ? "" : "s"}`);
  }
  if (subfolders > 0) contents.push(`${subfolders} subfolder${subfolders === 1 ? "" : "s"}`);
  if (contents.length === 0) return null;
  const parent = folder.parentId ? folders.find((row) => row.id === folder.parentId) : null;
  const destination = parent ? `“${parent.name}”` : "Unfiled";
  return `${contents.join(" and ")} will move to ${destination}. Nothing is deleted.`;
}
