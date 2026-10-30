import type { ModelEffort } from "../../shared/modelEffort.js";
import { effortLabel, effortRank, type ModelThinking } from "../../shared/thinkingLevels.js";
import type { AIModel } from "../db/entities/AIModel.js";

/**
 * Which thinking levels each AI Model offers, what it does when asked for
 * none, and how a level reaches it — the facts behind every thinking-level
 * picker and every turn's runtime parameters (`agent/thinkingParams.ts`).
 *
 * Explicitly supported models only, including their dated snapshots. Unknown
 * models keep their own default: a compatible wire format does not establish
 * which levels a model accepts, so a family not listed here never inherits
 * one. A custom endpoint offers levels only once its owners turn them on.
 *
 * Sources: https://developers.openai.com/api/docs/models,
 * https://platform.claude.com/docs/en/build-with-claude/effort and
 * …/extended-thinking (October 2026), and the model catalogue bundled with the
 * pinned `@openai/codex` 0.146.0 (`codex debug models --bundled`).
 */

/**
 * How a level reaches the model:
 *
 *   - `openai`                OpenCode's `reasoningEffort`, the Responses API's
 *                             `reasoning.effort`;
 *   - `codex`                 the Codex app-server's per-turn `effort`;
 *   - `anthropic-adaptive`    adaptive thinking plus `output_config.effort`;
 *   - `anthropic-effort-budget` `output_config.effort` plus a thinking budget
 *                             (Claude Opus 4.5, from before adaptive thinking);
 *   - `anthropic-budget`      a thinking budget (`budget_tokens`) alone;
 *   - `openai-compatible`     `reasoning_effort` on chat completions.
 */
export type ThinkingWire =
  | "openai"
  | "codex"
  | "anthropic-adaptive"
  | "anthropic-effort-budget"
  | "anthropic-budget"
  | "openai-compatible";

export type ThinkingProfile = {
  /** Levels the model offers, lowest first. `none` is thinking turned off. */
  levels: readonly ModelEffort[];
  /** The level it runs at when asked for none; null when unknown. */
  nativeDefault: ModelEffort | null;
  wire: ThinkingWire | null;
};

const STANDARD: readonly ModelEffort[] = ["low", "medium", "high"];
const EXTENDED: readonly ModelEffort[] = [...STANDARD, "xhigh"];
const MAXIMUM: readonly ModelEffort[] = [...EXTENDED, "max"];

const NONE: ThinkingProfile = { levels: [], nativeDefault: null, wire: null };

/**
 * OpenAI API-key models through OpenCode, which itself asks GPT-5-family
 * models for `medium` when Genosyn asks for nothing; the o-series and GPT-6
 * get the API's own default, `medium` on the o-series and unpublished for
 * GPT-6 Astra.
 */
function openAi(levels: readonly ModelEffort[], nativeDefault: ModelEffort | null = "medium") {
  return { levels, nativeDefault, wire: "openai" as const };
}

const OPENAI: Record<string, ThinkingProfile> = {
  "gpt-6-astra": openAi(MAXIMUM, null),
  "gpt-5.6": openAi(["none", ...MAXIMUM]),
  "gpt-5.6-sol": openAi(["none", ...MAXIMUM]),
  "gpt-5.6-terra": openAi(["none", ...MAXIMUM]),
  "gpt-5.6-luna": openAi(["none", ...MAXIMUM]),
  "gpt-5.5": openAi(["none", ...EXTENDED]),
  "gpt-5.5-pro": openAi(["medium", "high", "xhigh"]),
  "gpt-5.4": openAi(["none", ...EXTENDED]),
  "gpt-5.4-mini": openAi(["none", ...EXTENDED]),
  "gpt-5.4-nano": openAi(["none", ...EXTENDED]),
  "gpt-5.4-pro": openAi(["medium", "high", "xhigh"]),
  "gpt-5.3-codex": openAi(EXTENDED),
  "gpt-5.2": openAi(["none", ...EXTENDED]),
  "gpt-5.2-codex": openAi(EXTENDED),
  "gpt-5.1": openAi(["none", ...STANDARD]),
  "gpt-5.1-codex": openAi(STANDARD),
  "gpt-5-codex": openAi(STANDARD),
  "gpt-5": openAi(["minimal", ...STANDARD]),
  "gpt-5-mini": openAi(["minimal", ...STANDARD]),
  "gpt-5-nano": openAi(["minimal", ...STANDARD]),
  o1: openAi(STANDARD),
  o3: openAi(STANDARD),
  "o3-mini": openAi(STANDARD),
  "o4-mini": openAi(STANDARD),
};

