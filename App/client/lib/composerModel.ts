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
