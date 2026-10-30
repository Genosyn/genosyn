import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatActivityEvent } from "../../shared/chatActivity";
import {
  EMPTY_LIVE_TURN,
  buildActivitySteps,
  countSteps,
  latestProgress,
  mergeActivityEvents,
  reduceLiveTurn,
  visibleSteps,
  type ToolStep,
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
