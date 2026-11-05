import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ChatActivityEvent,
  ModelCallPhase,
  ModelPulse,
} from "../../shared/chatActivity";
import {
  EMPTY_LIVE_TURN,
  buildActivitySteps,
  closeThoughtsBefore,
  countSteps,
  latestProgress,
  mergeActivityEvents,
  reduceLiveTurn,
  thoughtInProgress,
  visibleSteps,
  type ThinkingStep,
  type ToolStep,
  type WaitStep,
} from "./chatActivity";

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

const use = (
  ordinal: number,
  ms: number,
  name: string,
  callId: string,
  input: Record<string, unknown> = {},
) => event(ordinal, "tool_use", ms, { name, callId, detail: { input } });
const result = (
  ordinal: number,
  ms: number,
  name: string,
  callId: string,
  detail: Record<string, unknown> = {},
  isError = false,
) =>
  event(ordinal, "tool_result", ms, { name, callId, detail: { output: "ok", ...detail }, isError });

describe("merging a turn's events", () => {
  test("keeps one copy of each event, in ordinal order, whatever order they arrive in", () => {
    const a = event(1, "turn_started", 0);
    const b = use(2, 100, "bash", "c1");
    const c = result(3, 900, "bash", "c1");
    const merged = mergeActivityEvents(mergeActivityEvents([], [c, a]), [b, a, c]);
    assert.deepEqual(
      merged.map((e) => e.ordinal),
      [1, 2, 3],
    );
  });

  test("hands back the same array when nothing is new, so a re-render is skipped", () => {
    const current = [event(1, "turn_started", 0)];
    assert.equal(mergeActivityEvents(current, [event(1, "turn_started", 0)]), current);
    assert.equal(mergeActivityEvents(current, []), current);
  });

  test("ignores anything that is not an event", () => {
    const current = [event(1, "turn_started", 0)];
    const junk = [
      null,
      { kind: "tool_use" },
      { ordinal: "2", kind: "x", at: "" },
    ] as unknown as ChatActivityEvent[];
    assert.equal(mergeActivityEvents(current, junk), current);
  });

  test("a live copy and a re-read row of the same event collapse even if their times differ", () => {
    const live = use(2, 100, "bash", "c1");
    const reread = { ...live, at: at(101) };
    assert.equal(mergeActivityEvents([live], [reread]).length, 1);
  });
});

describe("following a turn's frames", () => {
  test("the turn frame names the turn and sets the server clock", () => {
    const state = reduceLiveTurn(
      EMPTY_LIVE_TURN,
      { event: "turn", data: { messageId: "m1", startedAt: at(0), now: at(5_000) } },
      T0 + 2_000,
    );
    assert.equal(state.turnId, "m1");
    assert.equal(state.startedAt, T0);
    assert.equal(state.clockOffsetMs, 3_000);
    assert.equal(state.lastSignalAt, T0 + 5_000);
  });

  test("activity merges, heartbeats keep it alive, and text marks the writing", () => {
    let state = reduceLiveTurn(
      EMPTY_LIVE_TURN,
      { event: "turn", data: { messageId: "m1", startedAt: at(0), now: at(0) } },
      T0,
    );
    state = reduceLiveTurn(state, { event: "activity", data: use(4, 10, "bash", "c1") }, T0 + 10);
    state = reduceLiveTurn(state, { event: "activity", data: use(4, 10, "bash", "c1") }, T0 + 11);
    assert.equal(state.events.length, 1);
    assert.equal(state.lastOrdinal, 4);
    state = reduceLiveTurn(state, { event: "heartbeat", data: { now: at(20_000) } }, T0 + 20_000);
    assert.equal(state.lastSignalAt, T0 + 20_000);
    assert.equal(state.lastTextAt, null);
    state = reduceLiveTurn(state, { event: "chunk", data: { text: "Hi" } }, T0 + 21_000);
    assert.equal(state.lastTextAt, T0 + 21_000);
    state = reduceLiveTurn(state, { event: "chunk", data: { text: "" } }, T0 + 30_000);
    assert.equal(state.lastTextAt, T0 + 21_000, "an empty chunk is not writing");
  });

  test("a different turn starts its own events", () => {
    let state = reduceLiveTurn(EMPTY_LIVE_TURN, { event: "turn", data: { messageId: "m1" } }, T0);
    state = reduceLiveTurn(state, { event: "activity", data: use(1, 10, "bash", "c1") }, T0);
    state = reduceLiveTurn(state, { event: "working", data: { id: "m2", createdAt: at(50) } }, T0);
    assert.equal(state.turnId, "m2");
    assert.equal(state.events.length, 0);
    assert.equal(state.startedAt, T0 + 50);
  });
});

