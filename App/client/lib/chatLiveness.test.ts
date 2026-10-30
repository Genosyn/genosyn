import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MODEL_UNAVAILABLE_WAIT_CAUSE,
  MODEL_UNAVAILABLE_WAIT_LABEL,
  type ChatActivityEvent,
} from "../../shared/chatActivity";
import {
  QUIET_AFTER_MS,
  QUIET_START_AFTER_MS,
  SLOW_TOOL_AFTER_MS,
  STALE_CONNECTION_AFTER_MS,
  deriveLivePhase,
  describeLivePhase,
  elapsedSince,
  headlineOf,
  type LivePhaseInput,
} from "./chatLiveness";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function event(
  ordinal: number,
  kind: ChatActivityEvent["kind"],
  ms: number,
  extra: Partial<ChatActivityEvent> = {},
): ChatActivityEvent {
  return {
    ordinal,
    attempt: 1,
    kind,
    name: "",
    callId: "",
    summary: "",
    detail: null,
    isError: false,
    at: at(ms),
    ...extra,
  };
}

const started = event(1, "turn_started", 500, { detail: { reason: "start", attempt: 1 } });

function input(now: number, extra: Partial<LivePhaseInput> = {}): LivePhaseInput {
  return {
    events: [],
    startedAt: T0,
    now: T0 + now,
    lastTextAt: null,
    lastSignalAt: T0 + now,
    connection: "streaming",
    ...extra,
  };
}

