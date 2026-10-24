import { ChevronsUp } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
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
    <Badge tone="accent" className={className} title={HIGH_PRIORITY_TITLE} icon={<ChevronsUp />}>
      {HIGH_PRIORITY_MARK}
      <span className="sr-only"> priority</span>
    </Badge>
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
    <Badge
      aria-label={place.description}
      title={place.description}
      tone={place.next ? "success" : "neutral"}
      className={clsx("tabular-nums", className)}
    >
      {place.label}
    </Badge>
  );
}
