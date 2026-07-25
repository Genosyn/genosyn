import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentMessage, ToolResultBlock } from "./types.js";
import {
  TOOL_RESULT_CAP_DEFAULT,
  compactMessages,
  estimateMessageTokens,
  estimateTokens,
  isContextOverflowError,
  projectPromptTokens,
  promptBudget,
  toolResultCap,
} from "./contextBudget.js";

function result(content: string, extra: Partial<ToolResultBlock> = {}): ToolResultBlock {
  return { type: "tool_result", toolUseId: "call", content, ...extra };
}

function batch(content: string, extra: Partial<ToolResultBlock> = {}): AgentMessage {
  return { role: "user", content: [result(content, extra)] };
}

describe("context-window estimates", () => {
  test("scales and clamps the per-result ceiling", () => {
    assert.equal(toolResultCap(null), TOOL_RESULT_CAP_DEFAULT);
    assert.equal(toolResultCap(0), TOOL_RESULT_CAP_DEFAULT);
    assert.equal(toolResultCap(1_000), 8_000);
    assert.equal(toolResultCap(64_000), 38_400);
    assert.equal(toolResultCap(1_000_000), TOOL_RESULT_CAP_DEFAULT);
  });

  test("reserves fifteen percent of the context for output", () => {
    assert.equal(promptBudget(100_000), 85_000);
    assert.equal(promptBudget(1), 0);
  });

  test("rounds text estimates up at the four-character boundary", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  test("counts text, tool input, result images, and block framing", () => {
    const user: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "abcd" },
        result("abcdefgh", {
          images: [
            { mimeType: "image/png", data: "one" },
            { mimeType: "image/jpeg", data: "two" },
          ],
        }),
      ],
    };
    assert.equal(estimateMessageTokens(user), 1 + 8 + 2 + 3_000 + 8);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const assistant: AgentMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "1", name: "bash", input: circular }],
    };
    assert.equal(estimateMessageTokens(assistant), estimateTokens("bash") + 8);
  });

  test("projects only after a provider token count anchors the estimate", () => {
    const appended: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "12345678" }] },
    ];
    assert.equal(projectPromptTokens(null, appended), null);
    assert.equal(projectPromptTokens(100, appended), 110);
  });
});

describe("tool-result compaction", () => {
  test("evicts oldest results while preserving the instruction and two newest batches", () => {
    const old = result("x".repeat(400), {
      isError: true,
      images: [{ mimeType: "image/png", data: "image" }],
    });
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "original instruction" }] },
      { role: "user", content: [old] },
      batch("middle".repeat(50)),
      batch("recent one"),
      batch("recent two"),
    ];
    const compacted = compactMessages({
      messages,
      currentTokens: 2_000,
      targetTokens: 1_000,
    });
    assert.equal(compacted.evicted, 1);
    assert.ok(compacted.freedTokens > 1_000);
    assert.match(old.content, /older tool result dropped/);
    assert.equal(old.isError, false);
    assert.equal(old.images, undefined);
    assert.equal((messages[0].content[0] as { text: string }).text, "original instruction");
    assert.equal((messages[3].content[0] as ToolResultBlock).content, "recent one");
  });

  test("stops once enough space has been freed", () => {
    const first = result("a".repeat(400));
    const second = result("b".repeat(400));
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "instruction" }] },
      { role: "user", content: [first, second] },
    ];
    const out = compactMessages({
      messages,
      currentTokens: 200,
      targetTokens: 150,
      keepRecentBatches: 0,
    });
    assert.equal(out.evicted, 1);
    assert.match(first.content, /dropped/);
    assert.equal(second.content, "b".repeat(400));
  });

  test("does not replace tiny results with a larger stub", () => {
    const tiny = result("ok");
    const out = compactMessages({
      messages: [
        { role: "user", content: [{ type: "text", text: "instruction" }] },
        { role: "user", content: [tiny] },
      ],
      currentTokens: 100,
      targetTokens: 0,
      keepRecentBatches: 0,
    });
    assert.deepEqual(out, { evicted: 0, freedTokens: 0 });
    assert.equal(tiny.content, "ok");
  });

  test("is idempotent and ignores assistant prose and tool calls", () => {
    const old = result("x".repeat(400));
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "instruction" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "1", name: "read_file", input: {} },
        ],
      },
      { role: "user", content: [old] },
    ];
    compactMessages({ messages, currentTokens: 100, targetTokens: 0, keepRecentBatches: 0 });
    const second = compactMessages({
      messages,
      currentTokens: 100,
      targetTokens: 0,
      keepRecentBatches: 0,
    });
    assert.deepEqual(second, { evicted: 0, freedTokens: 0 });
    assert.equal((messages[1].content[0] as { text: string }).text, "thinking");
  });
});

describe("context overflow recognition", () => {
  test("accepts provider codes in both common locations", () => {
    assert.equal(isContextOverflowError({ code: "context_length_exceeded" }), true);
    assert.equal(
      isContextOverflowError({ error: { code: "string_above_max_length" } }),
      true,
    );
  });

  test("recognizes the common provider phrasings", () => {
    for (const message of [
      "Maximum context length is 128k",
      "context_length_exceeded",
      "Prompt is too long",
      "Too many tokens supplied",
      "Reduce the length of the input prompt",
      "Input exceeds the model's context window",
    ]) {
      assert.equal(isContextOverflowError({ message }), true, message);
    }
  });

  test("fails closed for unrelated and malformed errors", () => {
    assert.equal(isContextOverflowError(null), false);
    assert.equal(isContextOverflowError("too many tokens"), false);
    assert.equal(isContextOverflowError({ message: "rate limit" }), false);
    assert.equal(isContextOverflowError({ message: 42 }), false);
  });
});