describe("what a running turn is doing", () => {
  test("a turn nobody has picked up yet is starting, then quiet", () => {
    assert.equal(deriveLivePhase(input(2_000)).kind, "starting");
    const quiet = deriveLivePhase(input(QUIET_START_AFTER_MS + 1_000));
    assert.equal(quiet.kind, "quiet");
    if (quiet.kind === "quiet") assert.equal(quiet.before, "starting");
  });

  test("a reply already partly on screen has started, even with no events read yet", () => {
    // A reload re-attaches: the saved text arrives before the turn's events.
    const phase = deriveLivePhase(input(5_000, { hasReplyText: true }));
    assert.equal(phase.kind, "thinking");
  });

  test("between steps the employee is waiting on the AI Model; long silence says so plainly", () => {
    const thinking = deriveLivePhase(input(10_000, { events: [started] }));
    assert.equal(thinking.kind, "thinking");
    assert.equal(thinking.since, T0 + 500);
    const quiet = deriveLivePhase(input(500 + QUIET_AFTER_MS + 7_000, { events: [started] }));
    assert.equal(quiet.kind, "quiet");
    if (quiet.kind === "quiet") assert.equal(quiet.quietMs, QUIET_AFTER_MS + 7_000);
    assert.equal(describeLivePhase(quiet, "Sam Flinch", T0).title, "No activity for 52s");
  });

  test("a thinking summary names what it is thinking about", () => {
    const phase = deriveLivePhase(
      input(3_000, {
        events: [
          started,
          event(2, "reasoning", 2_000, {
            detail: { text: "**Comparing quotes**\nSpot is", block: "r" },
          }),
        ],
      }),
    );
    assert.equal(phase.kind, "thinking");
    assert.equal(describeLivePhase(phase, "Sam", T0).title, "Thinking: Comparing quotes");
  });

  test("a running tool is the work; past two minutes it is called slow, not stuck", () => {
    const events = [
      started,
      event(2, "tool_use", 1_000, {
        name: "bash",
        callId: "c",
        detail: { input: { command: "npm test" } },
      }),
    ];
    const phase = deriveLivePhase(input(5_000, { events }));
    assert.equal(phase.kind, "tool");
    if (phase.kind === "tool") {
      assert.equal(phase.step.label, "Running");
      assert.equal(phase.step.target, "npm test");
      assert.equal(phase.slow, false);
    }
    const slow = deriveLivePhase(input(1_000 + SLOW_TOOL_AFTER_MS + 1, { events }));
    assert.equal(slow.kind, "tool");
    if (slow.kind === "tool") assert.equal(slow.slow, true);
    assert.match(describeLivePhase(slow, "Sam", T0).detail ?? "", /taking a while/);
  });

  test("text arriving now is the reply being written", () => {
    const phase = deriveLivePhase(input(9_000, { events: [started], lastTextAt: T0 + 8_000 }));
    assert.equal(phase.kind, "writing");
    const later = deriveLivePhase(input(20_000, { events: [started], lastTextAt: T0 + 8_000 }));
    assert.equal(later.kind, "thinking");
    assert.equal(later.since, T0 + 8_000, "quiet time counts from the last text");
  });

  test("a named wait is shown with its own words", () => {
    const lock = deriveLivePhase(
      input(4_000, {
        events: [
          event(1, "waiting", 1_000, {
            name: "model_lock",
            detail: { cause: "model_lock", state: "waiting", label: "x" },
          }),
        ],
      }),
    );
    assert.equal(lock.kind, "waiting");
    assert.equal(describeLivePhase(lock, "Sam", T0).title, "Waiting for the AI Model");

    const busy = deriveLivePhase(
      input(4_000, {
        events: [
          event(1, "waiting", 1_000, {
            name: "thread_busy",
            detail: { cause: "thread_busy", state: "waiting", label: "x" },
          }),
        ],
      }),
    );
    assert.match(describeLivePhase(busy, "Sam Flinch", T0).detail ?? "", /one message at a time/);
  });

  test("a retry counts down, then the turn is back to waiting on the model", () => {
    const events = [
      started,
      event(2, "waiting", 2_000, {
        name: "model_retry",
        detail: {
          cause: "model_retry",
          state: "waiting",
          label: "x",
          until: at(7_000),
          attempt: 2,
          maxAttempts: 4,
          reason: "HTTP 529",
        },
      }),
    ];
    const retrying = deriveLivePhase(input(3_000, { events }));
    assert.equal(retrying.kind, "waiting");
    const words = describeLivePhase(retrying, "Sam", T0 + 3_000);
    assert.equal(words.title, "Retrying the AI Model in 4s");
    assert.match(words.detail ?? "", /HTTP 529.*attempt 2 of 4/);
    assert.equal(deriveLivePhase(input(8_000, { events })).kind, "thinking");
  });

  test("a wait the server has words for and the chat does not still shows", () => {
    const phase = deriveLivePhase(
      input(2_000, {
        events: [
          event(1, "waiting", 1_000, {
            name: "approval_pending",
            detail: {
              cause: "approval_pending",
              state: "waiting",
              label: "Waiting for an owner to approve the next step",
            },
          }),
        ],
      }),
    );
    assert.equal(phase.kind, "waiting");
    assert.equal(
      describeLivePhase(phase, "Sam", T0).title,
      "Waiting for an owner to approve the next step",
    );
  });

  test("a message waiting for its unavailable AI Model says so in the server's words, and how to cancel", () => {
    const phase = deriveLivePhase(
      input(60_000, {
        events: [
          event(1, "waiting", 1_000, {
            name: MODEL_UNAVAILABLE_WAIT_CAUSE,
            detail: {
              cause: MODEL_UNAVAILABLE_WAIT_CAUSE,
              state: "waiting",
              label: MODEL_UNAVAILABLE_WAIT_LABEL,
            },
          }),
        ],
      }),
    );
    assert.equal(phase.kind, "waiting");
    const words = describeLivePhase(phase, "Sam", T0 + 60_000);
    assert.equal(words.title, "The AI Model is unavailable — this will be answered when it is back");
    assert.match(words.detail ?? "", /^Nothing to resend: Sam answers it .* Stop it to cancel\.$/);
    assert.equal(words.tone, "warning");
  });

  test("a wait that ended is no longer the state", () => {
    const phase = deriveLivePhase(
      input(20_000, {
        events: [
          event(1, "waiting", 1_000, {
            name: "model_lock",
            detail: { cause: "model_lock", state: "waiting", label: "x" },
          }),
          event(2, "waiting", 15_000, {
            name: "model_lock",
            detail: { cause: "model_lock", state: "done" },
          }),
        ],
      }),
    );
    assert.equal(phase.kind, "thinking");
  });

  test("losing the connection is not the turn being quiet", () => {
    assert.equal(
      deriveLivePhase(input(5_000, { connection: "reconnecting" })).kind,
      "reconnecting",
    );
    const stale = deriveLivePhase(
      input(STALE_CONNECTION_AFTER_MS + 10_000, { events: [started], lastSignalAt: T0 + 1_000 }),
    );
    assert.equal(stale.kind, "reconnecting");
    // A follower that re-reads saved rows has no heartbeat to miss.
    const polling = deriveLivePhase(
      input(QUIET_AFTER_MS + 10_000, {
        events: [started],
        lastSignalAt: T0,
        connection: "polling",
      }),
    );
    assert.equal(polling.kind, "quiet");
  });

  test("a stop in flight, or a recorded one, reads as stopping", () => {
    assert.equal(
      deriveLivePhase(input(1_000, { events: [started], stopping: true })).kind,
      "stopping",
    );
    assert.equal(
      deriveLivePhase(input(1_000, { events: [started, event(2, "stopped", 900)] })).kind,
      "stopping",
    );
  });
});

