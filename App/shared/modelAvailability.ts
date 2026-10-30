/**
 * What the server and the browser say about an AI Model that is unavailable —
 * its service cannot be reached, fails, is overloaded, or keeps every key
 * rate-limited — while the work on it waits (`server/services/modelAvailability.ts`).
 *
 * Pure: no database, no clock but the one a caller passes in.
 */

/** Why an AI Model is unavailable. Mirrors `ModelUnavailableCause` on the server. */
export type ModelUnavailableReason =
  | "unreachable"
  | "timeout"
  | "server_error"
  | "overloaded"
  | "rate_limited";

/** The progress line a chat reply shows while its AI Model is unavailable. */
export const MODEL_WAIT_PROGRESS_LABEL = "Waiting for the AI Model to come back";

/** Whether a chat reply's progress line says it is waiting for its AI Model. */
export function isModelWaitLabel(label: string | null | undefined): boolean {
  return label === MODEL_WAIT_PROGRESS_LABEL;
}

/** An AI Model's availability, as the AI Models page reads it. */
export type PublicModelAvailability =
  | { state: "available" }
  | {
      state: "unavailable";
      /** ISO time the failures began. */
      since: string;
      reason: ModelUnavailableReason;
      /** One line from the server; never holds a key or a response body. */
      detail: string;
      /** Checks that found it still unavailable. */
      checks: number;
      lastCheckedAt: string | null;
      /** ISO time of the next check. */
      nextCheckAt: string;
      /** A check is asking it right now. */
      checking: boolean;
      /** The work waiting for it: queued or paused Runs, and chat messages. */
      waiting: { runs: number; chats: number };
    };

const REASONS: Record<ModelUnavailableReason, string> = {
  unreachable: "Genosyn can’t reach it",
  timeout: "It isn’t answering in time",
  server_error: "Its service is failing",
  overloaded: "Its service is overloaded",
  rate_limited: "It is rate-limited",
};

/** A short sentence for why the model is unavailable: "Its service is overloaded". */
export function unavailableReasonText(reason: ModelUnavailableReason): string {
  return REASONS[reason] ?? "It is unavailable";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 Runs and 1 chat message are waiting", or null when nothing waits. */
export function waitingWorkText(waiting: { runs: number; chats: number }): string | null {
  const parts = [
    waiting.runs > 0 ? plural(waiting.runs, "Run", "Runs") : null,
    waiting.chats > 0 ? plural(waiting.chats, "chat message", "chat messages") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const total = waiting.runs + waiting.chats;
  return `${parts.join(" and ")} ${total === 1 ? "is" : "are"} waiting`;
}

/** "in 4 min", "in 30 s", "now" — when the next check is, from `now`. */
export function nextCheckText(nextCheckAt: string | Date, now: number): string {
  const at = new Date(nextCheckAt).getTime();
  if (!Number.isFinite(at)) return "soon";
  const ms = at - now;
  if (ms <= 5_000) return "now";
  if (ms < 60_000) return `in ${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`;
  return `in ${Math.round(ms / 3_600_000)} h`;
}
