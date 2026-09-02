import type { RoutineFolder, RoutineWithMeta } from "./api";
import { cronHuman } from "./cron";
import { describeCronExpr } from "./scheduleBuilder";

/**
 * Free-text search over the Routines list.
 *
 * Folders answer *where does this live* and tags answer *what is this about*;
 * both need you to already know the answer before you can narrow. A search box
 * is the third question — *what was that thing called?* — and it is the one
 * people actually arrive with. So the query is matched against everything the
 * row already shows: the routine's name, the employee it is assigned to, the
 * folder it is filed in, its tags, and its schedule.
 *
 * The schedule is searchable in both dialects. `0 9 * * 1-5` and "weekday" are
 * the same fact, and which one someone types depends entirely on whether they
 * write cron for a living — so both the raw expression and the plain-English
 * rendering the row displays go into the haystack.
 *
 * Kept out of the page component because it is the part worth testing: the
 * component is markup, this is the behaviour.
 */

/**
 * The fields the search reads. A `Pick` rather than a fresh shape so a rename
 * on `RoutineWithMeta` breaks here at compile time instead of quietly making a
 * column unsearchable.
 */
export type SearchableRoutine = Pick<
  RoutineWithMeta,
  "name" | "slug" | "cronExpr" | "folderId" | "employee" | "tags"
>;

/**
 * Case- and accent-insensitive form. Typing `jose` should find "José" — the
 * person searching is at a keyboard, not necessarily the one that produced the
 * name.
 */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * A query split into the terms that must *all* match, folded and de-duplicated.
 *
 * Whitespace separates terms rather than being matched literally, so "finance
 * digest" finds the digest filed under Finance even though no single field
 * contains that phrase. An empty or whitespace-only query yields no terms,
 * which callers read as "not searching".
 */
export function searchTerms(query: string): string[] {
  const trimmed = fold(query).trim();
  if (!trimmed) return [];
  return [...new Set(trimmed.split(/\s+/))];
}

/**
 * Plain-English cron, memoized by expression.
 *
 * Both renderings, because the two say different words about the same
 * schedule and someone searching could reasonably type either. `0 9 * * 1-5`
 * is "Every weekday at 9:00 AM" in the app's own voice — which is what the
 * row on screen shows, so it has to match — and "Monday through Friday" in
 * cronstrue's, which is what the row used to show and what a person who
 * knows the schedule by its days would still reach for.
 *
 * The list re-filters on every keystroke, and a company with a few hundred
 * routines would otherwise re-render a few hundred cron expressions per
 * character typed. The rendering is a pure function of the expression, so the
 * cache can never go stale, and it is bounded by the number of distinct
 * schedules the company has written.
 */
const cronTextCache = new Map<string, string>();

function cronText(expr: string): string {
  const hit = cronTextCache.get(expr);
  if (hit !== undefined) return hit;
  const text = `${describeCronExpr(expr)} ${cronHuman(expr)}`;
  cronTextCache.set(expr, text);
  return text;
}

/**
 * Everything about one routine a query can match, as a single folded string.
 *
 * `folderPath` is passed in rather than looked up here because the row only
 * carries a `folderId`; the caller already has the folder list and resolving it
 * once per list beats once per routine.
 */
export function routineSearchText(
  routine: SearchableRoutine,
  folderPath: string | null,
): string {
  const parts = [
    routine.name,
    // Slugs are stable across renames, so a link someone pasted still matches
    // after the routine was given a friendlier name.
    routine.slug,
    routine.cronExpr,
    cronText(routine.cronExpr),
    routine.employee?.name,
    routine.employee?.slug,
    folderPath,
    ...(routine.tags ?? []).map((tag) => tag.name),
  ];
  return fold(parts.filter((part): part is string => !!part).join(" "));
}

/** Whether one routine matches every term in an already-parsed query. */
export function matchesSearchTerms(
  routine: SearchableRoutine,
  terms: string[],
  folderPath: string | null,
): boolean {
  if (terms.length === 0) return true;
  const haystack = routineSearchText(routine, folderPath);
  return terms.every((term) => haystack.includes(term));
}

/**
 * The routines matching `query`, in the order they came in — sorting is the
 * caller's business, and reordering a list as someone types is disorienting.
 *
 * A blank query returns everything, so the caller can filter unconditionally
 * rather than branching on whether the box is empty.
 */
export function filterRoutinesBySearch<T extends SearchableRoutine>(
  routines: readonly T[],
  query: string,
  folders: readonly RoutineFolder[],
): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [...routines];
  const pathById = new Map(folders.map((folder) => [folder.id, folder.path]));
  return routines.filter((routine) =>
    matchesSearchTerms(
      routine,
      terms,
      routine.folderId ? (pathById.get(routine.folderId) ?? null) : null,
    ),
  );
}
