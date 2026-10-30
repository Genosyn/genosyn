import React from "react";
import { api } from "../../lib/api";
import {
  emptyFollowedTurn,
  followRetryDelayMs,
  followedTurnReconnecting,
  reduceFollowedTurn,
  type FollowedTurnState,
} from "../../lib/followedTurn";

/**
 * Follow one AI turn over its own stream until it ends — the Workspace's live
 * cards and a Decision discussion's reply after a reload both use it.
 *
 * Reconnects with a backoff when the connection drops, resuming after the
 * last event it holds, so a dropped connection never repeats or loses a step.
 * The server says when the turn is over (`final`, or a direct chat's
 * `assistant`), and `onEnd` hears that frame once.
 */
export function useFollowedTurn(args: {
  /** Where to follow it from a cursor; null follows nothing. */
  streamUrl: ((after: number) => string) | null;
  turnId: string | null;
  /** When the turn was asked for, as the room already knows it. */
  startedAt: number | null;
  onEnd?: (event: string, data: unknown) => void;
}): FollowedTurnState {
  const { streamUrl, turnId, startedAt } = args;
  const [state, setState] = React.useState<FollowedTurnState>(() =>
    emptyFollowedTurn(turnId, startedAt),
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const onEndRef = React.useRef(args.onEnd);
  onEndRef.current = args.onEnd;
  const urlRef = React.useRef(streamUrl);
  urlRef.current = streamUrl;
  const following = streamUrl !== null && turnId !== null;

  React.useEffect(() => {
    setState(emptyFollowedTurn(turnId, startedAt));
    // A different turn starts from nothing; its start time arrives with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnId]);

  React.useEffect(() => {
    if (!following) return;
    const controller = new AbortController();
    let ended = false;
    void (async () => {
      let failures = 0;
      while (!controller.signal.aborted && !ended) {
        const url = urlRef.current;
        if (!url) return;
        try {
          await api.streamGet(
            url(stateRef.current.live.lastOrdinal),
            (event, data) => {
              failures = 0;
              setState((current) => {
                const next = reduceFollowedTurn(current, { event, data }, Date.now());
                stateRef.current = next;
                return next;
              });
              if (event === "final" || event === "assistant") {
                ended = true;
                onEndRef.current?.(event, data);
              } else if (event === "done") {
                ended = true;
              }
            },
            { signal: controller.signal },
          );
        } catch {
          // A dropped connection; reconnect below unless this one was stopped.
        }
        if (ended || controller.signal.aborted) return;
        failures += 1;
        setState((current) => followedTurnReconnecting(current));
        await new Promise((resolve) => window.setTimeout(resolve, followRetryDelayMs(failures)));
      }
    })();
    return () => controller.abort();
  }, [following, turnId]);

  return state;
}
