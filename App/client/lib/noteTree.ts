/**
 * The Notes sidebar's tree: notebooks hold pages, pages hold sub-pages. This
 * builds it, decides what is expanded, finds pages by title, and works out
 * where a dragged page lands — all as plain functions the tests can drive.
 */

import { foldSearchText, matchLabelText } from "./searchText.js";

export type TreeNote = {
  id: string;
  slug: string;
  title: string;
  icon: string;
  notebookId: string;
  parentId: string | null;
  sortOrder: number;
  updatedAt: string;
  archivedAt?: string | null;
};

export type TreeNode<N extends TreeNote = TreeNote> = { note: N; children: Array<TreeNode<N>> };

function bySortOrder(a: TreeNote, b: TreeNote): number {
  return (
    a.sortOrder - b.sortOrder ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
    a.title.localeCompare(b.title)
  );
}

/** Each notebook's top-level pages, nested. A page whose parent isn't in the list sits at the top. */
export function buildNoteTree<N extends TreeNote>(notes: readonly N[]): Map<string, Array<TreeNode<N>>> {
  const nodes = new Map<string, TreeNode<N>>();
  for (const note of notes) nodes.set(note.id, { note, children: [] });
  const roots = new Map<string, Array<TreeNode<N>>>();
  for (const node of nodes.values()) {
    const parent = node.note.parentId ? nodes.get(node.note.parentId) : undefined;
    if (parent && parent.note.notebookId === node.note.notebookId && !createsCycle(nodes, node.note.id)) {
      parent.children.push(node);
    } else {
      const list = roots.get(node.note.notebookId);
      if (list) list.push(node);
      else roots.set(node.note.notebookId, [node]);
    }
  }
  const sort = (list: Array<TreeNode<N>>) => {
    list.sort((a, b) => bySortOrder(a.note, b.note));
    for (const node of list) sort(node.children);
  };
  for (const list of roots.values()) sort(list);
  return roots;
}

function createsCycle(nodes: Map<string, TreeNode>, id: string): boolean {
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = nodes.get(cursor)?.note.parentId ?? null;
  }
  return false;
}

/** The page's ancestors, nearest last: what to expand so it shows in the tree. */
export function ancestorIds(notes: readonly TreeNote[], id: string): string[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cursor = byId.get(id)?.parentId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    out.unshift(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return out;
}

/** Every page under `id`, at any depth. */
export function descendantIds(notes: readonly TreeNote[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const n of notes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n.id);
    else children.set(n.parentId, [n.id]);
  }
  const out = new Set<string>();
  const queue = [...(children.get(id) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (out.has(next) || next === id) continue;
    out.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

/** The most recently edited pages. */
export function recentNotes<N extends TreeNote>(notes: readonly N[], limit = 5): N[] {
  return [...notes]
    .filter((n) => !n.archivedAt)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

/** Pages whose title matches a quick-find query, best match first, then most recent. */
export function findNotesByTitle<N extends TreeNote>(notes: readonly N[], query: string, limit = 30): N[] {
  const q = foldSearchText(query);
  if (!q) return [];
  return notes
    .map((note) => ({ note, score: matchLabelText(note.title || "Untitled", q)?.score ?? 0 }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.note.updatedAt).getTime() - new Date(a.note.updatedAt).getTime(),
    )
    .slice(0, limit)
    .map((entry) => entry.note);
}

export type DropZone = "before" | "inside" | "after";

/** Which part of a row the pointer is over: its top and bottom quarters reorder, the middle nests. */
export function dropZoneAt(offsetY: number, height: number): DropZone {
  if (height <= 0) return "inside";
  const ratio = offsetY / height;
  if (ratio < 0.28) return "before";
  if (ratio > 0.72) return "after";
  return "inside";
}

export type DropTarget = {
  notebookId: string;
  parentId: string | null;
  /** Position among the new siblings, not counting the moved page. */
  index: number;
};

function siblingsOf<N extends TreeNote>(notes: readonly N[], notebookId: string, parentId: string | null, exclude: string): N[] {
  return notes
    .filter((n) => n.notebookId === notebookId && (n.parentId ?? null) === parentId && n.id !== exclude && !n.archivedAt)
    .sort(bySortOrder);
}

/**
 * Where a page dropped on another page's row goes: before or after it among
 * its siblings, or inside it as its last sub-page. Null when the drop would
 * put a page inside itself.
 */
export function dropTarget(
  notes: readonly TreeNote[],
  draggedId: string,
  overId: string,
  zone: DropZone,
): DropTarget | null {
  if (draggedId === overId) return null;
  const over = notes.find((n) => n.id === overId);
  if (!over) return null;
  if (descendantIds(notes, draggedId).has(overId)) return null;
  if (zone === "inside") {
    const siblings = siblingsOf(notes, over.notebookId, over.id, draggedId);
    return { notebookId: over.notebookId, parentId: over.id, index: siblings.length };
  }
  const parentId = over.parentId ?? null;
  const siblings = siblingsOf(notes, over.notebookId, parentId, draggedId);
  const at = siblings.findIndex((n) => n.id === overId);
  return { notebookId: over.notebookId, parentId, index: zone === "before" ? at : at + 1 };
}

/** A page dropped on a notebook's header goes to the end of that notebook's top level. */
export function notebookDropTarget(notes: readonly TreeNote[], draggedId: string, notebookId: string): DropTarget {
  return { notebookId, parentId: null, index: siblingsOf(notes, notebookId, null, draggedId).length };
}

/**
 * The notes as they will be once the move lands, for an instant sidebar:
 * the page takes its new place and siblings are renumbered the way the
 * server will number them.
 */
export function applyMove<N extends TreeNote>(notes: readonly N[], movedId: string, target: DropTarget): N[] {
  const moved = notes.find((n) => n.id === movedId);
  if (!moved) return notes as N[];
  const siblings = siblingsOf(notes, target.notebookId, target.parentId, movedId);
  const index = Math.max(0, Math.min(target.index, siblings.length));
  const ordered = [...siblings.slice(0, index), moved, ...siblings.slice(index)];
  const order = new Map(ordered.map((n, i) => [n.id, (i + 1) * 1000]));
  const moving = descendantIds(notes, movedId);
  return notes.map((n) => {
    if (n.id === movedId) {
      return { ...n, notebookId: target.notebookId, parentId: target.parentId, sortOrder: order.get(n.id)! };
    }
    if (moving.has(n.id) && n.notebookId !== target.notebookId) return { ...n, notebookId: target.notebookId };
    if (order.has(n.id)) return { ...n, sortOrder: order.get(n.id)! };
    return n;
  });
}

export function noteHref(companySlug: string, notebookSlug: string, noteSlug: string): string {
  return `/c/${companySlug}/notes/${notebookSlug}/${noteSlug}`;
}

/** Expanded tree rows are remembered per company in the browser. */
export function expandedKey(companyId: string): string {
  return `genosyn.notes.expanded.${companyId}`;
}

export function readExpanded(storage: Pick<Storage, "getItem"> | null, key: string): Set<string> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : null;
  } catch {
    return null;
  }
}

export function writeExpanded(storage: Pick<Storage, "setItem"> | null, key: string, ids: Set<string>): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify([...ids].slice(-500)));
  } catch {
    // Storage blocked: expansion just isn't remembered.
  }
}
