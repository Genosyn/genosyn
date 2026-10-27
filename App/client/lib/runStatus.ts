import type { RunErrorKind, RunStatus, UsageBucket } from "@/lib/api";

/** Old timeout/interrupted rows remain readable as operational Errors. */
export function isRunError(status: RunStatus | undefined): boolean {
  return status === "error" || status === "timeout" || status === "interrupted";
}

export function runNeedsAttention(status: RunStatus | undefined): boolean {
  return status === "failed" || isRunError(status);
}

/** The button that asks Ask AI to explain a Run that went wrong. */
export function runExplanationLabel(status: RunStatus): string {
  return isRunError(status) ? "Why did it error?" : "Why did it fail?";
}

/**
 * The question that button drafts. An Error is an operational failure and
 * Failed means the work was not done, so the question says which it is asking.
 */
export function runExplanationPrompt(status: RunStatus): string {
  return isRunError(status)
    ? "Why did this Run error, and what would stop it happening again?"
    : "Why did this Run fail, and what should change so the next one succeeds?";
}

/**
 * A Run Genosyn paused to restart (an upgrade, a stop) waits in the queue with
 * its transcript and progress, and the same Run continues once Genosyn is back.
 * Its chip reads "resuming", never "paused": a Paused Routine is one switched
 * off, and the chip sits beside that Routine's Active / Paused toggle.
 */
export function isRunPaused(run: { status: RunStatus; pauseCount?: number | null }): boolean {
  return run.status === "queued" && (run.pauseCount ?? 0) > 0;
}

export function runStatusLabel(status: RunStatus, paused = false): string {
  if (status === "queued") return paused ? "resuming" : "pending";
  return isRunError(status) ? "error" : status;
}

export function runStatusHint(
  status: RunStatus,
  errorKind?: RunErrorKind | null,
  paused = false,
): string | undefined {
  if (status === "queued" && paused)
    return "Paused while Genosyn restarted. It keeps its work so far and continues where it stopped as soon as it can start again.";
  if (status === "queued")
    return "Waiting to start: Runs start as their AI Model has room, High priority first. A Standdown can defer this Run; other Routines run independently.";
  if (status === "reviewed")
    return "The proactive review finished. This Run did not carry out the proposed work.";
  if (status === "continued")
    return "This Run saved its progress and handed its unfinished work to a continuation. Open the continuation to see how the work ended.";
  if (status === "failed")
    return "The Run did not complete its intended work. Open the Run log for the reason.";
  if (!isRunError(status)) return undefined;
  if (status === "timeout" || errorKind === "timeout")
    return "The Run encountered an error: it ran out of time before it finished.";
  if (status === "interrupted" || errorKind === "interrupted")
    return "The Run encountered an error: it was interrupted before it finished.";
  return "A model request or runtime problem prevented this Run from finishing. Open the Run log for details.";
}

/**
 * Completed share of delivery Runs. A review delivers nothing, and a hand-off's
 * continuation carries its outcome, so neither is in the denominator.
 */
export function runCompletionRate(
  bucket: Pick<UsageBucket, "runs" | "reviewed" | "completed" | "continued">,
): number | null {
  const deliveryRuns = bucket.runs - (bucket.reviewed ?? 0) - (bucket.continued ?? 0);
  return deliveryRuns > 0 ? Math.round((bucket.completed / deliveryRuns) * 100) : null;
}
