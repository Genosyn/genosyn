/**
 * How full a model's context window is, right now.
 *
 * The numerator is always the provider's own count for the prompt it just
 * billed (see {@link ../types.TurnUsage}). We never estimate it locally: a
 * custom endpoint can serve any weights, so we cannot know its tokenizer, and a
 * guessed number rendered as a percentage in front of a human is worse than no
 * number at all. `contextBudget.ts` may estimate the delta it is about to
 * append because it only has to decide *when* to compact; nothing user-visible
 * gets that latitude.
 *
 * The denominator is `AIModel.contextWindow`, which is often unknown — many
 * OpenAI-compatible servers publish nothing, and an OpenAI subscription model
 * never reports one. `percent` is null in that case rather than defaulted, so
 * every surface has to decide what to say instead of quietly implying a ceiling
 * nobody told us about.
 *
 * One caveat worth knowing before writing copy around this number: the stored
 * window is not the same quantity on every provider. Anthropic reports
 * `max_input_tokens` (the prompt budget alone), while a local server reports
 * `max_model_len` / `n_ctx` (prompt plus reply). The share is honest on both,
 * but it is a share of slightly different things, so keep the wording
 * approximate.
 */

/** One provider-counted reading of how much of the window the prompt occupies. */
export type ContextUsage = {
  /** Prompt tokens the provider billed for the most recent model turn. */
  promptTokens: number;
  /** The model's window, or null when it was never probed or set by hand. */
  contextWindow: number | null;
  /** `promptTokens` as a share of the window; null when the window is unknown. */
  percent: number | null;
};

/**
 * Warn once the prompt is using this share of the window — just under the point
 * where the loop starts compacting (`contextBudget.promptBudget` reserves 15%),
 * so a human sees the squeeze building before they see history being dropped.
 *
 * Shared by the Run transcript and the chat badge on purpose: two surfaces
 * describing the same model disagreeing about what "nearly full" means is a bug
 * report waiting to happen.
 */
export const CONTEXT_WARN_PCT = 80;

/**
 * Share of the window this prompt occupies, or null when we can't say.
 *
 * Deliberately not clamped at 100: a window set too low by hand is a real
 * misconfiguration, and rounding it down to a comfortable-looking 100% would
 * hide the one case where the human needs to go fix the number. Callers drawing
 * a bar clamp the *width*, not the value.
 */
export function contextUsagePercent(
  promptTokens: number,
  contextWindow: number | null,
): number | null {
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return null;
  // A zero or negative window is not a ceiling, it's a missing one.
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.round((promptTokens / contextWindow) * 100);
}

/** Bundle one turn's prompt count with the window it has to fit inside. */
export function contextUsage(promptTokens: number, contextWindow: number | null): ContextUsage {
  const window = contextWindow && contextWindow > 0 ? contextWindow : null;
  return {
    promptTokens,
    contextWindow: window,
    percent: contextUsagePercent(promptTokens, window),
  };
}

/** True once the prompt is close enough to the ceiling to be worth flagging. */
export function isContextUsageHigh(percent: number | null): boolean {
  return percent !== null && percent >= CONTEXT_WARN_PCT;
}
