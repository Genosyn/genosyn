import type { ModelEffort } from "../../shared/modelEffort";

/**
 * Which AI Model the dedicated employee-chat composer shows for the thread the
 * human is currently looking at.
 *
 * The rule that matters: **a past thread reopens on the brain it was held
 * with.** The server reports that per thread as `ConversationSummary.lastModelId`
 * (already filtered to models this employee still has connected). Preselecting
 * the employee's *active* model instead would silently continue an old
 * conversation on a different model — different context window, different tool
 * habits, different bill — which is exactly the surprise this function exists
 * to prevent.
 *
 * Deliberately dependency-free so it can be unit-tested outside a browser; the
 * `models` array is structurally satisfied by `AIModel[]` from the API client.
 */
export type ComposerModelOption = {
  id: string;
  /** The employee's default brain, per the models endpoint. */
  isActive: boolean;
};

export type ComposerModelOverride = {
  /** Thread the human picked this model on; null for a not-yet-created thread. */
  convId: string | null;
  modelId: string;
};

export function resolveComposerModelId(args: {
  /** Connected models only — a disconnected one cannot answer a turn. */
  models: ComposerModelOption[];
  /** Thread being viewed; null before the first conversation exists. */
  activeConvId: string | null;
  /** The model this thread last ran a turn on, or null if it never has. */
  threadModelId: string | null;
  /** The human's hand-picked model, scoped to the thread they picked it on. */
  override: ComposerModelOverride | null;
}): string | null {
  const { models, activeConvId, threadModelId, override } = args;
  // An override only speaks for the thread it was made on. Dropping it on a
  // thread switch is what lets each thread keep its own model, and what lets a
  // thread created lazily by the first send adopt its persisted choice instead
  // of an override keyed to the conversation that did not exist yet.
  const overrideId = override && override.convId === activeConvId ? override.modelId : null;
  return (
    connectedModelId(models, overrideId) ??
    connectedModelId(models, threadModelId) ??
    models.find((model) => model.isActive)?.id ??
    models[0]?.id ??
    null
  );
}

/**
 * `id` when it still names one of the connected models, else null. A thread can
 * outlive the model it ran on, and a deleted or disconnected model must not
 * survive as a phantom selection the composer cannot actually send to.
 */
export function connectedModelId(models: ComposerModelOption[], id: string | null): string | null {
  if (!id) return null;
  return models.some((model) => model.id === id) ? id : null;
}

export type ComposerEffortOverride = {
  /** Thread the human picked this effort on; null for a not-yet-created thread. */
  convId: string | null;
  /** The model it was picked for. An effort is a setting of one model. */
  modelId: string;
  /** Null is an explicit Model default, which outranks the thread's own effort. */
  effort: ModelEffort | null;
};

/**
 * Which effort the composer shows for the model the next message goes to; null
 * is that model's default.
 *
 * The model's rule again: a past thread reopens at the effort its last turn
 * used (`ConversationSummary.lastEffort`), so a conversation that was thinking
 * hard does not quietly drop back to the default. That effort belongs to the
 * thread's own model, so it applies only while the composer is on that model,
 * and only while the model still supports it. A hand-picked effort speaks only
 * for the thread and model it was picked on.
 */
export function resolveComposerEffort(args: {
  /** The model the next message goes to; null when there is none. */
  modelId: string | null;
  /** Efforts that model supports. Empty means it only runs at its default. */
  effortLevels: readonly ModelEffort[];
  /** Thread being viewed; null before the first conversation exists. */
  activeConvId: string | null;
  /** The model this thread last ran a turn on, and the effort that turn used. */
  threadModelId: string | null;
  threadEffort: ModelEffort | null;
  /** The human's hand-picked effort, scoped to the thread and model it was picked on. */
  override: ComposerEffortOverride | null;
}): ModelEffort | null {
  const { modelId, effortLevels, activeConvId, threadModelId, threadEffort, override } = args;
  if (!modelId) return null;
  const supported = (effort: ModelEffort | null) =>
    effort !== null && effortLevels.includes(effort) ? effort : null;
  if (override && override.convId === activeConvId && override.modelId === modelId) {
    return supported(override.effort);
  }
  return threadModelId === modelId ? supported(threadEffort) : null;
}
