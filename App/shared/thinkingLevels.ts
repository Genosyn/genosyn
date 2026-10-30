import { MODEL_EFFORT_LABELS, MODEL_EFFORT_VALUES, type ModelEffort } from "./modelEffort.js";

/**
 * Thinking levels — how hard an AI Model thinks before it answers.
 *
 * A Member picks one per conversation; it sticks to the conversation and is
 * resolved, turn by turn, against the AI Model the turn runs on. Owners and
 * admins give each AI Model a default for chat and a highest level Members may
 * choose (Settings → AI Models). Every AI Model runs a level its own way — an
 * effort, a thinking budget, adaptive thinking — which the server maps
 * (`services/agent/thinkingParams.ts`); this module holds the rules both sides
 * share, so the composer shows exactly the level the server will run.
 *
 * A level only changes how hard the model thinks. It never widens what a turn
 * may do: Grants, Approvals, tools and limits are the same at every level.
 */

/** Where a level sits on the one scale every AI Model's levels share. */
export function effortRank(level: ModelEffort): number {
  return MODEL_EFFORT_VALUES.indexOf(level);
}

/** The words for a level: "Off", "Medium", "Extra high". */
export function effortLabel(level: ModelEffort): string {
  return MODEL_EFFORT_LABELS[level];
}

/**
 * The levels the picker always lists, whatever the AI Model, so the menu reads
 * the same everywhere; a model's other levels (Minimal, Extra high, Ultra) join
 * them when it offers them.
 */
export const CORE_THINKING_LEVELS: readonly ModelEffort[] = ["none", "low", "medium", "high", "max"];

/** What one AI Model offers, as the server describes it with the model. */
export type ModelThinking = {
  /** Levels this AI Model can run at, lowest first. Empty: it runs at its own default only. */
  levels: ModelEffort[];
  /** The level it runs at when Genosyn asks for none; null when unknown. */
  nativeDefault: ModelEffort | null;
  /** Owners' default for chat on this AI Model; null follows `nativeDefault`. */
  defaultLevel: ModelEffort | null;
  /** Highest level a Member may choose; null is no limit. */
  ceiling: ModelEffort | null;
  /** Why `levels` is empty, in a sentence; null when it is not. */
  unavailableReason: string | null;
};

/** Why a turn runs at another level than the one asked for. */
export type ThinkingAdjustment = "unsupported" | "ceiling";

export type ResolvedThinking = {
  /** The level Genosyn asks the runtime for; null asks for none (the model's own default). */
  send: ModelEffort | null;
  /** The level the turn runs at, when known. */
  level: ModelEffort | null;
  /** The conversation's level that led here; null is Default. */
  requested: ModelEffort | null;
  adjusted: ThinkingAdjustment | null;
};

function highest(levels: readonly ModelEffort[]): ModelEffort {
  return levels[levels.length - 1];
}

/** The highest of `levels` at or below `wanted`, else the lowest. */
function nearestAmong(levels: readonly ModelEffort[], wanted: ModelEffort): ModelEffort {
  let best: ModelEffort | null = null;
  for (const level of levels) if (effortRank(level) <= effortRank(wanted)) best = level;
  return best ?? levels[0];
}

function overCeiling(model: Pick<ModelThinking, "ceiling">, level: ModelEffort): boolean {
  return model.ceiling !== null && effortRank(level) > effortRank(model.ceiling);
}

/**
 * The levels a Member may choose on this AI Model: those it offers, up to the
 * company's ceiling. A ceiling below everything it offers leaves its lightest.
 */
export function allowedThinkingLevels(
  model: Pick<ModelThinking, "levels" | "ceiling">,
): ModelEffort[] {
  const under = model.levels.filter((level) => !overCeiling(model, level));
  return under.length > 0 ? under : model.levels.slice(0, 1);
}

/**
 * The level a turn runs at, from the conversation's level (`requested`, null
 * for Default) and the AI Model it runs on.
 *
 *   - Default takes the owners' default for the model, else the model's own,
 *     which Genosyn leaves to the model by sending nothing — unless the
 *     company's ceiling sits below it, when the ceiling is sent.
 *   - A level the model does not offer becomes the nearest one it does (the
 *     highest below, else its lightest): "unsupported".
 *   - A level over the ceiling becomes the ceiling: "ceiling".
 *
 * Never silent: the composer shows the result before a message is sent, and
 * the reply records it.
 */
export function resolveThinking(
  model: ModelThinking,
  requested: ModelEffort | null,
): ResolvedThinking {
  if (model.levels.length === 0) {
    return { send: null, level: null, requested, adjusted: requested === null ? null : "unsupported" };
  }
  const allowed = allowedThinkingLevels(model);
  const target = requested ?? model.defaultLevel;
  if (target === null) {
    const native = model.nativeDefault;
    if (model.ceiling !== null && (native === null || overCeiling(model, native))) {
      const send = nearestAmong(allowed, model.ceiling);
      return { send, level: send, requested, adjusted: "ceiling" };
    }
    return { send: null, level: native, requested, adjusted: null };
  }
  const supported = model.levels.includes(target) ? target : nearestAmong(model.levels, target);
  const capped = overCeiling(model, supported) ? nearestAmong(allowed, model.ceiling!) : supported;
  const adjusted: ThinkingAdjustment | null =
    capped !== supported ? "ceiling" : supported !== target ? "unsupported" : null;
  return { send: capped, level: capped, requested, adjusted };
}

/** One row of the picker. */
export type ThinkingOption = {
  level: ModelEffort;
  available: boolean;
  /** Why it cannot be chosen on this AI Model; null when it can. */
  reason: string | null;
};

