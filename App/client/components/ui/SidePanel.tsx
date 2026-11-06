import * as React from "react";
import { flushSync } from "react-dom";
import { clsx } from "./clsx";
import {
  draggedWidth,
  fitWidth,
  nudgedWidth,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MAX_WIDTH_IN_ROW,
  RAIL_MIN_WIDTH,
  RAIL_WIDTH_VARIABLE,
  readStoredWidth,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  writeStoredWidth,
  type ResizeEdge,
} from "./sidePanelWidth";

/**
 * The shared behaviour of a column a person can drag: a panel docked to the
 * right of a page or a rail down its left. Its width is set by dragging its
 * inner edge, remembered per column in this browser, and reachable from the
 * keyboard.
 *
 * Every panel and every rail uses it, and they must feel like the same object.
 * See `sidePanelWidth.ts` for the rules.
 */

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The drag itself, for a column whose resize handle is a direct child of it.
 * `width` is what the person asked for; a `max-width` on the column may be
 * holding it narrower for now, which is why both gestures start from what is on
 * screen.
 */
function useDraggableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  edge,
}: {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth?: number;
  edge: ResizeEdge;
}) {
  const [width, setWidth] = React.useState<number>(() =>
    readStoredWidth(browserStorage(), storageKey, defaultWidth, minWidth, maxWidth),
  );
  const [resizing, setResizing] = React.useState(false);

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const column = handle.parentElement;
    if (!column) return;
    e.preventDefault();
    const { pointerId, clientX: startX } = e;
    const startWidth = column.getBoundingClientRect().width;
    handle.setPointerCapture(pointerId);
    setResizing(true);
    /** Stays null through a press that never moves, which changes nothing. */
    let dragged: number | null = null;

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      dragged = fitWidth(draggedWidth(startWidth, ev.clientX - startX, edge), minWidth, maxWidth);
      setWidth(dragged);
    }
    function onEnd(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // capture may already be gone; harmless.
      }
      if (dragged !== null && column?.isConnected) {
        // Keep where the column stopped, not how far the pointer went past
        // that, so nothing is remembered wider than anyone saw it.
        const last = dragged;
        flushSync(() => setWidth(last));
        const settled = Math.round(column.getBoundingClientRect().width);
        setWidth(settled);
        writeStoredWidth(browserStorage(), storageKey, settled);
      }
      setResizing(false);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  function onResizeKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // Narrower than `width` means the layout is holding the column there,
    // unless the last key press is still animating its way to `width`.
    const column = e.currentTarget.parentElement;
    const onScreen =
      column && column.getAnimations().length === 0 ? column.getBoundingClientRect().width : width;
    const next = fitWidth(
      nudgedWidth(Math.min(width, onScreen), e.key, e.shiftKey, edge),
      minWidth,
      maxWidth,
    );
    setWidth(next);
    writeStoredWidth(browserStorage(), storageKey, next);
  }

  return { width, resizing, startResize, onResizeKeyDown };
}

/**
 * A panel docked to the right of a page. Spread `style` on it while it is
 * docked and give it a `SidePanelResizeHandle`. `maxWidth` says what it must
 * leave for the rest of its flex row (see `sidePanelWidth.ts`).
 */
export function useSidePanelWidth(
  storageKey: string,
  {
    defaultWidth = SIDE_PANEL_DEFAULT_WIDTH,
    maxWidth = SIDE_PANEL_MAX_WIDTH,
  }: { defaultWidth?: number; maxWidth?: string } = {},
) {
  const { width, resizing, startResize, onResizeKeyDown } = useDraggableWidth({
    storageKey,
    defaultWidth,
    minWidth: SIDE_PANEL_MIN_WIDTH,
    edge: "left",
  });
  const style: React.CSSProperties = { width, minWidth: SIDE_PANEL_MIN_WIDTH, maxWidth };
  return { style, resizing, startResize, onResizeKeyDown };
}

/**
 * A rail down the left of a page or section, with a handle on its right edge.
 * The rail itself is the child, filling this column with `w-full`, so a rail
 * that scrolls cannot clip the handle. `className` says when it shows.
 *
 * The width lives here rather than in the page, so dragging re-renders this
 * frame and not the rail's contents, and it is read back from storage whenever
 * a page mounts a rail of its own, so moving between sections doesn't move it.
 */
export function ResizableRail({
  storageKey,
  label,
  defaultWidth = RAIL_DEFAULT_WIDTH,
  className,
  children,
}: {
  storageKey: string;
  /** Named for the rail it resizes, so screen readers say which one. */
  label: string;
  defaultWidth?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const { width, resizing, startResize, onResizeKeyDown } = useDraggableWidth({
    storageKey,
    defaultWidth,
    minWidth: RAIL_MIN_WIDTH,
    maxWidth: RAIL_MAX_WIDTH,
    edge: "right",
  });
  const ref = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    row.style.setProperty(RAIL_WIDTH_VARIABLE, `${width}px`);
    return () => {
      row.style.removeProperty(RAIL_WIDTH_VARIABLE);
    };
  }, [width]);

  return (
    <div
      ref={ref}
      className={clsx("relative shrink-0", className)}
      style={{ width, minWidth: RAIL_MIN_WIDTH, maxWidth: RAIL_MAX_WIDTH_IN_ROW }}
    >
      {children}
      <SidePanelResizeHandle
        label={label}
        edge="right"
        onPointerDown={startResize}
        onKeyDown={onResizeKeyDown}
        active={resizing}
      />
    </div>
  );
}

/**
 * Whether the window is wide enough to put a panel *beside* something rather
 * than on top of it. Below this a docked panel and the page it docks to would
 * each get an unusable sliver, so the panel takes the screen instead.
 */
export function useWideViewport(minWidth = 768): boolean {
  const [wide, setWide] = React.useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= minWidth,
  );
  React.useEffect(() => {
    const query = window.matchMedia(`(min-width: ${minWidth}px)`);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [minWidth]);
  return wide;
}

/** The chevron a docked panel collapses itself with. */
export function SidePanelCollapseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  );
}

export function SidePanelResizeHandle({
  label,
  edge = "left",
  onPointerDown,
  onKeyDown,
  active,
}: {
  /** Named for the panel it resizes, so screen readers say which one. */
  label: string;
  /** The side of the column it sits on. */
  edge?: ResizeEdge;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  active: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={clsx(
        "touch-target group absolute top-0 z-10 flex h-full w-2 cursor-col-resize touch-none select-none items-center justify-center",
        edge === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2",
        active && "bg-indigo-500/20",
      )}
      title="Drag to resize"
    >
      {/* Sticky both ways: a panel can be taller than the page that scrolls it,
          and the grip stays in view on its whole length. */}
      <span
        className={
          "pointer-events-none sticky bottom-1/2 top-1/2 h-12 w-0.5 rounded-full transition-colors " +
          (active
            ? "bg-indigo-500"
            : "bg-slate-300 group-hover:bg-indigo-400 group-focus-visible:bg-indigo-400 dark:bg-slate-700")
        }
      />
    </div>
  );
}
