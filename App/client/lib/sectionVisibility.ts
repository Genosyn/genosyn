import type { SectionGroup, SectionKey } from "./sections";
import { effectiveFinanceAccess, type SubpageViewer } from "./subpages";

/**
 * Which sections the ⌘K palette lists while browsing, and the keyboard guide
 * shows: every section this person can open.
 */

/**
 * Whether this person can open the section at all. Finance and Customers are
 * both served by the finance routes, which refuse a Member without Finance
 * access, so neither is offered to them anywhere; a Member reaches the same
 * accounts through Revenue.
 */
export function canOpenSection(key: SectionKey, viewer: SubpageViewer): boolean {
  if (key === "finance" || key === "customers") return effectiveFinanceAccess(viewer) !== "none";
  return true;
}

/** The groups as browsing lists them; a group left empty is dropped with its heading. */
export function listedGroups(groups: SectionGroup[], viewer: SubpageViewer): SectionGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canOpenSection(item.key, viewer)),
    }))
    .filter((group) => group.items.length > 0);
}
