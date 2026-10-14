import { CORE_SECTIONS } from "../../shared/navigation";
import type { SectionGroup, SectionKey } from "./sections";
import { effectiveFinanceAccess, type SubpageViewer } from "./subpages";

/**
 * Which sections the ⌘K palette lists while browsing, and the keyboard guide
 * shows (`shared/navigation.ts` says why). Searching ignores all of this
 * except {@link canOpenSection}: every section a person can open is one query
 * away, listed or not.
 */

const CORE: ReadonlySet<string> = new Set(CORE_SECTIONS);

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

export type SectionListing = {
  /**
   * The usage sections this company has something in. `null` while unknown
   * (still loading, or the read failed): then every section is listed, since
   * hiding one the company uses is worse than showing a few it doesn't.
   */
  used: ReadonlySet<string> | null;
  /** The viewer asked to see every section. */
  showAll: boolean;
  /** The section on screen, which is always listed. */
  current: SectionKey;
  viewer: SubpageViewer;
};

/** Whether the section is listed while browsing. */
export function isSectionListed(key: SectionKey, listing: SectionListing): boolean {
  if (!canOpenSection(key, listing.viewer)) return false;
  if (listing.showAll || listing.used === null) return true;
  return key === listing.current || CORE.has(key) || listing.used.has(key);
}

/** The groups as browsing lists them; a group left empty is dropped with its heading. */
export function listedGroups(groups: SectionGroup[], listing: SectionListing): SectionGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isSectionListed(item.key, listing)),
    }))
    .filter((group) => group.items.length > 0);
}

/** How many sections this person could open that browsing currently leaves out. */
export function unlistedSectionCount(groups: SectionGroup[], listing: SectionListing): number {
  let count = 0;
  for (const group of groups) {
    for (const item of group.items) {
      if (canOpenSection(item.key, listing.viewer) && !isSectionListed(item.key, listing)) count++;
    }
  }
  return count;
}

const SHOW_ALL_KEY = "genosyn.sections.showAll";

/** The viewer's own "Show all sections" choice; a convenience, so storage may fail quietly. */
export function readShowAllSections(): boolean {
  try {
    return window.localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowAllSections(showAll: boolean): void {
  try {
    if (showAll) window.localStorage.setItem(SHOW_ALL_KEY, "1");
    else window.localStorage.removeItem(SHOW_ALL_KEY);
  } catch {
    // Private windows and blocked storage just forget the choice next time.
  }
}
