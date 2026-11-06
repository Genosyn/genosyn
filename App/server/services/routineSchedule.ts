import cron from "node-cron";
import { z } from "zod";
import {
  RANDOM_SCHEDULE_USAGE,
  isRandomScheduleExpr,
  parseRandomSchedule,
} from "../../shared/randomSchedule.js";
import type { Routine } from "../db/entities/Routine.js";
import { countMissedSlots, cronZoneOptions, nextRunFor } from "./cronMath.js";
import { countRandomRuns, nextRandomRun } from "./randomSchedule.js";

/**
 * What a Routine's `cronExpr` may hold, and when it next fires.
 *
 * A Routine alone may hold a random schedule as well as cron
 * (`shared/randomSchedule.ts`), so anything reading a *Routine's* schedule comes
 * through here. `nextRunFor` and `countMissedSlots` stay cron only, which keeps
 * Pipelines, Revenue Signals and recurring invoices from taking one by accident.
 */

type ScheduledRoutine = Pick<Routine, "id" | "cronExpr">;

/**
 * When this Routine next fires after `from`, or null when its schedule can't be
 * worked out. `timeZone` is its company's, as for `nextRunFor`; empty means
 * server time.
 */
export function nextRoutineRun(
  routine: ScheduledRoutine,
  from: Date,
  timeZone: string | null | undefined,
): Date | null {
  const random = parseRandomSchedule(routine.cronExpr);
  return random
    ? nextRandomRun(random, routine.id, from, cronZoneOptions(timeZone).tz)
    : nextRunFor(routine.cronExpr, from, timeZone);
}

/** The occurrences this Routine missed between two moments, as `countMissedSlots` counts them. */
export function countMissedRoutineSlots(
  routine: ScheduledRoutine,
  after: Date,
  until: Date,
  cap: number,
  timeZone: string | null | undefined,
): { count: number; capped: boolean } {
  const random = parseRandomSchedule(routine.cronExpr);
  return random
    ? countRandomRuns(random, routine.id, after, until, cap, cronZoneOptions(timeZone).tz)
    : countMissedSlots(routine.cronExpr, after, until, cap, timeZone);
}

/**
 * What is wrong with an expression as a Routine's schedule, or null if nothing
 * is. `node-cron` validates a cron expression and `cron-parser` schedules it, and
 * the two do not agree: `node-cron` accepts `@annually`, `0 9 1W * *` and
 * `5-1 9 * * *`, which `cron-parser` throws on. Asking only the first saved a
 * Routine with a 200 and a null `nextRunAt`, which the heartbeat never picks up:
 * work somebody believes is scheduled and that silently never happens. So both
 * are asked, and what is accepted is exactly what can be scheduled.
 */
export function routineScheduleProblem(expr: string): string | null {
  if (isRandomScheduleExpr(expr)) {
    return parseRandomSchedule(expr) ? null : RANDOM_SCHEDULE_USAGE;
  }
  if (!cron.validate(expr)) return "Invalid cron expression";
  if (nextRunFor(expr) === null) return "That cron expression cannot be scheduled";
  return null;
}

/** A Routine's `cronExpr` at the API boundary. */
export const routineScheduleSchema = z.string().superRefine((expr, ctx) => {
  const problem = routineScheduleProblem(expr);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});
