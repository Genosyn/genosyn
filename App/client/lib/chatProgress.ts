/**
 * A durable turn's row carries a progress label the server writes for its own
 * bookkeeping — a one-percent "Starting work" placeholder before the employee
 * reports anything, and the labels of a turn waiting for its thread, resuming
 * after a restart or starting again after a Retry. None of them is a
 * milestone the employee reported, so the chat never draws them as a
 * percentage: the turn's live status already says what is happening.
 */
const SYSTEM_LABELS = new Set([
  "starting work",
  "resuming durable work",
  "waiting for another reply",
  "starting again",
]);

export function isIndeterminateChatProgress(percent: number, label: string): boolean {
  if (percent !== 1) return false;
  return SYSTEM_LABELS.has(label.trim().toLowerCase());
}

/** The employee's own milestone, or null when the row holds a system placeholder. */
export function employeeMilestone(
  progress: { percent: number; label: string } | null | undefined,
): { percent: number; label: string } | null {
  if (!progress) return null;
  return isIndeterminateChatProgress(progress.percent, progress.label) ? null : progress;
}
