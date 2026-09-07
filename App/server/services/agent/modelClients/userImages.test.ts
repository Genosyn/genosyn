import assert from "node:assert/strict";
import test from "node:test";
import { toAnthropicMessage } from "./anthropic.js";
import { toOpenAIMessages } from "./openai.js";
import { toResponsesInput } from "./openaiResponses.js";
import { splitConversation } from "../codexRuntime.js";
import { buildMessages } from "../../chat.js";
import { workspaceReplayThroughMessage } from "../../workspaceChat.js";
import type { ChannelMessage } from "../../../db/entities/ChannelMessage.js";
import { estimateMessageTokens } from "../contextBudget.js";
import type { AgentMessage } from "../types.js";

const first = { mimeType: "image/png", data: "first-image" };
const second = { mimeType: "image/jpeg", data: "second-image" };
const messages = buildMessages(
  [
    { role: "user", content: "Original screenshot", images: [first] },
    { role: "assistant", content: "I see the original." },
  ],
  "Compare with this screenshot",
  [second],
);

test("shared chat input preserves current and historical native user images", () => {
  assert.deepEqual(messages[0], {
    role: "user",
    content: [
      { type: "text", text: "Original screenshot" },
      { type: "image", ...first },
    ],
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "text", text: "Compare with this screenshot" },
      { type: "image", ...second },
    ],
  });
  assert.equal(JSON.stringify(messages[1]).includes("image"), false);
});

test("image-only messages retain native image content", () => {
  const imageOnly = buildMessages([], "", [first]);
  assert.equal(imageOnly[0].content[0].type, "image");
  assert.ok(
    imageOnly[0].content.every((block) => block.type !== "text" || block.text.trim().length > 0),
  );
  assert.equal(toResponsesInput(imageOnly).length, 1);
  assert.equal(toOpenAIMessages("system", imageOnly).length, 2);
});

test("Anthropic receives native base64 images alongside the actual user text", () => {
  const mapped = toAnthropicMessage(messages[0]);
  assert.deepEqual(mapped, {
    role: "user",
    content: [
      { type: "text", text: "Original screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "first-image" } },
    ],
  });
});

test("OpenAI Responses receives native input_image blocks in history and the new turn", () => {
  const mapped = toResponsesInput(messages);
  assert.deepEqual(mapped[0], {
    role: "user",
    content: [
      { type: "input_text", text: "Original screenshot" },
      { type: "input_image", image_url: "data:image/png;base64,first-image", detail: "auto" },
    ],
  });
  assert.deepEqual(mapped[2], {
    role: "user",
    content: [
      { type: "input_text", text: "Compare with this screenshot" },
      { type: "input_image", image_url: "data:image/jpeg;base64,second-image", detail: "auto" },
    ],
  });
});

test("custom OpenAI-compatible endpoints receive standard image_url user content", () => {
  const mapped = toOpenAIMessages("Member request boundary", messages);
  assert.deepEqual(mapped[0], { role: "system", content: "Member request boundary" });
  assert.deepEqual(mapped[1], {
    role: "user",
    content: [
      { type: "text", text: "Original screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,first-image" } },
    ],
  });
  assert.deepEqual(toOpenAIMessages("system", buildMessages([], "plain text"))[1], {
    role: "user",
    content: "plain text",
  });
});

test("Codex subscription maps historical input_image and current image URL inputs", () => {
  const mapped = splitConversation(messages);
  const historyContent = mapped.history[0].content as Record<string, unknown>[];
  assert.deepEqual(historyContent[1], {
    type: "input_image",
    image_url: "data:image/png;base64,first-image",
  });
  assert.deepEqual(mapped.current[1], {
    type: "image",
    url: "data:image/jpeg;base64,second-image",
  });
  assert.ok(!String(mapped.current[0].text).includes("second-image"));
  assert.ok(!String(historyContent[0].text).includes("first-image"));
});

