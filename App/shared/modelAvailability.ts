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
      /**
       * The work waiting for it: queued or paused Runs, chat messages, and
       * every other piece of AI work that waits for it (`other`) — an email's
       * read, a paused Pipeline run, an answer owed on Slack, a text…
       */
      waiting: WaitingWorkCounts;
    };

export type WaitingWorkCounts = { runs: number; chats: number; other?: number };

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

/**
 * "3 Runs and 1 chat message are waiting", "1 Run, 2 chat messages and 4
 * other pieces of work are waiting", or null when nothing waits.
 */
export function waitingWorkText(waiting: WaitingWorkCounts): string | null {
  const other = waiting.other ?? 0;
  const parts = [
    waiting.runs > 0 ? plural(waiting.runs, "Run", "Runs") : null,
    waiting.chats > 0 ? plural(waiting.chats, "chat message", "chat messages") : null,
    other > 0
      ? plural(
          other,
          waiting.runs > 0 || waiting.chats > 0 ? "other piece of work" : "piece of work",
          waiting.runs > 0 || waiting.chats > 0 ? "other pieces of work" : "pieces of work",
        )
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const total = waiting.runs + waiting.chats + other;
  const listed =
    parts.length <= 2
      ? parts.join(" and ")
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${listed} ${total === 1 ? "is" : "are"} waiting`;
}

/**
 * What an AI Employee says in a conversation that cannot wait for its turn to
 * be retried — a Slack thread, a Workspace channel — when its AI Model is
 * unavailable. Plain words in place of the technical error, which named the
 * model and its endpoint to whoever was reading.
 */
export const MODEL_UNAVAILABLE_REPLY =
  "Sorry — I can't answer right now because my AI Model is unavailable. Please send your message again in a little while.";

/**
 * What an AI Employee says on Slack, Teams, Telegram or WhatsApp when its AI
 * Model is unavailable — once per conversation while messages wait. The
 * message waits and is answered there when the model is back
 * (`chatSurfaces/inbound.ts`), so nobody has to send it again.
 */
export const MODEL_WAIT_SURFACE_ACK =
  "Sorry — I can't answer right now because my AI Model is unavailable. I'll reply here as soon as it's back.";

/** Kept in the transcript in Genosyn when a waiting message's time ran out; never sent. */
export const MODEL_WAIT_SURFACE_GAVE_UP =
  "This message was not answered: the AI Model was unavailable for too long. Send it again to get an answer.";

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
