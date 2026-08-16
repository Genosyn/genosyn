import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "./loop.js";
import { PARSE_ERROR_KEY } from "./modelClients/parseArgs.js";
import { buildRegistry, residentOnlyRegistry } from "./tools/toolRegistry.js";
import type {
  AgentMessage,
  AgentTool,
  AssistantTurn,
  ModelClient,
  ModelRetryInfo,
  StreamCallbacks,
  ToolResult,
} from "./types.js";

const successfulTurn: AssistantTurn = {
  blocks: [{ type: "text", text: "recovered" }],
  stopReason: "end_turn",
};

function client(streamTurn: ModelClient["streamTurn"]): ModelClient {
  return { model: "test-model", maxTools: null, streamTurn };
}

function tool(
  name: string,
  run: AgentTool["run"],
  describeCall?: AgentTool["describeCall"],
): AgentTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", additionalProperties: false },
    run,
    ...(describeCall ? { describeCall } : {}),
  };
}

function toolResults(messages: AgentMessage[]) {
  const message = messages.at(-1);
  assert.equal(message?.role, "user");
  if (!message || message.role !== "user") throw new Error("Expected a user message");
  return message.content.map((block) => {
    assert.equal(block.type, "tool_result");
    if (block.type !== "tool_result") throw new Error("Expected a tool result");
    return block;
  });
}

test("runs a model to tool to result to final-answer round trip", async () => {
  const invocations: Record<string, unknown>[] = [];
  let calls = 0;
  const echo = tool("echo", async (input) => {
    invocations.push(input);
    return { content: `echoed ${String(input.value)}` };
  });

  const result = await runAgentLoop({
    client: client(async ({ system, messages, tools }) => {
      calls += 1;
      assert.equal(system, "employee soul");
      assert.deepEqual(tools, [
        {
          name: "echo",
          description: "echo description",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ]);

      if (calls === 1) {
        assert.deepEqual(messages, [
          { role: "user", content: [{ type: "text", text: "say hello" }] },
        ]);
        return {
          blocks: [
            { type: "text", text: "I will check." },
            { type: "tool_use", id: "call-1", name: "echo", input: { value: "hello" } },
          ],
          stopReason: "tool_use",
        };
      }

      assert.equal(calls, 2);
      assert.deepEqual(messages, [
        { role: "user", content: [{ type: "text", text: "say hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will check." },
            { type: "tool_use", id: "call-1", name: "echo", input: { value: "hello" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-1",
              content: "echoed hello",
              isError: undefined,
            },
          ],
        },
      ]);
      return { blocks: [{ type: "text", text: "The answer is hello." }], stopReason: "end_turn" };
    }),
    system: "employee soul",
    messages: [{ role: "user", content: [{ type: "text", text: "say hello" }] }],
    registry: residentOnlyRegistry([echo]),
    maxSteps: 3,
  });

  assert.equal(calls, 2);
  assert.deepEqual(invocations, [{ value: "hello" }]);
  assert.deepEqual(result, {
    finalText: "The answer is hello.",
    steps: 2,
    stopReason: "end_turn",
  });
});

test("runs multiple calls in order, including a directly named deferred tool", async () => {
  const ran: string[] = [];
  const resident = tool("resident", async () => {
    ran.push("resident");
    return { content: "resident result" };
  });
  const findTools = tool("find_tools", async () => ({ content: "not called" }));
  const deferred = tool("deferred", async (input) => {
    ran.push(`deferred:${String(input.id)}`);
    return { content: "deferred result" };
  });
  let calls = 0;

  const result = await runAgentLoop({
    client: client(async ({ messages, tools }) => {
      calls += 1;
      assert.deepEqual(
        tools.map(({ name }) => name),
        ["resident", "find_tools"],
      );
      if (calls === 1) {
        return {
          blocks: [
            { type: "tool_use", id: "one", name: "resident", input: {} },
            { type: "tool_use", id: "two", name: "deferred", input: { id: 42 } },
            { type: "tool_use", id: "three", name: "missing", input: {} },
          ],
          stopReason: "tool_use",
        };
      }

      assert.deepEqual(toolResults(messages), [
        {
          type: "tool_result",
          toolUseId: "one",
          content: "resident result",
          isError: undefined,
        },
        {
          type: "tool_result",
          toolUseId: "two",
          content: "deferred result",
          isError: undefined,
        },
        {
          type: "tool_result",
          toolUseId: "three",
          content: "Unknown tool: missing. Call find_tools to see what is available.",
          isError: true,
        },
      ]);
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: buildRegistry({
      resident: [resident, findTools],
      deferred: [deferred],
      aliases: [],
      domains: ["test"],
      fromSkills: [],
    }),
    maxSteps: 2,
  });

  assert.deepEqual(ran, ["resident", "deferred:42"]);
  assert.equal(result.finalText, "recovered");
});

test("reports an unknown tool without suggesting unavailable discovery", async () => {
  let calls = 0;
  await runAgentLoop({
    client: client(async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "unknown", name: "missing", input: {} }],
          stopReason: "tool_use",
        };
      }
      assert.equal(toolResults(messages)[0].content, "Unknown tool: missing.");
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([]),
    maxSteps: 2,
  });
});

test("turns a malformed argument marker into a diagnostic without dispatching", async () => {
  let ran = false;
  let calls = 0;
  const guarded = tool("guarded", async () => {
    ran = true;
    return { content: "should not run" };
  });

  await runAgentLoop({
    client: client(async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [
            {
              type: "tool_use",
              id: "bad-json",
              name: "guarded",
              input: { [PARSE_ERROR_KEY]: "arguments were not valid JSON" },
            },
          ],
          stopReason: "tool_use",
        };
      }
      assert.deepEqual(toolResults(messages), [
        {
          type: "tool_result",
          toolUseId: "bad-json",
          content:
            "Your arguments for guarded did not parse: arguments were not valid JSON\n" +
            "Re-send the call with valid JSON.",
          isError: true,
        },
      ]);
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([guarded]),
    maxSteps: 2,
  });

  assert.equal(ran, false);
});