describe("the words and clocks", () => {
  test("a thought's headline is its last bold title, else its first sentence", () => {
    assert.equal(headlineOf({ text: "**One**\nmore\n**Two titles**" }), "Two titles");
    assert.equal(
      headlineOf({ text: "I should check the ledger. Then the bank." }),
      "I should check the ledger.",
    );
    assert.equal(headlineOf({ text: "   " }), null);
  });

  test("elapsed time is whole seconds, minutes and hours", () => {
    assert.equal(elapsedSince(T0, T0 + 999), "0s");
    assert.equal(elapsedSince(T0, T0 + 134_000), "2m 14s");
    assert.equal(elapsedSince(T0, T0 + 3_780_000), "1h 3m");
    assert.equal(
      elapsedSince(T0 + 5_000, T0),
      "0s",
      "a clock behind the server never goes negative",
    );
  });

  test("what a screen reader hears changes with the state, never with the clock", () => {
    const quietAt = (ms: number) =>
      describeLivePhase(deriveLivePhase(input(ms, { events: [started] })), "Sam", T0 + ms);
    const first = quietAt(QUIET_AFTER_MS + 2_000);
    const later = quietAt(QUIET_AFTER_MS + 9_000);
    assert.notEqual(first.title, later.title, "the visible line counts");
    assert.equal(first.announce, later.announce, "the announcement does not");
    assert.ok(!/\d/.test(first.announce));
    const retry = deriveLivePhase(
      input(3_000, {
        events: [
          started,
          event(2, "waiting", 2_000, {
            name: "model_retry",
            detail: { cause: "model_retry", state: "waiting", label: "x", until: at(9_000) },
          }),
        ],
      }),
    );
    assert.equal(describeLivePhase(retry, "Sam", T0 + 3_000).announce, "Retrying the AI Model");
    assert.equal(describeLivePhase(retry, "Sam", T0 + 6_000).announce, "Retrying the AI Model");
  });

  test("every phase has a title a screen reader can announce", () => {
    const phases = [
      deriveLivePhase(input(0)),
      deriveLivePhase(input(0, { connection: "reconnecting" })),
      deriveLivePhase(input(0, { stopping: true })),
      deriveLivePhase(input(100, { events: [started], lastTextAt: T0 + 50 })),
    ];
    for (const phase of phases) assert.ok(describeLivePhase(phase, "Sam", T0).title.length > 0);
  });
});