/**
 * Claude through the Messages API, by how each generation thinks:
 *
 *   - Claude 5-family models always think (adaptive by default; turning it
 *     off is refused or, on Claude Opus 5, error-prone), so `low` is their
 *     lightest level and their own default is the API's default effort.
 *   - Claude Opus 4.6 to 4.8 and Sonnet 4.6 think only when asked, with
 *     adaptive thinking; asked for nothing they do not think, so `none` is
 *     their own default.
 *   - Claude Opus 4.5 takes an effort but predates adaptive thinking, so a
 *     level is an effort plus a thinking budget.
 *   - Older Claude 4 models and Claude 3.7 Sonnet take a thinking budget only.
 */
function adaptiveAlwaysOn(nativeDefault: ModelEffort, levels: readonly ModelEffort[] = MAXIMUM) {
  return { levels, nativeDefault, wire: "anthropic-adaptive" as const };
}
function adaptiveOptIn(levels: readonly ModelEffort[]) {
  return { levels: ["none", ...levels] as ModelEffort[], nativeDefault: "none" as const, wire: "anthropic-adaptive" as const };
}
const BUDGET_ONLY: ThinkingProfile = {
  levels: ["none", "low", "medium", "high", "max"],
  nativeDefault: "none",
  wire: "anthropic-budget",
};

const ANTHROPIC: Record<string, ThinkingProfile> = {
  "claude-fable-5-1": adaptiveAlwaysOn("high"),
  "claude-fable-5": adaptiveAlwaysOn("high"),
  "claude-mythos-5-1": adaptiveAlwaysOn("high"),
  "claude-mythos-5": adaptiveAlwaysOn("high"),
  "claude-mythos-preview": adaptiveAlwaysOn("high", [...STANDARD, "max"]),
  "claude-opus-5-5": adaptiveAlwaysOn("medium"),
  "claude-opus-5": adaptiveAlwaysOn("high"),
  "claude-sonnet-5-5": adaptiveAlwaysOn("high"),
  "claude-sonnet-5": adaptiveAlwaysOn("high"),
  "claude-haiku-5-5": adaptiveAlwaysOn("medium"),
  "claude-opus-4-8": adaptiveOptIn(MAXIMUM),
  "claude-opus-4-7": adaptiveOptIn(MAXIMUM),
  "claude-opus-4-6": adaptiveOptIn([...STANDARD, "max"]),
  "claude-sonnet-4-6": adaptiveOptIn([...STANDARD, "max"]),
  "claude-opus-4-5": {
    levels: ["none", ...STANDARD],
    nativeDefault: "none",
    wire: "anthropic-effort-budget",
  },
  "claude-sonnet-4-5": BUDGET_ONLY,
  "claude-haiku-4-5": BUDGET_ONLY,
  "claude-opus-4-1": BUDGET_ONLY,
  "claude-opus-4-0": BUDGET_ONLY,
  "claude-opus-4": BUDGET_ONLY,
  "claude-sonnet-4-0": BUDGET_ONLY,
  "claude-sonnet-4": BUDGET_ONLY,
  "claude-3-7-sonnet": BUDGET_ONLY,
};

function codex(levels: readonly ModelEffort[], nativeDefault: ModelEffort = "medium") {
  return { levels, nativeDefault, wire: "codex" as const };
}

/** The bundled model catalogue in pinned @openai/codex 0.146.0, defaults included. */
const SUBSCRIPTION: Record<string, ThinkingProfile> = {
  "gpt-5.6-sol": codex([...MAXIMUM, "ultra"], "low"),
  "gpt-5.6-terra": codex([...MAXIMUM, "ultra"]),
  "gpt-5.6-luna": codex(MAXIMUM),
  "gpt-5.5": codex(EXTENDED),
  "gpt-5.4": codex(EXTENDED),
  "gpt-5.4-mini": codex(EXTENDED),
  "gpt-5.2": codex(EXTENDED),
  "codex-auto-review": codex(EXTENDED),
};

/** What `reasoning_effort` takes on the servers that read it (vLLM, Ollama, LM Studio). */
const CUSTOM_LEVELS: ThinkingProfile = {
  levels: ["none", ...STANDARD],
  nativeDefault: null,
  wire: "openai-compatible",
};

export type EffortModel = Pick<AIModel, "provider" | "model"> &
  Partial<Pick<AIModel, "authMode" | "customThinkingLevels">>;

