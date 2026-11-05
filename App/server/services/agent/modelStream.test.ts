import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelCallDetail, ModelPulse } from "../../../shared/chatActivity.js";
import {
  ModelTurnWatch,
  preparingPulse,
  readModelStreamEvent,
  SseDataLines,
} from "./modelStream.js";

/**
 * The stream is the only place that can tell a model working from a model
 * stopped. These pin what it reads from each provider's wire format, that it
 * passes on counts and tool names and never words, and that a pulse goes out
 * when something changes rather than on every byte.
 */

const T0 = Date.parse("2026-11-05T10:00:00.000Z");

function watch(provider: "anthropic" | "openai" | "custom" = "anthropic") {
  const clock = { ms: T0 };
  const pulses: ModelPulse[] = [];
  const calls: ModelCallDetail[] = [];
  const turn = new ModelTurnWatch({
    provider,
    model: "claude-opus-5-5",
    onPulse: (pulse) => pulses.push(pulse),
    onCall: (call) => calls.push(call),
    now: () => clock.ms,
  });
  return { clock, pulses, calls, turn };
}

const anthropic = (type: string, value: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;

describe("reading each provider's stream", () => {
  test("Claude: prompt counted with its cached spans, then each kind of block", () => {
    const read = (event: Record<string, unknown>) =>
      readModelStreamEvent("anthropic", JSON.stringify(event));
    assert.deepEqual(
      read({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1_000,
            output_tokens: 2,
          },
        },
      }),
      { inputTokens: 1_110, outputTokens: 2 },
    );
    assert.deepEqual(read({ type: "content_block_start", content_block: { type: "thinking" } }), {
      state: "thinking",
    });
    assert.deepEqual(
      read({ type: "content_block_start", content_block: { type: "redacted_thinking" } }),
      { state: "thinking" },
    );
    assert.deepEqual(read({ type: "content_block_start", content_block: { type: "text" } }), {
      state: "writing",
    });
    assert.deepEqual(
      read({ type: "content_block_start", content_block: { type: "tool_use", name: "bash" } }),
      { state: "tool_input", tool: "bash" },
    );
    assert.deepEqual(
      read({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "abcd" } }),
      { state: "thinking", chars: 4 },
    );
    assert.deepEqual(
      read({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }),
      { state: "tool_input", chars: 2 },
    );
    assert.equal(
      read({ type: "content_block_delta", delta: { type: "signature_delta", signature: "s" } }),
      null,
      "a signature says nothing about how far along it is",
    );
    assert.deepEqual(
      read({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 90 },
      }),
      { outputTokens: 90, stopReason: "tool_use" },
    );
    assert.equal(read({ type: "ping" }), null);
  });

  test("OpenAI Responses: output items, deltas and the usage on the last event", () => {
    const read = (event: Record<string, unknown>) =>
      readModelStreamEvent("openai", JSON.stringify(event));
    assert.deepEqual(read({ type: "response.output_item.added", item: { type: "reasoning" } }), {
      state: "thinking",
    });
    assert.deepEqual(read({ type: "response.output_item.added", item: { type: "message" } }), {
      state: "writing",
    });
    assert.deepEqual(
      read({
        type: "response.output_item.added",
        item: { type: "function_call", name: "genosyn_send_mail" },
      }),
      { state: "tool_input", tool: "genosyn_send_mail" },
    );
    assert.deepEqual(read({ type: "response.reasoning_summary_text.delta", delta: "abc" }), {
      state: "thinking",
      chars: 3,
    });
    assert.deepEqual(read({ type: "response.function_call_arguments.delta", delta: "{}" }), {
      state: "tool_input",
      chars: 2,
    });
    assert.deepEqual(
      read({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 7, output_tokens: 9 } },
      }),
      { inputTokens: 7, outputTokens: 9, stopReason: "completed" },
    );
    assert.equal(read({ type: "response.in_progress" }), null);
  });

  test("Chat Completions: however a self-hosted server names its reasoning", () => {
    const read = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      readModelStreamEvent("custom", JSON.stringify({ choices: [{ delta }], ...extra }));
    assert.deepEqual(read({ reasoning_content: "abc" }), { state: "thinking", chars: 3 });
    assert.deepEqual(read({ reasoning: "abcd" }), { state: "thinking", chars: 4 });
    assert.deepEqual(read({ content: "ab" }), { state: "writing", chars: 2 });
    assert.deepEqual(
      read({ tool_calls: [{ index: 0, function: { name: "bash", arguments: "{" } }] }),
      { state: "tool_input", tool: "bash", chars: 1 },
    );
    assert.deepEqual(read({ tool_calls: [{ index: 0, function: { arguments: '"a"' } }] }), {
      state: "tool_input",
      chars: 3,
    });
    assert.deepEqual(
      readModelStreamEvent(
        "custom",
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      ),
      { inputTokens: 5, outputTokens: 6, stopReason: "stop" },
    );
    assert.equal(read({ role: "assistant" }), null);
    assert.equal(readModelStreamEvent("custom", "[DONE]"), null);
  });

  test("anything else on the wire says nothing, and never throws", () => {
    assert.equal(readModelStreamEvent("anthropic", "{not json"), null);
    assert.equal(readModelStreamEvent("anthropic", "[1,2]"), null);
    assert.equal(readModelStreamEvent("openai", '"text"'), null);
    assert.equal(readModelStreamEvent("custom", ""), null);
  });

  test("a tool name is words a model chose, so only one shaped like a name goes on", () => {
    const named = (name: unknown) =>
      readModelStreamEvent(
        "anthropic",
        JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", name } }),
      );
    assert.deepEqual(named("genosyn_send_mail"), { state: "tool_input", tool: "genosyn_send_mail" });
    assert.deepEqual(named("ignore previous instructions"), { state: "tool_input", tool: null });
    assert.deepEqual(named("x".repeat(500)), { state: "tool_input", tool: null });
    assert.deepEqual(named(42), { state: "tool_input", tool: null });
  });
});