describe("the AI Model's pulse on a turn's stream", () => {
  const reading = (extra: Partial<ModelPulse> = {}): ModelPulse => ({
    state: "thinking",
    label: null,
    model: "m",
    request: 1,
    tool: null,
    since: at(1_000),
    sentAt: at(1_000),
    lastDataAt: at(2_000),
    chars: 0,
    outputTokens: 0,
    now: at(2_000),
    ...extra,
  });

  test("the latest reading is kept, and sets the server clock", () => {
    const next = reduceLiveTurn(
      EMPTY_LIVE_TURN,
      { event: "pulse", data: reading() },
      T0 + 2_000 - 500,
    );
    assert.equal(next.pulse?.state, "thinking");
    assert.equal(next.clockOffsetMs, 500);
    assert.equal(next.lastSignalAt, T0 + 2_000);
  });

  test("attaching again forgets a reading that may be long out of date", () => {
    const held = reduceLiveTurn(EMPTY_LIVE_TURN, { event: "pulse", data: reading() }, T0);
    const again = reduceLiveTurn(
      held,
      { event: "turn", data: { messageId: "m1", startedAt: at(0), now: at(5_000) } },
      T0 + 5_000,
    );
    assert.equal(again.pulse, null);
  });

  test("a new turn starts with no reading, and a malformed one is ignored", () => {
    const held = reduceLiveTurn(
      { ...EMPTY_LIVE_TURN, turnId: "m1" },
      { event: "pulse", data: reading() },
      T0,
    );
    assert.equal(
      reduceLiveTurn(held, { event: "working", data: { id: "m2", createdAt: at(0) } }, T0).pulse,
      null,
    );
    assert.equal(
      reduceLiveTurn(EMPTY_LIVE_TURN, { event: "pulse", data: { state: 3 } }, T0).pulse,
      null,
    );
  });

  test("the server saying it can no longer see the AI Model clears what was last heard", () => {
    const held = reduceLiveTurn(
      reduceLiveTurn(EMPTY_LIVE_TURN, { event: "pulse", data: reading() }, T0),
      { event: "tool_output", data: { callId: "c1", output: "one\n" } },
      T0,
    );
    const lost = reduceLiveTurn(held, { event: "pulse", data: null }, T0);
    assert.equal(lost.pulse, null);
    assert.deepEqual(lost.toolOutputs, {});
    assert.equal(
      reduceLiveTurn(held, { event: "pulse", data: { state: 3 } }, T0).pulse?.state,
      "thinking",
      "a malformed reading changes nothing",
    );
  });
});

describe("what a running command prints, on a turn's stream", () => {
  test("is held by the call, replacing what it printed before", () => {
    let state = reduceLiveTurn(
      EMPTY_LIVE_TURN,
      { event: "tool_output", data: { callId: "c1", output: "one\n" } },
      T0,
    );
    state = reduceLiveTurn(
      state,
      { event: "tool_output", data: { callId: "c1", output: "one\ntwo\n" } },
      T0,
    );
    state = reduceLiveTurn(state, { event: "tool_output", data: { callId: "c2", output: "x\n" } }, T0);
    assert.deepEqual(state.toolOutputs, { c1: "one\ntwo\n", c2: "x\n" });
    assert.deepEqual(
      reduceLiveTurn(state, { event: "tool_output", data: { callId: 3 } }, T0).toolOutputs,
      state.toolOutputs,
    );
  });

  test("a step knows its call, and a new turn starts with nothing printed", () => {
    const steps = buildActivitySteps([use(1, 0, "bash", "c1", { command: "npm test" })]);
    assert.equal((steps[0] as ToolStep).callId, "c1");
    const held = reduceLiveTurn(
      { ...EMPTY_LIVE_TURN, turnId: "m1" },
      { event: "tool_output", data: { callId: "c1", output: "one\n" } },
      T0,
    );
    assert.deepEqual(
      reduceLiveTurn(held, { event: "working", data: { id: "m2", createdAt: at(0) } }, T0).toolOutputs,
      {},
    );
  });
});

