import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { usesChatWorkloadLease } from "./chat.js";

/**
 * Which chat-seam turns serialize their replies, and why it matters.
 *
 * The interesting case is a Repository work session started from chat: the
 * conversation that called `start_repository_work_session` is still holding
 * the employee's reply lease when the session begins. The session itself is
 * background work, so it must not ask for that same lease and deadlock against
 * the conversation that started it.
 */

describe("chat reply serialization", () => {
  test("an ordinary chat turn takes the employee's reply lease", () => {
    assert.equal(usesChatWorkloadLease({}), true);
    assert.equal(usesChatWorkloadLease({ repositoryWorkSessionId: null }), true);
  });

  test("a Repository work session does not take the employee's reply lease", () => {
    assert.equal(usesChatWorkloadLease({ repositoryWorkSessionId: "session_1" }), false);
  });
});
