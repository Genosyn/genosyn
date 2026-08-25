import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeFlight,
  bindLazyCreatedConversation,
  chatFlightKey,
  flightFor,
  IDLE_FLIGHT,
  moveQueuedMessageToFront,
  resolveLazyCreatedSelection,
  shouldRenderQueuedMessage,
  type ConversationFlight,
  type EmployeeSession,
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

function flight(overrides: Partial<ConversationFlight> = {}): ConversationFlight {
  return { ...IDLE_FLIGHT, sending: true, ...overrides };
}

function session(overrides: Partial<EmployeeSession> = {}): EmployeeSession {
  return {
    activeConvId: null,
    loadedConvId: null,
    messages: [],
    contextUsage: null,
    flights: {},
    newConversationIntent: 0,
    input: "",
    convs: [],
    archivedConvs: [],
    convsLoaded: true,
    archivedLoaded: false,
    convLoading: false,
    ...overrides,
  };
}

/**
 * Threads run in parallel, so every piece of in-flight state is addressed to
 * one thread. A Member with three conversations open on the same AI Employee
 * gets three replies at once; before this, the second and third sat in a queue
 * behind the first.
 */
describe("per-conversation chat flights", () => {
  test("gives each conversation its own key", () => {
    assert.notEqual(chatFlightKey("conv_a", 0), chatFlightKey("conv_b", 0));
  });

  test("keys a staged thread by intent until its row exists", () => {
    assert.equal(chatFlightKey(null, 3), "new:3");
    assert.notEqual(chatFlightKey(null, 3), chatFlightKey(null, 4));
    // The lazy create moves the thread onto its real id, and the two keys are
    // deliberately different — that move is what `sendTurn` has to perform.
    assert.notEqual(chatFlightKey(null, 3), chatFlightKey("conv_a", 3));
  });

  test("a reply in one conversation leaves the others idle", () => {
    const s = session({
      activeConvId: "conv_b",
      flights: { [chatFlightKey("conv_a", 0)]: flight({ conversationId: "conv_a" }) },
    });

    assert.equal(flightFor(s, "conv_a", 0).sending, true);
    assert.equal(flightFor(s, "conv_b", 0).sending, false);
    assert.equal(activeFlight(s).sending, false, "the visible thread must accept a new message");
  });

  test("shows only the visible thread's queue and stream", () => {
    const s = session({
      activeConvId: "conv_a",
      flights: {
        [chatFlightKey("conv_a", 0)]: flight({
          conversationId: "conv_a",
          streamingReply: "answering A",
          queuedMessages: [queued("follow-up A", 0, "conv_a")],
        }),
        [chatFlightKey("conv_b", 0)]: flight({
          conversationId: "conv_b",
          streamingReply: "answering B",
          queuedMessages: [queued("follow-up B", 0, "conv_b")],
        }),
      },
    });

    assert.equal(activeFlight(s).streamingReply, "answering A");
    assert.deepEqual(
      activeFlight(s).queuedMessages.map((m) => m.id),
      ["follow-up A"],
    );
  });

  test("reports an idle thread rather than undefined", () => {
    assert.equal(flightFor(session(), "conv_missing", 0), IDLE_FLIGHT);
    assert.equal(activeFlight(session()).sending, false);
  });
});

describe("interrupt and send", () => {
  test("moves the chosen follow-up ahead of everything else waiting", () => {
    const queue = [queued("first", 1), queued("second", 1), queued("third", 1)];

    assert.deepEqual(
      moveQueuedMessageToFront(queue, "third").map((message) => message.id),
      ["third", "first", "second"],
      "the message the Member interrupted for must be the one that sends next",
    );
    assert.deepEqual(
      queue.map((message) => message.id),
      ["first", "second", "third"],
      "promotion must not mutate the queue the worker is draining",
    );
  });

  test("leaves the queue alone when the message is already next or already sent", () => {
    const queue = [queued("first", 1), queued("second", 1)];

    assert.equal(moveQueuedMessageToFront(queue, "first"), queue);
    assert.equal(
      moveQueuedMessageToFront(queue, "already-drained"),
      queue,
      "a message the worker already shifted off must not resurrect a stale copy",
    );
  });

  test("a stop asked for in one thread leaves another thread's reply alone", () => {
    // `interrupting` lives on the flight, so the button in the thread on
    // screen can never stop a reply the Member is not looking at.
    const s = session({
      activeConvId: "conv_a",
      flights: {
        [chatFlightKey("conv_a", 0)]: flight({ conversationId: "conv_a", interrupting: true }),
        [chatFlightKey("conv_b", 0)]: flight({ conversationId: "conv_b" }),
      },
    });

    assert.equal(activeFlight(s).interrupting, true);
    assert.equal(flightFor(s, "conv_b", 0).interrupting, false);
  });
});
