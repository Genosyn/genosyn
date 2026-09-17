import type { RunErrorKind, RunStatus } from "@/lib/api";

/** Old timeout/interrupted rows remain readable as operational Errors. */
export function isRunError(status: RunStatus | undefined): boolean {
  return status === "error" || status === "timeout" || status === "interrupted";
}

export function runNeedsAttention(status: RunStatus | undefined): boolean {
  return status === "failed" || isRunError(status);
}

export function runStatusLabel(status: RunStatus): string {
  return isRunError(status) ? "error" : status;
}

export function runStatusHint(
  status: RunStatus,
  errorKind?: RunErrorKind | null,
): string | undefined {
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
