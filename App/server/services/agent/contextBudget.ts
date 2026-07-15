import type { AgentMessage, ToolResultBlock } from "./types.js";

/**
 * Keeping a run inside its model's context window.
 *
 * Genosyn injects the Soul, every Skill, and the whole tool catalog on every
 * turn, then appends a tool result per step. On a big-window model that's fine;
 * on a 64k self-hosted one the system prompt alone can be half the window, and a
 * couple of chatty tool results (a 50-message inbox listing, 100 CRM rows) take
 * the rest. Without this module the loop would keep appending until the provider
 * rejected the prompt outright, killing the run mid-flight.
 *
 * The strategy is to shrink the oldest tool results — the bulk of a transcript,
 * and the part least likely to matter now — while leaving the routine
 * instruction and recent work intact.
 *
 * ## Why we shrink content instead of dropping messages
 *
 * Both wire formats pair a tool call with its result: Anthropic wants a
 * `tool_result` block for every `tool_use` block, and Chat Completions wants a
 * `role:"tool"` message for every entry in `tool_calls`. Deleting a message
 * would orphan its partner and earn a *different* 400 than the one we're trying
 * to avoid. So compaction is destructive to content only — the shape of the
 * conversation never changes, and every id keeps its counterpart.
 */

/** Replaces an evicted tool result, so the model knows the gap is deliberate. */
const EVICTED_STUB = "[older tool result dropped to fit the context window]";

/**
 * Rough chars-per-token, used only for content we haven't sent yet.
 *
 * Everywhere else in the agent we refuse to estimate tokens locally, because a
 * custom endpoint can serve any weights and we can't know its tokenizer. That
 * rule still holds for anything user-visible: {@link estimateTokens} never
 * decides what a turn *cost* — the provider's own count does that, and we anchor
 * on it (see {@link projectPromptTokens}). We only estimate the delta we're
 * about to append, and only to decide *when* to compact. Being off by 20% means
 * compacting a little early or a little late; the overflow retry in the loop is
 * the backstop for when it's off by more.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Flat per-image cost. Vision models bill by pixel area, not base64 length, so
 * measuring the string would overstate a screenshot by an order of magnitude.
 * This is the honest ballpark for a browser screenshot at our capture sizes.
 */
const IMAGE_TOKENS = 1_500;

/** Share of the window kept free for the model's reply and our estimate error. */
const OUTPUT_RESERVE_SHARE = 0.15;

/** No single tool result may claim more than this share of the window. */
const TOOL_RESULT_WINDOW_SHARE = 0.15;

/** Cap on one tool result when the window is unknown — the historical default. */
export const TOOL_RESULT_CAP_DEFAULT = 60_000;

/** Even a tiny window must leave a result big enough to be worth reading. */
const TOOL_RESULT_CAP_MIN = 8_000;

/**
 * How many of the most recent tool-result batches are never evicted. The model
 * is actively reasoning about these; dropping them would make it re-fetch what
 * it just asked for and spend the window all over again.
 */
const KEEP_RECENT_BATCHES = 2;

/** Ceiling on how many chars of one tool result we keep, given the window. */
export function toolResultCap(contextWindow: number | null): number {
  if (!contextWindow) return TOOL_RESULT_CAP_DEFAULT;
  const chars = contextWindow * TOOL_RESULT_WINDOW_SHARE * CHARS_PER_TOKEN;
  return Math.max(TOOL_RESULT_CAP_MIN, Math.min(TOOL_RESULT_CAP_DEFAULT, Math.floor(chars)));
}

/** The largest prompt we'll send: the window minus room to answer. */
export function promptBudget(contextWindow: number): number {
  return Math.floor(contextWindow * (1 - OUTPUT_RESERVE_SHARE));
}

/** Approximate token cost of text we're about to send. See {@link CHARS_PER_TOKEN}. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Approximate token cost of one message's blocks. */
export function estimateMessageTokens(m: AgentMessage): number {
  let total = 0;
  for (const b of m.content) {
    if (b.type === "text") {
      total += estimateTokens(b.text);
    } else if (b.type === "tool_use") {
      total += estimateTokens(b.name) + estimateTokens(safeJson(b.input));
    } else {
      total += estimateTokens(b.content);
      total += (b.images?.length ?? 0) * IMAGE_TOKENS;
    }
    // Per-block wire overhead (role, ids, framing). Small but not zero, and it
    // compounds across the many small results a long run accumulates.
    total += 8;
  }
  return total;
}

