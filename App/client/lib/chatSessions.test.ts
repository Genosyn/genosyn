import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bindLazyCreatedConversation,
  resolveLazyCreatedSelection,
  shouldRenderQueuedMessage,
  type QueuedChatMessage,
} from "./chatSessions.js";

function queued(
  id: string,
  newConversationIntent: number,
  conversationId: string | null = null,
): QueuedChatMessage {
  return {
    id,
    conversationId,
    newConversationIntent,
    modelId: null,
    content: id,
    attachments: [],
    queuedAt: "2026-08-21T09:00:00.000Z",
  };
}

describe("lazy-created chat conversation boundaries", () => {
  test("does not adopt a staged TLDR draft into an older in-flight conversation", () => {
    const oldIntent = 4;
    const stagedTldrIntent = 5;
    const messages = [
      queued("old follow-up", oldIntent),
      queued("staged TLDR", stagedTldrIntent),
      queued("existing thread", oldIntent, "conversation-existing"),
    ];

    const rebound = bindLazyCreatedConversation(messages, oldIntent, "conversation-old");

    assert.deepEqual(
      rebound.map((message) => [message.id, message.conversationId]),
      [
        ["old follow-up", "conversation-old"],
        ["staged TLDR", null],
        ["existing thread", "conversation-existing"],
      ],
    );
    assert.equal(messages[0].conversationId, null, "queue binding must not mutate shared state");
    assert.equal(
      resolveLazyCreatedSelection(stagedTldrIntent, oldIntent, null, "conversation-old"),
      null,
      "the older POST must not replace the staged new-conversation selection",
    );
    assert.equal(
      shouldRenderQueuedMessage(null, null, oldIntent, stagedTldrIntent),
      false,
      "the older queued draft must not appear in the newly staged transcript",
    );
  });

  test("keeps ordinary fast follow-ups in the same newly created conversation", () => {
    const messages = [queued("first follow-up", 7), queued("second follow-up", 7)];

    assert.deepEqual(
      bindLazyCreatedConversation(messages, 7, "conversation-new").map(
        (message) => message.conversationId,
      ),
      ["conversation-new", "conversation-new"],
    );
    assert.equal(resolveLazyCreatedSelection(7, 7, null, "conversation-new"), "conversation-new");
    assert.equal(shouldRenderQueuedMessage(null, null, 7, 7), true);
    assert.equal(shouldRenderQueuedMessage("conversation-new", "conversation-new", 7, 8), true);
    assert.equal(shouldRenderQueuedMessage("conversation-new", "conversation-other", 7, 7), false);
  });
});
