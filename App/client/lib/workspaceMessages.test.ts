import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkspaceMessage, WsInboundEvent } from "./workspace";
import { applyWorkspaceMessageEvent, mergeWorkspaceMessages } from "./workspaceMessages";

/**
 * What a live socket frame does to a channel already on screen.
 *
 * Two surfaces read the same channel — the Workspace page and the unread peek
 * on Home — and they used to carry a reducer each. The copies had drifted:
 * one kept a deleted message's body in memory, one appended without sorting,
 * one ignored reactions entirely. These tests are what keeps the single copy
 * honest, and they run outside a browser because the reducer has no DOM in it.
 */

const ME = "user-me";
const CHANNEL = "channel-1";

function message(id: string, createdAt: string): WorkspaceMessage {
  return {
    id,
    channelId: CHANNEL,
    authorKind: "user",
    author: { kind: "user", id: "user-them", name: "Them", email: null },
    content: id,
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt,
    attachments: [],
    reactions: [],
  };
}

const apply = (list: WorkspaceMessage[], event: WsInboundEvent) =>
  applyWorkspaceMessageEvent(list, event, { meId: ME });

describe("mergeWorkspaceMessages", () => {
  test("orders by created time and de-duplicates by id", () => {
    const merged = mergeWorkspaceMessages(
      [message("b", "2026-01-02T00:00:00.000Z")],
      [message("a", "2026-01-01T00:00:00.000Z"), message("b", "2026-01-02T00:00:00.000Z")],
    );
    assert.deepEqual(
      merged.map((m) => m.id),
      ["a", "b"],
    );
  });

  test("a later group wins the collision, so a socket echo beats a fetched page", () => {
    const stale = { ...message("a", "2026-01-01T00:00:00.000Z"), content: "stale" };
    const fresh = { ...message("a", "2026-01-01T00:00:00.000Z"), content: "fresh" };
    assert.equal(mergeWorkspaceMessages([stale], [fresh])[0].content, "fresh");
  });

  test("ties on timestamp fall back to the id, so the order is stable", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const merged = mergeWorkspaceMessages([message("z", at), message("a", at)]);
    assert.deepEqual(
      merged.map((m) => m.id),
      ["a", "z"],
    );
  });
});

describe("applyWorkspaceMessageEvent", () => {
  const older = message("a", "2026-01-01T00:00:00.000Z");
  const newer = message("b", "2026-01-02T00:00:00.000Z");

  test("an unrelated frame returns the same array, so a caller can skip the render", () => {
    const list = [older];
    const next = apply(list, { type: "presence", userId: "user-them", online: true });
    assert.equal(next, list);
  });

  test("a new message lands in time order, not at the end", () => {
    const arriving = message("mid", "2026-01-01T12:00:00.000Z");
    const next = apply([older, newer], {
      type: "message.new",
      channelId: CHANNEL,
      message: arriving,
    });
    assert.deepEqual(
      next.map((m) => m.id),
      ["a", "mid", "b"],
    );
  });

  test("a message.new we already hold is a no-op", () => {
    const list = [older];
    const next = apply(list, { type: "message.new", channelId: CHANNEL, message: older });
    assert.equal(next, list);
  });

  test("an edit rewrites the body and stamps editedAt", () => {
    const next = apply([older, newer], {
      type: "message.edit",
      channelId: CHANNEL,
      messageId: "a",
      content: "rewritten",
      editedAt: "2026-01-03T00:00:00.000Z",
    });
    assert.equal(next[0].content, "rewritten");
    assert.equal(next[0].editedAt, "2026-01-03T00:00:00.000Z");
    // Untouched rows keep their identity so React can skip them.
    assert.equal(next[1], newer);
  });

  test("a delete clears the body and the attachments with the tombstone", () => {
    const withFile: WorkspaceMessage = {
      ...older,
      content: "secret",
      attachments: [
        { id: "att-1", filename: "x.png", mimeType: "image/png", sizeBytes: 1, isImage: true },
      ],
    };
    const next = apply([withFile], {
      type: "message.delete",
      channelId: CHANNEL,
      messageId: "a",
    });
    assert.equal(next[0].content, "");
    assert.deepEqual(next[0].attachments, []);
    assert.ok(next[0].deletedAt);
  });

  test("a frame for a message we never loaded leaves the list alone", () => {
    const list = [older];
    const next = apply(list, {
      type: "message.delete",
      channelId: CHANNEL,
      messageId: "not-here",
    });
    assert.equal(next, list);
  });

  test("a reaction from someone else counts but is not mine", () => {
    const next = apply([older], {
      type: "reaction.add",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "🎉",
      by: { kind: "user", id: "user-them", name: "Them" },
    });
    assert.deepEqual(next[0].reactions, [
      {
        emoji: "🎉",
        count: 1,
        byMe: false,
        actors: [{ kind: "user", id: "user-them", name: "Them" }],
      },
    ]);
  });

  test("my own reaction reads as mine", () => {
    const next = apply([older], {
      type: "reaction.add",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "user", id: ME, name: "Me" },
    });
    assert.equal(next[0].reactions[0].byMe, true);
  });

  test("the same actor reacting twice is counted once", () => {
    const frame: WsInboundEvent = {
      type: "reaction.add",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "ai", id: "emp-1", name: "Ada" },
    };
    const once = apply([older], frame);
    const twice = apply(once, frame);
    assert.equal(twice[0].reactions[0].count, 1);
    assert.equal(twice, once);
  });

  test("removing the last actor drops the pill entirely", () => {
    const added = apply([older], {
      type: "reaction.add",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "user", id: "user-them", name: "Them" },
    });
    const removed = apply(added, {
      type: "reaction.remove",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "user", id: "user-them" },
    });
    assert.deepEqual(removed[0].reactions, []);
  });

  test("removing one of two actors recomputes the count and byMe", () => {
    let list = apply([older], {
      type: "reaction.add",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "user", id: ME, name: "Me" },
    });
    list = apply(list, {
      type: "reaction.add",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "user", id: "user-them", name: "Them" },
    });
    const removed = apply(list, {
      type: "reaction.remove",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "👍",
      by: { kind: "user", id: ME },
    });
    assert.equal(removed[0].reactions[0].count, 1);
    assert.equal(removed[0].reactions[0].byMe, false);
  });

  test("removing a reaction nobody left is a no-op", () => {
    const list = [older];
    const next = apply(list, {
      type: "reaction.remove",
      channelId: CHANNEL,
      messageId: "a",
      emoji: "🙃",
      by: { kind: "user", id: ME },
    });
    assert.equal(next, list);
  });

  test("frames buffered during the initial fetch replay onto the page in order", () => {
    // This is exactly what the Home peek does: the socket is live before the
    // first page lands, so an edit can arrive for a message still in flight.
    const page = [older, newer];
    const buffered: WsInboundEvent[] = [
      { type: "message.edit", channelId: CHANNEL, messageId: "a", content: "v2", editedAt: "t1" },
      { type: "message.edit", channelId: CHANNEL, messageId: "a", content: "v3", editedAt: "t2" },
      { type: "message.delete", channelId: CHANNEL, messageId: "b" },
    ];
    const replayed = buffered.reduce((acc, event) => apply(acc, event), page);
    assert.equal(replayed[0].content, "v3");
    assert.equal(replayed[1].content, "");
    assert.ok(replayed[1].deletedAt);
  });
});