/**
 * Project what the next prompt will cost.
 *
 * `lastPromptTokens` is what the provider actually billed for the previous turn
 * — a real number from a real tokenizer, covering the system prompt, the tool
 * catalog, and everything said so far. We add only our estimate of what has been
 * appended since. That keeps the guesswork proportional to the new content
 * rather than the whole conversation.
 *
 * Returns null when there's no anchor yet (before the first turn completes), in
 * which case the caller has nothing to act on and shouldn't pretend otherwise.
 */
export function projectPromptTokens(
  lastPromptTokens: number | null,
  appended: AgentMessage[],
): number | null {
  if (lastPromptTokens === null) return null;
  let total = lastPromptTokens;
  for (const m of appended) total += estimateMessageTokens(m);
  return total;
}

export type CompactionResult = {
  /** How many tool results we emptied. */
  evicted: number;
  /** Roughly how many tokens that freed. */
  freedTokens: number;
};

/**
 * Shrink the oldest tool results until the projected prompt fits `targetTokens`.
 *
 * Walks oldest-first and empties each evictable tool result's content (and any
 * images) down to {@link EVICTED_STUB}, stopping as soon as the projection fits.
 * Mutates `messages` in place.
 *
 * What is never touched:
 *   - the first user message — that's the routine instruction; without it the
 *     model no longer knows what it was asked to do;
 *   - the last {@link KEEP_RECENT_BATCHES} tool-result batches — the work in
 *     flight;
 *   - assistant prose and tool_use blocks — small, and load-bearing for pairing.
 *
 * `keepRecentBatches` is overridable so the overflow-retry path can compact
 * harder than the routine pre-flight check does.
 */
export function compactMessages(params: {
  messages: AgentMessage[];
  currentTokens: number;
  targetTokens: number;
  keepRecentBatches?: number;
}): CompactionResult {
  const { messages, currentTokens, targetTokens } = params;
  const keepRecent = params.keepRecentBatches ?? KEEP_RECENT_BATCHES;

  const evictable = evictableBlocks(messages, keepRecent);
  let running = currentTokens;
  let evicted = 0;
  let freedTokens = 0;

  for (const block of evictable) {
    if (running <= targetTokens) break;
    const before = estimateTokens(block.content) + (block.images?.length ?? 0) * IMAGE_TOKENS;
    const after = estimateTokens(EVICTED_STUB);
    const freed = before - after;
    // An already-tiny result isn't worth a stub that says nothing useful.
    if (freed <= 0) continue;
    block.content = EVICTED_STUB;
    block.isError = false;
    delete block.images;
    running -= freed;
    freedTokens += freed;
    evicted++;
  }

  return { evicted, freedTokens };
}

/**
 * Tool results eligible for eviction, oldest first.
 *
 * Skips the first message (the instruction), anything already evicted, and the
 * newest `keepRecent` batches — where a "batch" is one user message carrying the
 * results of one assistant turn's tool calls.
 */
function evictableBlocks(messages: AgentMessage[], keepRecent: number): ToolResultBlock[] {
  const batchIndexes: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (m.content.some((b) => b.type === "tool_result")) batchIndexes.push(i);
  }
  const cutoff = Math.max(0, batchIndexes.length - keepRecent);
  const open: ToolResultBlock[] = [];
  for (const i of batchIndexes.slice(0, cutoff)) {
    for (const b of messages[i].content) {
      if (b.type !== "tool_result") continue;
      if (b.content === EVICTED_STUB) continue;
      open.push(b);
    }
  }
  return open;
}

/**
 * Does this provider error mean "your prompt didn't fit"?
 *
 * Both providers report it as a 400 and neither gives us a stable machine-
 * readable code across every OpenAI-compatible server, so we match the shapes we
 * know plus the prose they all converge on. A false negative just means the run
 * fails the way it does today; a false positive costs one wasted retry.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string; error?: { code?: string }; message?: string };
  const code = e.code ?? e.error?.code;
  if (code === "context_length_exceeded" || code === "string_above_max_length") return true;
  const message = typeof e.message === "string" ? e.message : "";
  if (!message) return false;
  return (
    /maximum context length/i.test(message) ||
    /context[_ ]length[_ ]exceeded/i.test(message) ||
    /prompt is too long/i.test(message) ||
    /too many tokens/i.test(message) ||
    /reduce the length of the (input )?prompt/i.test(message) ||
    /exceeds the (model'?s )?context window/i.test(message)
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
