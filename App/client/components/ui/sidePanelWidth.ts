/**
 * Width rules for the columns a person can drag: the panels that dock on the
 * right of a page (a Todo beside its board, Ask AI, the live browser and
 * repository work in chat) and the rails down its left (the app's sidebar, and
 * the conversation lists in Chat, Workspace and Help).
 *
 * What a column may take right now is left to the browser, through the
 * `max-width`s below. They resolve against the column's own flex row, so they
 * measure the space the page really has, on every frame: with the sidebar
 * dragged wide, with Ask AI open beside the board, in a window that just
 * shrank. Arithmetic over the window and fixed rail widths kept getting that
 * wrong, and it threw away what the person asked for as well: a panel squeezed
 * by a smaller window now comes back to its width when there is room again.
 *
 * What stays here is the part with rules of its own: the numbers, what a stored
 * width may be, and which way a drag or an arrow key moves an edge.
 */

/** Nothing narrower than this is a panel; it is a squashed sliver. */
export const SIDE_PANEL_MIN_WIDTH = 360;

/** What the page beside a panel keeps for itself. */
export const SIDE_PANEL_MIN_COMPANION_WIDTH = 360;

/** Enough for a diff without taking over the window. */
export const SIDE_PANEL_DEFAULT_WIDTH = 520;

/** Narrower than this, a rail's labels are all truncation. */
export const RAIL_MIN_WIDTH = 200;

export const RAIL_DEFAULT_WIDTH = 256;

/** Wider than this, a rail is taking room from the page and giving nothing back. */
export const RAIL_MAX_WIDTH = 480;

/**
 * A rail's width, published on the flex row it sits in, for a panel in the same
 * row to leave room for. A variable rather than React state so that dragging a
 * rail re-renders nothing but the rail.
 */
export const RAIL_WIDTH_VARIABLE = "--rail-width";

/**
 * The narrowest window on which a panel docks beside the page rather than
 * covering it: two rails at their usual width, a readable column and a readable
 * panel. Derived rather than picked, so it cannot drift from the limits below.
 */
export const SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT =
  RAIL_DEFAULT_WIDTH + RAIL_DEFAULT_WIDTH + SIDE_PANEL_MIN_COMPANION_WIDTH + SIDE_PANEL_MIN_WIDTH;

/** A panel with only the page beside it in its row: a Todo next to its board. */
export const SIDE_PANEL_MAX_WIDTH = `calc(100% - ${SIDE_PANEL_MIN_COMPANION_WIDTH}px)`;

/** A panel whose row also holds a rail: chat's panels, past its conversation list. */
export const SIDE_PANEL_BESIDE_RAIL_MAX_WIDTH = `calc(100% - var(${RAIL_WIDTH_VARIABLE}, 0px) - ${SIDE_PANEL_MIN_COMPANION_WIDTH}px)`;

/**
 * Ask AI, which docks beside the whole page. The page may hold a second column
 * of its own (chat's conversation list, a Todo beside its board), so it keeps
 * room for that next to a readable one.
 */
export const APP_PANEL_MAX_WIDTH = `calc(100% - var(${RAIL_WIDTH_VARIABLE}, 0px) - ${
  RAIL_DEFAULT_WIDTH + SIDE_PANEL_MIN_COMPANION_WIDTH
}px)`;

/** A rail stops at its own maximum, or sooner where the page would lose its column. */
export const RAIL_MAX_WIDTH_IN_ROW = `min(${RAIL_MAX_WIDTH}px, calc(100% - ${SIDE_PANEL_MIN_COMPANION_WIDTH}px))`;

/** Which side of a column its handle sits on, which decides the way it grows. */
export type ResizeEdge = "left" | "right";

/** Only the two methods these helpers use, so a test can pass a fake. */
export type WidthStorage = Pick<Storage, "getItem" | "setItem">;

export function fitWidth(width: number, minWidth: number, maxWidth = Infinity): number {
  return Math.min(maxWidth, Math.max(minWidth, width));
}

/**
 * The width a column was last left at. Anything unreadable, unparseable, or
 * narrower than the column should be falls back to its default — a stored value
 * is a convenience, never a constraint worth honouring when it is nonsense.
 */
export function readStoredWidth(
  storage: WidthStorage | null | undefined,
  key: string,
  fallback: number,
  minWidth: number,
  maxWidth = Infinity,
): number {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= minWidth) return Math.min(parsed, maxWidth);
  } catch {
    // Storage can be disabled outright. A remembered width is not worth an
    // exception on the way to rendering.
  }
  return fallback;
}

export function writeStoredWidth(
  storage: WidthStorage | null | undefined,
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
 * How wide a drag makes a column. Moving a left edge left grows it, and moving
 * a right edge right does, so the edge stays under the pointer either way.
 */
export function draggedWidth(startWidth: number, pointerDelta: number, edge: ResizeEdge): number {
  return edge === "left" ? startWidth - pointerDelta : startWidth + pointerDelta;
}

/**
 * Keyboard resizing moves the same edge a drag does: ← grows a column whose
 * handle is on its left, → grows one whose handle is on its right. Shift takes
 * bigger steps for anyone crossing a wide monitor.
 */
export function nudgedWidth(
  width: number,
  key: "ArrowLeft" | "ArrowRight",
  shiftKey: boolean,
  edge: ResizeEdge,
): number {
  const step = shiftKey ? 80 : 24;
  const grows = key === (edge === "left" ? "ArrowLeft" : "ArrowRight");
  return grows ? width + step : width - step;
}
