import type { RunErrorKind, RunStatus } from "@/lib/api";

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

export function runStatusLabel(status: RunStatus): string {
  if (status === "queued") return "pending";
  return isRunError(status) ? "error" : status;
}

export function runStatusHint(
  status: RunStatus,
  errorKind?: RunErrorKind | null,
): string | undefined {
  if (status === "queued")
    return "Waiting to start. A Standdown can defer this Run; other Routines run independently.";
  if (status === "reviewed")
    return "The proactive review finished. This Run did not carry out the proposed work.";
  if (status === "failed")
    return "The Run did not complete its intended work. Open the Run log for the reason.";
  if (!isRunError(status)) return undefined;
  if (status === "timeout" || errorKind === "timeout")
    return "The Run encountered an error: it ran out of time before it finished.";
  if (status === "interrupted" || errorKind === "interrupted")
    return "The Run encountered an error: it was interrupted before it finished.";
  return "A model request or runtime problem prevented this Run from finishing. Open the Run log for details.";
}