/** The model id without a dated snapshot or `-latest` suffix, in lower case. */
function baseModelId(model: string | null | undefined): string {
  return (model ?? "")
    .trim()
    .toLowerCase()
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$/, "");
}

/** How this AI Model thinks, by service and model. */
export function modelThinkingProfile(model: EffortModel): ThinkingProfile {
  if (model.provider === "custom" || model.authMode === "customEndpoint") {
    return model.customThinkingLevels ? CUSTOM_LEVELS : NONE;
  }
  const id = baseModelId(model.model);
  const catalogue =
    model.provider === "openai"
      ? model.authMode === "subscription"
        ? SUBSCRIPTION
        : OPENAI
      : model.provider === "anthropic"
        ? ANTHROPIC
        : undefined;
  return catalogue && Object.hasOwn(catalogue, id) ? catalogue[id] : NONE;
}

export function modelEffortLevels(model: EffortModel): ModelEffort[] {
  return [...modelThinkingProfile(model).levels];
}

/** Whether this AI Model accepts `effort`. Null, the model's own default, always passes. */
export function supportsModelEffort(model: EffortModel, effort?: ModelEffort | null): boolean {
  return effort == null || modelEffortLevels(model).includes(effort);
}

/** Validate before creating work, and again if its AI Model changes later. */
export function requireModelEffort(
  model: EffortModel,
  effort?: ModelEffort | null,
): ModelEffort | null {
  if (effort == null) return null;
  if (!supportsModelEffort(model, effort)) {
    throw new Error(
      "The selected AI Model does not support this effort. Start a new work session with a supported effort or Model default.",
    );
  }
  return effort;
}

/**
 * {@link requireModelEffort}, and within the highest level the model's owners
 * allow Members to choose (`AIModel.effortCeiling`). For work a Member starts
 * with an explicit level, such as a Repository work session.
 */
export function requireAllowedEffort(
  model: EffortModel & Partial<Pick<AIModel, "effortCeiling">>,
  effort?: ModelEffort | null,
): ModelEffort | null {
  const level = requireModelEffort(model, effort);
  const ceiling = model.effortCeiling ?? null;
  if (level !== null && ceiling !== null && effortRank(level) > effortRank(ceiling)) {
    throw new Error(
      `Your company allows thinking levels up to ${effortLabel(ceiling)} on this AI Model. Choose a lower level or Default.`,
    );
  }
  return level;
}

/** Why a model offers no levels, in the words the picker shows. */
function unavailableReason(model: EffortModel): string {
  if (model.provider === "custom" || model.authMode === "customEndpoint") {
    return "Thinking levels are off for this AI Model's server. Owners can turn them on in Settings → AI Models when the server reads reasoning_effort.";
  }
  return "Genosyn doesn't know which thinking levels this AI Model accepts, so it uses its own default.";
}

/**
 * Everything the chat needs to show and resolve thinking levels on one AI
 * Model: what it offers and does by itself, plus the default and ceiling its
 * owners set (`AIModel.defaultEffort`, `AIModel.effortCeiling`).
 */
export function modelThinking(
  model: EffortModel & Partial<Pick<AIModel, "defaultEffort" | "effortCeiling">>,
): ModelThinking {
  const profile = modelThinkingProfile(model);
  return {
    levels: [...profile.levels],
    nativeDefault: profile.nativeDefault,
    defaultLevel: profile.levels.length > 0 ? (model.defaultEffort ?? null) : null,
    ceiling: profile.levels.length > 0 ? (model.effortCeiling ?? null) : null,
    unavailableReason: profile.levels.length > 0 ? null : unavailableReason(model),
  };
}

/** Why owners cannot save these thinking settings on this model, or null when they can. */
export function thinkingSettingsProblem(
  model: EffortModel,
  settings: { defaultEffort: ModelEffort | null; effortCeiling: ModelEffort | null },
): string | null {
  const levels = modelEffortLevels(model);
  for (const [name, level] of [
    ["default", settings.defaultEffort],
    ["highest level", settings.effortCeiling],
  ] as const) {
    if (level !== null && !levels.includes(level)) {
      return levels.length === 0
        ? "This AI Model doesn't offer thinking levels."
        : `This AI Model doesn't offer ${effortLabel(level)} as a ${name}. Choose one of the levels it offers.`;
    }
  }
  if (
    settings.defaultEffort !== null &&
    settings.effortCeiling !== null &&
    effortRank(settings.defaultEffort) > effortRank(settings.effortCeiling)
  ) {
    return "The default can't be above the highest level Members may choose.";
  }
  return null;
}
