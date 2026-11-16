/**
 * How the app talks about a Routine's run condition and a Workstream's revisit.
 * The rule itself is decided on the server (`shared/routineRunCondition.ts`,
 * read by `server/services/routineRunConditions.ts`); these only turn what the
 * server sends into the words on screen, so the Overview, Settings and the
 * Proactive pages say the same thing. Pure, with the clock passed in.
 */
import {
  routineRunConditionOf,
  scheduleWithRunCondition,
  type RoutineRunCondition,
} from "../../shared/routineRunCondition";
import type { RoutineRunConditionStatus } from "./api";

export { routineRunConditionOf, scheduleWithRunCondition, type RoutineRunCondition };

/** The choices Routine settings offers, in the order it shows them. */
export const RUN_CONDITION_OPTIONS: ReadonlyArray<{
  value: RoutineRunCondition;
  label: string;
}> = [
  { value: "always", label: "Every time" },
  { value: "workstream_due", label: "When a Workstream is due" },
];

/** What the Overview calls the condition, next to the schedule. */
export function runConditionLabel(condition: unknown): string {
  return routineRunConditionOf(condition) === "workstream_due"
    ? "Only when a Workstream is due"
    : "Every time";
}

/** What the setting does, under the control. */
export function runConditionHelp(condition: unknown, employeeName?: string | null): string {
  const whose = employeeName ? `${employeeName}’s` : "the employee’s";
  return routineRunConditionOf(condition) === "workstream_due"
    ? `A scheduled time or Trigger starts a Run only when one of ${whose} Workstreams has reached the revisit time it planned. Genosyn looks without the AI Model, so a time with nothing due starts no Run and costs nothing. Run now always runs.`
    : "Every scheduled time and Trigger starts a Run. Choose When a Workstream is due for work that only matters when something is waiting, such as following up on open work.";
}

/** "in 3h", "3m ago", "just now": a short distance from `now`. */
export function relativeTime(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  const future = ms > 0;
  const minutes = Math.round(Math.abs(ms) / 60_000);
  let span: string;
  if (minutes < 1) return future ? "in under a minute" : "just now";
  if (minutes < 60) span = `${minutes}m`;
  else if (minutes < 60 * 24) span = `${Math.round(minutes / 60)}h`;
  else span = `${Math.round(minutes / (60 * 24))}d`;
  return future ? `in ${span}` : `${span} ago`;
}

/** A Workstream's revisit, as one short phrase for its card. */
export function revisitPhrase(revisitAt: string | null, now: number): string {
  if (!revisitAt) return "No revisit planned";
  const when = relativeTime(revisitAt, now);
  if (new Date(revisitAt).getTime() > now) return `Revisit ${when}`;
  return when === "just now" ? "Revisit due now" : `Revisit due since ${when}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** What the Overview says about a conditioned Routine right now. */
export type RunConditionSummary = {
  /** `due` — the next scheduled time starts a Run; `idle` — it starts none. */
  state: "due" | "idle";
  headline: string;
  /** Further lines, most useful first. */
  details: string[];
};

export function summarizeRunConditionStatus(
  status: RoutineRunConditionStatus,
  now: number,
): RunConditionSummary {
  const details: string[] = [];
  const due = status.dueWorkstreams.length;
  if (status.due) {
    for (const workstream of status.dueWorkstreams.slice(0, 3)) {
      details.push(`“${workstream.title}” · due ${relativeTime(workstream.revisitAt, now)}`);
    }
    if (due > 3) details.push(`and ${due - 3} more`);
  } else if (status.nextRevisit) {
    details.push(
      `Next revisit: “${status.nextRevisit.title}” ${relativeTime(status.nextRevisit.revisitAt, now)}`,
    );
  } else {
    details.push("No revisit is planned, so it waits until the employee plans one.");
  }
  if (status.nothingDueCount > 0 && status.nothingDueAt) {
    const looked = status.nothingDueCount;
    details.push(
      `Since its last Run, Genosyn looked ${looked === 1 ? "once" : `${looked} times`} and found nothing due — ${plural(looked, "no Run, no AI Model turn", "no Runs, no AI Model turns")}. Last looked ${relativeTime(status.nothingDueAt, now)}.`,
    );
  }
  if (status.unplanned > 0) {
    details.push(
      `${status.unplanned} open ${plural(status.unplanned, "Workstream has", "Workstreams have")} no revisit planned and won’t start it.`,
    );
  }
  return {
    state: status.due ? "due" : "idle",
    headline: status.due
      ? `${due} ${plural(due, "Workstream is", "Workstreams are")} due — the next scheduled time starts a Run`
      : "Nothing is due — scheduled times start no Run",
    details,
  };
}
