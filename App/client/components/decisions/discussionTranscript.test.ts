import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ConversationMessage } from "../../lib/api";
import {
  isWorkingMessage,
  mergeTranscript,
  parseProgress,
  retryableReplyId,
  upsertMessage,
} from "./discussionTranscript";

function message(
  id: string,
  role: ConversationMessage["role"],
  status: ConversationMessage["status"],
  content = id,
): ConversationMessage {
  return {
    id,
    conversationId: "thread",
    role,
    content,
    status,
    createdAt: "2026-10-08T09:00:00.000Z",
  };
}

describe("Decision discussion transcript", () => {
  test("only an unfinished employee reply is working", () => {
    assert.equal(isWorkingMessage(message("a", "assistant", "working")), true);
    assert.equal(isWorkingMessage(message("a", "assistant", "ok")), false);
    assert.equal(isWorkingMessage(message("u", "user", null)), false);
  });

  test("upserts by id without reordering the thread", () => {
    const thread = [message("u", "user", null), message("a", "assistant", "working", "")];
    const finished = upsertMessage(thread, message("a", "assistant", "ok", "Here is why."));
    assert.deepEqual(
      finished.map((row) => [row.id, row.status, row.content]),
      [
        ["u", null, "u"],
        ["a", "ok", "Here is why."],
      ],
    );
    assert.equal(upsertMessage(thread, message("b", "user", null)).at(-1)?.id, "b");
  });

  test("a stale read never turns a finished reply back into a spinner", () => {
    const current = [message("u", "user", null), message("a", "assistant", "ok", "Done.")];
    const stale = [message("u", "user", null), message("a", "assistant", "working", "")];
    assert.deepEqual(
      mergeTranscript(current, stale).map((row) => [row.id, row.status]),
      [
        ["u", null],
        ["a", "ok"],
      ],
    );
    // The server stays the source of the order and of every other row.
    const later = [...stale, message("u2", "user", null), message("a2", "assistant", "working")];
    assert.deepEqual(
      mergeTranscript(current, later).map((row) => [row.id, row.status]),
      [
        ["u", null],
        ["a", "ok"],
        ["u2", null],
        ["a2", "working"],
      ],
    );
  });

  test("a Retry turns a failed reply back into one being written, because it is newer", () => {
    const failed = {
      ...message("a", "assistant", "error", "It failed."),
      updatedAt: "2026-10-08T09:01:00.000Z",
    };
    const retried = { ...message("a", "assistant", "working", ""), updatedAt: "2026-10-08T09:02:00.000Z" };
    assert.equal(mergeTranscript([failed], [retried])[0].status, "working");
    // A read that left before the reply failed is still stale.
    const older = { ...message("a", "assistant", "working", ""), updatedAt: "2026-10-08T09:00:30.000Z" };
    assert.equal(mergeTranscript([failed], [older])[0].status, "error");
  });

  test("only the newest reply can be retried, when it failed and nothing is running", () => {
    const user = message("u", "user", null);
    assert.equal(retryableReplyId([user, message("a", "assistant", "error")]), "a");
    assert.equal(retryableReplyId([user, message("a", "assistant", "skipped")]), "a");
    assert.equal(retryableReplyId([user, message("a", "assistant", "ok")]), null);
    assert.equal(retryableReplyId([user, message("a", "assistant", "interrupted")]), null);
    assert.equal(
      retryableReplyId([
        message("a", "assistant", "error"),
        message("u2", "user", null),
        message("b", "assistant", "ok"),
      ]),
      null,
      "an older failure is behind the conversation",
    );
    assert.equal(
      retryableReplyId([message("a", "assistant", "error"), message("b", "assistant", "working")]),
      null,
      "not while a reply is being written",
    );
    assert.equal(retryableReplyId([user]), null);
  });

  test("accepts only well-formed progress", () => {
    assert.deepEqual(parseProgress({ percent: 40, label: " Reading the decision " }), {
      percent: 40,
      label: "Reading the decision",
    });
    for (const bad of [
      null,
      { percent: 0, label: "x" },
      { percent: 100, label: "x" },
      { percent: 4.5, label: "x" },
      { percent: 40, label: "  " },
      { percent: "40", label: "x" },
    ]) {
      assert.equal(parseProgress(bad), null, JSON.stringify(bad));
    }
  });
});
