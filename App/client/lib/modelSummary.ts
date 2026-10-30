import type { AIModel, AuthMode, Company, Provider } from "./api";
import { apiKeyConnectionLine, apiKeyNotes } from "./modelApiKeys";

/**
 * How an AI Model is described to a Member.
 *
 * The API speaks in `provider` and `authMode` values (`anthropic`, `apikey`),
 * which are names for the code, not words for a person. Everything a Member
 * reads about a model — its card on an employee's Model page or in Settings →
 * AI Models, the offer to use one the company already has — goes through here
 * so it says the same thing everywhere, and so no screen has to invent its own
 * spelling of "Claude".
 *
 * Dependency-free on purpose: it only needs the *shape* of a model, and runs
 * under `node --test`.
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

/** "Oct 9, 2026" — the day, in the viewer's own words, without the clock. */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The line under a model's name: how it is connected, in plain words, and the
 * day it connected — or what it is still waiting for. It says nothing about who
 * may finish it, so a Member and an owner read the same line.
 */
export function modelConnectionLine(
  model: Pick<
    AIModel,
    | "status"
    | "authMode"
    | "connectedAt"
    | "customEndpointHost"
    | "subscriptionCredentialKind"
    | "subscriptionAvailable"
    | "subscriptionUnavailableReason"
  > & { apiKeys?: readonly unknown[] },
  day: (iso: string) => string = dayLabel,
): string {
  if (model.status !== "connected") {
    if (model.authMode === "customEndpoint") return "Waiting for the server's details";
    if (model.authMode === "subscription") {
      return model.subscriptionAvailable
        ? "Waiting for a ChatGPT sign-in"
        : (model.subscriptionUnavailableReason ??
            "ChatGPT sign-in is unavailable on this install.");
    }
    return "Waiting for an API key";
  }
  const how =
    model.authMode === "customEndpoint"
      ? model.customEndpointHost
        ? `Connected to ${model.customEndpointHost}`
        : "Connected to a custom endpoint"
      : model.authMode === "subscription"
        ? model.subscriptionCredentialKind === "accessToken"
          ? "Signed in with a Business or Enterprise access token"
          : "Signed in with ChatGPT"
        : apiKeyConnectionLine(model.apiKeys?.length || 1);
  return model.connectedAt ? `${how} · since ${day(model.connectedAt)}` : how;
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
 * Owners and admins connect, tune, test and remove AI Models; a Member reads
 * them. The server refuses a Member's writes, so a Member is not offered them.
 */
export function canManageModels(role: Company["role"]): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The tuning on one model that has been moved off its default, in the words
 * its Advanced section uses for it. Empty when everything is at its default —
 * which is nearly always, and is why the section can stay closed.
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
  > &
    Partial<Pick<AIModel, "provider" | "apiKeys">>,
): string[] {
  // A ChatGPT sign-in has neither control, and an unconnected model has no
  // settings worth reporting yet.
  if (model.status !== "connected" || model.authMode === "subscription") return [];
  // The keys sessions are spread across, and any the provider is refusing,
  // come first: a dead key is the one thing in here an owner should not have
  // to go looking for.
  const notes: string[] = model.provider ? apiKeyNotes({ ...model, provider: model.provider }) : [];
  if (model.contextWindowSource === "manual") notes.push("Context window set manually");
  else if (model.authMode === "customEndpoint" && model.contextWindow === null) {
    notes.push("Context window unknown");
  }
  if (model.maxConcurrentRuns !== null) notes.push(runLimitNote(model.maxConcurrentRuns));
  return notes;
}

/**
 * What one model card's Advanced section holds, in a few words — the closed
 * line while nothing inside has been changed, so the person knows where its
 * keys, endpoint or sign-in are before opening it.
 */
export function modelAdvancedHint(model: Pick<AIModel, "authMode" | "status">): string {
  if (model.status !== "connected") return "Service and model";
  if (model.authMode === "subscription") return "ChatGPT sign-in and model";
  if (model.authMode === "customEndpoint") return "Endpoint, context window and Run limit";
  return "API keys, model, context window and Run limit";
}

/**
 * The line one model card's Advanced section shows while it is closed:
 * whatever inside has been moved off its default, and any key the provider is
 * refusing — e.g. "3 API keys · 1 API key failing · 2 concurrent Runs".
 * With nothing changed it names what the section holds instead, so the line is
 * never blank and nothing that was set is hidden by being folded away.
 *
 * Each card reports only its own model: two cards never share a line.
 */
export function modelAdvancedSummary(
  model: Pick<
    AIModel,
    "authMode" | "status" | "contextWindow" | "contextWindowSource" | "maxConcurrentRuns"
  > &
    Partial<Pick<AIModel, "provider" | "apiKeys">>,
): string {
  const notes = tuningNotes(model);
  return notes.length > 0 ? notes.join(" · ") : modelAdvancedHint(model);
}

/**
 * The line over a list of several AI Models, saying which one does the work:
 * "2 AI Models — Ada uses the active one for chat and Routines."
 */
export function modelListLine(count: number, employeeName: string): string {
  return `${count} AI Models — ${employeeName} uses the active one for chat and Routines.`;
}

/** "answered in 2.4 s" — how long a Test connection reply took, to a tenth of a second. */
export function answeredInLine(elapsedMs: number): string {
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (ms < 1_000) return "answered in under a second";
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `answered in ${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `answered in ${minutes} min ${rest} s`;
}

/** The sentence a passed Test connection shows on its card. */
export function testPassedLine(elapsedMs: number): string {
  return `Working — the model ${answeredInLine(elapsedMs)}.`;
}
