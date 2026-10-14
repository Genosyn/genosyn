import type { Goal } from "./api";

/**
 * The company's Goal as one short line, for the places that show it without
 * the Goals page around it: the setup guide and Home.
 */

/**
 * The Goal the company is steering by: the oldest active one at the top of the
 * tree. The Goals route lists oldest first, and this is the same Goal the
 * server counts as direction (`server/services/companyDirection.ts`) and
 * quotes in a starter Routine's brief.
 */
export function primaryGoal<T extends Pick<Goal, "status" | "parentGoalId">>(
  goals: readonly T[],
): T | null {
  return goals.find((goal) => goal.status === "active" && goal.parentGoalId === null) ?? null;
}

function formatValue(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString();
}

/**
 * Where the Goal stands, in words: "12 of 50 customers", or "Target 50
 * customers" before anything has been reported against it.
 */
export function goalStandingLine(
  goal: Pick<Goal, "currentValue" | "targetValue" | "unit" | "direction">,
): string {
  const unit = goal.unit ? ` ${goal.unit}` : "";
  if (goal.currentValue === null) {
    return `${goal.direction === "decrease_to" ? "Down to" : "Target"} ${formatValue(goal.targetValue)}${unit}`;
  }
  return `${formatValue(goal.currentValue)} of ${formatValue(goal.targetValue)}${unit}`;
}

/** The bar's fill, 0 to 1, or null when the Goal has no honest progress yet. */
export function goalBarFill(goal: Pick<Goal, "progress">): number | null {
  if (goal.progress === null || !Number.isFinite(goal.progress)) return null;
  return Math.min(1, Math.max(0, goal.progress));
}
