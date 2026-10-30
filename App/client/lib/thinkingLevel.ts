import type { ModelEffort } from "../../shared/modelEffort";
import {
  adjustmentNote,
  describeThinkingDefault,
  describeTurnThinking,
  effortLabel,
  effortRank,
  resolveThinking,
  thinkingOptions,
  type ModelThinking,
  type ResolvedThinking,
  type ThinkingOption,
  type TurnThinking,
} from "../../shared/thinkingLevels";

/**
 * The chat composer's thinking-level control, as plain data: what the button
 * says, what the menu lists, and what the next message will actually run at.
 *
 * The level belongs to the conversation, not the message: a Member picks it
 * once and it sticks, across AI Models. The composer resolves it against the
 * model the next message goes to with the same rules the server uses
 * (`shared/thinkingLevels.ts`), so a level the model does not offer, or its
 * owners do not allow, is shown moved before anything is sent — never
 * silently dropped. Dependency-free so it is tested outside a browser.
 */
export type ComposerThinking = {
  /** The conversation's level; null is Default. */
  chosen: ModelEffort | null;
  /** What the next message runs at on the selected AI Model. */
  resolved: ResolvedThinking;
  /** The level on the button: "Medium", "Off", "Default". */
  label: string;
  /** The conversation follows the AI Model's default. */
  isDefault: boolean;
  /** Why the level runs moved, when it does: "Max isn't offered by this AI Model, …". */
  note: string | null;
  /** Every level the menu lists, with why one is unavailable. */
  options: ThinkingOption[];
  /** What Default means on this AI Model, for its row. */
  defaultRow: { label: string; detail: string };
  /** Why the AI Model offers no levels at all, or null when it offers some. */
  unavailableReason: string | null;
  /** The sentence a screen reader and a hover give the button. */
  title: string;
};

/** What Default reads as: "Medium", or "Its own" when the model's default is unknown. */
function defaultRow(model: ModelThinking): { label: string; detail: string } {
  const value = describeThinkingDefault(model);
  const label = value.level === null ? "Its own" : effortLabel(value.level);
  const detail =
    model.levels.length === 0
      ? "The AI Model's own setting"
      : value.source === "company"
        ? "Set by your company for this AI Model"
        : "The AI Model's own setting";
  return { label, detail };
}

export function composerThinking(args: {
  /** The selected AI Model's thinking, or null when there is no model to send to. */
  model: ModelThinking | null;
  /** The conversation's level; null is Default. */
  chosen: ModelEffort | null;
}): ComposerThinking {
  const model: ModelThinking = args.model ?? {
    levels: [],
    nativeDefault: null,
    defaultLevel: null,
    ceiling: null,
    unavailableReason: null,
  };
  const resolved = resolveThinking(model, args.chosen);
  const isDefault = args.chosen === null;
  const label = resolved.level === null ? "Default" : effortLabel(resolved.level);
  const note = adjustmentNote(resolved);
  const row = defaultRow(model);
  const title = [
    `Thinking level: ${label}${isDefault && resolved.level !== null ? " (default)" : ""}.`,
    note,
    "How hard the AI Model thinks before it answers. Higher levels take longer and cost more.",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    chosen: args.chosen,
    resolved,
    label,
    isDefault,
    note,
    options: thinkingOptions(model),
    defaultRow: row,
    unavailableReason: model.levels.length === 0 ? (model.unavailableReason ?? null) : null,
    title,
  };
}

/**
 * The level a not-yet-created conversation starts at. It is picked in the
 * composer before the first message creates the thread, so it is scoped to
 * that new-thread intent: starting another new conversation starts at
 * Default again.
 */
export type NewThreadThinking = { intent: number; effort: ModelEffort | null };

/** The conversation's level the composer shows for the thread being viewed. */
export function chosenThinkingLevel(args: {
  activeConvId: string | null;
  /** The thread's own level, from the server; absent on an older summary. */
  threadEffort: ModelEffort | null | undefined;
  /** A level picked before the thread existed. */
  newThread: NewThreadThinking | null;
  /** Which new thread the composer is on. */
  newConversationIntent: number;
}): ModelEffort | null {
  if (args.activeConvId) return args.threadEffort ?? null;
  return args.newThread && args.newThread.intent === args.newConversationIntent
    ? args.newThread.effort
    : null;
}

