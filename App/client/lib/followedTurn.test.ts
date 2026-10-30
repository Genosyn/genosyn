import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  emptyFollowedTurn,
  followRetryDelayMs,
  followedTurnReconnecting,
  reduceFollowedTurn,
  type FollowedTurnState,
} from "./followedTurn";

/**
 * One AI turn as a browser follows it over the turn's own stream: frames in,
 * what the live card shows out.
 */

const NOW = Date.parse("2026-10-30T10:00:10.000Z");

function fold(frames: Array<[string, unknown]>, start = emptyFollowedTurn("t1", NOW - 10_000)) {
  return frames.reduce<FollowedTurnState>(
    (state, [event, data], index) => reduceFollowedTurn(state, { event, data }, NOW + index),
    start,
  );
}

const step = (ordinal: number, kind = "tool_use") => ({
  ordinal,
  attempt: 1,
  kind,
  name: "search_mail",
  callId: `c${ordinal}`,
  summary: "Searching email",
  detail: { input: null, withheld: "steps" },
  isError: false,
  at: "2026-10-30T10:00:05.000Z",
});

describe("following a turn", () => {
  test("the opening frame says which view of the steps this reader gets, on the server's clock", () => {
    const state = fold([
      [
        "turn",
        {
          messageId: "t1",
          startedAt: "2026-10-30T10:00:00.000Z",
          now: "2026-10-30T10:00:12.000Z",
          access: "steps",
        },
      ],
    ]);
    assert.equal(state.access, "steps");
    assert.equal(state.live.turnId, "t1");
    assert.equal(state.live.startedAt, Date.parse("2026-10-30T10:00:00.000Z"));
    assert.equal(state.live.clockOffsetMs, 2_000);
    assert.equal(state.connection, "streaming");
  });

  test("steps arrive once each, however often a reconnect replays them", () => {
    const state = fold([
      ["activity", step(1)],
      ["activity", step(2, "tool_result")],
      ["activity", step(1)],
    ]);
    assert.deepEqual(state.live.events.map((event) => event.ordinal), [1, 2]);
    assert.equal(state.live.lastOrdinal, 2, "a reconnect resumes after it");
  });

  test("the reply is written from chunks, and a snapshot from saved rows replaces it", () => {
    const chunked = fold([
      ["chunk", { text: "Three are " }],
      ["chunk", { text: "unreviewed." }],
    ]);
    assert.equal(chunked.text, "Three are unreviewed.");
    assert.ok(chunked.live.lastTextAt !== null, "text arriving is the reply being written");
    const snapshot = fold([["snapshot", { text: "Three are unreviewed so far" }]], chunked);
    assert.equal(snapshot.text, "Three are unreviewed so far");
    const same = reduceFollowedTurn(snapshot, { event: "snapshot", data: { text: snapshot.text } }, NOW);
    assert.equal(same.text, snapshot.text);
  });

  test("a milestone shows while the turn is between its start and its end", () => {
    const state = fold([["progress", { percent: 40, label: "Matching receipts" }]]);
    assert.deepEqual(state.progress, { percent: 40, label: "Matching receipts" });
    const ignored = fold([["progress", { percent: 100, label: "Done" }]]);
    assert.equal(ignored.progress, null);
  });

  test("the turn's end is the end of following, and a dropped connection reads as one", () => {
    const ended = fold([["final", { turn: { id: "t1" }, message: null }]]);
    assert.equal(ended.finished, true);
    assert.equal(ended.connection, null);
    assert.equal(followedTurnReconnecting(ended), ended, "nothing to reconnect to");
    const dropped = followedTurnReconnecting(fold([["heartbeat", { now: "2026-10-30T10:00:10.000Z" }]]));
    assert.equal(dropped.connection, "reconnecting");
    assert.equal(fold([["activity", step(3)]], dropped).connection, "streaming", "back once a frame lands");
  });

  test("reconnecting backs off, up to ten seconds", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(followRetryDelayMs), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });
});
