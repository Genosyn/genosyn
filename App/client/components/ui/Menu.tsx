import React from "react";
import { createPortal } from "react-dom";
import { clsx } from "./clsx";
import { placeMenu, type MenuPlacement } from "./menuPlacement";

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
 * trigger's bounding rect and the menu's own height (`menuPlacement.ts`).
 * It opens below the trigger; `side="top"` opens it above, for a trigger that
 * sits at the bottom of the screen, like a floating bulk bar. Either way it
 * turns to the other side when only that one has room, so a row's menu at the
 * bottom of a page stays on screen, and it scrolls inside when neither does.
 */
export function Menu({
  trigger,
  children,
  align = "left",
  side = "bottom",
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
  side?: "bottom" | "top";
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
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = React.useState<MenuPlacement | null>(null);

  // The menu is on the page by now, so it can be measured; placing it here
  // re-renders before the browser paints, so it is never seen unplaced.
  React.useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!open || !trigger || !menu) return;
    setPlacement(
      placeMenu({
        trigger: trigger.getBoundingClientRect(),
        // Its full height, past any cap an earlier opening left on it.
        height: menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
        width,
        align,
        side,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    );
  }, [open, align, side, width]);

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
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onMouseDownCapture={markPressInside}
            // Visible, not hidden, while it is measured: a search field inside
            // (the assignee picker's) takes focus with `autoFocus`, which a
            // hidden element refuses.
            style={placement ? { ...placement, width } : { top: 0, left: 0, width }}
            className="fixed z-50 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-900 dark:ring-black/20"
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
    <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
      {children}
    </div>
  );
}
