import type { AIModel, AIModelApiKey, ApiKeyFailureKind } from "./api";

/**
 * How an AI Model's API keys are described to a Member.
 *
 * An Anthropic or OpenAI AI Model connected with an API key holds any number
 * of keys, all equals: its sessions — a chat reply, a Routine Run, a
 * work-session turn — are spread across them, each opening on the next key in
 * turn and staying on it. When the provider refuses a session's key — invalid
 * or revoked, not allowed, out of credit or quota, rate-limited — the session
 * moves to another key, and the refused key rests for a while so sessions
 * skip it. This module turns what the server reports about each key into the
 * words the model's settings show, so the owner can see the sessions spread
 * across the keys and tell which key is dead.
 *
 * Dependency-free on purpose, like `modelSummary.ts`: it runs under
 * `node --test`.
 */

/** Explains the card: how sessions use the keys, and what happens to a refused one. */
export const API_KEYS_DESCRIPTION =
  "Sessions are spread across these keys: each new chat reply, Routine Run or work session opens on the next key in turn and stays on it. When the provider refuses a key — invalid or revoked, out of credit, or rate-limited — the session moves to another key, so work carries on, and the refused key is skipped for a few minutes.";

/** The same, for a model with one key: what adding more would do. */
export const API_KEY_ALONE_DESCRIPTION =
  "Every session uses this key. Add more and sessions are spread across them: each new chat reply, Routine Run or work session opens on the next key in turn, and a key the provider refuses — invalid or revoked, out of credit, or rate-limited — hands the session to another and is skipped for a few minutes.";

/** The card's explanation for a model holding `keyCount` keys. */
export function apiKeysDescription(keyCount: number): string {
  return keyCount > 1 ? API_KEYS_DESCRIPTION : API_KEY_ALONE_DESCRIPTION;
}

/**
 * Where a key stands:
 *   - `working` — its last request succeeded;
 *   - `failing` — the provider refused it last time it was tried;
 *   - `resting` — just refused, so sessions skip it for now;
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
> &
  // Optional, so a page loaded before the server counted sessions still reads.
  Partial<Pick<AIModelApiKey, "sessionsLast24h">>;

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
 * "12 sessions in the last 24 h" — the key's share of the model's recent
 * work — or null when it carried none, which the rest of the line already
 * says one way or another.
 */
export function sessionsLabel(key: Pick<Health, "sessionsLast24h">): string | null {
  const sessions = Math.max(0, Math.floor(key.sessionsLast24h ?? 0));
  if (sessions === 0) return null;
  return `${sessions} ${sessions === 1 ? "session" : "sessions"} in the last 24 h`;
}

/**
 * The one line under a key's preview: whether it works, how many sessions it
 * carried lately, and the last time the provider refused it and why.
 */
export function apiKeyHealthLine(key: Health, now = Date.now()): string {
  const state = apiKeyState(key, now);
  const sessions = sessionsLabel(key);
  const parts: string[] = [];
  if (state === "working") {
    parts.push(`Last used ${sinceLabel(key.lastUsedAt!, now)}`);
    if (sessions) parts.push(sessions);
    if (key.lastErrorAt)
      parts.push(`last refused ${sinceLabel(key.lastErrorAt, now)} (${refusalLabel(key)})`);
  } else if (state === "failing" || state === "resting") {
    parts.push(
      `Refused ${sinceLabel(key.lastErrorAt ?? key.restingUntil!, now)} (${refusalLabel(key)})`,
    );
    if (state === "resting") parts.push(`skipped until ${clockLabel(key.restingUntil!)}`);
    if (key.lastUsedAt) parts.push(`last used ${sinceLabel(key.lastUsedAt, now)}`);
    if (sessions) parts.push(sessions);
  } else {
    // Sessions opened on it but none has had a reply yet: say so, not "unused".
    parts.push(sessions ? "No reply yet" : "Not used yet");
    if (sessions) parts.push(sessions);
    if (key.addedAt) parts.push(`added ${sinceLabel(key.addedAt, now)}`);
  }
  return parts.join(" · ");
}

/** Does this model take API keys — a pool of them, as many as an owner adds? */
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
 * The warning a model card shows, outside its Advanced section, while the
 * provider is refusing some of its keys — the one thing in there an owner
 * should not have to go looking for. Null while every key works.
 *
 * Some keys refused is a warning: sessions skip them and carry on on the
 * others. Every key refused means the AI Model cannot answer at all.
 */
export function failingKeysNotice(
  model: Pick<AIModel, "provider" | "authMode" | "status"> & { apiKeys?: readonly Health[] },
  now = Date.now(),
): { failing: number; total: number; all: boolean; text: string } | null {
  if (model.status !== "connected" || !holdsApiKeys(model)) return null;
  const keys = model.apiKeys ?? [];
  const failing = keys.filter((key) => isRefused(key, now)).length;
  if (failing === 0) return null;
  const total = keys.length;
  if (failing === total) {
    return {
      failing,
      total,
      all: true,
      text:
        total === 1
          ? "The provider is refusing this AI Model's API key, so it can't answer. Add a working key under Advanced."
          : `The provider is refusing all ${total} API keys, so this AI Model can't answer. Add a working key under Advanced.`,
    };
  }
  return {
    failing,
    total,
    all: false,
    text: `The provider is refusing ${failing} of ${total} API keys. Sessions move to the other keys, so work carries on — replace or remove the failing ${failing === 1 ? "key" : "keys"} under Advanced.`,
  };
}

/**
 * What the closed Advanced line says about a model's keys: how many keys its
 * sessions are spread across and how many are failing, e.g. "3 API keys · 1
 * API key failing". Empty with a single working key, which is the default.
 */
export function apiKeyNotes(
  model: Pick<AIModel, "provider" | "authMode" | "status"> & { apiKeys?: readonly Health[] },
  now = Date.now(),
): string[] {
  if (model.status !== "connected" || !holdsApiKeys(model)) return [];
  const keys = model.apiKeys ?? [];
  const notes: string[] = [];
  if (keys.length > 1) notes.push(`${keys.length} API keys`);
  const failing = keys.filter((key) => isRefused(key, now)).length;
  if (failing > 0) notes.push(`${failing} API ${failing === 1 ? "key" : "keys"} failing`);
  return notes;
}