describe("what a request's record adds to the steps", () => {
  const call = (
    ordinal: number,
    ms: number,
    phases: Array<Omit<ModelCallPhase, "startedAt"> & { start: number }>,
    request = 1,
  ) =>
    event(ordinal, "model_call", ms, {
      name: String(request),
      detail: {
        request,
        model: "m",
        sentAt: at(phases[0]?.start ?? ms),
        durationMs: 1,
        phases: phases.map(({ start, ...phase }) => ({ ...phase, startedAt: at(start) })),
        inputTokens: null,
        outputTokens: null,
        stopReason: null,
      },
    });

  test("a model that thought and shared no words still gets its step, in its place", () => {
    const steps = buildActivitySteps([
      event(1, "turn_started", 0),
      use(2, 40_000, "bash", "c"),
      result(3, 41_000, "bash", "c"),
      call(4, 40_000, [{ kind: "thinking", start: 2_000, ms: 38_000 }]),
    ]);
    const visible = visibleSteps(steps);
    assert.deepEqual(
      visible.map((step) => step.kind),
      ["thinking", "tool"],
    );
    const thought = visible[0] as ThinkingStep;
    assert.equal(thought.text, "");
    assert.equal(thought.startedAt, T0 + 2_000);
    assert.equal(thought.endedAt, T0 + 40_000);
  });

  test("two requests close together keep a thought each", () => {
    const steps = buildActivitySteps([
      event(1, "reasoning", 2_000, { detail: { text: "First", block: "a" } }),
      call(2, 4_000, [{ kind: "thinking", start: 1_000, ms: 3_000, chars: 5 }], 1),
      call(3, 12_000, [{ kind: "thinking", start: 5_000, ms: 7_000 }], 2),
    ]);
    const thoughts = steps.filter((step): step is ThinkingStep => step.kind === "thinking");
    assert.equal(thoughts.length, 2);
    assert.equal(thoughts[0].text, "First");
    assert.equal(thoughts[0].endedAt, T0 + 4_000, "not stretched over the next request's");
    assert.equal(thoughts[1].text, "");
    assert.equal(thoughts[1].endedAt, T0 + 12_000);
  });

  test("the moment a request's first bytes arrive does not claim the next request's thought", () => {
    // A request that went straight to its tool call, then one that thinks in words.
    const first = call(
      1,
      1_500,
      [
        { kind: "waiting", start: 0, ms: 1_000 },
        { kind: "thinking", start: 1_000, ms: 50 },
        { kind: "tool_input", start: 1_050, ms: 300, tool: "search_web" },
      ],
      1,
    );
    const worded = event(5, "reasoning", 4_500, {
      detail: { text: "**Weighing the options** in words", block: "r2" },
    });
    const live = [
      use(2, 2_000, "search_web", "a"),
      first,
      result(4, 2_500, "search_web", "a"),
      worded,
    ];
    const during = buildActivitySteps(live);
    assert.equal(thoughtInProgress(during)?.text, "**Weighing the options** in words");

    const finished = buildActivitySteps([
      ...live,
      call(
        6,
        34_000,
        [
          { kind: "waiting", start: 2_600, ms: 400 },
          { kind: "thinking", start: 3_000, ms: 30_000, chars: 900 },
          { kind: "writing", start: 33_000, ms: 1_000, chars: 40 },
        ],
        2,
      ),
    ]);
    const thoughts = finished.filter((step): step is ThinkingStep => step.kind === "thinking");
    assert.equal(thoughts.length, 1, "one thought, with its words and its whole length");
    assert.equal(thoughts[0].text, "**Weighing the options** in words");
    assert.equal(thoughts[0].startedAt, T0 + 3_000);
    assert.equal(thoughts[0].endedAt, T0 + 33_000);
  });

  test("words a turn kept to itself still leave the time they took", () => {
    const steps = buildActivitySteps([
      call(1, 30_000, [{ kind: "thinking", start: 0, ms: 30_000, chars: 400 }]),
    ]);
    assert.equal(steps.length, 1);
    assert.equal((steps[0] as ThinkingStep).text, "");
  });

  test("every step of a retried turn has its own key, though its requests number again", () => {
    const steps = buildActivitySteps([
      call(
        1,
        17_000,
        [
          { kind: "waiting", start: 0, ms: 12_000 },
          { kind: "thinking", start: 12_000, ms: 5_000 },
        ],
        1,
      ),
      event(2, "turn_started", 20_000, { detail: { reason: "retry" } }),
      call(
        3,
        38_000,
        [
          { kind: "waiting", start: 21_000, ms: 12_000 },
          { kind: "thinking", start: 33_000, ms: 5_000 },
        ],
        1,
      ),
    ]);
    const keys = steps.map((step) => step.key);
    assert.equal(keys.length, 5);
    assert.equal(new Set(keys).size, keys.length, keys.join(", "));
  });

  test("a tool call's writing time lands on that call, or on nothing", () => {
    // A call the feed leaves out says nothing about a step ten minutes on.
    const far = buildActivitySteps([
      call(1, 4_100, [{ kind: "tool_input", start: 0, ms: 4_000, tool: "genosyn_report_progress" }]),
      use(2, 600_000, "search_web", "z"),
    ]);
    assert.equal((far[0] as ToolStep).draftMs, null);
    // Nor on another tool that happens to start just then.
    const other = buildActivitySteps([
      call(1, 4_100, [{ kind: "tool_input", start: 0, ms: 4_000, tool: "genosyn_report_progress" }]),
      use(2, 5_000, "search_web", "z"),
    ]);
    assert.equal((other[0] as ToolStep).draftMs, null);
  });

  test("a turn around that took a moment is not a step", () => {
    const steps = buildActivitySteps([
      call(1, 2_000, [{ kind: "thinking", start: 0, ms: 2_000 }]),
    ]);
    assert.equal(steps.length, 0);
  });

  test("a thought that shared words gets the true start and end, not when it was written", () => {
    const steps = buildActivitySteps([
      event(1, "reasoning", 6_000, { detail: { text: "Weighing it", block: "r" } }),
      use(2, 50_000, "write", "c", { filePath: "a.md" }),
      call(3, 50_000, [
        { kind: "thinking", start: 4_000, ms: 20_000, chars: 300 },
        { kind: "tool_input", start: 24_000, ms: 26_000, tool: "write" },
      ]),
    ]);
    const thought = steps[0] as ThinkingStep;
    assert.equal(thought.text, "Weighing it");
    assert.equal(thought.startedAt, T0 + 4_000);
    assert.equal(thought.endedAt, T0 + 24_000, "not stretched over the tool call that came next");
    assert.equal(steps.filter((step) => step.kind === "thinking").length, 1);
  });

  test("a long tool call says how long it took to write", () => {
    const steps = buildActivitySteps([
      use(1, 30_000, "genosyn_create_note", "c"),
      result(2, 31_000, "genosyn_create_note", "c"),
      call(3, 30_000, [
        { kind: "tool_input", start: 2_000, ms: 28_000, tool: "genosyn_create_note" },
      ]),
    ]);
    assert.equal((steps[0] as ToolStep).draftMs, 28_000);
  });

  test("a quick one does not, and call_tool's real target is still found", () => {
    const quick = buildActivitySteps([
      use(1, 1_000, "bash", "c"),
      call(2, 1_000, [{ kind: "tool_input", start: 0, ms: 1_000, tool: "bash" }]),
    ]);
    assert.equal((quick[0] as ToolStep).draftMs, null);
    const through = buildActivitySteps([
      use(1, 10_000, "create_note", "c"),
      call(2, 10_000, [{ kind: "tool_input", start: 0, ms: 10_000, tool: "genosyn_call_tool" }]),
    ]);
    assert.equal((through[0] as ToolStep).draftMs, 10_000);
  });

  test("a parallel worker's step is not mistaken for this request's tool call", () => {
    const steps = buildActivitySteps([
      use(1, 10_000, "[worker:one] bash", "w"),
      call(2, 10_000, [{ kind: "tool_input", start: 0, ms: 10_000, tool: "bash" }]),
    ]);
    assert.equal((steps[0] as ToolStep).draftMs, null);
  });

  test("a long wait for the first answer is a step; a short one is not", () => {
    const long = buildActivitySteps([
      call(1, 60_000, [{ kind: "waiting", start: 0, ms: 45_000 }]),
    ]);
    assert.equal(long.length, 1);
    assert.equal((long[0] as WaitStep).cause, "model_first_answer");
    assert.equal((long[0] as WaitStep).endedAt, T0 + 45_000);
    assert.equal(
      buildActivitySteps([call(1, 2_000, [{ kind: "waiting", start: 0, ms: 2_000 }])]).length,
      0,
    );
  });

  test("a record that is not what it should be is ignored, not fatal", () => {
    const steps = buildActivitySteps([
      event(1, "model_call", 0, { detail: null }),
      event(2, "model_call", 0, { detail: { phases: "nope" } }),
      event(3, "model_call", 0, { detail: { phases: [{ kind: "thinking", startedAt: "x" }] } }),
    ]);
    assert.equal(steps.length, 0);
  });

  test("a call counts for nothing in the tool counts", () => {
    const counts = countSteps(
      buildActivitySteps([call(1, 8_000, [{ kind: "thinking", start: 0, ms: 8_000 }])]),
    );
    assert.equal(counts.tools, 0);
    assert.equal(counts.thinking, 1);
  });
});

