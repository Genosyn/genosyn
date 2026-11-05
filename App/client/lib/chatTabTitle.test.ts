import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { replyTabTitle } from "./chatTabTitle";

describe("the browser tab while an AI Employee answers", () => {
  test("says it is working, and that a reply landed while nobody was looking", () => {
    const employeeName = "Sam Flinch";
    assert.equal(
      replyTabTitle({ employeeName, working: true, readyWhileAway: false }),
      "Working · Sam Flinch",
    );
    assert.equal(
      replyTabTitle({ employeeName, working: false, readyWhileAway: true }),
      "Reply ready · Sam Flinch",
    );
    assert.equal(replyTabTitle({ employeeName, working: false, readyWhileAway: false }), null);
  });
});
