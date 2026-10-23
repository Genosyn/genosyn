import type { AIModel, AIModelApiKey, ApiKeyFailureKind } from "./api";

/**
 * How an AI Model's API keys are described to a Member.
 *
 * An Anthropic or OpenAI AI Model connected with an API key holds a primary key
 * and any number of backup keys. Requests use the first key; when the provider
 * refuses it — invalid or revoked, not allowed, out of credit or quota,
 * rate-limited — the same request moves to the next key, and the refused key
 * rests for a while so the requests behind it start elsewhere. This module
 * turns what the server reports about each key into the words the model's
 * settings show, so the owner can tell which key is dead.
 *
 * Dependency-free on purpose, like `modelSummary.ts`: it runs under
 * `node --test`.
 */

/**
 * Where a key stands:
 *   - `working` — its last request succeeded;
 *   - `failing` — the provider refused it last time it was tried;
 *   - `resting` — just refused, so requests try the other keys first for now;
 *   - `unused`  — no request has gone out on it since it was added.
 */
export type ApiKeyState = "working" | "failing" | "resting" | "unused";

type Health = Pick<
  AIModelApiKey,
  | "addedAt"
  | "lastUsedAt"
  | "lastErrorAt"
  | "lastErrorStatus"
  | "lastErrorKind"
  | "lastError"
  | "restingUntil"
>;

function time(iso: string | null): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : 0;
}

export function apiKeyState(key: Health, now = Date.now()): ApiKeyState {
  if (time(key.restingUntil) > now) return "resting";
  const used = time(key.lastUsedAt);
  const refused = time(key.lastErrorAt);
  if (refused && refused > used) return "failing";
  if (used) return "working";
  return "unused";
}

/** A state the owner should act on: the last time the key was tried, it was refused. */
export function isRefused(key: Health, now = Date.now()): boolean {
  const state = apiKeyState(key, now);
  return state === "failing" || state === "resting";
}

const KIND_WORDS: Record<ApiKeyFailureKind, string> = {
  auth: "invalid or revoked",
  permission: "not allowed",
  billing: "out of credit",
  quota: "out of quota",
  rate_limit: "rate-limited",
};

/** "rate-limited, HTTP 429" — why a key was refused, in a few words. */
export function refusalLabel(key: Pick<Health, "lastErrorKind" | "lastErrorStatus">): string {
  const words = key.lastErrorKind ? KIND_WORDS[key.lastErrorKind] : "refused";
  return key.lastErrorStatus ? `${words}, HTTP ${key.lastErrorStatus}` : words;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function sinceLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - time(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "14:05" — a time today, in the viewer's own clock. */
function clockLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The one line under a key's preview: whether it works, and the last time
 * the provider refused it and why.
 */
export function apiKeyHealthLine(key: Health, now = Date.now()): string {
  const state = apiKeyState(key, now);
  const parts: string[] = [];
  if (state === "working") {
    parts.push(`Last used ${sinceLabel(key.lastUsedAt!, now)}`);
    if (key.lastErrorAt)
      parts.push(`last refused ${sinceLabel(key.lastErrorAt, now)} (${refusalLabel(key)})`);
  } else if (state === "failing" || state === "resting") {
    parts.push(
      `Refused ${sinceLabel(key.lastErrorAt ?? key.restingUntil!, now)} (${refusalLabel(key)})`,
    );
    if (state === "resting") parts.push(`skipped until ${clockLabel(key.restingUntil!)}`);
    if (key.lastUsedAt) parts.push(`last used ${sinceLabel(key.lastUsedAt, now)}`);
  } else {
    parts.push("Not used yet");
    if (key.addedAt) parts.push(`added ${sinceLabel(key.addedAt, now)}`);
  }
  return parts.join(" · ");
}

/** The ids with `id` moved one place up or down; unchanged at either end. */
export function moveApiKey(ids: readonly string[], id: string, direction: "up" | "down"): string[] {
  const order = [...ids];
  const from = order.indexOf(id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= order.length) return order;
  [order[from], order[to]] = [order[to], order[from]];
  return order;
}

/** Does this model take backup API keys? */
export function holdsApiKeys(model: Pick<AIModel, "provider" | "authMode">): boolean {
  return (
    model.authMode === "apikey" && (model.provider === "anthropic" || model.provider === "openai")
  );
}

/** "Connected with an API key" or "Connected with 3 API keys". */
export function apiKeyConnectionLine(keyCount: number): string {
  return keyCount > 1 ? `Connected with ${keyCount} API keys` : "Connected with an API key";
}

/**
 * What the closed Advanced line says about a model's keys: how many backups
 * it holds and how many keys are failing, e.g. "2 backup API keys · 1 API key
 * failing". Empty with a single working key, which is the default.
 */
export function apiKeyNotes(
  model: Pick<AIModel, "provider" | "authMode" | "status"> & { apiKeys?: readonly Health[] },
  now = Date.now(),
): string[] {
  if (model.status !== "connected" || !holdsApiKeys(model)) return [];
  const keys = model.apiKeys ?? [];
  const notes: string[] = [];
  const backups = keys.length - 1;
  if (backups > 0) notes.push(`${backups} backup API ${backups === 1 ? "key" : "keys"}`);
  const failing = keys.filter((key) => isRefused(key, now)).length;
  if (failing > 0) notes.push(`${failing} API ${failing === 1 ? "key" : "keys"} failing`);
  return notes;
}
