/**
 * How the app talks about a Routine's priority and a waiting Run's place in
 * the queue. The order itself is decided on the server
 * (`shared/routinePriority.ts`, read by `server/services/routineQueueOrder.ts`);
 * these only turn what the server sends into the words and marks on screen, so
 * the Running page, the employee's day and Routine settings say the same thing.
 */
import {
  DEFAULT_ROUTINE_PRIORITY,
  HIGH_PRIORITY_HEAD_START_MS,
  isRoutinePriority,
  waitedIntoHighPriority,
  type RoutinePriority,
} from "../../shared/routinePriority";

export { DEFAULT_ROUTINE_PRIORITY, HIGH_PRIORITY_HEAD_START_MS, type RoutinePriority };

/** A priority as stored, with anything unknown or missing read as Normal. */
export function routinePriorityOf(value: unknown): RoutinePriority {
  return isRoutinePriority(value) ? value : DEFAULT_ROUTINE_PRIORITY;
}

export function isHighPriority(value: unknown): boolean {
  return routinePriorityOf(value) === "high";
}

/** The head start, as words: "a day". */
export function headStartWords(ms: number = HIGH_PRIORITY_HEAD_START_MS): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours === 24) return "a day";
  if (hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** The choices Routine settings offers, in the order it shows them. */
export const ROUTINE_PRIORITY_OPTIONS: ReadonlyArray<{
  value: RoutinePriority;
  label: string;
}> = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

/** What the Priority setting does, under the control. */
export function routinePriorityHelp(priority: RoutinePriority): string {
  const rest =
    `Runs paused for a restart and continuations of unfinished work still go first, and a ` +
    `Normal Run that has waited ${headStartWords()} moves up with High ones, so nothing waits forever.`;
  return priority === "high"
    ? `This Routine's Runs start before Normal ones whenever they wait for their AI Model. ${rest}`
    : `Runs wait for their AI Model in the order they were queued. High puts this Routine's Runs ahead of Normal ones. ${rest}`;
}

/** The short mark a High priority Routine or Run carries in a list. */
export const HIGH_PRIORITY_MARK = "High";

/** The mark's tooltip. */
export const HIGH_PRIORITY_TITLE =
  "High priority: this Routine's Runs start before Normal ones waiting for the same AI Model.";

/** "1st", "2nd", "3rd", "4th", … "11th", "12th", "13th", "21st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export type QueuePlace = {
  /** What the badge reads: "Next up", or "#2". */
  label: string;
  /** For assistive technology and the tooltip. */
  description: string;
  next: boolean;
};

/**
 * A waiting Run's place in its company's queue, as a badge. Null when the Run
 * has no place to show: the server sent none (it is running, scheduled for
 * later, held by a Standdown), or it came from a server that predates queue
 * positions.
 */
export function queuePlace(position: number | null | undefined): QueuePlace | null {
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) return null;
  if (position === 1) {
    return {
      label: "Next up",
      description: "Queue position 1: next to start when its AI Model has room",
      next: true,
    };
  }
  return {
    label: `#${position}`,
    description: `Queue position ${position}: ${ordinal(position)} in line to start`,
    next: false,
  };
}

/**
 * Why a waiting Normal Run sits among High priority work: it has waited long
 * enough to move up. Null for anything else.
 */
export function movedUpNote(
  run: { priority?: unknown; queuedAt?: string | null },
  now: Date | number | string,
): string | null {
  const nowMs =
    typeof now === "string" ? Date.parse(now) : typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(nowMs) || !run.queuedAt || !Number.isFinite(Date.parse(run.queuedAt)))
    return null;
  return waitedIntoHighPriority(
    { priority: routinePriorityOf(run.priority), createdAt: run.queuedAt },
    nowMs,
  )
    ? `Waited over ${headStartWords()}, so it now goes ahead of Normal work`
    : null;
}

/** The one line over a queue that says what its order is. */
export const QUEUE_ORDER_NOTE = "In start order · High priority first";
