import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatRetryText } from "./chatRetry";

describe("retrying accepted AI messages", () => {
  test("preserves a written request exactly", () =>
    assert.equal(
      chatRetryText({ content: " Explain this\ncarefully. " }),
      " Explain this\ncarefully. ",
    ));
  test("retries image-only requests with a reference to persisted files", () =>
    assert.match(
      chatRetryText({ content: "", attachments: [{ id: "image" }] }),
      /previous message/,
    ));
  test("handles whitespace-only attachment messages", () =>
    assert.ok(chatRetryText({ content: "   ", attachments: [{}] }).trim()));
  test("does not invent a request for a blank row with no attachment", () =>
    assert.equal(chatRetryText({ content: "", attachments: [] }), ""));
  test("uses the written request when both text and attachments exist", () =>
    assert.equal(
      chatRetryText({ content: "Check the screenshot", attachments: [{}] }),
      "Check the screenshot",
    ));
});
