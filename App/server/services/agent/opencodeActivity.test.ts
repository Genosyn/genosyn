import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2";

import { ChatTurnActivityRecorder } from "../chatTurnActivity.js";
import { OpenCodeEvents } from "./opencodeEvents.js";
import type { StreamCallbacks, ToolResult } from "./types.js";
import type { ChatActivityEvent } from "../../../shared/chatActivity.js";

/**
 * From OpenCode's event stream to the steps a Member sees. OpenCode sends
 * durable snapshots and deltas for the same part, can report overlapping
 * native tool calls out of order, can skip a part's running state entirely,
 * and repeats snapshots on reconnect. These recorded-shape sequences pin that
 * each thought, call and result reaches the feed exactly once and in a shape
 * the chat pairs correctly.
 */

function assistant(id = "assistant", summary = false): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "user",
    modelID: "fixture",
    providerID: "genosyn-model",
    mode: "genosyn",
    agent: "genosyn",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
    finish: "stop",
    ...(summary ? { summary: true } : {}),
  } as AssistantMessage;
}

const messageUpdated = (info: AssistantMessage): Event => ({
  id: `message-${info.id}`,
  type: "message.updated",
  properties: { sessionID: "session", info },
});
const updated = (part: Part): Event => ({
  id: `event-${part.id}`,
  type: "message.part.updated",
  properties: { sessionID: "session", part, time: 1 },
});
const delta = (partID: string, text: string, messageID = "assistant"): Event => ({
  id: `delta-${partID}-${text}`,
  type: "message.part.delta",
  properties: { sessionID: "session", messageID, partID, field: "text", delta: text },
});
const reasoning = (id: string, text: string, end?: number, messageID = "assistant"): Part => ({
  id,
  type: "reasoning",
  sessionID: "session",
  messageID,
  text,
  time: end === undefined ? { start: 1 } : { start: 1, end },
});
const tool = (
  callID: string,
  name: string,
  state: Extract<Part, { type: "tool" }>["state"],
): Part => ({
  id: `part-${callID}`,
  type: "tool",
  sessionID: "session",
  messageID: "assistant",
  callID,
  tool: name,
  state,
});

function collector() {
  const calls: Array<[string, ...unknown[]]> = [];
  const callbacks: StreamCallbacks = {
    onReasoning: (text, block) => calls.push(["reasoning", text, block]),
    onReasoningEnd: (block) => calls.push(["reasoningEnd", block]),
    onToolUse: (name, input, callId) => calls.push(["use", name, input, callId]),
    onToolResult: (name, result, callId) => calls.push(["result", name, result, callId]),
    onText: (text) => calls.push(["text", text]),
  };
  return { calls, callbacks };
}

test("thinking streams once across snapshots and deltas, and ends once", () => {
  const { calls, callbacks } = collector();
  const events = new OpenCodeEvents("session", callbacks);
  events.accept(messageUpdated(assistant()));
  events.accept(updated(reasoning("r1", "")));
  events.accept(delta("r1", "**Comparing"));
  events.accept(delta("r1", " quotes**\n"));
  // A snapshot repeating what the deltas already delivered adds nothing…
  events.accept(updated(reasoning("r1", "**Comparing quotes**\n")));
  // …and one that grew carries only the new part.
  events.accept(updated(reasoning("r1", "**Comparing quotes**\nSpot is cheaper.", 5)));
  events.accept(updated(reasoning("r1", "**Comparing quotes**\nSpot is cheaper.", 5)));
  events.accept(
    updated({
      id: "t1",
      type: "text",
      sessionID: "session",
      messageID: "assistant",
      text: "Go spot.",
    }),
  );
  assert.deepEqual(calls, [
    ["reasoning", "**Comparing", "r1"],
    ["reasoning", " quotes**\n", "r1"],
    ["reasoning", "Spot is cheaper.", "r1"],
    ["reasoningEnd", "r1"],
    ["text", "Go spot."],
  ]);
});

test("thinking in a compaction summary, or before the message is known, is not shown", () => {
  const { calls, callbacks } = collector();
  const events = new OpenCodeEvents("session", callbacks);
  // The part arrives before its message: OpenCode has not said whose it is.
  events.accept(updated(reasoning("early", "unattributed thought", undefined, "pending")));
  events.accept(delta("early", " more", "pending"));
  events.accept(messageUpdated(assistant("summary", true)));
  events.accept(updated(reasoning("s1", "summarizing the history", 3, "summary")));
  assert.deepEqual(calls, []);
});

