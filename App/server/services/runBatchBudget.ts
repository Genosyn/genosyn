import type { ToolResult } from "./agent/types.js";
import {
  CONTINUATION_DELAY_MS,
  CONTINUATION_TOKEN_LIMIT,
  MAX_RUN_CONTINUATIONS,
} from "./runContinuation.js";

/** Leave room for fresh-context continuations within the same allowance. */
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
  previousTokens: number;
  continuationCount: number;
  deadlineAtMs: number;
  canContinue: boolean;
  now?: number;
}): boolean {
  if (
    !args.canContinue ||
    args.toolName !== "save_run_checkpoint" ||
    args.result.isError ||
    args.tokensThisRun < RUN_BATCH_TOKEN_TARGET ||
    args.previousTokens + args.tokensThisRun >= CONTINUATION_TOKEN_LIMIT ||
    args.continuationCount >= MAX_RUN_CONTINUATIONS ||
    args.deadlineAtMs <= (args.now ?? Date.now()) + CONTINUATION_DELAY_MS
  )
    return false;
  try {
    const result = JSON.parse(args.result.content) as { ok?: unknown; state?: unknown };
    return result?.ok === true && result.state === "continue";
  } catch {
    return false;
  }
}

export function runAllowanceBrief(previousTokens: number): string {
  const remaining = Math.max(0, CONTINUATION_TOKEN_LIMIT - previousTokens);
  return [
    "## Work in small batches",
    `This allowance has ${remaining.toLocaleString("en-US")} model tokens remaining, including repeated input and cached context.`,
    "Review at most five source records or conversations per batch. Read bounded pages and exact entries; keep completed IDs, unresolved items and stable source cursors in each checkpoint. Resume older unfinished work before collecting newer work.",
    `Use save_run_checkpoint after each batch. Once this Run uses ${RUN_BATCH_TOKEN_TARGET.toLocaleString("en-US")} tokens, a successful continue checkpoint can hand the work to a fresh Run automatically. Save all progress before that call; do not rely on being able to write a report afterward.`,
    "The initial Run and its automatic continuations share the same time and token limits. For a backlog spanning daily occurrences, maintain a linked Workstream with the remaining IDs and original review window; do not repeatedly audit unchanged completed records or expand this occurrence's scope. Never call unfinished required work complete just because a batch ended.",
  ].join("\n");
}