describe("the thought in progress", () => {
  const thought = (ms: number) =>
    event(1, "reasoning", ms, { detail: { text: "Comparing quotes", block: "r" } });
  const reading = (state: ModelPulse["state"], since: number): ModelPulse => ({
    state,
    label: null,
    model: null,
    request: 1,
    tool: null,
    since: at(since),
    sentAt: at(0),
    lastDataAt: at(since),
    chars: 0,
    outputTokens: 0,
    now: at(since),
  });

  test("is the open thought at the end of the steps, when it has words", () => {
    const steps = buildActivitySteps([thought(1_000)]);
    assert.equal(thoughtInProgress(steps)?.text, "Comparing quotes");
    assert.equal(thoughtInProgress(buildActivitySteps([])), null);
    assert.equal(
      thoughtInProgress(buildActivitySteps([thought(1_000), use(2, 2_000, "bash", "c")])),
      null,
    );
  });

  test("ends when the stream says the model has moved on, before any later step lands", () => {
    const steps = closeThoughtsBefore(
      buildActivitySteps([thought(1_000)]),
      reading("tool_input", 5_000),
    );
    assert.equal((steps[0] as ThinkingStep).endedAt, T0 + 5_000);
    assert.equal(thoughtInProgress(steps), null);
  });

  test("words that land just after the stream moved on are not a thought of negative length", () => {
    const steps = closeThoughtsBefore(
      buildActivitySteps([thought(6_000)]),
      reading("tool_input", 5_000),
    );
    const step = steps[0] as ThinkingStep;
    assert.equal(step.endedAt, step.startedAt);
  });

  test("carries on while the model is still thinking, or nobody can say otherwise", () => {
    for (const pulse of [reading("thinking", 5_000), null]) {
      const steps = closeThoughtsBefore(buildActivitySteps([thought(1_000)]), pulse);
      assert.equal(thoughtInProgress(steps)?.text, "Comparing quotes");
    }
  });
});

