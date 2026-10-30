import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { employeeMilestone, isIndeterminateChatProgress } from "./chatProgress";

describe("chat progress presentation", () => {
  test("keeps system starting and recovery placeholders indeterminate", () => {
    assert.equal(isIndeterminateChatProgress(1, "Starting work"), true);
    assert.equal(isIndeterminateChatProgress(1, "Resuming durable work"), true);
    assert.equal(isIndeterminateChatProgress(1, "  STARTING WORK  "), true);
  });

  test("treats a waiting or retried turn's label as bookkeeping too", () => {
    assert.equal(isIndeterminateChatProgress(1, "Waiting for another reply"), true);
    assert.equal(isIndeterminateChatProgress(1, "Starting again"), true);
  });

  test("shows determinate progress once the employee reports a milestone", () => {
    assert.equal(isIndeterminateChatProgress(1, "Reading the brief"), false);
    assert.equal(isIndeterminateChatProgress(2, "Starting work"), false);
    assert.equal(isIndeterminateChatProgress(42, "Checking records"), false);
  });

  test("an employee milestone survives; a placeholder becomes nothing", () => {
    assert.equal(employeeMilestone({ percent: 1, label: "Starting work" }), null);
    assert.equal(employeeMilestone(null), null);
    assert.deepEqual(employeeMilestone({ percent: 40, label: "Drafting the summary" }), {
      percent: 40,
      label: "Drafting the summary",
    });
  });
});
