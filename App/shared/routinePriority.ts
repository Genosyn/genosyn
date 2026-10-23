/**
 * Routine priority, and the order the Routine queue starts waiting Runs in.
 *
 * The server dispatches waiting Runs in this order and reports each Run's place
 * in it; the client labels it. Pure — no database, and no clock but the one a
 * caller passes in — so both sides read the same rule.
 *
 * The order, first to last:
 *
 *   1. Runs paused for a restart. They were already working when Genosyn
 *      restarted, and resume before anything new starts (AGENTS.md §3).
 *   2. Continuations of Runs that saved their progress: the same occurrence
 *      carrying on.
 *   3. Everything else.
 *
 * Within each group a High priority Run goes before Normal ones, and Runs of
 * the same priority keep the order they joined the queue in. Priority never
 * interrupts a Run that is already working.
 */

/** A Routine's priority. Every Routine is Normal until someone marks it High. */
export const ROUTINE_PRIORITIES = ["normal", "high"] as const;
export type RoutinePriority = (typeof ROUTINE_PRIORITIES)[number];
export const DEFAULT_ROUTINE_PRIORITY: RoutinePriority = "normal";

export function isRoutinePriority(value: unknown): value is RoutinePriority {
  return (ROUTINE_PRIORITIES as readonly unknown[]).includes(value);
}

/**
 * How far ahead of Normal work a High priority Run queues: it is ordered as if
 * it had been waiting this much longer than it has.
 *
 * Read the other way round, this is the starvation bound. A Normal Run that
 * has waited this long counts as High from then on, behind the High Runs that
 * were already waiting when it did. High work that keeps an AI Model busy all
 * day can hold Normal work back by a day, never for good.
 */
export const HIGH_PRIORITY_HEAD_START_MS = 24 * 60 * 60 * 1000;

/** What the queue knows about a waiting Run when it decides the order. */
export type QueuedRunOrderFields = {
  id: string;
  /** When the Run joined the queue. */
  createdAt: Date | string;
  /** Above zero: the Run was paused for a restart and waits to resume. */
  pauseCount: number;
  /** Above zero: a continuation of a Run that saved its progress. */
  continuationCount: number;
  /** Its Routine's priority, read when the order is decided. */
  priority: RoutinePriority;
};

/** Which group a waiting Run is in: work already under way goes first. */
export type QueueStage = "resuming" | "continuing" | "new";

const STAGE_RANK: Record<QueueStage, number> = { resuming: 0, continuing: 1, new: 2 };

export function queueStage(run: Pick<QueuedRunOrderFields, "pauseCount" | "continuationCount">): QueueStage {
  if ((run.pauseCount ?? 0) > 0) return "resuming";
  if ((run.continuationCount ?? 0) > 0) return "continuing";
  return "new";
}

/** Milliseconds, with an unreadable time sorting after every readable one. */
function queuedAtMs(createdAt: Date | string): number {
  const ms = new Date(createdAt).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The time a Run is ordered by within its group: when it joined the queue, less
 * the head start for a High Run. Never depends on the current time, so the
 * order between two waiting Runs never flips while they wait.
 */
export function queueOrderTime(run: Pick<QueuedRunOrderFields, "createdAt" | "priority">): number {
  const at = queuedAtMs(run.createdAt);
  return run.priority === "high" ? at - HIGH_PRIORITY_HEAD_START_MS : at;
}

/** Negative when `a` starts before `b`. A total order: ties fall back to the Run id. */
export function compareQueuedRuns(a: QueuedRunOrderFields, b: QueuedRunOrderFields): number {
  return (
    STAGE_RANK[queueStage(a)] - STAGE_RANK[queueStage(b)] ||
    queueOrderTime(a) - queueOrderTime(b) ||
    queuedAtMs(a.createdAt) - queuedAtMs(b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** A copy of `runs` in the order the queue starts them. */
export function orderQueuedRuns<T extends QueuedRunOrderFields>(runs: readonly T[]): T[] {
  return [...runs].sort(compareQueuedRuns);
}

/**
 * Whether a Normal Run has waited long enough to count as High. Only says why
 * a Normal Run moved up; the order itself never needs the clock.
 */
export function waitedIntoHighPriority(
  run: Pick<QueuedRunOrderFields, "createdAt" | "priority">,
  now: Date | number,
): boolean {
  if (run.priority === "high") return false;
  const nowMs = typeof now === "number" ? now : now.getTime();
  return nowMs - queuedAtMs(run.createdAt) >= HIGH_PRIORITY_HEAD_START_MS;
}
