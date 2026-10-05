import { Loader2 } from "lucide-react";
import { clsx } from "./clsx";

/** A page or section that is loading. Muted, so it waits quietly. */
export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-slate-400 dark:text-slate-500" />;
}

/**
 * A control whose work is running. Drawn in the control's own text colour,
 * where `Spinner` is a fixed slate, so it reads on an indigo or red button as
 * well as on a quiet one. `<Button loading>` renders it already; reach for it
 * directly only in a hand-rolled `<button>`, in place of that button's icon.
 */
export function ButtonSpinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 aria-hidden size={size} className={clsx("shrink-0 animate-spin", className)} />;
}
