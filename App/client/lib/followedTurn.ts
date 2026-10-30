import type { TurnActivityAccess } from "../../shared/turnActivityAccess";
import { EMPTY_LIVE_TURN, reduceLiveTurn, type LiveTurnState } from "./chatActivity";

/**
 * One AI turn as a browser follows it over the turn's own stream
 * (`services/chatTurnFollow.ts`): its recorded events, the reply text so far,
 * the employee's own milestone, how the connection stands, and which view of
 * the steps the server gave this reader.
 *
 * The Workspace follows every turn running in a room this way, and a
 * Decision's discussion follows its reply the same way after a reload — the
 * frames are the ones the direct chat's follow stream sends, so the same
 * `reduceLiveTurn` folds them. Pure, so `followedTurn.test.ts` drives it with
 * recorded frames.
 */

export type FollowedTurnState = {
  live: LiveTurnState;
  /** The reply as far as it has been written. */
  text: string;
  progress: { percent: number; label: string } | null;
  /** How this browser follows the turn; `reconnecting` while it has lost it. */
  connection: "streaming" | "polling" | "reconnecting" | null;
  /** What the server lets this reader see of the steps, once it has said. */
  access: TurnActivityAccess | null;
  /** The stream sent the turn's end. */
  finished: boolean;
};

export function emptyFollowedTurn(turnId: string | null, startedAt: number | null): FollowedTurnState {
  return {
    live: { ...EMPTY_LIVE_TURN, turnId, startedAt },
    text: "",
    progress: null,
    connection: "polling",
    access: null,
    finished: false,
  };
}

/** Fold one frame of the turn's stream into what the browser shows. */
export function reduceFollowedTurn(
  state: FollowedTurnState,
  frame: { event: string; data: unknown },
  clientNow: number,
): FollowedTurnState {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  let next: FollowedTurnState = {
    ...state,
    connection: "streaming",
    live: reduceLiveTurn(state.live, frame, clientNow),
  };
  switch (frame.event) {
    case "turn": {
      const access = data.access;
      if (access === "full" || access === "steps" || access === "none") {
        next = { ...next, access };
      }
      break;
    }
    case "snapshot": {
      const text = typeof data.text === "string" ? data.text : "";
      if (text !== state.text) {
        // A turn followed through its saved rows sends its text as snapshots;
        // one that changed is the reply being written, as a chunk would be.
        next = {
          ...next,
          text,
          live: text ? { ...next.live, lastTextAt: clientNow + next.live.clockOffsetMs } : next.live,
        };
      }
      break;
    }
    case "chunk": {
      const text = typeof data.text === "string" ? data.text : "";
      if (text) next = { ...next, text: next.text + text };
      break;
    }
    case "progress": {
      const percent = typeof data.percent === "number" ? data.percent : null;
      const label = typeof data.label === "string" ? data.label : null;
      if (percent !== null && label !== null && percent >= 1 && percent <= 99) {
        next = { ...next, progress: { percent, label } };
      }
      break;
    }
    case "final":
    case "assistant":
    case "done":
      next = { ...next, finished: true, connection: null };
      break;
    default:
      break;
  }
  return next;
}

/** The connection dropped while the turn was still running. */
export function followedTurnReconnecting(state: FollowedTurnState): FollowedTurnState {
  if (state.finished || state.connection === "reconnecting") return state;
  return { ...state, connection: "reconnecting" };
}

/** How long to wait before following again after `failures` drops in a row. */
export function followRetryDelayMs(failures: number): number {
  return Math.min(10_000, 1_000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
}
