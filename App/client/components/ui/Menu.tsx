import React from "react";
import { clsx } from "./clsx";

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
    if (onOpenChange) onOpenChange(v);
    else setUncontrolled(v);
  };

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
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

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen(!open),
        open,
      })}
      {open && coords && (
        <div
          ref={menuRef}
          role="menu"
          style={{ top: coords.top, left: coords.left, width }}
          className="fixed z-50 max-h-[80vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
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
        active ? "bg-indigo-50 text-indigo-700" : "text-slate-700 hover:bg-slate-100",
        className,
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-slate-400">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-slate-100" />;
}

export function MenuHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
      {children}
    </div>
  );
}
