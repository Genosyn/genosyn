import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CONCURRENT_TOOL_CALLS, runAgentLoop } from "./loop.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import type {
  AgentMessage,
  AgentTool,
  AssistantBlock,
  AssistantTurn,
  ModelClient,
  StreamCallbacks,
  ToolResultBlock,
} from "./types.js";

/**
 * How one model turn's tool calls are scheduled.
 *
 * A batch of read-only calls runs at once, bounded; a batch with a write in it
 * runs in the order the model gave. Every test here uses gates the test itself
 * opens, never wall-clock timing, so the schedule it observes is the schedule
 * the loop chose. The one timer is a watchdog that turns a would-be hang into
 * a quick, named failure.
 */

const finalTurn: AssistantTurn = {
  blocks: [{ type: "text", text: "done" }],
  stopReason: "end_turn",
};

function client(streamTurn: ModelClient["streamTurn"]): ModelClient {
  return { model: "test-model", maxTools: null, streamTurn };
}

function tool(name: string, run: AgentTool["run"], readOnly?: boolean): AgentTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", additionalProperties: false },
    run,
    ...(readOnly === undefined ? {} : { readOnly }),
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): AssistantBlock {
  return { type: "tool_use", id, name, input };
}

function toolResults(messages: AgentMessage[]): ToolResultBlock[] {
  const message = messages.at(-1);
  if (!message || message.role !== "user") throw new Error("Expected a user message");
  return message.content.map((block) => {
    if (block.type !== "tool_result") throw new Error("Expected a tool result");
    return block;
  });
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

/** A promise the test resolves by hand, so a tool finishes only when told to. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every microtask and I/O callback queued so far run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolve to "timed out" if `promise` has not settled within two seconds. */
function withWatchdog<T>(promise: Promise<T>): Promise<T | "timed out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed out">((resolve) => {
    timer = setTimeout(() => resolve("timed out"), 2_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Drive one turn of tool calls followed by a final answer, handing the test
 * the results the model was shown on its second call.
 */
async function runBatch(params: {
  tools: AgentTool[];
  calls: AssistantBlock[];
  callbacks?: StreamCallbacks;
}) {
  let modelCalls = 0;
  let results: ToolResultBlock[] = [];
  const result = await runAgentLoop({
    client: client(async ({ messages }) => {
      modelCalls += 1;
      if (modelCalls === 1) return { blocks: params.calls, stopReason: "tool_use" };
      results = toolResults(messages);
      return finalTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry(params.tools),
    maxSteps: 3,
    callbacks: params.callbacks,
  });
  return { result, results, modelCalls };
}

test("MAX_CONCURRENT_TOOL_CALLS is a small bound above one", () => {
  assert.ok(MAX_CONCURRENT_TOOL_CALLS > 1);
  assert.ok(MAX_CONCURRENT_TOOL_CALLS <= 16);
});

test("runs a batch of read-only calls concurrently and reports results in call order", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  const gates = { a: deferred(), b: deferred(), c: deferred() };
  const allStarted = deferred();

  const read = (name: keyof typeof gates) =>
    tool(
      name,
      async (input) => {
        started.push(name);
        if (started.length === 3) allStarted.resolve();
        await gates[name].promise;
        finished.push(name);
        return { content: `${name}:${String(input.file)}` };
      },
      true,
    );

  const uses: Array<{ name: string; callId?: string }> = [];
  const callbackResults: Array<{ name: string; content: string; callId?: string }> = [];

  const run = runBatch({
    tools: [read("a"), read("b"), read("c")],
    calls: [
      toolUse("call-a", "a", { file: "a.ts" }),
      toolUse("call-b", "b", { file: "b.ts" }),
      toolUse("call-c", "c", { file: "c.ts" }),
    ],
    callbacks: {
      onToolUse: (name, _input, callId) => uses.push({ name, callId }),
      onToolResult: (name, result, callId) =>
        callbackResults.push({ name, content: result.content, callId }),
    },
  });

  // Had the loop run these one at a time, "a" would still be waiting on its
  // gate and "b" and "c" would never have started.
  assert.notEqual(
    await withWatchdog(allStarted.promise),
    "timed out",
    "all three reads must be in flight at once",
  );
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.deepEqual(finished, [], "nothing finishes before its gate opens");

  // Finish them in the reverse of the order they were called.
  gates.c.resolve();
  await tick();
  gates.a.resolve();
  await tick();
  gates.b.resolve();

  const { result, results } = await run;
  assert.deepEqual(finished, ["c", "a", "b"]);
  assert.deepEqual(results, [
    { type: "tool_result", toolUseId: "call-a", content: "a:a.ts", isError: undefined },
    { type: "tool_result", toolUseId: "call-b", content: "b:b.ts", isError: undefined },
    { type: "tool_result", toolUseId: "call-c", content: "c:c.ts", isError: undefined },
  ]);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.finalText, "done");

  // Every call was announced with its id before any ran, and every result
  // carried the id of the call it answers — in completion order, which is
  // exactly why the id is needed.
  assert.deepEqual(uses, [
    { name: "a", callId: "call-a" },
    { name: "b", callId: "call-b" },
    { name: "c", callId: "call-c" },
  ]);
  assert.deepEqual(callbackResults, [
    { name: "c", content: "c:c.ts", callId: "call-c" },
    { name: "a", content: "a:a.ts", callId: "call-a" },
    { name: "b", content: "b:b.ts", callId: "call-b" },
  ]);
});

test("runs a batch strictly in order when any call in it writes", async () => {
  const trace: string[] = [];
  const make = (name: string, readOnly?: boolean) =>
    tool(
      name,
      async () => {
        trace.push(`start:${name}`);
        // Yield twice so a concurrent scheduler would have every chance to
        // interleave the next call's start before this one finishes.
        await tick();
        await tick();
        trace.push(`finish:${name}`);
        return { content: `${name} done` };
      },
      readOnly,
    );

  const { results } = await runBatch({
    tools: [make("read", true), make("write", false), make("read_again", true)],
    calls: [
      toolUse("r1", "read"),
      toolUse("w1", "write"),
      toolUse("r2", "read_again"),
      toolUse("r3", "read"),
    ],
  });

  assert.deepEqual(trace, [
    "start:read",
    "finish:read",
    "start:write",
    "finish:write",
    "start:read_again",
    "finish:read_again",
    "start:read",
    "finish:read",
  ]);
  assert.deepEqual(
    results.map((block) => [block.toolUseId, block.content]),
    [
      ["r1", "read done"],
      ["w1", "write done"],
      ["r2", "read_again done"],
      ["r3", "read done"],
    ],
  );
});

test("treats a tool with readOnly unset as a write", async () => {
  const trace: string[] = [];
  const make = (name: string, readOnly?: boolean) =>
    tool(
      name,
      async () => {
        trace.push(`start:${name}`);
        await tick();
        trace.push(`finish:${name}`);
        return { content: name };
      },
      readOnly,
    );

  await runBatch({
    tools: [make("read", true), make("unknown_intent")],
    calls: [toolUse("1", "read"), toolUse("2", "unknown_intent"), toolUse("3", "read")],
  });

  assert.deepEqual(trace, [
    "start:read",
    "finish:read",
    "start:unknown_intent",
    "finish:unknown_intent",
    "start:read",
    "finish:read",
  ]);
});

test("never has more than MAX_CONCURRENT_TOOL_CALLS read-only calls in flight", async () => {
  const cap = MAX_CONCURRENT_TOOL_CALLS;
  const total = cap * 2 + 3;
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  const gates = new Map<number, Deferred<void>>();
  const released = new Set<number>();
  const firstWave = deferred();

  const read = tool(
    "read",
    async (input) => {
      const index = input.index as number;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started.push(index);
      if (started.length === cap) firstWave.resolve();
      const gate = deferred();
      gates.set(index, gate);
      await gate.promise;
      inFlight -= 1;
      return { content: `read ${index}` };
    },
    true,
  );
  const release = async (index: number) => {
    const gate = gates.get(index);
    assert.ok(gate, `call ${index} should have started`);
    released.add(index);
    gate.resolve();
    // Let the worker that was running it pick up its next call.
    await tick();
  };

  const calls = Array.from({ length: total }, (_, index) =>
    toolUse(`call-${index}`, "read", { index }),
  );
  const run = runBatch({ tools: [read], calls });

  // The first wave fills the cap exactly, in call order, and nothing beyond it
  // starts until one of those finishes.
  assert.notEqual(await withWatchdog(firstWave.promise), "timed out");
  await tick();
  assert.deepEqual(
    started,
    Array.from({ length: cap }, (_, i) => i),
  );
  assert.equal(inFlight, cap);

  // Finishing one call, whichever it is, admits exactly the next queued call.
  await release(3);
  assert.deepEqual(started.slice(cap), [cap]);
  assert.equal(inFlight, cap);
  await release(0);
  assert.deepEqual(started.slice(cap), [cap, cap + 1]);
  assert.equal(inFlight, cap);

  // Drain the rest a wave at a time.
  for (let rounds = 0; started.length < total || released.size < total; rounds++) {
    assert.ok(rounds < total, "the batch should drain");
    const pending = started.filter((index) => !released.has(index));
    await Promise.all(pending.map((index) => release(index)));
    assert.ok(inFlight <= cap, `in flight ${inFlight} exceeded the cap`);
  }

  const { results } = await run;
  assert.equal(peak, cap);
  assert.equal(started.length, total);
  assert.deepEqual(
    results.map((block) => [block.toolUseId, block.content]),
    calls.map((_, index) => [`call-${index}`, `read ${index}`]),
  );
});

test("answers every call with 'Aborted before running.' when the turn is already aborted", async () => {
  const controller = new AbortController();
  let ran = 0;
  let loopMessages: AgentMessage[] | undefined;
  const uses: string[] = [];
  const read = tool(
    "read",
    async () => {
      ran += 1;
      return { content: "should not run" };
    },
    true,
  );

  const result = await runAgentLoop({
    client: client(async ({ messages }) => {
      loopMessages = messages;
      // The Member stops the turn while the model is still producing its calls.
      controller.abort();
      return {
        blocks: [toolUse("1", "read"), toolUse("2", "read"), toolUse("3", "read")],
        stopReason: "tool_use",
      };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([read]),
    maxSteps: 3,
    signal: controller.signal,
    callbacks: { onToolUse: (name) => uses.push(name) },
  });

  assert.equal(ran, 0);
  assert.deepEqual(uses, [], "an aborted call is never announced as running");
  assert.deepEqual(result, { finalText: "", steps: 1, stopReason: "aborted" });
  assert.ok(loopMessages);
  assert.deepEqual(toolResults(loopMessages), [
    { type: "tool_result", toolUseId: "1", content: "Aborted before running.", isError: true },
    { type: "tool_result", toolUseId: "2", content: "Aborted before running.", isError: true },
    { type: "tool_result", toolUseId: "3", content: "Aborted before running.", isError: true },
  ]);
});

test("an abort during a concurrent batch answers the queued calls without running them", async () => {
  const cap = MAX_CONCURRENT_TOOL_CALLS;
  const total = cap + 2;
  const controller = new AbortController();
  const started: number[] = [];
  const gates = new Map<number, Deferred<void>>();
  const firstWave = deferred();
  let loopMessages: AgentMessage[] | undefined;

  const read = tool(
    "read",
    async (input) => {
      const index = input.index as number;
      started.push(index);
      if (started.length === cap) firstWave.resolve();
      const gate = deferred();
      gates.set(index, gate);
      await gate.promise;
      // The first call to finish stops the turn: the cap's worth already
      // running complete, the two still queued never start.
      if (index === 0) controller.abort();
      return { content: `read ${index}` };
    },
    true,
  );
  const calls = Array.from({ length: total }, (_, index) =>
    toolUse(`call-${index}`, "read", { index }),
  );

  const run = runAgentLoop({
    client: client(async ({ messages }) => {
      loopMessages = messages;
      return { blocks: calls, stopReason: "tool_use" };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([read]),
    maxSteps: 3,
    signal: controller.signal,
  });

  assert.notEqual(await withWatchdog(firstWave.promise), "timed out");
  gates.get(0)!.resolve();
  await tick();
  assert.equal(controller.signal.aborted, true);
  assert.equal(started.length, cap, "no queued call starts once the turn is aborted");
  for (let index = 1; index < cap; index++) gates.get(index)!.resolve();

  const result = await run;
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.steps, 1);
  assert.ok(loopMessages);
  const results = toolResults(loopMessages);
  assert.deepEqual(
    results.map((block) => block.toolUseId),
    calls.map((_, index) => `call-${index}`),
  );
  for (let index = 0; index < cap; index++) {
    assert.equal(results[index].content, `read ${index}`);
    assert.equal(results[index].isError, undefined);
  }
  for (let index = cap; index < total; index++) {
    assert.equal(results[index].content, "Aborted before running.");
    assert.equal(results[index].isError, true);
  }
});

test("a throwing read-only call becomes an error result without failing the batch", async () => {
  const ran: string[] = [];
  const ok = tool(
    "ok",
    async (input) => {
      ran.push(String(input.id));
      await tick();
      return { content: `ok ${String(input.id)}` };
    },
    true,
  );
  const broken = tool(
    "broken",
    async () => {
      ran.push("broken");
      throw new Error("permission denied");
    },
    true,
  );
  const callbackResults: Array<{ name: string; isError?: boolean; callId?: string }> = [];

  const { result, results } = await runBatch({
    tools: [ok, broken],
    calls: [
      toolUse("first", "ok", { id: 1 }),
      toolUse("second", "broken"),
      toolUse("third", "ok", { id: 2 }),
    ],
    callbacks: {
      onToolResult: (name, r, callId) => callbackResults.push({ name, isError: r.isError, callId }),
    },
  });

  // All three started together; the failure did not stop its neighbours.
  assert.deepEqual(ran, ["1", "broken", "2"]);
  assert.deepEqual(results, [
    { type: "tool_result", toolUseId: "first", content: "ok 1", isError: undefined },
    {
      type: "tool_result",
      toolUseId: "second",
      content: "Tool broken threw: permission denied",
      isError: true,
    },
    { type: "tool_result", toolUseId: "third", content: "ok 2", isError: undefined },
  ]);
  assert.equal(result.finalText, "done");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(
    callbackResults.find((entry) => entry.callId === "second"),
    { name: "broken", isError: true, callId: "second" },
  );
  // The synchronous throw was reported first, ahead of the reads that yielded.
  assert.equal(callbackResults[0].callId, "second");
});

test("an unknown tool in an otherwise read-only batch is answered in place", async () => {
  const read = tool("read", async () => ({ content: "content" }), true);
  const { results } = await runBatch({
    tools: [read],
    calls: [toolUse("1", "read"), toolUse("2", "missing"), toolUse("3", "read")],
  });
  assert.deepEqual(
    results.map((block) => [block.toolUseId, block.isError]),
    [
      ["1", undefined],
      ["2", true],
      ["3", undefined],
    ],
  );
  assert.equal(results[1].content, "Unknown tool: missing.");
});
