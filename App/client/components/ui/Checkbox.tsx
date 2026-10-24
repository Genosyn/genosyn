import React from "react";
import { clsx } from "./clsx";

/**
 * Checkbox that can render the "some but not all" state.
 *
 * `indeterminate` exists only as a DOM property — there is no attribute for it —
 * so it has to be written through a ref rather than passed as a prop. Every
 * select-all header in the app needs that, which is why this lives here rather
 * than being re-derived per page.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  disabled,
  title,
  label,
  onChange,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  title?: string;
  /** Accessible name — these sit in dense rows with no visible label. */
  label: string;
  /** Receives the event so callers can read modifiers (shift-click ranges). */
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  className?: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    // A finger-sized target around the 16px box (`touch-target`, on touch
    // screens) that takes no more room. Not a <label>: callers often sit the
    // box inside their own label, and labels must not nest.
    <span
      className="touch-target relative inline-flex shrink-0"
      onClick={(event) => {
        // Rows are usually clickable themselves; ticking a box must not also
        // open whatever is underneath it.
        event.stopPropagation();
        if (event.target === ref.current || disabled) return;
        // A press beside the box, inside its target: tick the box, once —
        // and not again through a label the box sits in.
        event.preventDefault();
        ref.current?.click();
      }}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        title={title}
        aria-label={label}
        onChange={onChange}
        onClick={(event) => event.stopPropagation()}
        className={clsx(
          // A native box, tinted with the accent. The global focus outline
          // (styles/index.css) draws its keyboard focus.
          "h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-indigo-600",
          "disabled:cursor-not-allowed disabled:opacity-40",
          "dark:border-slate-600 dark:bg-slate-900 dark:accent-indigo-500",
          className,
        )}
      />
    </span>
  );
}