describe("the steps of a turn", () => {
  test("pairs results with their calls by id, even when overlapping calls finish out of order", () => {
    const steps = buildActivitySteps([
      use(1, 0, "grep", "a", { pattern: "invoice" }),
      use(2, 50, "bash", "b", { command: "npm test" }),
      result(3, 1_250, "bash", "b", { durationMs: 1_200 }),
      result(4, 2_000, "grep", "a", { durationMs: 2_000, output: "3 matches" }),
    ]) as ToolStep[];
    assert.equal(steps.length, 2);
    assert.equal(steps[0].name, "grep");
    assert.equal(steps[0].status, "done");
    assert.equal(steps[0].durationMs, 2_000);
    assert.equal(steps[0].output, "3 matches");
    assert.equal(steps[0].label, "Searched files for");
    assert.equal(steps[0].target, "“invoice”");
    assert.equal(steps[1].label, "Ran");
    assert.equal(steps[1].target, "npm test");
    assert.equal(steps[1].targetIsCode, true);
    assert.equal(steps[1].durationMs, 1_200);
  });

  test("a call still running is running; when the turn ends it reads stopped", () => {
    const events = [use(1, 0, "browser_open", "x", { url: "https://www.example.com/pricing" })];
    const live = buildActivitySteps(events) as ToolStep[];
    assert.equal(live[0].status, "running");
    assert.equal(live[0].label, "Opening");
    assert.equal(live[0].target, "example.com/pricing");
    const finished = buildActivitySteps(events, { finishedAt: T0 + 4_000 }) as ToolStep[];
    assert.equal(finished[0].status, "stopped");
    assert.equal(finished[0].durationMs, 4_000);
  });

  test("a result whose call was never seen still becomes a step", () => {
    const steps = buildActivitySteps([
      result(7, 5_000, "search_mail", "late", {
        durationMs: 800,
        hint: "“Renewal” · from ana@acme.com",
      }),
    ]) as ToolStep[];
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, "done");
    assert.equal(steps[0].startedAt, T0 + 4_200);
    assert.equal(steps[0].target, "“Renewal” · from ana@acme.com");
  });

  test("a failure keeps its first line; a held call waits for approval", () => {
    const steps = buildActivitySteps([
      use(1, 0, "send_mail", "m", { to: ["ana@acme.com"] }),
      result(2, 300, "send_mail", "m", { output: "\nRecipient refused\nmore" }, true),
      use(3, 400, "pay_invoices_from_bank_transaction", "p"),
      result(4, 500, "pay_invoices_from_bank_transaction", "p", { approval: { id: "ap-1" } }),
    ]) as ToolStep[];
    assert.equal(steps[0].status, "failed");
    assert.equal(steps[0].error, "Recipient refused");
    assert.equal(steps[0].target, "ana@acme.com");
    assert.equal(steps[1].status, "held");
    assert.equal(steps[1].approvalId, "ap-1");
    assert.deepEqual(countSteps(steps), { tools: 2, failed: 1, held: 1, running: 0, thinking: 0 });
  });

  test("chunks of one thought join; a new block or a tool call starts another", () => {
    const steps = buildActivitySteps([
      event(1, "reasoning", 0, { detail: { text: "**Planning** the ", block: "r1" } }),
      event(2, "reasoning", 1_500, { detail: { text: "query", block: "r1" } }),
      use(3, 2_000, "run_explore_query", "q", { sql: "select 1" }),
      result(4, 2_500, "run_explore_query", "q"),
      event(5, "reasoning", 3_000, { detail: { text: "Done.", block: "r2", truncated: true } }),
    ]);
    assert.equal(steps.length, 3);
    assert.equal(steps[0].kind, "thinking");
    if (steps[0].kind === "thinking") {
      assert.equal(steps[0].text, "**Planning** the query");
      assert.equal(steps[0].endedAt, T0 + 2_000, "the next step closes the thought");
    }
    if (steps[2].kind === "thinking") {
      assert.equal(steps[2].truncated, true);
      assert.equal(steps[2].endedAt, null, "the newest thought is still open while live");
    }
  });

  test("waits close on their done event, on the turn starting, or at their backoff", () => {
    const steps = buildActivitySteps([
      event(1, "waiting", 0, {
        name: "thread_busy",
        detail: { cause: "thread_busy", state: "waiting", label: "x" },
      }),
      event(2, "turn_started", 30_000, { detail: { reason: "start", attempt: 2 } }),
      event(3, "waiting", 31_000, {
        name: "model_lock",
        detail: { cause: "model_lock", state: "waiting", label: "y" },
      }),
      event(4, "waiting", 41_000, {
        name: "model_lock",
        detail: { cause: "model_lock", state: "done" },
      }),
      event(5, "waiting", 42_000, {
        name: "model_retry",
        detail: {
          cause: "model_retry",
          state: "waiting",
          label: "z",
          until: at(46_000),
          attempt: 2,
          maxAttempts: 5,
        },
      }),
      use(6, 60_000, "bash", "c"),
    ]);
    const waits = steps.filter((step) => step.kind === "wait");
    assert.equal(waits.length, 3);
    assert.deepEqual(
      waits.map((w) => (w.kind === "wait" ? [w.cause, w.endedAt! - w.startedAt] : null)),
      [
        ["thread_busy", 30_000],
        ["model_lock", 10_000],
        ["model_retry", 4_000],
      ],
    );
  });

  test("bookkeeping notes are kept but hidden from the list; stops and restarts show", () => {
    const steps = buildActivitySteps([
      event(1, "turn_started", 0, { detail: { reason: "start" } }),
      event(2, "progress", 10, { detail: { percent: 40, label: "Drafting" } }),
      event(3, "turn_started", 20, { detail: { reason: "resume" } }),
      event(4, "notice", 30, { name: "compact", summary: "Compacted" }),
      event(5, "stopped", 40, { summary: "Stopped by a Member" }),
    ]);
    assert.deepEqual(
      visibleSteps(steps).map((step) => (step.kind === "note" ? step.code : step.kind)),
      ["resumed", "compact", "stopped"],
    );
    assert.deepEqual(
      latestProgress([event(2, "progress", 10, { detail: { percent: 40, label: "Drafting" } })]),
      {
        percent: 40,
        label: "Drafting",
      },
    );
    assert.equal(latestProgress([]), null);
  });

  test("a parallel worker's call keeps its own label and the worker's name", () => {
    const steps = buildActivitySteps([
      use(1, 0, "[worker:Vendor research] search_web", "w:1", { query: "spot GPUs" }),
    ]) as ToolStep[];
    assert.equal(steps[0].worker, "Vendor research");
    assert.equal(steps[0].label, "Searching the web for");
    assert.equal(steps[0].target, "“spot GPUs”");
  });

  test("a step shown without its details says why, and its result keeps its status and time", () => {
    const steps = buildActivitySteps([
      event(1, "tool_use", 0, {
        name: "search_mail",
        callId: "c1",
        detail: { input: null, withheld: "steps" },
      }),
      event(2, "tool_result", 1_200, {
        name: "search_mail",
        callId: "c1",
        isError: true,
        detail: { output: null, durationMs: 1_200, withheld: "steps" },
      }),
      event(3, "reasoning", 1_500, { detail: { text: "", block: "b1", withheld: "steps" } }),
    ]);
    const [tool, thought] = steps as [ToolStep, Extract<(typeof steps)[number], { kind: "thinking" }>];
    assert.equal(tool.withheld, "steps");
    assert.equal(tool.status, "failed");
    assert.equal(tool.output, null);
    assert.equal(tool.durationMs, 1_200);
    assert.equal(tool.target, "", "nothing a tool was asked is named");
    assert.equal(thought.kind, "thinking");
    assert.equal(thought.withheld, "steps");
    assert.equal(thought.text, "");
  });

  test("a bound discussion's step says its details were never kept", () => {
    const [tool] = buildActivitySteps([
      event(1, "tool_use", 0, {
        name: "read_decision",
        callId: "c1",
        detail: { input: {}, withheld: "discussion" },
      }),
      event(2, "tool_result", 300, {
        name: "read_decision",
        callId: "c1",
        detail: { output: null, durationMs: 300, withheld: "discussion" },
      }),
    ]) as ToolStep[];
    assert.equal(tool.withheld, "discussion");
    assert.equal(tool.status, "done");
    assert.equal(
      buildActivitySteps([use(1, 0, "bash", "c1", { command: "ls" })])[0].kind === "tool" &&
        (buildActivitySteps([use(1, 0, "bash", "c1", { command: "ls" })])[0] as ToolStep).withheld,
      null,
      "an ordinary step withholds nothing",
    );
  });

  test("a turn_finished event closes everything at its time when no end is given", () => {
    const steps = buildActivitySteps([
      use(1, 0, "bash", "c", { command: "sleep 100" }),
      event(2, "turn_finished", 9_000, { detail: { status: "interrupted" } }),
    ]) as ToolStep[];
    assert.equal(steps[0].status, "stopped");
    assert.equal(steps[0].endedAt, T0 + 9_000);
  });
});
