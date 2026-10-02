import type { ToolResult } from "./agent/types.js";
import {
  checkpointAdvanced,
  CONTINUATION_DELAY_MS,
  MAX_RUN_CONTINUATIONS,
  runCheckpointSchema,
  type RunCheckpoint,
} from "./runContinuation.js";

/** Refresh context at a durable checkpoint; this is not a total token limit. */
export const RUN_BATCH_TOKEN_TARGET = 2_000_000;

/**
 * Only a successful, durable checkpoint is a safe batch boundary. Never stop
 * at an arbitrary read/write result and replay an older checkpoint as if it
 * included that work. A complete/blocked checkpoint must finish normally.
 */
export function shouldYieldRunBatch(args: {
  toolName: string;
  result: ToolResult;
  tokensThisRun: number;
  continuationCount: number;
  deadlineAtMs: number;
  canContinue: boolean;
  /** Undefined for an initial Run; a continuation must advance its parent's checkpoint. */
  previousCheckpoint?: RunCheckpoint | null;
  /**
   * The shared time a fresh Run needs to be worth starting; see
   * `minContinuationWindowMs`. Defaults to the bare scheduling delay.
   */
  minWindowMs?: number;
  now?: number;
}): boolean {
  if (
    !args.canContinue ||
    args.toolName !== "save_run_checkpoint" ||
    args.result.isError ||
    args.tokensThisRun < RUN_BATCH_TOKEN_TARGET ||
    args.continuationCount >= MAX_RUN_CONTINUATIONS ||
    args.deadlineAtMs <=
      (args.now ?? Date.now()) + Math.max(CONTINUATION_DELAY_MS, args.minWindowMs ?? 0)
  )
    return false;
  try {
    const result = JSON.parse(args.result.content) as {
      ok?: unknown;
      state?: unknown;
      checkpoint?: unknown;
    };
    const checkpoint = runCheckpointSchema.safeParse(result?.checkpoint);
    if (
      result?.ok !== true ||
      result.state !== "continue" ||
      !checkpoint.success ||
      checkpoint.data.state !== "continue"
    )
      return false;
    // Finalization applies this same progress rule before scheduling a child.
    // Refusing the handoff now leaves time to finish the current source item,
    // rather than aborting work only to discover that no child can resume it.
    return (
      args.previousCheckpoint === undefined ||
      (args.previousCheckpoint !== null &&
        checkpointAdvanced(checkpoint.data, args.previousCheckpoint))
    );
  } catch {
    // A runtime may clip a large serialized checkpoint. Unknown progress must
    // keep this Run alive, never turn a partial tool result into an abort.
    return false;
  }
}

/** Past the batch target, at most one progress check per this many more tokens. */
export const BATCH_NOTICE_INTERVAL_TOKENS = 1_000_000;

/**
 * Remind a long Run to save a checkpoint once a fresh Run could take over.
 *
 * The brief asks for a checkpoint after every batch, and a continue checkpoint
 * past the token target hands the rest to a fresh Run with a short context. A
 * Weekly Customer Expansion Run on Qwen saved none between 1.7M and 12.2M
 * tokens: ten million tokens of turns that each resent a conversation near the
 * model's limit, the slowest work a local model does. Past the target, tool
 * results carry a short reminder, at most once per further million tokens and
 * only while a hand-off is possible.
 */
export function createRunBatchNotice(args: {
  tokens: () => number;
  canHandOff: () => boolean;
}): (context: { canCheckpoint: boolean }) => string | null {
  let dueAt = RUN_BATCH_TOKEN_TARGET;
  return (context) => {
    if (!context.canCheckpoint) return null;
    const used = args.tokens();
    if (used < dueAt || !args.canHandOff()) return null;
    dueAt = used + BATCH_NOTICE_INTERVAL_TOKENS;
    return `[Progress check] This Run has used ${(used / 1_000_000).toFixed(1)}M tokens, and every step resends its whole conversation. At the next safe point, when no parallel work is pending, save a continue checkpoint with save_run_checkpoint (through call_tool if it is not in your tool list): a fresh Run then carries on from it with a short conversation, which is faster. If only your final report remains, write it instead.`;
  };
}

export function runBatchBrief(args: {
  continuationCount: number;
  deadlineAtMs: number;
  now?: number;
}): string {
  const remainingContinuations = Math.max(0, MAX_RUN_CONTINUATIONS - args.continuationCount);
  const remainingMs = args.deadlineAtMs - (args.now ?? Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const deadline = new Date(args.deadlineAtMs).toISOString();
  return [
    "## Work in small batches",
    "There is no total model-token limit or fixed model/tool step limit for this work. Finish promptly when the required work is complete. Otherwise keep making safe progress within the original scope until an actual blocker prevents further useful work, the runtime stops this Run, or the shared deadline requires closing. Work on independent unblocked items before stopping for a blocker; respect current Grants, delivery limits, approval requirements and Standdowns.",
    args.continuationCount === 0
      ? "This is the initial Run in the current time window."
      : `This is continuation ${args.continuationCount} of ${MAX_RUN_CONTINUATIONS} in the current time window.`,
    remainingMs > 0
      ? `Shared absolute deadline: ${deadline} (UTC). Approximately ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"} remained when this brief was prepared; elapsed work and waiting do not reset that boundary. Reserve enough time to save truthful progress and your final report before it. Avoid starting an action that cannot safely finish in the time remaining.`
      : `Shared absolute deadline: ${deadline} (UTC). That deadline has been reached. Record the unfinished work and finish without starting further work or assuming a fresh time allowance.`,
    "Substantively review or process at most five source records or conversations per batch. Compact discovery listings may use the tool's supported bounded page sizes; retry the same page with a smaller limit if its output is truncated. Capture and deduplicate stable IDs and cursors from fully read pages. Record inventory coverage separately from completed substantive review. Read bounded pages and exact entries; keep completed IDs, unresolved items and stable source cursors in each checkpoint. Follow the Routine's stated priority and discovery requirements. Preserve this occurrence's captured scope and retain inherited backlog without letting it replace explicitly required current priority work or urgent commitments. Resume older unfinished items at the priority the Routine requires.",
    "Use save_run_checkpoint after each batch. If the call returns control, keep working on the next useful step while time remains. Saving progress alone is not a reason to end your turn or defer independent required work to the next scheduled occurrence.",
    remainingContinuations > 0
      ? `Up to ${remainingContinuations} automatic continuations may follow this Run, subject to the existing progress, review and time rules. Once this Run uses ${RUN_BATCH_TOKEN_TARGET.toLocaleString("en-US")} tokens, a successful continue checkpoint can hand the work to a fresh Run automatically. Save all progress before that call; do not rely on being able to write a report afterward.`
      : "No automatic continuations remain after this Run. The continuation allowance limits creation of another Run; it does not require ending this active Run. Continue safe useful work within the remaining shared time, checkpointing each batch. Do not stop merely because this is the final continuation or plan another Run to bypass the limit.",
    "A continuation can hand off only after its stable source progressKey and its completed or resume description advance beyond the previous Run's checkpoint. Keep the key truthful to the last fully processed source item; never change it merely to request another Run. An unchanged checkpoint preserves the current Run so you can finish the current item or continue within the remaining time.",
    "The initial Run and its automatic continuations share the same time limit. For a backlog spanning daily occurrences, maintain a linked Workstream with the remaining IDs and original review window; do not repeatedly audit unchanged completed records or expand this occurrence's scope. Never call unfinished required work complete just because a batch ended.",
  ].join("\n");
}
