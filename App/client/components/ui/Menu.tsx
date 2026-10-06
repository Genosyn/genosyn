import React from "react";
import { createPortal } from "react-dom";
import { clsx } from "./clsx";

/* ── Escape across open menus and popovers ────────────────────────────────
 *
 * Every open Menu or popover pushes an entry, and one listener closes only the
 * newest, the way `ModalChrome` stacks modals. Each used to bind a window
 * listener of its own, so a menu opened inside a popover took the popover down
 * with it, and a page listener registered earlier (the Base grid clearing its
 * selection) acted on the same Escape before any of them.
 *
 * The listener bubbles on `document`: after anything inside the surface that
 * claims the key (a `Select` closing its list calls `preventDefault`), and
 * before the page's own bubbling `window` listeners. Closing marks the key
 * handled, and page listeners skip an Escape that arrives handled.
 */

const openSurfaces: Array<() => void> = [];

function onEscape(event: KeyboardEvent) {
  // Handled already: by something nearer the focus, or by a modal open on top.
  // Mid-composition, Escape belongs to the IME (see `ModalChrome`).
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  const close = openSurfaces[openSurfaces.length - 1];
  if (!close) return;
  event.preventDefault();
  close();
}

/** Close a menu or popover on Escape, while it is the newest one open. */
export function useCloseOnEscape(open: boolean, onClose: () => void) {
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    // Through the ref, so a parent passing a fresh arrow every render does not
    // re-register the entry — or lose its place at the top of the stack.
    const close = () => closeRef.current();
    openSurfaces.push(close);
    if (openSurfaces.length === 1) document.addEventListener("keydown", onEscape);
    return () => {
      openSurfaces.splice(openSurfaces.indexOf(close), 1);
      if (openSurfaces.length === 0) document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
}

/* ── Presses outside menus and popovers ───────────────────────────────────
 *
 * A menu or popover closes on a mousedown outside it, and outside means outside
 * its React tree, not its DOM node. A Menu portals to document.body, so one
 * opened inside another menu or a popover is no DOM descendant of it: a press
 * on one of its items counted as outside, closed the parent, and unmounted the
 * item before its click could apply the choice.
 *
 * React events bubble along the component tree, through portals, so the
 * surface's root marks every press that passes through it — a nested menu's
 * too — and the window listener, which hears the same press last, lets a
 * marked one go.
 */

/**
 * Close a menu or popover on a press outside it and its trigger. Returns the
 * handler for the surface's root element's `onMouseDownCapture`.
 */
export function useCloseOnPressOutside(
  open: boolean,
  onClose: () => void,
  triggerRef: React.RefObject<HTMLElement>,
) {
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const pressInside = React.useRef<Event | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const inside = event === pressInside.current;
      pressInside.current = null;
      if (inside || triggerRef.current?.contains(event.target as Node)) return;
      closeRef.current();
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, triggerRef]);

  return React.useCallback((event: React.MouseEvent) => {
    pressInside.current = event.nativeEvent;
  }, []);
}

/**
 * Small popover menu, Linear-style. Not a full combobox — pairs with a
 * trigger button supplied by the caller so the same primitive can back
 * status pickers, assignee pickers, filter menus, "more actions" menus, etc.
 *
 * Positioning is fixed-coord relative to the viewport, computed from the
 * trigger's bounding rect. The menu sizes itself (no max-height math) and
 * caps to an 80vh scroll — fine for our lists which max out at ~dozens.
 */
export function Menu({
  trigger,
  children,
  align = "left",
  width = 220,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger: (props: {
    ref: React.RefObject<HTMLButtonElement>;
    onClick: () => void;
    open: boolean;
  }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  width?: number;
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const open = controlledOpen ?? uncontrolled;
  const setOpen = (v: boolean) => {
    // Only skip the internal state when the parent is fully controlling `open`.
    // Passing just `onOpenChange` (as AssigneePicker does to clear its search
    // on close) should still drive the Menu's own open state.
    if (controlledOpen === undefined) setUncontrolled(v);
    onOpenChange?.(v);
  };

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const top = r.bottom + 4;
    const left = align === "left" ? r.left : r.right - width;
    // Clamp horizontally to keep the menu on-screen.
    const maxLeft = window.innerWidth - width - 8;
    setCoords({ top, left: Math.max(8, Math.min(left, maxLeft)) });
  }, [open, align, width]);

  const markPressInside = useCloseOnPressOutside(open, () => setOpen(false), triggerRef);
  useCloseOnEscape(open, () => setOpen(false));

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen(!open),
        open,
      })}
      {open &&
        coords &&
        createPortal(
          <div
            role="menu"
            onMouseDownCapture={markPressInside}
            style={{ top: coords.top, left: coords.left, width }}
            className="fixed z-50 max-h-[80vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Row inside a Menu. Active rows get a light indigo wash + check. Optional
 * shortcut badge on the right (e.g. "1", "⌘K") — purely decorative today.
 */
export function MenuItem({
  onSelect,
  active,
  icon,
  label,
  hint,
  className,
}: {
  onSelect: () => void;
  active?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onSelect}
      className={clsx(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
        className,
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-slate-400 dark:text-slate-500">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-slate-100 dark:bg-slate-800" />;
}

export function MenuHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
      {children}
    </div>
  );
}
