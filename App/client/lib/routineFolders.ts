import type { RoutineFolder } from "./api";

/**
 * Client-side reads of the folder tree. The server hands back a flat list —
 * every row carrying its own `parentId` and `depth` — so the shapes the UI
 * actually renders are derived here rather than in the components.
 */

/**
 * A folder and every folder beneath it.
 *
 * The Routines list filters on this so selecting a parent shows its children's
 * routines too. A folder whose count excluded its subfolders would read as
 * empty the moment you nested anything inside it, which is the opposite of what
 * a tree is for.
 *
 * Defensive against a malformed tree rather than trusting one: the server
 * refuses to create a cycle, but a client that looped on a bad payload would
 * hang the tab, so the walk tracks what it has already visited.
 */
export function folderAndDescendants(folders: RoutineFolder[], rootId: string): Set<string> {
  const childIds = childrenByParent(folders);
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(childIds.get(id) ?? []).map((folder) => folder.id));
  }
  return out;
}

/**
 * parentId → its folders, in the order the server returned them (sortOrder,
 * then name). Top-level folders live under the `null` key.
 *
 * A folder whose parent is not in the list is treated as top-level rather than
 * dropped. That happens if a delete is only partly applied, or if a row is
 * hand-edited in the database — and a folder nobody can see is a folder nobody
 * can fix, so it surfaces at the root instead of vanishing.
 */
export function childrenByParent(
  folders: RoutineFolder[],
): Map<string | null, RoutineFolder[]> {
  const present = new Set(folders.map((folder) => folder.id));
  const map = new Map<string | null, RoutineFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parentId && present.has(folder.parentId) ? folder.parentId : null;
    const siblings = map.get(parentId) ?? [];
    siblings.push(folder);
    map.set(parentId, siblings);
  }
  return map;
}
