import type { NavigationAttention } from "../../shared/navigation";
import {
  SECTION_BY_KEY,
  SECTION_GROUPS,
  activeSection,
  type SectionGroup,
  type SectionItem,
  type SectionKey,
} from "./sections";
import { listedGroups } from "./sectionVisibility";
import type { SubpageViewer } from "./subpages";

/**
 * What the app sidebar (`components/AppSidebar.tsx`) lists and remembers.
 *
 * The sidebar is the map of the product: every section this person can open,
 * in the groups the ⌘K palette and the keyboard guide use, always on screen.
 * It used to live only inside the palette, behind a pill in the top bar, which
 * left a new person with no idea what Genosyn had in it.
 *
 * Kept apart from the component so the rules can be tested without a DOM.
 */

/** The group drawn at the foot of the sidebar rather than in its list. */
export const FOOTER_GROUP_ID = "system";

/** Whether the person chose to see the sidebar as icons only. */
export const NAV_COLLAPSED_KEY = "genosyn.nav.collapsed";

/** Which groups the person opened or closed, by group id. */
export const NAV_GROUPS_KEY = "genosyn.nav.groups";

/**
 * Below this window width the sidebar starts as icons, so a laptop keeps room
 * for a section's own rail and the page. A person's own choice wins at every
 * width.
 */
export const NAV_WIDE_VIEWPORT = 1280;

/** Only the two methods these helpers use, so a test can pass a fake. */
export type NavStorage = Pick<Storage, "getItem" | "setItem">;

/** The sidebar's groups, without the footer's: what it lists down its middle. */
export function sidebarGroups(viewer: SubpageViewer): SectionGroup[] {
  return listedGroups(SECTION_GROUPS, viewer).filter((group) => group.id !== FOOTER_GROUP_ID);
}

/** The sections pinned to the sidebar's foot: Settings, when it can be opened. */
export function footerSections(viewer: SubpageViewer): SectionItem[] {
  return listedGroups(SECTION_GROUPS, viewer)
    .filter((group) => group.id === FOOTER_GROUP_ID)
    .flatMap((group) => group.items);
}

/** The group holding a section, so arriving there can open it. */
export function groupOfSection(groups: SectionGroup[], key: SectionKey): SectionGroup | null {
  return groups.find((group) => group.items.some((item) => item.key === key)) ?? null;
}

/**
 * Whether a group is drawn open: as the person left it, otherwise as the
 * catalogue starts it. A group without an id can't be remembered, so it is
 * always open.
 */
export function groupIsOpen(
  group: SectionGroup,
  preferences: Readonly<Record<string, boolean>>,
): boolean {
  if (!group.id) return true;
  const chosen = preferences[group.id];
  return typeof chosen === "boolean" ? chosen : !group.startsClosed;
}

/** `null` when the person has not chosen, so the window width decides. */
export function readCollapsedPreference(storage: NavStorage | null): boolean | null {
  const raw = safeGet(storage, NAV_COLLAPSED_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function writeCollapsedPreference(storage: NavStorage | null, collapsed: boolean): void {
  safeSet(storage, NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
}

/**
 * The open or closed state the person gave each group. Anything that isn't a
 * `{ id: boolean }` object reads as no choices at all, so a hand-edited or
 * older value can never break the sidebar.
 */
export function readGroupPreferences(storage: NavStorage | null): Record<string, boolean> {
  const raw = safeGet(storage, NAV_GROUPS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [id, open] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof open === "boolean") out[id] = open;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeGroupPreferences(
  storage: NavStorage | null,
  preferences: Readonly<Record<string, boolean>>,
): void {
  safeSet(storage, NAV_GROUPS_KEY, JSON.stringify(preferences));
}

/**
 * Everything waiting on this person, across the Decision stack's own rows and
 * the queues it links to — the number beside the stack in the sidebar. A queue
 * that isn't theirs to act on is `null` and adds nothing. `null` until the
 * counts have loaded, so nothing is drawn rather than a wrong zero.
 */
export function attentionTotal(attention: NavigationAttention | null): number | null {
  if (!attention) return null;
  const { elsewhere } = attention;
  return [
    attention.decisions,
    attention.reviews,
    elsewhere.approvals,
    elsewhere.revisions,
    elsewhere.initiatives,
    elsewhere.todoReviews,
    elsewhere.financeProposals,
  ].reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

/**
 * The browser tab's title on a company page: where you are, then which
 * company, so a row of Genosyn tabs can be told apart. The first-run guide
 * lives under Home's address but is its own place.
 */
export function companyTabTitle(pathname: string, companyName: string): string {
  const where = /\/c\/[^/]+\/onboarding(\/|$)/.test(pathname)
    ? "Set up"
    : SECTION_BY_KEY[activeSection(pathname)].label;
  return `${where} · ${companyName}`;
}

/** How a count reads in a small badge: exact up to 99. */
export function badgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function safeGet(storage: NavStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage: NavStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private windows and full storage refuse writes; the sidebar still works,
    // it just forgets the choice on the next load.
  }
}
