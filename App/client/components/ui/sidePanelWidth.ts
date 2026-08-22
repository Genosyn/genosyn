/**
 * Width arithmetic for the panels that dock beside a page — the live browser
 * in chat, and the repository work session it now sits alongside.
 *
 * Kept out of the components because it is the part with rules: a panel may
 * never squeeze what it is docked next to below a usable column, a stored
 * width from a wider monitor must not survive onto a narrow one, and a
 * keyboard nudge has to move the same edge the pointer does.
 */

/** Nothing narrower than this is a panel; it is a squashed sliver. */
export const SIDE_PANEL_MIN_WIDTH = 360;

/** What the page beside the panel always keeps for itself. */
export const SIDE_PANEL_MIN_COMPANION_WIDTH = 360;

/** Enough for a diff without taking over the window. */
export const SIDE_PANEL_DEFAULT_WIDTH = 520;

/**
 * Chrome that is already spoken for before a panel takes anything.
 *
 * Both panels dock in chat, and chat sits behind two fixed `w-64` rails from
 * the `md` breakpoint up: the app's contextual sidebar (`AppShell`) and the
 * conversation list (`EmployeeChat`). The window is not the space the panel is
 * competing for — counting it as such is how a panel that looked reasonable on
 * a 1440 monitor left a 150 px conversation on a 1100 px one.
 */
const APP_SIDEBAR_WIDTH = 256;
const CHAT_RAIL_WIDTH = 256;
const RAILS_FROM_VIEWPORT = 768;

/** Width the page has already committed to chrome at this viewport. */
export function sidePanelChromeWidth(viewportWidth: number): number {
  return viewportWidth >= RAILS_FROM_VIEWPORT ? APP_SIDEBAR_WIDTH + CHAT_RAIL_WIDTH : 0;
}

/**
 * The narrowest window on which a panel can sit *beside* the conversation
 * rather than on top of it: both rails, a readable conversation, and a
 * readable panel. Derived rather than picked, so it cannot drift away from the
 * clamp below.
 */
export const SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT =
  APP_SIDEBAR_WIDTH + CHAT_RAIL_WIDTH + SIDE_PANEL_MIN_COMPANION_WIDTH + SIDE_PANEL_MIN_WIDTH;

/** The widest a panel may be on this viewport, before the floor is applied. */
export function maxSidePanelWidth(viewportWidth: number): number {
  return Math.max(
    SIDE_PANEL_MIN_WIDTH,
    viewportWidth - sidePanelChromeWidth(viewportWidth) - SIDE_PANEL_MIN_COMPANION_WIDTH,
  );
}

/** Only the two methods these helpers use, so a test can pass a fake. */
export type SidePanelWidthStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Fit a width to the window, keeping a usable column for the page beside it.
 *
 * A viewport too small for both loses the argument in the panel's favour —
 * clamping below the minimum would produce the sliver this exists to prevent —
 * and a viewport we cannot measure is left alone.
 */
export function clampSidePanelWidth(width: number, viewportWidth: number | null): number {
  if (viewportWidth === null || !Number.isFinite(viewportWidth)) return width;
  const max = maxSidePanelWidth(viewportWidth);
  if (width > max) return max;
  if (width < SIDE_PANEL_MIN_WIDTH) return SIDE_PANEL_MIN_WIDTH;
  return width;
}

/**
 * The width this panel was last left at. Anything unreadable, unparseable, or
 * narrower than a panel should be falls back to the default — a stored value
 * is a convenience, never a constraint worth honouring when it is nonsense.
 */
export function readStoredSidePanelWidth(
  storage: SidePanelWidthStorage | null | undefined,
  key: string,
  fallback: number = SIDE_PANEL_DEFAULT_WIDTH,
): number {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= SIDE_PANEL_MIN_WIDTH) return parsed;
  } catch {
    // Storage can be disabled outright. A remembered width is not worth an
    // exception on the way to rendering.
  }
  return fallback;
}

/**
 * The width a panel opens at: what it was left at, fitted to this window.
 *
 * Pure and separate from the hook because the fitting is the part that is easy
 * to leave out — a remembered width from a large monitor is exactly the case
 * where opening unclamped is worst.
 */
export function initialSidePanelWidth(
  storage: SidePanelWidthStorage | null | undefined,
  key: string,
  defaultWidth: number,
  viewportWidth: number | null,
): number {
  return clampSidePanelWidth(readStoredSidePanelWidth(storage, key, defaultWidth), viewportWidth);
}

export function writeStoredSidePanelWidth(
  storage: SidePanelWidthStorage | null | undefined,
  key: string,
  width: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, String(Math.round(width)));
  } catch {
    // Ignore — the width is a nicety, not state anything depends on.
  }
}

/**
 * Keyboard resizing. The handle is on the panel's left edge, so ← grows the
 * panel and → shrinks it, matching what dragging that edge does. Shift takes
 * bigger steps for anyone crossing a wide monitor.
 */
export function nudgedSidePanelWidth(
  width: number,
  key: "ArrowLeft" | "ArrowRight",
  shiftKey: boolean,
  viewportWidth: number | null,
): number {
  const step = shiftKey ? 80 : 24;
  const delta = key === "ArrowLeft" ? step : -step;
  return clampSidePanelWidth(width + delta, viewportWidth);
}
