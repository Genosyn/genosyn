import type { AIModel, AuthMode, Provider } from "./api";

/**
 * How an AI Model is described to a Member.
 *
 * The API speaks in `provider` and `authMode` values (`anthropic`, `apikey`),
 * which are names for the code, not words for a person. Everything a Member
 * reads about a model — its card, the offer to reuse it, the line that says it
 * was reused — goes through here so it says the same thing everywhere, and so
 * no screen has to invent its own spelling of "Claude".
 *
 * Dependency-free on purpose: it only needs the *shape* of a model, so it
 * describes a connected model and a reusable one alike, and runs under
 * `node --test`.
 */

export type DescribableModel = {
  provider: Provider;
  authMode: AuthMode;
  model: string;
  /** Set on a custom endpoint's own model; its `model` mirrors it. */
  customEndpointModelId?: string | null;
};

/** The service the model runs on: "Claude (Anthropic)", "OpenAI", … */
export function modelService(model: Pick<DescribableModel, "provider" | "authMode">): string {
  if (model.provider === "anthropic") return "Claude (Anthropic)";
  if (model.provider === "custom") return "Custom endpoint";
  return model.authMode === "subscription" ? "OpenAI (ChatGPT sign-in)" : "OpenAI";
}

/** The model itself. `auto` is the ChatGPT default, which nobody typed. */
export function modelName(model: DescribableModel): string {
  if (model.model === "auto") return "default model";
  if (model.provider === "custom") return model.customEndpointModelId || model.model;
  return model.model;
}

/** "Claude (Anthropic) · claude-sonnet-4-5" — the whole description on one line. */
export function describeModel(model: DescribableModel): string {
  return `${modelService(model)} · ${modelName(model)}`;
}

/** The active model first; everything else keeps the order it came in. */
export function activeFirst<T extends Pick<AIModel, "isActive">>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => Number(b.isActive) - Number(a.isActive));
}

/** What a Run limit of `n` reads as. Zero is the "No limit" choice. */
export function runLimitNote(maxConcurrentRuns: number): string {
  if (maxConcurrentRuns === 0) return "No limit on concurrent Runs";
  return `${maxConcurrentRuns} concurrent ${maxConcurrentRuns === 1 ? "Run" : "Runs"}`;
}

/**
 * The tuning on one model that has been moved off its default, in the words
 * the Advanced panel uses for it. Empty when everything is at its default —
 * which is nearly always, and is why the panel can stay closed.
 *
 * An unknown context window is named only for a custom endpoint. For an OpenAI
 * key it is simply how that service is, and naming it would put the same words
 * on nearly every card; for a server you run yourself it usually means the
 * server did not say, and the number is worth setting by hand.
 */
export function tuningNotes(
  model: Pick<
    AIModel,
    "authMode" | "status" | "contextWindow" | "contextWindowSource" | "maxConcurrentRuns"
  >,
): string[] {
  // A ChatGPT sign-in has neither control, and an unconnected model has no
  // settings worth reporting yet.
  if (model.status !== "connected" || model.authMode === "subscription") return [];
  const notes: string[] = [];
  if (model.contextWindowSource === "manual") notes.push("Context window set manually");
  else if (model.authMode === "customEndpoint" && model.contextWindow === null) {
    notes.push("Context window unknown");
  }
  if (model.maxConcurrentRuns !== null) notes.push(runLimitNote(model.maxConcurrentRuns));
  return notes;
}

/**
 * The one line an Advanced disclosure shows while it is closed: the other AI
 * Models the employee holds and whatever has been tuned away from its default,
 * e.g. "Context window set manually · 2 concurrent Runs". Empty when there is
 * nothing to say, so the caller can show a plain hint of what is inside.
 */
export function advancedSummary(
  models: ReadonlyArray<
    Pick<
      AIModel,
      "authMode" | "status" | "contextWindow" | "contextWindowSource" | "maxConcurrentRuns"
    >
  >,
): string {
  const parts: string[] = [];
  const others = models.length - 1;
  if (others > 0) parts.push(`${others} other AI ${others === 1 ? "Model" : "Models"}`);
  for (const note of models.flatMap(tuningNotes)) {
    if (!parts.includes(note)) parts.push(note);
  }
  return parts.join(" · ");
}
