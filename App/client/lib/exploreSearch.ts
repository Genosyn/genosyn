import { type SearchKind, matchKindToken } from "../../shared/searchKinds";
import { foldSearchText, matchLabelText, queryTokens } from "./searchText";

/**
 * Searching the two lists in Explore's sidebar.
 *
 * The box says "Search charts and dashboards", so people type the name of the
 * thing and the kind it is: "revenue dashboard". Matching that as one literal
 * string over the title finds nothing, because the Dashboard is called
 * Revenue and "dashboard" is the list it lives in. A kind word is therefore a
 * qualifier for the list — it can only match the list's own kind — while the
 * other words narrow the title. The same words in any order, singular or
 * plural, or half-typed ("revenue dash") work as well.
 *
 * This is deliberately the same rule `server/services/search.ts` applies to
 * company results, so the sidebar and ⌘K agree about what a phrase means.
 */

export type ExploreSearchKind = Extract<SearchKind, "chart" | "dashboard">;

/**
 * How well an Explore row answers `query`, or null when it does not. Every
 * word has to land in the title or name the row's own kind; the score is the
 * weakest landing, so each extra word narrows rather than widens.
 */
export function scoreExploreItem(
  title: string,
  kind: ExploreSearchKind,
  query: string,
): number | null {
  const q = foldSearchText(query);
  if (!q) return 0;
  const tokens = queryTokens(q);
  let weakest = Infinity;
  for (const token of tokens) {
    const label = matchLabelText(title, token);
    const best = Math.max(label?.score ?? 0, matchKindToken(kind, token) ?? 0);
    if (best === 0) return null;
    weakest = Math.min(weakest, best);
  }
  // A phrase that lands intact in the title is a stronger signal than the
  // same words landing separately ("Revenue dashboard" for "revenue dashboard").
  const whole = matchLabelText(title, q);
  return Math.max(whole?.score ?? 0, weakest);
}

/**
 * The rows in one Explore list that answer the query, in their existing
 * order. Filtering rather than ranking keeps the sidebar's recent-first order
 * stable while someone types; a blank query returns every row.
 */
export function searchExploreItems<T extends { title: string }>(
  items: readonly T[],
  kind: ExploreSearchKind,
  query: string,
): T[] {
  if (!foldSearchText(query)) return [...items];
  return items.filter((item) => scoreExploreItem(item.title, kind, query) !== null);
}
