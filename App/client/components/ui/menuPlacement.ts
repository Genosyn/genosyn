/**
 * Where a `Menu` opens, fitted to the window.
 *
 * Kept out of the component because it is the part with rules. A menu is
 * fixed to the viewport, so scrolling the page never brings back what the
 * window cut off: opened downward from the last row of a list, a row's ⋯ menu
 * left Archive, Void and Delete below the screen, out of reach. So a menu
 * opens on the side it asks for while it fits there, and otherwise on the
 * roomier side — where, if even that is too short, it scrolls inside rather
 * than running off the window.
 */

/** Between the trigger and the menu. */
const GAP = 4;
/** What a menu keeps clear of the window's edges. */
const EDGE = 8;
/** The tallest a menu grows, as a share of the window; past it, it scrolls. */
const MAX_HEIGHT_SHARE = 0.8;

/**
 * A fixed position for the menu. Exactly one of `top` and `bottom` is set:
 * above its trigger, a menu pins its bottom edge, so it grows upward.
 */
export type MenuPlacement = {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
};

export function placeMenu({
  trigger,
  height,
  width,
  align,
  side,
  viewport,
}: {
  trigger: Pick<DOMRect, "top" | "bottom" | "left" | "right">;
  /** The menu's full height, uncapped. */
  height: number;
  width: number;
  align: "left" | "right";
  /** The side it opens on when it fits there. */
  side: "bottom" | "top";
  viewport: { width: number; height: number };
}): MenuPlacement {
  const roomBelow = viewport.height - trigger.bottom - GAP - EDGE;
  const roomAbove = trigger.top - GAP - EDGE;
  const [asked, other] = side === "bottom" ? [roomBelow, roomAbove] : [roomAbove, roomBelow];
  // Too tall for the side it asked for, and the other side has more room.
  const flip = height > asked && other > asked;
  const above = side === "top" ? !flip : flip;
  const left = align === "left" ? trigger.left : trigger.right - width;
  return {
    ...(above ? { bottom: viewport.height - trigger.top + GAP } : { top: trigger.bottom + GAP }),
    left: Math.max(EDGE, Math.min(left, viewport.width - width - EDGE)),
    maxHeight: Math.min(above ? roomAbove : roomBelow, viewport.height * MAX_HEIGHT_SHARE),
  };
}