/** What Settings → AI Models needs of a model to show and save its thinking settings. */
export type ThinkingSettingsModel = {
  authMode: "apikey" | "subscription" | "customEndpoint";
  thinking: ModelThinking;
  customThinkingLevels: boolean;
};

/**
 * The body a change to one thinking setting saves: the model's current
 * settings with `next` applied. Lowering the ceiling below the default brings
 * the default down with it, and turning a custom endpoint's levels off clears
 * both, so a pick is never refused for the other setting.
 */
export function thinkingSettingsSave(
  model: ThinkingSettingsModel,
  next: {
    defaultEffort?: ModelEffort | null;
    effortCeiling?: ModelEffort | null;
    customThinkingLevels?: boolean;
  },
): { defaultEffort: ModelEffort | null; effortCeiling: ModelEffort | null; customThinkingLevels?: boolean } {
  const custom = model.authMode === "customEndpoint";
  const off = custom && next.customThinkingLevels === false;
  let defaultEffort = off
    ? null
    : next.defaultEffort !== undefined
      ? next.defaultEffort
      : model.thinking.defaultLevel;
  const effortCeiling = off
    ? null
    : next.effortCeiling !== undefined
      ? next.effortCeiling
      : model.thinking.ceiling;
  if (defaultEffort && effortCeiling && effortRank(defaultEffort) > effortRank(effortCeiling)) {
    defaultEffort = effortCeiling;
  }
  return {
    defaultEffort,
    effortCeiling,
    ...(custom && next.customThinkingLevels !== undefined
      ? { customThinkingLevels: next.customThinkingLevels }
      : {}),
  };
}

/**
 * One line for a model's thinking settings, as its card shows them: "Default
 * for chat: High · Members choose up to Max".
 */
export function thinkingSettingsLine(model: ThinkingSettingsModel): string {
  const thinking = model.thinking;
  if (thinking.levels.length === 0) {
    return model.authMode === "customEndpoint"
      ? "Not offered on this server"
      : "Not offered by this AI Model";
  }
  const own = thinking.nativeDefault
    ? `the AI Model's own (${effortLabel(thinking.nativeDefault)})`
    : "the AI Model's own";
  const defaultPart = `Default for chat: ${thinking.defaultLevel ? effortLabel(thinking.defaultLevel) : own}`;
  const ceilingPart = thinking.ceiling
    ? `Members choose up to ${effortLabel(thinking.ceiling)}`
    : "Members choose any level";
  return `${defaultPart} · ${ceilingPart}`;
}

/**
 * What a model card's closed Advanced section says about thinking, when it
 * says anything: only settings moved off their defaults.
 */
export function thinkingTuningNotes(model: ThinkingSettingsModel): string[] {
  const notes: string[] = [];
  if (model.authMode === "customEndpoint" && model.customThinkingLevels) {
    notes.push("Thinking levels on");
  }
  if (model.thinking.defaultLevel) {
    notes.push(`Chat thinks at ${effortLabel(model.thinking.defaultLevel)}`);
  }
  if (model.thinking.ceiling) {
    notes.push(`Thinking up to ${effortLabel(model.thinking.ceiling)}`);
  }
  return notes;
}

/** What a work session's Default option reads as: "Default (Medium)". */
export function workSessionDefaultLabel(model: ModelThinking | null): string {
  if (!model) return "Default";
  const value = describeThinkingDefault(model);
  return value.level === null ? "Default" : `Default (${effortLabel(value.level)})`;
}

/** A reply's quiet line and its reason, or null for a reply with no record. */
export function replyThinkingLine(
  thinking: TurnThinking | null | undefined,
): { label: string; note: string | null; moved: boolean } | null {
  if (!thinking) return null;
  const described = describeTurnThinking(thinking);
  return { ...described, moved: thinking.adjusted !== null };
}
