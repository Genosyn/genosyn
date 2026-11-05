import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MODEL_RESUMING_WAIT_CAUSE,
  MODEL_RESUMING_WAIT_LABEL,
  MODEL_UNAVAILABLE_WAIT_CAUSE,
  MODEL_UNAVAILABLE_WAIT_LABEL,
  type ChatActivityEvent,
  type ModelPulse,
} from "../../shared/chatActivity";
import {
  EXPLAIN_WAIT_AFTER_MS,
  FIRST_ANSWER_SILENT_AFTER_MS,
  QUIET_AFTER_MS,
  QUIET_START_AFTER_MS,
  SLOW_TOOL_AFTER_MS,
  STALE_CONNECTION_AFTER_MS,
  STREAM_SILENT_AFTER_MS,
  deriveLivePhase,
  describeLivePhase,
  describePulseFacts,
  describePulseSignal,
  elapsedSince,
  formatSize,
  headlineOf,
  phaseClockSince,
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

  test("a reader with only the steps never calls a turn it cannot see inactive", () => {
    const thinking = deriveLivePhase(input(10_000, { events: [started] }));
    assert.equal(thinking.kind, "thinking");
    assert.equal(thinking.since, T0 + 500);
    const quiet = deriveLivePhase(input(500 + QUIET_AFTER_MS + 7_000, { events: [started] }));
    assert.equal(quiet.kind, "quiet");
    if (quiet.kind === "quiet") assert.equal(quiet.quietMs, QUIET_AFTER_MS + 7_000);
    const words = describeLivePhase(quiet, "Sam Flinch", T0);
    assert.equal(words.title, "Working");
    assert.equal(words.tone, "waiting", "not a warning: nothing says anything is wrong");
    assert.match(words.detail ?? "", /No step has finished for 52s/);
    assert.match(words.detail ?? "", /may well still be thinking/);
  });

  test("a turn nobody has picked up says so, in the amber it has earned", () => {
    const words = describeLivePhase(
      deriveLivePhase(input(QUIET_START_AFTER_MS + 1_000)),
      "Sam",
      T0,
    );
    assert.equal(words.title, "Not started yet");
    assert.equal(words.tone, "warning");
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

  test("a Workspace reply taking its turn once the AI Model is back says so", () => {
    const phase = deriveLivePhase(
      input(20_000, {
        events: [
          event(1, "waiting", 1_000, {
            name: MODEL_RESUMING_WAIT_CAUSE,
            detail: {
              cause: MODEL_RESUMING_WAIT_CAUSE,
              state: "waiting",
              label: MODEL_RESUMING_WAIT_LABEL,
            },
          }),
        ],
      }),
    );
    assert.equal(phase.kind, "waiting");
    const words = describeLivePhase(phase, "Ada", T0 + 20_000);
    assert.equal(words.title, "Starting again now the AI Model is back");
    assert.match(words.detail ?? "", /one at a time/);
    assert.equal(words.tone, "waiting");
  });

  test("a step the room sees without its details still drives the status line", () => {
    const phase = deriveLivePhase(
      input(3_000, {
        events: [
          started,
          event(2, "tool_use", 1_000, {
            name: "search_mail",
            callId: "c1",
            detail: { input: null, withheld: "steps" },
          }),
        ],
      }),
    );
    assert.equal(phase.kind, "tool");
    assert.equal(describeLivePhase(phase, "Ada", T0 + 3_000).title, "Searching email");
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

/** A reading of the AI Model's stream, `ms` after the turn started. */
function pulse(ms: number, extra: Partial<ModelPulse> = {}): ModelPulse {
  return {
    state: "thinking",
    label: null,
    model: "claude-opus-5-5",
    request: 1,
    tool: null,
    since: at(ms),
    sentAt: at(ms),
    lastDataAt: at(ms),
    chars: 0,
    outputTokens: 0,
    now: at(ms),
    ...extra,
  };
}

describe("what the AI Model's own stream says", () => {
  // The screenshot this exists for: a question, two minutes and forty-two
  // seconds of a model thinking hard, and a card calling that "No activity".
  test("a model thinking for minutes reads as thinking, never as nothing happening", () => {
    const events = [started];
    const lastDataAt = at(161_000);
    const phase = deriveLivePhase(
      input(162_000, { events, pulse: pulse(1_000, { lastDataAt, outputTokens: 4_000 }) }),
    );
    assert.equal(phase.kind, "thinking");
    const words = describeLivePhase(phase, "Sam Flinch", T0 + 162_000);
    assert.equal(words.title, "Thinking");
    assert.equal(words.tone, "working");
    assert.ok(!/no activity/i.test(JSON.stringify(words)));
  });

  test("a request nothing has come back for says that, and later why it can take a while", () => {
    const reading = pulse(1_000, { state: "waiting", lastDataAt: null });
    const soon = deriveLivePhase(input(5_000, { events: [started], pulse: reading }));
    assert.equal(soon.kind, "asking");
    const words = describeLivePhase(soon, "Sam", T0 + 5_000);
    assert.equal(words.title, "Waiting for the AI Model to start answering");
    assert.equal(words.detail, null);
    const later = T0 + 1_000 + EXPLAIN_WAIT_AFTER_MS + 1;
    assert.match(
      describeLivePhase(soon, "Sam", later).detail ?? "",
      /Long conversations and higher thinking levels/,
    );
  });

  test("writing a tool call is the next step being prepared, with how much so far", () => {
    const phase = deriveLivePhase(
      input(30_000, {
        events: [started],
        pulse: pulse(10_000, {
          state: "tool_input",
          tool: "genosyn_create_note",
          chars: 4_200,
          lastDataAt: at(29_500),
        }),
      }),
    );
    assert.equal(phase.kind, "drafting");
    const words = describeLivePhase(phase, "Sam", T0 + 31_000);
    assert.equal(words.title, "Preparing: Creating note");
    assert.match(words.detail ?? "", /4\.2 KB written so far/);
    assert.match(words.detail ?? "", /Long arguments/);
    assert.equal(words.announce, "Preparing the next step");
    assert.equal(
      describeLivePhase(phase, "Sam", T0 + 12_000).detail,
      "4.2 KB written so far.",
      "the reason waits until it has been a while",
    );
  });

  test("a tool whose label is only a verb still says what it is preparing", () => {
    const draft = (tool: string) =>
      describeLivePhase(
        deriveLivePhase(
          input(2_000, { pulse: pulse(1_000, { state: "tool_input", tool, lastDataAt: at(2_000) }) }),
        ),
        "Sam",
        T0 + 2_000,
      ).title;
    assert.equal(draft("bash"), "Preparing: Running a command");
    assert.equal(draft("write"), "Preparing: Writing a file");
    assert.equal(draft("webfetch"), "Preparing: Opening a web page");
    assert.equal(draft("genosyn_find_tools"), "Preparing: Looking for the right tool");
    assert.equal(
      describeLivePhase(
        deriveLivePhase(input(2_000, { pulse: pulse(1_000, { state: "tool_input" }) })),
        "Sam",
        T0 + 2_000,
      ).title,
      "Preparing: the next step",
    );
  });

  test("the reply being written, however long it takes, and a summary nobody reads", () => {
    const writing = deriveLivePhase(
      input(60_000, { pulse: pulse(10_000, { state: "writing", lastDataAt: at(59_000) }) }),
    );
    assert.equal(writing.kind, "writing");
    assert.equal(writing.since, T0 + 10_000);
    const compacting = deriveLivePhase(
      input(20_000, { pulse: pulse(10_000, { state: "compacting", lastDataAt: at(19_000) }) }),
    );
    assert.equal(compacting.kind, "compacting");
    assert.equal(
      describeLivePhase(compacting, "Sam", T0 + 20_000).title,
      "Compacting the conversation",
    );
  });

  test("getting ready says what with, before the AI Model has been asked anything", () => {
    const phase = deriveLivePhase(
      input(3_000, {
        events: [started],
        pulse: pulse(1_000, {
          state: "preparing",
          label: "Updating its Repositories",
          sentAt: null,
          lastDataAt: null,
        }),
      }),
    );
    assert.equal(phase.kind, "preparing");
    const words = describeLivePhase(phase, "Sam", T0 + 3_000);
    assert.equal(words.title, "Getting ready");
    assert.equal(words.detail, "Updating its Repositories");
  });

  test("only a stream that has really gone silent is called silent, and says for how long", () => {
    const lastDataAt = at(1_000);
    const just = deriveLivePhase(
      input(1_000 + STREAM_SILENT_AFTER_MS, { pulse: pulse(1_000, { lastDataAt }) }),
    );
    assert.equal(just.kind, "thinking");
    const silent = deriveLivePhase(
      input(1_000 + STREAM_SILENT_AFTER_MS + 5_000, { pulse: pulse(1_000, { lastDataAt }) }),
    );
    assert.equal(silent.kind, "silent");
    const words = describeLivePhase(silent, "Sam", T0);
    assert.equal(words.title, "No data from the AI Model for 2m 5s");
    assert.equal(words.tone, "warning");
    assert.match(words.detail ?? "", /It was thinking when it went silent.*keep waiting or stop/);
    assert.equal(words.announce, "The AI Model has gone silent");
  });

  test("a keep-alive counts: what matters is the last thing heard, not the last word", () => {
    const phase = deriveLivePhase(
      input(600_000, { pulse: pulse(1_000, { lastDataAt: at(595_000) }) }),
    );
    assert.equal(phase.kind, "thinking");
  });

  test("a first answer gets longer before it is called silent than a stream in progress", () => {
    const waiting = (ms: number) =>
      deriveLivePhase(input(ms, { pulse: pulse(1_000, { state: "waiting", lastDataAt: null }) }));
    assert.equal(waiting(1_000 + STREAM_SILENT_AFTER_MS + 10_000).kind, "asking");
    const silent = waiting(1_000 + FIRST_ANSWER_SILENT_AFTER_MS + 1_000);
    assert.equal(silent.kind, "silent");
    assert.match(describeLivePhase(silent, "Sam", T0).detail ?? "", /has not started answering/);
  });

  test("a model that thinks without saying anything for a while gets a word of context", () => {
    const quietly = deriveLivePhase(
      input(40_000, { pulse: pulse(1_000, { lastDataAt: at(1_000) }) }),
    );
    assert.equal(quietly.kind, "thinking");
    assert.match(describeLivePhase(quietly, "Sam", T0).detail ?? "", /can go quiet/);
  });

  test("a running tool, a named wait and a stop all outrank the stream", () => {
    const reading = pulse(1_000, { state: "thinking", lastDataAt: at(1_900) });
    const tool = deriveLivePhase(
      input(2_000, {
        pulse: reading,
        events: [started, event(2, "tool_use", 1_500, { name: "bash", callId: "c" })],
      }),
    );
    assert.equal(tool.kind, "tool");
    const waiting = deriveLivePhase(
      input(2_000, {
        pulse: reading,
        events: [
          event(1, "waiting", 1_000, {
            name: "model_lock",
            detail: { cause: "model_lock", state: "waiting", label: "x" },
          }),
        ],
      }),
    );
    assert.equal(waiting.kind, "waiting");
    assert.equal(deriveLivePhase(input(2_000, { pulse: reading, stopping: true })).kind, "stopping");
    assert.equal(
      deriveLivePhase(input(2_000, { pulse: reading, connection: "reconnecting" })).kind,
      "reconnecting",
    );
  });

  test("the moment between requests is no one's thought: not a stale headline", () => {
    const events = [
      started,
      event(2, "reasoning", 2_000, { detail: { text: "**Old thought**", block: "r" } }),
    ];
    const phase = deriveLivePhase(
      input(5_000, { events, pulse: pulse(4_000, { state: "finished" }) }),
    );
    assert.equal(phase.kind, "between");
    assert.equal(describeLivePhase(phase, "Sam", T0).title, "Working");
    // Still not nothing, should the gap go on.
    const later = deriveLivePhase(
      input(4_000 + QUIET_AFTER_MS + 1, { events, pulse: pulse(4_000, { state: "finished" }) }),
    );
    assert.equal(later.kind, "quiet");
  });
});

describe("the evidence under the status line", () => {
  const NOW = T0 + 100_000;

  test("data arriving is shown as arriving; after that, as how long ago", () => {
    assert.deepEqual(describePulseSignal(pulse(0, { lastDataAt: at(98_000) }), NOW), {
      tone: "live",
      text: "Receiving now",
    });
    assert.deepEqual(describePulseSignal(pulse(0, { lastDataAt: at(50_000) }), NOW), {
      tone: "idle",
      text: "Last data 50s ago",
    });
  });

  test("a request nothing has come back for says when it went out", () => {
    assert.deepEqual(
      describePulseSignal(pulse(40_000, { state: "waiting", lastDataAt: null }), NOW),
      { tone: "idle", text: "Sent 1m 0s ago" },
    );
  });

  test("nothing to say before a request, between requests, or to a reader with no pulses", () => {
    assert.equal(describePulseSignal(pulse(0, { state: "preparing" }), NOW), null);
    assert.equal(describePulseSignal(pulse(0, { state: "finished" }), NOW), null);
    assert.equal(describePulseSignal(null, NOW), null);
    assert.deepEqual(describePulseFacts(null), []);
  });

  test("the facts name the AI Model, which call this is once there is more than one, and tokens", () => {
    assert.deepEqual(describePulseFacts(pulse(0)), ["claude-opus-5-5"]);
    assert.deepEqual(describePulseFacts(pulse(0, { request: 3, outputTokens: 1_240 })), [
      "claude-opus-5-5",
      "AI Model call 3",
      "~1.2K tokens",
    ]);
    assert.deepEqual(describePulseFacts(pulse(0, { model: null, outputTokens: 12 })), ["~12 tokens"]);
  });

  test("how much a tool call has grown", () => {
    assert.equal(formatSize(1), "1 character");
    assert.equal(formatSize(812), "812 characters");
    assert.equal(formatSize(4_200), "4.2 KB");
    assert.equal(formatSize(1_300_000), "1.3 MB");
  });

  test("a status keeps its own clock only once it has parted from the turn's", () => {
    const thinking = (since: number) =>
      deriveLivePhase(input(since + 100, { pulse: pulse(since, { lastDataAt: at(since) }) }));
    assert.equal(phaseClockSince(thinking(1_000), T0), null, "two clocks reading the same");
    assert.equal(phaseClockSince(thinking(30_000), T0), T0 + 30_000);
    const quiet = deriveLivePhase(input(QUIET_START_AFTER_MS + 1_000));
    assert.equal(phaseClockSince(quiet, T0), null);
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
    const silentAt = (ms: number) =>
      describeLivePhase(
        deriveLivePhase(input(ms, { events: [started], pulse: pulse(0) })),
        "Sam",
        T0 + ms,
      );
    const first = silentAt(STREAM_SILENT_AFTER_MS + 2_000);
    const later = silentAt(STREAM_SILENT_AFTER_MS + 9_000);
    assert.notEqual(first.title, later.title, "the visible line counts");
    assert.equal(first.announce, later.announce, "the announcement does not");
    assert.ok(!/\d/.test(first.announce));
    const quietAt = (ms: number) =>
      describeLivePhase(deriveLivePhase(input(ms, { events: [started] })), "Sam", T0 + ms);
    assert.equal(quietAt(QUIET_AFTER_MS + 2_000).announce, "Working");
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