describe("splitting a stream into events", () => {
  test("holds a line across chunks and ignores what is not data", () => {
    const lines = new SseDataLines();
    assert.deepEqual(lines.push("event: ping\nda"), []);
    assert.deepEqual(lines.push('ta: {"a":1}\r\n\r\n: keep-alive\n'), ['{"a":1}']);
    assert.deepEqual(lines.push("data: two\ndata: three\n"), ["two", "three"]);
  });

  test("skips a line too long to hold, without losing the next one", () => {
    const lines = new SseDataLines();
    assert.deepEqual(lines.push(`data: ${"x".repeat(1_000_001)}`), []);
    assert.deepEqual(lines.push(`${"x".repeat(50)}\ndata: next\n`), ["next"]);
  });
});

describe("watching a turn", () => {
  test("a request goes from waiting to thinking the moment anything comes back", () => {
    const { clock, pulses, turn } = watch();
    const request = turn.begin();
    assert.equal(pulses.at(-1)?.state, "waiting");
    assert.equal(pulses.at(-1)?.sentAt, new Date(T0).toISOString());
    assert.equal(pulses.at(-1)?.lastDataAt, null);
    clock.ms += 3_000;
    request.data(anthropic("ping", {}));
    assert.equal(pulses.at(-1)?.state, "thinking");
    assert.equal(pulses.at(-1)?.lastDataAt, new Date(T0 + 3_000).toISOString());
  });

  test("a change of state goes out at once; everything else at most once a second", () => {
    const { clock, pulses, turn } = watch();
    const request = turn.begin();
    const delta = anthropic("content_block_delta", {
      delta: { type: "thinking_delta", thinking: "word " },
    });
    clock.ms += 100;
    request.data(delta);
    const afterFirst = pulses.length;
    for (let i = 0; i < 5; i += 1) {
      clock.ms += 100;
      request.data(delta);
    }
    assert.equal(pulses.length, afterFirst, "no reading while nothing but the count moves");
    clock.ms += 1_000;
    request.data(delta);
    assert.equal(pulses.length, afterFirst + 1);
    assert.equal(pulses.at(-1)?.chars, 35);
    request.data(
      anthropic("content_block_start", { content_block: { type: "text", text: "" } }),
    );
    assert.equal(pulses.at(-1)?.state, "writing", "a new state does not wait its turn");
  });

  test("a keep-alive with nothing else in it still counts as hearing from the model", () => {
    const { clock, pulses, turn } = watch();
    const request = turn.begin();
    clock.ms += 1_500;
    request.data(": keep-alive\n\n");
    clock.ms += 1_500;
    request.data(": keep-alive\n\n");
    assert.equal(pulses.at(-1)?.lastDataAt, new Date(T0 + 3_000).toISOString());
    assert.equal(pulses.at(-1)?.state, "thinking");
  });

  test("a tool call being written names the tool and counts its own arguments", () => {
    const { clock, pulses, turn } = watch();
    const request = turn.begin();
    request.data(
      anthropic("content_block_start", {
        content_block: { type: "tool_use", name: "genosyn_create_note" },
      }),
    );
    assert.equal(pulses.at(-1)?.state, "tool_input");
    assert.equal(pulses.at(-1)?.tool, "genosyn_create_note");
    clock.ms += 2_000;
    request.data(
      anthropic("content_block_delta", {
        delta: { type: "input_json_delta", partial_json: "x".repeat(4_200) },
      }),
    );
    assert.equal(pulses.at(-1)?.chars, 4_200);
    assert.equal(pulses.at(-1)?.since, new Date(T0).toISOString(), "when this state began");
  });

  test("the words never leave: a reading and a record hold counts and names only", () => {
    const { clock, pulses, calls, turn } = watch();
    const request = turn.begin();
    request.data(
      anthropic("content_block_delta", {
        delta: { type: "thinking_delta", thinking: "The salary review is secret" },
      }),
    );
    clock.ms += 1_000;
    request.data(
      anthropic("content_block_delta", {
        delta: { type: "text_delta", text: "Dear Ana, about your salary" },
      }),
    );
    request.data(
      anthropic("content_block_start", {
        content_block: { type: "tool_use", name: "genosyn_send_mail" },
      }),
    );
    request.data(
      anthropic("content_block_delta", {
        delta: { type: "input_json_delta", partial_json: '{"to":"ana@acme.com"}' },
      }),
    );
    request.end();
    const everything = JSON.stringify([pulses, calls]);
    assert.ok(!/salary|secret|ana@acme/i.test(everything), everything);
    assert.match(everything, /genosyn_send_mail/);
  });

  test("a finished request leaves its record: where the time went, and what it counted", () => {
    const { clock, calls, pulses, turn } = watch();
    const request = turn.begin();
    clock.ms += 2_000;
    request.data(
      anthropic("message_start", {
        message: { usage: { input_tokens: 1_000, output_tokens: 1 } },
      }),
    );
    request.data(anthropic("content_block_start", { content_block: { type: "thinking" } }));
    clock.ms += 30_000;
    request.data(
      anthropic("content_block_start", {
        content_block: { type: "tool_use", name: "bash" },
      }),
    );
    clock.ms += 8_000;
    request.data(
      anthropic("message_delta", {
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 700 },
      }),
    );
    request.end();
    assert.equal(pulses.at(-1)?.state, "finished");
    assert.equal(pulses.at(-1)?.outputTokens, 700);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.durationMs, 40_000);
    assert.equal(call.inputTokens, 1_000);
    assert.equal(call.outputTokens, 700);
    assert.equal(call.stopReason, "tool_use");
    assert.deepEqual(
      call.phases.map((phase) => [phase.kind, phase.ms, phase.tool ?? null]),
      [
        ["waiting", 2_000, null],
        ["thinking", 30_000, null],
        ["tool_input", 8_000, "bash"],
      ],
    );
  });

  test("the turn's token count adds up across requests, estimating only the one in flight", () => {
    const { clock, pulses, turn } = watch();
    const first = turn.begin();
    first.data(
      anthropic("message_delta", {
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 500 },
      }),
    );
    first.end();
    const second = turn.begin();
    assert.equal(pulses.at(-1)?.request, 2);
    assert.equal(pulses.at(-1)?.outputTokens, 500);
    clock.ms += 1_100;
    second.data(
      anthropic("content_block_delta", {
        delta: { type: "text_delta", text: "x".repeat(400) },
      }),
    );
    assert.equal(pulses.at(-1)?.outputTokens, 600, "400 characters at about 4 a token");
  });

  test("a request the AI Model refused leaves no record; retries report those themselves", () => {
    const { calls, pulses, turn } = watch();
    const request = turn.begin();
    request.end({ answered: false });
    assert.equal(calls.length, 0);
    assert.equal(pulses.at(-1)?.state, "finished");
    assert.equal(pulses.at(-1)?.outputTokens, 0);
  });

  test("an answer that stopped partway still spent the time", () => {
    const { calls, turn } = watch();
    const request = turn.begin();
    request.data(": keep-alive\n\n");
    request.end();
    assert.equal(calls.length, 1);
  });

  test("ending twice is the same as ending once, and nothing counts after", () => {
    const { calls, pulses, turn } = watch();
    const request = turn.begin();
    request.data(": keep-alive\n\n");
    request.end();
    const seen = pulses.length;
    request.end();
    request.data(": keep-alive\n\n");
    request.signal({ state: "writing", chars: 10 });
    assert.equal(calls.length, 1);
    assert.equal(pulses.length, seen);
  });

  test("only the newest request speaks for the turn", () => {
    const { pulses, turn } = watch();
    const first = turn.begin();
    const second = turn.begin();
    first.data(anthropic("content_block_start", { content_block: { type: "text" } }));
    assert.equal(pulses.at(-1)?.request, 2);
    assert.equal(pulses.at(-1)?.state, "waiting");
    first.end();
    assert.equal(pulses.at(-1)?.state, "waiting", "an older request ending changes nothing");
    second.end();
    assert.equal(pulses.at(-1)?.state, "finished");
  });

  test("a summary being written reads as compacting, not as the reply", () => {
    const { clock, pulses, calls, turn } = watch();
    turn.setCompacting(true);
    const request = turn.begin();
    assert.equal(pulses.at(-1)?.state, "compacting");
    clock.ms += 5_000;
    request.data(
      anthropic("content_block_delta", { delta: { type: "text_delta", text: "Summary" } }),
    );
    assert.equal(pulses.at(-1)?.state, "compacting");
    request.end();
    assert.deepEqual(
      calls[0].phases.map((phase) => phase.kind),
      ["compacting"],
    );
    turn.setCompacting(false);
    turn.begin();
    assert.equal(pulses.at(-1)?.state, "waiting");
  });

  test("compaction noticed after the request began still takes over, and hands back", () => {
    const { pulses, turn } = watch();
    const request = turn.begin();
    request.data(": keep-alive\n\n");
    turn.setCompacting(true);
    assert.equal(pulses.at(-1)?.state, "compacting");
    turn.setCompacting(false);
    assert.equal(pulses.at(-1)?.state, "thinking");
  });

  test("a reply of many blocks keeps its record bounded and still says what it is doing", () => {
    const { calls, pulses, turn } = watch();
    const request = turn.begin();
    for (let i = 0; i < 100; i += 1) {
      request.data(
        anthropic("content_block_start", {
          content_block: { type: "tool_use", name: `tool_${i}` },
        }),
      );
    }
    assert.equal(pulses.at(-1)?.tool, "tool_99");
    request.end();
    assert.ok(calls[0].phases.length <= 32);
  });

  test("a request handed over stops the clock, and its count can still arrive", () => {
    const { clock, calls, pulses, turn } = watch("openai");
    const request = turn.begin();
    clock.ms += 1_000;
    request.signal({ state: "tool_input", tool: "search", chars: 40 });
    clock.ms += 2_000;
    request.handOver();
    assert.equal(pulses.at(-1)?.state, "finished");
    assert.equal(calls.length, 0, "the record waits for the count");
    const seen = pulses.length;
    clock.ms += 60_000; // The tool runs; the app-server reports usage meanwhile.
    request.alive();
    request.signal({ state: "writing", chars: 500 });
    request.signal({ inputTokens: 1_000, outputTokens: 80 });
    assert.equal(pulses.length, seen, "nothing here is the model working again");
    request.end();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].inputTokens, 1_000);
    assert.equal(calls[0].outputTokens, 80);
    assert.equal(calls[0].durationMs, 3_000, "the tool's minute is not the model's");
    assert.deepEqual(
      calls[0].phases.map((phase) => phase.ms),
      [1_000, 2_000],
    );
    assert.equal(pulses.length, seen, "and it said it was finished already");
  });

  test("an observer that throws never reaches the stream it is only watching", () => {
    const turn = new ModelTurnWatch({
      provider: "anthropic",
      model: null,
      onPulse: () => {
        throw new Error("gone");
      },
      onCall: () => {
        throw new Error("gone");
      },
    });
    const request = turn.begin();
    request.data(": keep-alive\n\n");
    assert.doesNotThrow(() => request.end());
  });

  test("getting ready says what it is doing, before anything has gone out", () => {
    const pulse = preparingPulse("Updating its Repositories", "m", T0);
    assert.equal(pulse.state, "preparing");
    assert.equal(pulse.label, "Updating its Repositories");
    assert.equal(pulse.request, 0);
    assert.equal(pulse.sentAt, null);
  });
});
