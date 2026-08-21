import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  mergeQuestions,
  upsertQuestionMessage,
  workingMessage,
  type TldrQuestion,
  type TldrQuestionMessage,
} from "./tldrQuestions.js";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  status: TldrQuestionMessage["status"] = null,
): TldrQuestionMessage {
  return {
    id,
    questionId: "q1",
    role,
    employeeId: role === "assistant" ? "emp" : null,
    modelId: null,
    content,
    status,
    actions: [],
    createdByUserId: role === "user" ? "user" : null,
    createdAt: "2026-08-20T12:00:00.000Z",
  };
}

function question(messages: TldrQuestionMessage[], id = "q1"): TldrQuestion {
  return {
    id,
    tldrId: "t1",
    prompt: "What can be improved?",
    employee: { id: "emp", name: "Rey", slug: "rey", role: "Chief of staff", avatarKey: null },
    createdByUserId: "user",
    createdAt: "2026-08-20T12:00:00.000Z",
    messages,
  };
}

describe("upsertQuestionMessage", () => {
  test("replaces a row by id so a working bubble becomes its own answer", () => {
    const working = message("a1", "assistant", "", "working");
    const finalized = message("a1", "assistant", "Ship fewer things.", "ok");

    const merged = upsertQuestionMessage([working], finalized);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].content, "Ship fewer things.");
    assert.equal(merged[0].status, "ok");
  });

  test("appends a row this panel has not seen", () => {
    const merged = upsertQuestionMessage([message("u1", "user", "Why?")], message("a1", "assistant", "Because."));
    assert.deepEqual(
      merged.map((m) => m.id),
      ["u1", "a1"],
    );
  });
});

describe("mergeQuestions", () => {
  test("keeps text already streamed into a row the server still stores empty", () => {
    // The server persists the in-flight row before the model runs and only
    // writes text when the turn finalizes, so a poll landing mid-stream carries
    // an empty bubble for an answer this browser is watching arrive.
    const streaming = question([message("a1", "assistant", "Ship fewer thi", "working")]);
    const fromServer = question([message("a1", "assistant", "", "working")]);

    const merged = mergeQuestions([streaming], [fromServer]);

    assert.equal(merged[0].messages[0].content, "Ship fewer thi");
    assert.equal(merged[0].messages[0].status, "working");
  });

  test("lets the finalized server row win over the partial stream", () => {
    const streaming = question([message("a1", "assistant", "Ship fewer thi", "working")]);
    const fromServer = question([message("a1", "assistant", "Ship fewer things.", "ok")]);

    const merged = mergeQuestions([streaming], [fromServer]);

    assert.equal(merged[0].messages[0].content, "Ship fewer things.");
    assert.equal(merged[0].messages[0].status, "ok");
  });

  test("drops an optimistic twin once the server has the real row", () => {
    const optimistic = question([message("temp-1", "user", "Why?")]);
    const fromServer = question([message("u1", "user", "Why?")]);

    const merged = mergeQuestions([optimistic], [fromServer]);

    assert.deepEqual(
      merged[0].messages.map((m) => m.id),
      ["u1"],
    );
  });

  test("keeps an optimistic row the server has not echoed yet", () => {
    const optimistic = question([message("temp-1", "user", "Why?")]);
    const fromServer = question([]);

    const merged = mergeQuestions([optimistic], [fromServer]);

    assert.deepEqual(
      merged[0].messages.map((m) => m.id),
      ["temp-1"],
    );
  });

  test("a card the server no longer has is gone, not resurrected from local state", () => {
    const merged = mergeQuestions([question([message("a1", "assistant", "Answer", "ok")])], []);
    assert.deepEqual(merged, []);
  });
});

describe("workingMessage", () => {
  test("finds the in-flight reply and ignores finished ones", () => {
    const card = question([
      message("a1", "assistant", "Done.", "ok"),
      message("a2", "assistant", "", "working"),
    ]);
    assert.equal(workingMessage(card)?.id, "a2");
    assert.equal(workingMessage(question([message("a1", "assistant", "Done.", "ok")])), null);
  });

  test("never treats a Member's own message as an in-flight reply", () => {
    assert.equal(workingMessage(question([message("u1", "user", "Why?")])), null);
  });
});
