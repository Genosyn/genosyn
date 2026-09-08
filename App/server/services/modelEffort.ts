import type { ModelEffort } from "../../shared/modelEffort.js";
import type { AIModel } from "../db/entities/AIModel.js";

const STANDARD: readonly ModelEffort[] = ["low", "medium", "high"];
const EXTENDED: readonly ModelEffort[] = [...STANDARD, "xhigh"];
const MAXIMUM: readonly ModelEffort[] = [...EXTENDED, "max"];

/**
 * Explicitly supported models, including their dated snapshots. Unknown models
 * and custom endpoints retain their own default: a compatible wire format does
 * not establish which effort values the model accepts.
 *
 * Sources: https://developers.openai.com/api/docs/models and
 * https://platform.claude.com/docs/en/build-with-claude/effort (September 2026).
 * Keep this table explicit so a new family cannot inherit unsupported values.
 */
const OPENAI_EFFORT: Record<string, readonly ModelEffort[]> = {
  "gpt-6-astra": MAXIMUM,
  "gpt-5.6": ["none", ...MAXIMUM],
  "gpt-5.6-sol": ["none", ...MAXIMUM],
  "gpt-5.6-terra": ["none", ...MAXIMUM],
  "gpt-5.6-luna": ["none", ...MAXIMUM],
  "gpt-5.5": ["none", ...EXTENDED],
  "gpt-5.5-pro": ["medium", "high", "xhigh"],
  "gpt-5.4": ["none", ...EXTENDED],
  "gpt-5.4-mini": ["none", ...EXTENDED],
  "gpt-5.4-nano": ["none", ...EXTENDED],
  "gpt-5.4-pro": ["medium", "high", "xhigh"],
  "gpt-5.3-codex": EXTENDED,
  "gpt-5.2": ["none", ...EXTENDED],
  "gpt-5.2-codex": EXTENDED,
  "gpt-5.1": ["none", ...STANDARD],
  "gpt-5.1-codex": STANDARD,
  "gpt-5-codex": STANDARD,
  "gpt-5": ["minimal", ...STANDARD],
  "gpt-5-mini": ["minimal", ...STANDARD],
  "gpt-5-nano": ["minimal", ...STANDARD],
  o1: STANDARD,
  o3: STANDARD,
  "o3-mini": STANDARD,
  "o4-mini": STANDARD,
};

const ANTHROPIC_EFFORT: Record<string, readonly ModelEffort[]> = {
  "claude-opus-4-5": STANDARD,
  "claude-opus-4-6": [...STANDARD, "max"],
  "claude-sonnet-4-6": [...STANDARD, "max"],
  "claude-opus-4-7": MAXIMUM,
  "claude-opus-4-8": MAXIMUM,
  "claude-opus-5": MAXIMUM,
  "claude-sonnet-5": MAXIMUM,
  "claude-fable-5": MAXIMUM,
  "claude-fable-5-1": MAXIMUM,
  "claude-mythos-5": MAXIMUM,
  "claude-mythos-5-1": MAXIMUM,
  "claude-mythos-preview": [...STANDARD, "max"],
};

/** The bundled model/list catalogue in pinned @openai/codex 0.146.0. */
const SUBSCRIPTION_EFFORT: Record<string, readonly ModelEffort[]> = {
  "gpt-5.6-sol": [...MAXIMUM, "ultra"],
  "gpt-5.6-terra": [...MAXIMUM, "ultra"],
  "gpt-5.6-luna": MAXIMUM,
  "gpt-5.5": EXTENDED,
  "gpt-5.4": EXTENDED,
  "gpt-5.4-mini": EXTENDED,
  "gpt-5.2": EXTENDED,
  "codex-auto-review": EXTENDED,
};

type EffortModel = Pick<AIModel, "provider" | "model"> & Partial<Pick<AIModel, "authMode">>;

export function modelEffortLevels(model: EffortModel): ModelEffort[] {
  const id = model.model
    .trim()
    .toLowerCase()
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  const catalogue =
    model.provider === "openai"
      ? model.authMode === "subscription"
        ? SUBSCRIPTION_EFFORT
        : OPENAI_EFFORT
      : model.provider === "anthropic"
        ? ANTHROPIC_EFFORT
        : undefined;
  return catalogue && Object.hasOwn(catalogue, id) ? [...catalogue[id]] : [];
}

/** Validate before creating work, and again if its AI Model changes later. */
export function requireModelEffort(
  model: EffortModel,
  effort?: ModelEffort | null,
): ModelEffort | null {
  if (effort == null) return null;
  if (!modelEffortLevels(model).includes(effort)) {
    throw new Error(
      "The selected AI Model does not support this effort. Start a new work session with a supported effort or Model default.",
    );
  }
  return effort;
}
