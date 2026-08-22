import * as React from "react";
import {
  clampSidePanelWidth,
  initialSidePanelWidth,
  nudgedSidePanelWidth,
  writeStoredSidePanelWidth,
  SIDE_PANEL_DEFAULT_WIDTH,
} from "./sidePanelWidth";

/**
 * The shared behaviour of a panel docked to the right of a page: a width the
 * reader sets by dragging its left edge, remembered per panel, kept sensible
 * when the window changes size, and reachable from the keyboard.
 *
 * Two surfaces use it — the live browser and repository work, side by side in
 * chat — and they must feel like the same object. See `sidePanelWidth.ts` for
 * the arithmetic.
 */

function viewportWidth(): number | null {
  return typeof window === "undefined" ? null : window.innerWidth;
}

export function useSidePanelWidth(storageKey: string, defaultWidth = SIDE_PANEL_DEFAULT_WIDTH) {
  // Fitted at mount, not only on resize: a width dragged out on a large
  // monitor is remembered, and seeding it raw would open the panel far too
  // wide the next time the same person opens chat on a laptop.
  const [width, setWidth] = React.useState<number>(() =>
    initialSidePanelWidth(
      typeof window === "undefined" ? null : window.localStorage,
      storageKey,
      defaultWidth,
      viewportWidth(),
    ),
  );
  const [resizing, setResizing] = React.useState(false);

  // Re-clamp whenever the window resizes, so a once-comfortable panel doesn't
  // end up squeezing the page after the viewport shrinks.
  React.useEffect(() => {
    function onResize() {
      setWidth((current) => clampSidePanelWidth(current, viewportWidth()));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persist = React.useCallback(
    (next: number) => {
      writeStoredSidePanelWidth(
        typeof window === "undefined" ? null : window.localStorage,
        storageKey,
        next,
      );
    },
    [storageKey],
  );

  /**
   * Drag to resize. The handle sits on the panel's left edge, so as the cursor
   * moves left the panel grows; the math is just `panelRight - cursorX`.
   */
  const startResize = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      setResizing(true);

      function onMove(ev: PointerEvent) {
        setWidth(clampSidePanelWidth(window.innerWidth - ev.clientX, viewportWidth()));
      }
      function onUp(ev: PointerEvent) {
        setResizing(false);
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          // capture may already be gone; harmless.
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setWidth((current) => {
          const clamped = clampSidePanelWidth(current, viewportWidth());
          persist(clamped);
          return clamped;
        });
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [persist],
  );

  const onResizeKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setWidth((current) => {
        const next = nudgedSidePanelWidth(
          current,
          e.key as "ArrowLeft" | "ArrowRight",
          e.shiftKey,
          viewportWidth(),
        );
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return { width, resizing, startResize, onResizeKeyDown };
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
  onPointerDown,
  onKeyDown,
  active,
}: {
  /** Named for the panel it resizes, so screen readers say which one. */
  label: string;
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
      className={
        "group absolute left-0 top-0 z-10 flex h-full w-2 -translate-x-1/2 cursor-col-resize select-none items-center justify-center focus:outline-none " +
        (active ? "bg-indigo-500/20" : "")
      }
      title="Drag to resize"
    >
      <span
        className={
          "pointer-events-none h-12 w-0.5 rounded-full transition-colors " +
          (active
            ? "bg-indigo-500"
            : "bg-slate-300 group-hover:bg-indigo-400 group-focus-visible:bg-indigo-400 dark:bg-slate-700")
        }
      />
    </div>
  );
}
