import type { ModelEffort } from "../../../shared/modelEffort.js";
import { modelThinkingProfile, type EffortModel } from "../modelEffort.js";

/**
 * How a turn's thinking level becomes each runtime's real parameters.
 *
 * OpenCode receives them as the model's options, which its bundled AI SDK
 * providers turn into the request body — checked against a fake upstream in
 * `opencodeIntegration.test.ts`:
 *
 *   | AI Model                         | Level        | Request body                                   |
 *   | -------------------------------- | ------------ | ---------------------------------------------- |
 *   | OpenAI (Responses API)           | any          | `reasoning: { effort, summary: "auto" }`        |
 *   | Claude 4.6+ (adaptive thinking)  | Off          | nothing: it does not think                     |
 *   |                                  | Low … Max    | `thinking: { type: "adaptive", display:         |
 *   |                                  |              | "summarized" }`, `output_config: { effort }`   |
 *   | Claude Opus 4.5                  | Low … High   | `output_config: { effort }` + a thinking budget |
 *   | Older Claude (thinking budget)   | Low … Max    | `thinking: { type: "enabled", budget_tokens }` |
 *   | Custom endpoint, levels turned on| Off … High   | `reasoning_effort`                              |
 *
 * The Codex app-server takes `effort` and `summary` on `turn/start`.
 *
 * Every level that thinks also asks for the thinking to come back readable —
 * a reasoning summary on OpenAI and Codex, `display: "summarized"` on Claude,
 * whose newer models otherwise return empty thinking blocks — so the chat's
 * activity shows what the AI Model considered. Nothing here widens what a turn
 * may do: only how hard the model thinks, and whether it shows its summary.
 */

/**
 * Response ceiling while Claude thinks adaptively. Thinking counts against
 * `max_tokens`, so the 8K a reply otherwise gets would cut a hard thought off
 * before the answer; every Claude model with adaptive thinking takes 64K or
 * more.
 */
export const ADAPTIVE_THINKING_OUTPUT_LIMIT = 32_000;

/**
 * Thinking budgets for Claude models that take `budget_tokens` (at least
 * 1,024). The AI SDK adds the budget to the response ceiling (8K), so the
 * largest stays under the 32K Claude Opus 4 and 4.1 accept in all. Those
 * models offer Low, Medium, High and Max; the rest only keep a level that
 * reached them from being dropped.
 */
export const THINKING_BUDGETS: Record<Exclude<ModelEffort, "none">, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 20_480,
  max: 23_552,
  ultra: 23_552,
};

/** What OpenCode's config gets for one turn's thinking level. */
export type OpenCodeThinking = {
  /** Merged into the model's OpenCode options (the AI SDK provider options). */
  options: Record<string, unknown>;
  /** A response ceiling to use instead of the default, when thinking needs room. */
  outputLimit?: number;
};

/** A level reached the runtime for an AI Model with no way to take one. */
export class ThinkingLevelError extends Error {}

/** Whether the turn asks for readable thinking when it runs at the model's own default. */
export type ThinkingOptions = {
  /**
   * Ask for the thinking summary even when no level is sent. Chat sets it so
   * its activity shows what the model considered; Routines leave it off.
   */
  summaries?: boolean;
};

const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" } as const;

/**
 * OpenCode options for `effort` (null: the model's own default) on this AI
 * Model. Callers resolve the level against the model first
 * (`shared/thinkingLevels.ts`); one the model then refuses anyway is caught by
 * the model proxy, which carries the turn on at the model's default
 * (`opencodeProxy.ts`). A level for a model Genosyn cannot send one to at all
 * is refused here rather than dropped.
 */
export function openCodeThinking(
  model: EffortModel,
  effort: ModelEffort | null | undefined,
  options: ThinkingOptions = {},
): OpenCodeThinking {
  const level = effort ?? null;
  const profile = modelThinkingProfile(model);
  switch (profile.wire) {
    case "openai":
      return {
        options: {
          ...(level ? { reasoningEffort: level } : {}),
          ...(level || options.summaries ? { reasoningSummary: "auto" } : {}),
        },
      };
    case "anthropic-adaptive":
      if (level === null) {
        // Asked for nothing, a model that thinks by default still thinks; it
        // is only asked to show it. One that does not stays as it is.
        return options.summaries && profile.nativeDefault !== "none"
          ? { options: { thinking: ADAPTIVE_THINKING }, outputLimit: ADAPTIVE_THINKING_OUTPUT_LIMIT }
          : { options: {} };
      }
      if (level === "none") return { options: {} };
      return {
        options: { thinking: ADAPTIVE_THINKING, effort: level },
        outputLimit: ADAPTIVE_THINKING_OUTPUT_LIMIT,
      };
    case "anthropic-effort-budget":
    case "anthropic-budget": {
      if (level === null || level === "none") return { options: {} };
      const budgetTokens = THINKING_BUDGETS[level];
      return {
        options: {
          ...(profile.wire === "anthropic-effort-budget" ? { effort: level } : {}),
          thinking: { type: "enabled", budgetTokens },
        },
      };
    }
    case "openai-compatible":
      return { options: level ? { reasoningEffort: level } : {} };
    default:
      if (level !== null) {
        throw new ThinkingLevelError(
          "This AI Model doesn't offer thinking levels. Choose Default, then send the message again.",
        );
      }
      return { options: {} };
  }
}

/**
 * The Codex app-server's `turn/start` fields for `effort` on this AI Model.
 * Codex checks the level against its own catalogue; a turn it refuses runs
 * again at the model's default (`codexRuntime.ts`).
 */
export function codexThinking(
  model: EffortModel,
  effort: ModelEffort | null | undefined,
  options: ThinkingOptions = {},
): { effort?: ModelEffort; summary?: "auto" } {
  const level = effort ?? null;
  if (level !== null) return { effort: level, summary: "auto" };
  return options.summaries && modelThinkingProfile(model).wire === "codex"
    ? { summary: "auto" }
    : {};
}
