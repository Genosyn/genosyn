import { ChevronsUp } from "lucide-react";
import { clsx } from "@/components/ui/clsx";
import { HIGH_PRIORITY_MARK, HIGH_PRIORITY_TITLE, isHighPriority } from "@/lib/routinePriority";

/**
 * The small mark a High priority Routine, or one of its Runs, carries in a
 * list. Normal is every Routine's default and carries nothing, so the mark
 * only ever points at the few Routines someone moved up.
 */
export function RoutinePriorityChip({
  priority,
  className,
}: {
  priority: unknown;
  className?: string;
}) {
  if (!isHighPriority(priority)) return null;
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300",
        className,
      )}
      title={HIGH_PRIORITY_TITLE}
    >
      <ChevronsUp size={11} aria-hidden="true" />
      {HIGH_PRIORITY_MARK}
      <span className="sr-only"> priority</span>
    </span>
  );
}

/**
 * A waiting Run's place in its company's queue: "Next up", or "#2". Renders
 * nothing when the server gave the Run no place (running, scheduled for later,
 * held by a Standdown).
 */
export function QueuePlaceBadge({
  place,
  className,
}: {
  place: { label: string; description: string; next: boolean } | null;
  className?: string;
}) {
  if (!place) return null;
  return (
    <span
      aria-label={place.description}
      title={place.description}
      className={clsx(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        place.next
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
        className,
      )}
    >
      {place.label}
    </span>
  );
}
