import type { Run } from "../db/entities/Run.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { readRunCheckpoint } from "./runContinuation.js";

type ContinuationSource = Pick<
  Run,
  "checkpointJson" | "retryAt" | "continuationCount" | "continuationStopReason"
>;

/** Progress bodies stay private; Run views receive only scheduling metadata. */
export function runContinuationView(run: ContinuationSource) {
  return {
    hasUnfinishedWork: readRunCheckpoint(run)?.state === "continue",
    continuationPending: !!run.retryAt && readRunCheckpoint(run)?.state === "continue",
    continuationCount: run.continuationCount ?? 0,
    continuationStopReason: run.continuationStopReason
      ? redactSensitiveText(run.continuationStopReason).slice(0, 2000)
      : null,
  };
}

/** Never leak the saved checkpoint through a route that returns a Run row. */
export function publicRun(run: Run) {
  const {
    checkpointJson: _checkpointJson,
    continuationDeadlineAt: _continuationDeadlineAt,
    continuationTokensUsed: _continuationTokensUsed,
    continuationOriginTriggerKind: _continuationOriginTriggerKind,
    continuationReviewOnly: _continuationReviewOnly,
    diagnosticsJson: _diagnosticsJson,
    requiredToolsJson: _requiredToolsJson,
    ...visible
  } = run;
  return { ...visible, ...runContinuationView(run) };
}
