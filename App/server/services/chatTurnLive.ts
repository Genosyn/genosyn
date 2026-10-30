import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import type { AgentProgress, ContextUsage } from "./agent/types.js";

/**
 * The live side of a running chat turn, held in this process while it runs.
 *
 * The browser that sent a message follows its turn over that request's own
 * stream. Everyone else — the same Member after a reload, another tab, a
 * phone — attaches later, and must see exactly what the first browser sees
 * from that moment on, without a gap or a repeat. Persisted activity rows
 * cover the past, but they land asynchronously and a reply's text is not
 * persisted token by token, so the running turn also keeps an in-memory copy:
 * every event it recorded, the reply text so far, and the subscribers to
 * fan both out to. A late subscriber takes a synchronous snapshot and
 * subscribes in the same tick, which is what makes the hand-over seamless.
 *
 * Process-local on purpose, like the durable worker that owns the turn. A
 * reader attached to another replica falls back to the persisted rows
 * (`routes/employeeSurface.ts`), and re-attaches here when the turn is local.
 */

export type LiveTurnFrame =
  | { type: "activity"; event: ChatActivityEvent }
  | { type: "text"; delta: string }
  | { type: "progress"; progress: AgentProgress }
  | { type: "context"; usage: ContextUsage }
  /** The turn finalized; its row is now authoritative. */
  | { type: "final" }
  /**
   * The turn stopped running here without finishing — it is waiting for
   * another reply in its thread, or another worker took it over. Readers fall
   * back to the persisted rows.
   */
  | { type: "detached" };

export type LiveTurnListener = (frame: LiveTurnFrame) => void;

/** Recorded events kept in memory per turn; older ones are read from the rows. */
const MAX_EVENTS_IN_MEMORY = 2_000;

export class LiveTurn {
  /** The reply text streamed in this attempt. */
  text = "";
  private events: ChatActivityEvent[] = [];
  private listeners = new Set<LiveTurnListener>();
  private ended = false;

  constructor(
    readonly messageId: string,
    readonly conversationId: string,
  ) {}

  /** True once the turn finalized or detached; a stale subscriber learns it at once. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** The lowest ordinal still held in memory, or null when none is. */
  get firstOrdinal(): number | null {
    return this.events[0]?.ordinal ?? null;
  }

  /** The newest event, for a writer deciding whether a wait is already shown. */
  get lastEvent(): ChatActivityEvent | null {
    return this.events.at(-1) ?? null;
  }

  /** Events with an ordinal above `after`, oldest first. */
  eventsAfter(after: number): ChatActivityEvent[] {
    return this.events.filter((event) => event.ordinal > after);
  }

  /** A new attempt starts its reply from nothing; its events continue. */
  beginAttempt(): void {
    this.text = "";
    this.ended = false;
  }

  pushEvent(event: ChatActivityEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.shift();
    this.publish({ type: "activity", event });
  }

  appendText(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.publish({ type: "text", delta });
  }

  progress(progress: AgentProgress): void {
    this.publish({ type: "progress", progress });
  }

  context(usage: ContextUsage): void {
    this.publish({ type: "context", usage });
  }

  subscribe(listener: LiveTurnListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The turn finalized: tell every subscriber, then let them go. */
  finish(): void {
    this.end({ type: "final" });
  }

  /** The turn stopped running here without finishing. */
  detach(): void {
    this.end({ type: "detached" });
  }

  private end(frame: LiveTurnFrame): void {
    if (this.ended) return;
    this.ended = true;
    this.publish(frame);
    this.listeners.clear();
  }

  private publish(frame: LiveTurnFrame): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch {
        // A subscriber that has gone away never breaks the turn.
      }
    }
  }
}

const turns = new Map<string, LiveTurn>();

/**
 * The live record for a turn starting to run here. A recovered or retried
 * attempt in the same process reuses the record, so its earlier events stay
 * readable from memory.
 */
export function openLiveTurn(messageId: string, conversationId: string): LiveTurn {
  const existing = turns.get(messageId);
  if (existing) {
    existing.beginAttempt();
    return existing;
  }
  const turn = new LiveTurn(messageId, conversationId);
  turns.set(messageId, turn);
  return turn;
}

/** The running turn, when this process is running it. */
export function liveTurnFor(messageId: string): LiveTurn | null {
  const turn = turns.get(messageId);
  return turn && !turn.isEnded ? turn : null;
}

/** Forget a turn this process no longer runs; only the record that ended it may. */
export function releaseLiveTurn(turn: LiveTurn): void {
  if (turns.get(turn.messageId) === turn && turn.isEnded) turns.delete(turn.messageId);
}