test("converts a thrown tool failure into a model-visible error result", async () => {
  let calls = 0;
  const broken = tool("broken", async () => {
    throw new Error("database unavailable");
  });

  const result = await runAgentLoop({
    client: client(async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "failure", name: "broken", input: {} }],
          stopReason: "tool_use",
        };
      }
      assert.deepEqual(toolResults(messages), [
        {
          type: "tool_result",
          toolUseId: "failure",
          content: "Tool broken threw: database unavailable",
          isError: true,
        },
      ]);
      return { blocks: [{ type: "text", text: "I could not finish." }], stopReason: "end_turn" };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([broken]),
    maxSteps: 2,
  });

  assert.equal(result.finalText, "I could not finish.");
});

test("clips text while preserving images in the callback and next model turn", async () => {
  const source = "x".repeat(8_010);
  const image = { mimeType: "image/png", data: "aW1hZ2U=" };
  const callbackResults: Array<{ name: string; result: ToolResult }> = [];
  let calls = 0;
  const screenshot = tool("screenshot", async () => ({ content: source, images: [image] }));

  await runAgentLoop({
    client: client(async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "shot", name: "screenshot", input: {} }],
          stopReason: "tool_use",
        };
      }
      const block = toolResults(messages)[0];
      assert.equal(block.content, `${"x".repeat(8_000)}\n… [truncated 10 chars]`);
      assert.deepEqual(block.images, [image]);
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([screenshot]),
    maxSteps: 2,
    contextWindow: 100,
    callbacks: {
      onToolResult: (name, result) => callbackResults.push({ name, result }),
    },
  });

  assert.equal(callbackResults[0].name, "screenshot");
  assert.equal(callbackResults[0].result.content, `${"x".repeat(8_000)}\n… [truncated 10 chars]`);
  assert.deepEqual(callbackResults[0].result.images, [image]);
});

test("preserves an image-only result without inventing text", async () => {
  const image = { mimeType: "image/jpeg", data: "cGhvdG8=" };
  let calls = 0;
  const camera = tool("camera", async () => ({ content: "", images: [image] }));

  await runAgentLoop({
    client: client(async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "photo", name: "camera", input: {} }],
          stopReason: "tool_use",
        };
      }
      assert.deepEqual(toolResults(messages), [
        {
          type: "tool_result",
          toolUseId: "photo",
          content: "",
          isError: undefined,
          images: [image],
        },
      ]);
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([camera]),
    maxSteps: 2,
  });
});

test("returns before calling the model when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  const result = await runAgentLoop({
    client: client(async () => {
      calls += 1;
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([]),
    maxSteps: 2,
    signal: controller.signal,
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { finalText: "", steps: 0, stopReason: "aborted" });
});

