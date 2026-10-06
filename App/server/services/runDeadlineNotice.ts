/**
 * Mid-Run time checks for the model.
 *
 * A Run's deadline is absolute, and its brief states the remaining time once,
 * when the work starts. A fast hosted model finishes long before that matters.
 * A slow or saturated local model can spend most of the budget on a handful of
 * steps, has no clock of its own, and used to run straight into the timeout:
 * the progress it had not saved and the final report it never wrote were lost,
 * and real work was recorded as an Error.
 *
 * Near the deadline, tool results therefore carry a short server-written note
 * saying how much time is left and what to do with it. The note rides beside
 * the tool's own output (`ToolRegistry.resultNotice`), never inside it: the
 * runner logs results verbatim and parses `save_run_checkpoint` replies.
 */

/** The warning window is a fifth of the Run's budget, within these bounds. */
export const DEADLINE_NOTICE_MIN_WINDOW_MS = 2 * 60_000;
export const DEADLINE_NOTICE_MAX_WINDOW_MS = 15 * 60_000;
/** Inside the last minutes every tool result carries the note. */
export const DEADLINE_NOTICE_URGENT_MS = 3 * 60_000;
/** Earlier in the window, at most one note per interval. */
export const DEADLINE_NOTICE_INTERVAL_MS = 2 * 60_000;

export type RunDeadlineNoticeContext = {
  /** Whether this turn can save Run progress with `save_run_checkpoint`. */
  canCheckpoint: boolean;
};

/** Returns the note for the next tool result, or null when none is due. */
export type RunDeadlineNotice = (context: RunDeadlineNoticeContext) => string | null;

export function deadlineNoticeWindowMs(budgetMs: number): number {
  return Math.min(
    DEADLINE_NOTICE_MAX_WINDOW_MS,
    Math.max(DEADLINE_NOTICE_MIN_WINDOW_MS, Math.round(budgetMs / 5)),
  );
}

/**
 * One stateful source of notes for a Run and every turn inside it (the main
 * work, Check remediation, delegated workers), so they share one cadence.
 */
export function createRunDeadlineNotice(args: {
  deadlineAtMs: number;
  /** The Routine's configured budget; sizes the warning window. */
  budgetMs: number;
  now?: () => number;
}): RunDeadlineNotice {
  const now = args.now ?? Date.now;
  const windowMs = deadlineNoticeWindowMs(args.budgetMs);
  let lastNoticeAt: number | null = null;
  return (context) => {
    const at = now();
    const remainingMs = args.deadlineAtMs - at;
    if (remainingMs <= 0 || remainingMs > windowMs) return null;
    const urgent = remainingMs <= DEADLINE_NOTICE_URGENT_MS;
    if (!urgent && lastNoticeAt !== null && at - lastNoticeAt < DEADLINE_NOTICE_INTERVAL_MS) {
      return null;
    }
    lastNoticeAt = at;
    return formatRunDeadlineNotice({
      remainingMs,
      deadlineAtMs: args.deadlineAtMs,
      urgent,
      canCheckpoint: context.canCheckpoint,
    });
  };
}

export function formatRunDeadlineNotice(args: {
  remainingMs: number;
  deadlineAtMs: number;
  urgent: boolean;
  canCheckpoint: boolean;
}): string {
  const clock = `${new Date(args.deadlineAtMs).toISOString().slice(11, 16)} UTC`;
  const save = args.canCheckpoint
    ? "save truthful progress with save_run_checkpoint (through call_tool if it is not in your tool list)"
    : "record what is done and what remains";
  const remaining = remainingClause(args.remainingMs, args.urgent);
  if (args.urgent) {
    return `[Time check] ${remaining} before this Run's hard deadline (${clock}). Start no new work: ${save} now, then write your final report.`;
  }
  return `[Time check] ${remaining} before this Run's hard deadline (${clock}). Work still running at the deadline is stopped, and progress that is not saved is lost. Finish the item in hand, ${save}, and leave time to write your final report. Do not start anything that cannot finish before the deadline.`;
}

function remainingClause(remainingMs: number, urgent: boolean): string {
  if (remainingMs < 60_000) return "Less than a minute remains";
  if (urgent) return `Under ${Math.ceil(remainingMs / 60_000)} minutes remain`;
  const minutes = Math.round(remainingMs / 60_000);
  return `About ${minutes} minute${minutes === 1 ? " remains" : "s remain"}`;
}