test("a discussion's gate withholds thinking from before the required read", () => {
  let wasRead = false;
  const { calls, callbacks } = collector();
  const events = new OpenCodeEvents("session", { ...callbacks, shouldStreamText: () => wasRead });
  events.accept(messageUpdated(assistant("first")));
  events.accept(updated(reasoning("pre", "guessing without the record", 2, "first")));
  wasRead = true;
  events.accept(messageUpdated(assistant("second")));
  events.accept(updated(reasoning("post", "now grounded", 3, "second")));
  assert.deepEqual(calls, [
    ["reasoning", "now grounded", "post"],
    ["reasoningEnd", "post"],
  ]);
});

test("overlapping native calls finishing out of order pair by call id; repeats are dropped", () => {
  const { calls, callbacks } = collector();
  const events = new OpenCodeEvents("session", callbacks);
  events.accept(messageUpdated(assistant()));
  events.accept(updated(tool("a", "grep", { status: "pending", input: {}, raw: "" })));
  events.accept(
    updated(tool("a", "grep", { status: "running", input: { pattern: "x" }, time: { start: 1 } })),
  );
  events.accept(
    updated(
      tool("b", "glob", { status: "running", input: { pattern: "*.ts" }, time: { start: 2 } }),
    ),
  );
  events.accept(
    updated(
      tool("b", "glob", {
        status: "completed",
        input: { pattern: "*.ts" },
        output: "a.ts",
        title: "glob",
        metadata: {},
        time: { start: 2, end: 3 },
      }),
    ),
  );
  events.accept(
    updated(
      tool("a", "grep", {
        status: "error",
        input: { pattern: "x" },
        error: "grep: bad pattern",
        time: { start: 1, end: 4 },
      }),
    ),
  );
  // A reconnect replays the final snapshot.
  events.accept(
    updated(
      tool("a", "grep", {
        status: "error",
        input: { pattern: "x" },
        error: "grep: bad pattern",
        time: { start: 1, end: 4 },
      }),
    ),
  );
  const shape = calls.map(([kind, name, , callId]) => [kind, name, callId]);
  assert.deepEqual(shape, [
    ["use", "grep", "assistant:a"],
    ["use", "glob", "assistant:b"],
    ["result", "glob", "assistant:b"],
    ["result", "grep", "assistant:a"],
  ]);
  assert.equal((calls[3][2] as ToolResult).isError, true);
});

test("a call that jumps straight to completed still reports its use first", () => {
  const { calls, callbacks } = collector();
  const events = new OpenCodeEvents("session", callbacks);
  events.accept(messageUpdated(assistant()));
  events.accept(
    updated(
      tool("q", "bash", {
        status: "completed",
        input: { command: "date" },
        output: "Fri",
        title: "bash",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    ),
  );
  assert.deepEqual(
    calls.map(([kind, name]) => [kind, name]),
    [
      ["use", "bash"],
      ["result", "bash"],
    ],
  );
});

test("the whole path: OpenCode events through the recorder become the chat's events", async () => {
  const recorded: ChatActivityEvent[] = [];
  let now = Date.parse("2026-10-30T10:00:00.000Z");
  const recorder = new ChatTurnActivityRecorder(
    { companyId: "co", conversationId: "conv", messageId: "msg", attempt: 1 },
    1,
    { onEvent: (event) => recorded.push(event), now: () => now },
  );
  // No database in this test: the recorder's inserts fail quietly, which is
  // exactly the guarantee that a broken feed never breaks the turn.
  const events = new OpenCodeEvents("session", {
    onReasoning: (text, block) => recorder.reasoning(text, block),
    onReasoningEnd: (block) => recorder.reasoningEnd(block),
    onToolUse: (name, input, callId) => recorder.toolUse(name, input, callId),
    onToolResult: (name, result, callId) => recorder.toolResult(name, result, callId),
  });
  events.accept(messageUpdated(assistant()));
  events.accept(updated(reasoning("r", "**Planning**", 1)));
  now += 500;
  events.accept(
    updated(
      tool("w", "webfetch", {
        status: "running",
        input: { url: "https://example.com/a" },
        time: { start: 1 },
      }),
    ),
  );
  now += 2_000;
  events.accept(
    updated(
      tool("w", "webfetch", {
        status: "completed",
        input: { url: "https://example.com/a" },
        output: "<html>",
        title: "fetch",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    ),
  );
  assert.deepEqual(
    recorded.map((event) => [event.ordinal, event.kind, event.callId, event.summary]),
    [
      [1, "reasoning", "", "**Planning**"],
      [2, "tool_use", "assistant:w", "Opening · example.com/a"],
      [3, "tool_result", "assistant:w", "Opened"],
    ],
  );
  assert.equal((recorded[2].detail as { durationMs: number }).durationMs, 2_000);
  await recorder.close();
});