test("aborts between tools without starting the remaining calls", async () => {
  const controller = new AbortController();
  const ran: string[] = [];
  let loopMessages: AgentMessage[] | undefined;
  const first = tool("first", async () => {
    ran.push("first");
    controller.abort();
    return { content: "first result" };
  });
  const second = tool("second", async () => {
    ran.push("second");
    return { content: "second result" };
  });

  const result = await runAgentLoop({
    client: client(async ({ messages }) => {
      loopMessages = messages;
      return {
        blocks: [
          { type: "text", text: "Starting." },
          { type: "tool_use", id: "first-id", name: "first", input: {} },
          { type: "tool_use", id: "second-id", name: "second", input: {} },
        ],
        stopReason: "tool_use",
      };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([first, second]),
    maxSteps: 3,
    signal: controller.signal,
  });

  assert.deepEqual(ran, ["first"]);
  assert.deepEqual(result, { finalText: "Starting.", steps: 1, stopReason: "aborted" });
  assert.ok(loopMessages);
  assert.deepEqual(toolResults(loopMessages), [
    {
      type: "tool_result",
      toolUseId: "first-id",
      content: "first result",
      isError: undefined,
    },
    {
      type: "tool_result",
      toolUseId: "second-id",
      content: "Aborted before running.",
      isError: true,
    },
  ]);
});

test("returns the step-limit fallback after a tool-only runaway", async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  const again = tool("again", async () => {
    toolCalls += 1;
    return { content: `result ${toolCalls}` };
  });

  const result = await runAgentLoop({
    client: client(async () => {
      modelCalls += 1;
      return {
        blocks: [{ type: "tool_use", id: `call-${modelCalls}`, name: "again", input: {} }],
        stopReason: "tool_use",
      };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "loop" }] }],
    registry: residentOnlyRegistry([again]),
    maxSteps: 2,
  });

  assert.equal(modelCalls, 2);
  assert.equal(toolCalls, 2);
  assert.deepEqual(result, {
    finalText: "(the agent stopped after reaching the step limit)",
    steps: 2,
    stopReason: "max_steps",
  });
});

test("reports streamed text, usage, and described tool callbacks", async () => {
  const events: string[] = [];
  const callbacks: StreamCallbacks = {
    onText: (delta) => events.push(`text:${delta}`),
    onUsage: (usage) => events.push(`usage:${usage.inputTokens}/${usage.outputTokens}`),
    onToolUse: (name, input) => events.push(`use:${name}:${JSON.stringify(input)}`),
    onToolResult: (name, result) =>
      events.push(`result:${name}:${result.content}:${String(result.isError)}`),
  };
  const dispatcher = tool(
    "call_tool",
    async () => ({ content: "created" }),
    () => ({ name: "contacts_create", input: { email: "member@example.com" } }),
  );
  let calls = 0;

  await runAgentLoop({
    client: client(async ({ onText }) => {
      calls += 1;
      if (calls === 1) {
        onText?.("Working");
        onText?.("…");
        return {
          blocks: [
            {
              type: "tool_use",
              id: "dispatch",
              name: "call_tool",
              input: { name: "contacts_create", args_json: "{}" },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 4 },
        };
      }
      onText?.("Done");
      return {
        blocks: [{ type: "text", text: "Done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 18, outputTokens: 1 },
      };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([dispatcher]),
    maxSteps: 2,
    callbacks,
  });

  assert.deepEqual(events, [
    "text:Working",
    "text:…",
    "usage:10/4",
    'use:contacts_create:{"email":"member@example.com"}',
    "result:contacts_create:created:undefined",
    "text:Done",
    "usage:18/1",
  ]);
});

test("compacts old tool results and retries once after a context overflow", async () => {
  const oldResult = "old".repeat(1_000);
  const recentResult = "recent".repeat(100);
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "original request" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "old-call", name: "lookup", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "old-call", content: oldResult, isError: false }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "recent-call", name: "lookup", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "recent-call",
          content: recentResult,
          isError: false,
        },
      ],
    },
  ];
  const compactions: NonNullable<Parameters<NonNullable<StreamCallbacks["onCompact"]>>[0]>[] = [];
  let calls = 0;

  const result = await runAgentLoop({
    client: client(async ({ messages: turnMessages }) => {
      calls += 1;
      const oldBlock = toolResults(turnMessages.slice(0, 3))[0];
      const recentBlock = toolResults(turnMessages)[0];
      if (calls === 1) {
        assert.equal(oldBlock.content, oldResult);
        throw Object.assign(new Error("maximum context length exceeded"), {
          status: 400,
          code: "context_length_exceeded",
        });
      }
      assert.equal(oldBlock.content, "[older tool result dropped to fit the context window]");
      assert.equal(oldBlock.isError, false);
      assert.equal(recentBlock.content, recentResult);
      return successfulTurn;
    }),
    system: "test",
    messages,
    registry: residentOnlyRegistry([]),
    maxSteps: 1,
    callbacks: { onCompact: (info) => compactions.push(info) },
  });

  assert.equal(calls, 2);
  assert.equal(result.finalText, "recovered");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].reason, "overflow");
  assert.equal(compactions[0].evicted, 1);
  assert.ok(compactions[0].freedTokens > 0);
});