test("native user images do not become tool results or change tool-call pairing", () => {
  const mixed: AgentMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call", content: "read result" },
        { type: "image", ...first },
      ],
    },
  ];
  const responses = toResponsesInput(mixed);
  assert.deepEqual(responses[1], {
    type: "function_call_output",
    call_id: "call",
    output: "read result",
  });
  assert.equal((responses[2] as { role: string }).role, "user");
  const completion = toOpenAIMessages("system", mixed);
  assert.deepEqual(completion[2], { role: "tool", tool_call_id: "call", content: "read result" });
  assert.equal(completion[3].role, "user");
});

test("image budgeting counts visual content rather than base64 string length", () => {
  const small: AgentMessage = { role: "user", content: [{ type: "image", ...first }] };
  const large: AgentMessage = {
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "x".repeat(100_000) }],
  };
  assert.ok(estimateMessageTokens(small) > 0);
  assert.equal(estimateMessageTokens(large), estimateMessageTokens(small));
});

test("attachment identity stays beside its image even when other files exceed limits", () => {
  const labelled = buildMessages([], "Compare the attached files", [
    { ...first, sourceLabel: '[Attached image id=first filename="screen.png"]' },
  ]);
  assert.deepEqual(
    labelled[0].content.slice(1).map((block) => block.type),
    ["text", "image"],
  );
  const mapped = toResponsesInput(labelled);
  assert.ok(
    JSON.stringify(mapped).indexOf("screen.png") < JSON.stringify(mapped).indexOf("data:image/png"),
  );
});

test("Codex keeps each image beside its own label in current and historical input", () => {
  const images = [
    { ...first, sourceLabel: "First screenshot" },
    { ...second, sourceLabel: "Second screenshot" },
  ];
  const messages = buildMessages([{ role: "user", content: "", images }], " ", images);
  const mapped = splitConversation(messages);
  assert.deepEqual(
    mapped.current.map((item) => item.type),
    ["text", "image", "text", "image"],
  );
  assert.deepEqual(
    (mapped.history[0].content as Array<{ type: string }>).map((item) => item.type),
    ["input_text", "input_image", "input_text", "input_image"],
  );
  assert.equal(mapped.current[0].text, "First screenshot");
  assert.equal(mapped.current[2].text, "Second screenshot");
  const anthropic = toAnthropicMessage(messages[0]);
  assert.ok(Array.isArray(anthropic.content));
  assert.ok(
    anthropic.content.every((block) => block.type !== "text" || block.text.trim().length > 0),
  );
});

test("an image-only history turn remains valid after its images fall outside the replay budget", () => {
  const messages = buildMessages([{ role: "user", content: "" }], "Continue");
  const mapped = toAnthropicMessage(messages[0]);
  assert.ok(Array.isArray(mapped.content));
  assert.ok(mapped.content.some((block) => block.type === "text" && block.text.trim().length > 0));
});

test("workspace replay keeps a pasted-image trigger last when another employee already replied", () => {
  const rows = ["older", "trigger", "first-employee-reply", "newer-member-message"].map(
    (id) => ({ id, authorKind: "user", content: id }) as ChannelMessage,
  );
  assert.deepEqual(
    workspaceReplayThroughMessage(rows, rows[1]).map((row) => row.id),
    ["older", "trigger"],
  );
  assert.deepEqual(
    workspaceReplayThroughMessage(rows.slice(2), rows[1]).map((row) => row.id),
    ["trigger"],
  );
});

test("workspace image replay respects the last context reset before the trigger", () => {
  const older = { id: "older", authorKind: "user", content: "old screenshot" } as ChannelMessage;
  const reset = {
    id: "reset",
    authorKind: "system",
    content: "New context started by Member.",
  } as ChannelMessage;
  const trigger = {
    id: "trigger",
    authorKind: "user",
    content: "new screenshot",
  } as ChannelMessage;
  assert.deepEqual(
    workspaceReplayThroughMessage([older, reset, trigger], trigger).map((row) => row.id),
    ["trigger"],
  );
});