/** What a model with no levels says, when the server gave no reason of its own. */
export const NO_THINKING_LEVELS_REASON =
  "This AI Model doesn't offer thinking levels, so it uses its own default.";

/** Why `level` is not one this AI Model offers, in a few words. */
export function unsupportedLevelReason(
  model: Pick<ModelThinking, "levels" | "unavailableReason">,
  level: ModelEffort,
): string {
  if (model.levels.length === 0) return model.unavailableReason ?? NO_THINKING_LEVELS_REASON;
  const lightest = model.levels[0];
  const top = highest(model.levels);
  if (level === "none") return `This AI Model always thinks; ${effortLabel(lightest)} is its lightest level.`;
  if (effortRank(level) > effortRank(top)) return `This AI Model tops out at ${effortLabel(top)}.`;
  if (effortRank(level) < effortRank(lightest)) {
    return `${effortLabel(lightest)} is this AI Model's lightest level.`;
  }
  return "This AI Model doesn't offer this level.";
}

/** Why a Member cannot choose a level over the company's ceiling. */
export function ceilingReason(ceiling: ModelEffort): string {
  return `Your company allows up to ${effortLabel(ceiling)} on this AI Model.`;
}

/**
 * Every row the picker lists for this AI Model, lowest first: the core levels
 * always, plus any other level the model offers; each with why it is
 * unavailable when it is.
 */
export function thinkingOptions(model: ModelThinking): ThinkingOption[] {
  const listed = new Set<ModelEffort>([...CORE_THINKING_LEVELS, ...model.levels]);
  return MODEL_EFFORT_VALUES.filter((level) => listed.has(level)).map((level) => {
    if (!model.levels.includes(level)) {
      return { level, available: false, reason: unsupportedLevelReason(model, level) };
    }
    if (overCeiling(model, level)) {
      return { level, available: false, reason: ceilingReason(model.ceiling!) };
    }
    return { level, available: true, reason: null };
  });
}

/** What Default means on this AI Model: the level it resolves to, and whose it is. */
export function describeThinkingDefault(model: ModelThinking): {
  level: ModelEffort | null;
  /** `company` when owners set it (or their ceiling caps it); `model` when it is the model's own. */
  source: "company" | "model";
} {
  const resolved = resolveThinking(model, null);
  const company =
    (model.defaultLevel !== null && model.levels.length > 0) || resolved.adjusted === "ceiling";
  return { level: resolved.level, source: company ? "company" : "model" };
}

/** The sentence the composer and a reply use when a level was moved. */
export function adjustmentNote(resolved: {
  requested: ModelEffort | null;
  level: ModelEffort | null;
  adjusted: ThinkingAdjustment | "rejected" | null;
  refused?: ModelEffort | null;
}): string | null {
  const asked = resolved.requested === null ? "The default level" : effortLabel(resolved.requested);
  switch (resolved.adjusted) {
    case "unsupported":
      return resolved.level === null
        ? `${asked} isn't offered by this AI Model, so it uses its own default.`
        : `${asked} isn't offered by this AI Model, so it thinks at ${effortLabel(resolved.level)}.`;
    case "ceiling":
      return resolved.level === null
        ? "Capped by your company for this AI Model."
        : `Capped at ${effortLabel(resolved.level)}, the highest your company allows on this AI Model.`;
    case "rejected":
      return `This AI Model didn't accept ${
        resolved.refused ? effortLabel(resolved.refused) : "the thinking level"
      }, so it answered at its own default.`;
    default:
      return null;
  }
}

// ───────────────────────────── on each reply ─────────────────────────────

/**
 * The thinking level one reply ran at, stored on the reply
 * (`ConversationMessage.thinkingJson`) when its turn is accepted and updated if
 * the AI Model refused the level mid-turn.
 */
export type TurnThinking = {
  /** The level the reply ran at; null is the AI Model's own default, unknown to Genosyn. */
  level: ModelEffort | null;
  /** The conversation's level when it was sent; null is Default. */
  requested: ModelEffort | null;
  /**
   * Why `level` differs from what was asked: a level the model does not offer,
   * the company's ceiling, or the AI Model refusing the level it was sent.
   */
  adjusted: ThinkingAdjustment | "rejected" | null;
  /** The level the AI Model refused, when `adjusted` is `rejected`. */
  refused?: ModelEffort | null;
};

const LEVELS = new Set<string>(MODEL_EFFORT_VALUES);
const ADJUSTMENTS = new Set(["unsupported", "ceiling", "rejected"]);

function levelOrNull(value: unknown): ModelEffort | null {
  return typeof value === "string" && LEVELS.has(value) ? (value as ModelEffort) : null;
}

/** Parse a stored record, tolerating rows written before it existed. */
export function parseTurnThinking(raw: string | null | undefined): TurnThinking | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof TurnThinking, unknown>> | null;
    if (!value || typeof value !== "object") return null;
    const adjusted =
      typeof value.adjusted === "string" && ADJUSTMENTS.has(value.adjusted)
        ? (value.adjusted as TurnThinking["adjusted"])
        : null;
    const parsed: TurnThinking = {
      level: levelOrNull(value.level),
      requested: levelOrNull(value.requested),
      adjusted,
    };
    if (adjusted === "rejected") parsed.refused = levelOrNull(value.refused);
    return parsed;
  } catch {
    return null;
  }
}

/** A reply's quiet line: "Thinking: High", with why it moved when it did. */
export function describeTurnThinking(thinking: TurnThinking): { label: string; note: string | null } {
  return {
    label: `Thinking: ${thinking.level === null ? "Default" : effortLabel(thinking.level)}`,
    note: adjustmentNote(thinking),
  };
}
