import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isIndeterminateChatProgress, shouldShowChatProgressCard } from "./chatProgress";

describe("chat progress presentation", () => {
  test("keeps system starting and recovery placeholders indeterminate", () => {
    assert.equal(isIndeterminateChatProgress(1, "Starting work"), true);
    assert.equal(isIndeterminateChatProgress(1, "Resuming durable work"), true);
    assert.equal(isIndeterminateChatProgress(1, "  STARTING WORK  "), true);
  });

  test("shows determinate progress once the employee reports a milestone", () => {
    assert.equal(isIndeterminateChatProgress(1, "Reading the brief"), false);
    assert.equal(isIndeterminateChatProgress(2, "Starting work"), false);
    assert.equal(isIndeterminateChatProgress(42, "Checking records"), false);
  });

  test("keeps typing dots for a new live turn", () => {
    assert.equal(shouldShowChatProgressCard(1, "Starting work", "streaming"), false);
  });

  test("shows the card for recovery and real milestones", () => {
    assert.equal(shouldShowChatProgressCard(1, "Starting work", "polling"), true);
    assert.equal(shouldShowChatProgressCard(1, "Resuming durable work", "reconnecting"), true);
    assert.equal(shouldShowChatProgressCard(1, "Starting work", null), true);
    assert.equal(shouldShowChatProgressCard(30, "Checking records", "streaming"), true);
  });
});
