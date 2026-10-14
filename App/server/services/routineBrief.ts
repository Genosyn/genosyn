import type { Routine } from "../db/entities/Routine.js";
import { registerRoutine } from "./cron.js";
import { isUnwrittenRoutineBrief, routineTemplate } from "./files.js";

/**
 * A Routine's brief and its on/off switch, where the two meet.
 *
 * A Routine created without a brief starts paused: until someone writes what
 * each Run should do, a scheduled Run could only act on the starter outline.
 * The first brief written into it switches it on, so finishing the Routine is
 * one save rather than a save and a separate switch nobody is told about.
 */

/**
 * The brief and switch a new Routine starts with. A brief that says something
 * is its body and the Routine starts on. Without one (omitted, blank, or the
 * starter outline left as it is) it holds the starter outline and waits paused,
 * and the first brief written into it switches it on ({@link writeRoutineBrief}).
 * The caller schedules it with `registerRoutine`, which leaves a paused
 * Routine with nothing scheduled.
 */
export function startingRoutineBrief(routine: {
  name: string;
  cronExpr: string;
  brief?: string | null;
}): { body: string; enabled: boolean } {
  const body = routine.brief?.trim()
    ? routine.brief
    : routineTemplate(routine.name, routine.cronExpr);
  return { body, enabled: !isUnwrittenRoutineBrief(body) };
}

/** Paused with its brief still unwritten: switched on by the first brief. */
export function awaitingRoutineBrief(routine: Pick<Routine, "enabled" | "body">): boolean {
  return !routine.enabled && isUnwrittenRoutineBrief(routine.body);
}

/**
 * Replace a Routine's brief. The first brief written into a Routine awaiting
 * one also switches it on and schedules its next Run, on the clock of the
 * company's `timeZone` (`company.timezone`, "" for server time); every other
 * save leaves the switch where it is. Returns whether this save switched it on.
 * The caller persists the Routine.
 */
export function writeRoutineBrief(routine: Routine, brief: string, timeZone: string): boolean {
  const switchesOn = awaitingRoutineBrief(routine) && !isUnwrittenRoutineBrief(brief);
  routine.body = brief;
  if (switchesOn) {
    routine.enabled = true;
    registerRoutine(routine, timeZone);
  }
  return switchesOn;
}
