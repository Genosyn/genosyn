/**
 * A Routine's run condition: what must be true for a scheduled time or a
 * Trigger fire to start a Run.
 *
 * The server decides it from its own rows, before any Run exists and without
 * asking an AI Model, so a Routine that has nothing to do costs nothing: no Run
 * row, no model turn, no outcome check. Only automatic starts are decided this
 * way. A person's Run now, a webhook, an approved Approval, a retry and a
 * continuation always start, because somebody or something already decided the
 * work should happen. See `server/services/routineRunConditions.ts`.
 *
 * Pure — no database — so the server and the client read the same rule.
 */

/**
 * Every condition a Routine can have, in the order Settings offers them.
 *
 *   * `always` — every scheduled time and Trigger fire starts a Run (the
 *     default, and every Routine's behaviour before conditions existed).
 *   * `workstream_due` — only when one of the Workstreams this Routine resumes
 *     (the employee's own, unbound or bound to this Routine) has reached the
 *     revisit time the employee planned, and this Routine has not run since.
 */
export const ROUTINE_RUN_CONDITIONS = ["always", "workstream_due"] as const;
export type RoutineRunCondition = (typeof ROUTINE_RUN_CONDITIONS)[number];
export const DEFAULT_ROUTINE_RUN_CONDITION: RoutineRunCondition = "always";

export function isRoutineRunCondition(value: unknown): value is RoutineRunCondition {
  return (ROUTINE_RUN_CONDITIONS as readonly unknown[]).includes(value);
}

/** A condition as stored, with anything unknown or missing read as `always`. */
export function routineRunConditionOf(value: unknown): RoutineRunCondition {
  return isRoutineRunCondition(value) ? value : DEFAULT_ROUTINE_RUN_CONDITION;
}

/** How a schedule reads with its condition, as a phrase to follow it. */
const CONDITION_PHRASE: Record<RoutineRunCondition, string | null> = {
  always: null,
  workstream_due: "only when a Workstream is due",
};

/** "Every 30 minutes, only when a Workstream is due" — or the schedule alone. */
export function scheduleWithRunCondition(schedule: string, condition: unknown): string {
  const phrase = CONDITION_PHRASE[routineRunConditionOf(condition)];
  return phrase ? `${schedule}, ${phrase}` : schedule;
}

/**
 * The starts a run condition decides. Everything else — `manual`, `webhook`,
 * `approval`, `retry`, `continuation` — was asked for by someone, or carries
 * on work that already started, and is never held back by it.
 */
export const CONDITIONED_STARTS = ["schedule", "event"] as const;
export type ConditionedStart = (typeof CONDITIONED_STARTS)[number];

export function runConditionDecides(triggerKind: string): triggerKind is ConditionedStart {
  return (CONDITIONED_STARTS as readonly string[]).includes(triggerKind);
}

/**
 * How far ahead an employee may plan a Workstream's revisit. Far enough for a
 * yearly renewal; a date past it is a mistake, not a plan.
 */
export const WORKSTREAM_REVISIT_MAX_AHEAD_MS = 2 * 366 * 24 * 60 * 60 * 1000;

/**
 * Whether a Workstream is due for a Routine with the `workstream_due`
 * condition.
 *
 * Due means its revisit time has come and the Routine has not looked since.
 * `lookedAt` is when the Routine's latest Run that got going started — a Run
 * that ended in an Error, or never reached its AI Model, did not look. So a
 * revisit is taken up by exactly one Run: an employee that wants another look
 * plans a new revisit, and one that forgets costs a single Run, never one every
 * scheduled time. A Workstream with no revisit planned is never due.
 */
export function workstreamRevisitDue(
  workstream: { status: string; revisitAt: Date | string | null },
  lookedAt: Date | string | null,
  now: Date | number,
): boolean {
  if (workstream.status !== "active" || workstream.revisitAt === null) return false;
  const revisit = new Date(workstream.revisitAt).getTime();
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(revisit) || revisit > nowMs) return false;
  return lookedAt === null || revisit > new Date(lookedAt).getTime();
}