test("retries a transient provider failure and reports the attempt", async () => {
  let calls = 0;
  const retries: ModelRetryInfo[] = [];
  const result = await runAgentLoop({
    client: client(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("temporary failure"), {
          status: 500,
          headers: new Headers({ "retry-after": "0" }),
        });
      }
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    registry: residentOnlyRegistry([]),
    maxSteps: 1,
    callbacks: { onModelRetry: (info) => retries.push(info) },
  });

  assert.equal(calls, 2);
  assert.equal(result.finalText, "recovered");
  assert.deepEqual(retries, [{ attempt: 2, maxAttempts: 5, delayMs: 0, reason: "HTTP 500" }]);
});

test("stops after five transient attempts", async () => {
  let calls = 0;
  await assert.rejects(
    runAgentLoop({
      client: client(async () => {
        calls += 1;
        throw Object.assign(new Error("still failing"), {
          status: 503,
          headers: new Headers({ "retry-after": "0" }),
        });
      }),
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
    }),
    /still failing/,
  );
  assert.equal(calls, 5);
});

test("does not retry a permanent error or replay a partial streamed answer", async () => {
  let permanentCalls = 0;
  await assert.rejects(
    runAgentLoop({
      client: client(async () => {
        permanentCalls += 1;
        throw Object.assign(new Error("bad request"), { status: 400 });
      }),
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
    }),
    /bad request/,
  );
  assert.equal(permanentCalls, 1);

  let partialCalls = 0;
  await assert.rejects(
    runAgentLoop({
      client: client(async ({ onText }) => {
        partialCalls += 1;
        onText?.("half an answer");
        throw Object.assign(new Error("stream failed"), { status: 500 });
      }),
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
    }),
    /stream failed/,
  );
  assert.equal(partialCalls, 1);
});

test("reports how full the context window is after every counted turn", async () => {
  const readings: string[] = [];
  let calls = 0;

  await runAgentLoop({
    client: client(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 40_000, outputTokens: 120 },
        };
      }
      return {
        blocks: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 92_000, outputTokens: 40 },
      };
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([tool("echo", async () => ({ content: "ok" }))]),
    maxSteps: 2,
    contextWindow: 200_000,
    callbacks: {
      onContextUsage: (usage) =>
        readings.push(`${usage.promptTokens}/${String(usage.contextWindow)}=${String(usage.percent)}`),
    },
  });

  assert.deepEqual(readings, ["40000/200000=20", "92000/200000=46"]);
});

test("reports the prompt size with a null share when the window is unknown", async () => {
  const readings: { promptTokens: number; contextWindow: number | null; percent: number | null }[] =
    [];

  await runAgentLoop({
    client: client(async () => ({
      blocks: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 142_311, outputTokens: 12 },
    })),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([]),
    maxSteps: 1,
    // The OpenAI-subscription and unprobeable-custom-endpoint case.
    contextWindow: null,
    callbacks: { onContextUsage: (usage) => readings.push(usage) },
  });

  assert.deepEqual(readings, [{ promptTokens: 142_311, contextWindow: null, percent: null }]);
});

test("stays silent on a turn the provider reported no usage for", async () => {
  const readings: unknown[] = [];
  const usages: unknown[] = [];

  await runAgentLoop({
    client: client(async () => ({
      blocks: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    })),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "work" }] }],
    registry: residentOnlyRegistry([]),
    maxSteps: 1,
    contextWindow: 200_000,
    callbacks: {
      onUsage: (usage) => usages.push(usage),
      onContextUsage: (usage) => readings.push(usage),
    },
  });

  // Inventing a reading here would put a made-up number in front of a human;
  // the gauge keeps its previous value instead.
  assert.deepEqual(usages, []);
  assert.deepEqual(readings, []);
});
