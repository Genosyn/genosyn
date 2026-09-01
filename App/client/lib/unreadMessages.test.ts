import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkspaceMessage } from "./workspace";
import { countsAsUnread, firstUnreadMessageId, unreadCountIn } from "./unreadMessages";

/**
 * Where the "New" line lands when you peek at an unread channel from Home.
 *
 * The badge on the Home card is a server count, and the line here is a client
 * guess at the same thing. If the two use different rules the card says four
 * unread and the line sits above three of them, which is the kind of small
 * wrongness that stops people trusting the count at all.
 */

const ME = "user-me";

function message(
  id: string,
  createdAt: string,
  author: WorkspaceMessage["author"],
): WorkspaceMessage {
  return {
    id,
    channelId: "channel-1",
    authorKind: author?.kind ?? "system",
    author,
    content: id,
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt,
    attachments: [],
    reactions: [],
  };
}

const mine = (id: string, at: string) =>
  message(id, at, { kind: "user", id: ME, name: "Me", email: null });
const theirs = (id: string, at: string) =>
  message(id, at, { kind: "user", id: "user-them", name: "Them", email: null });
const employee = (id: string, at: string) =>
  message(id, at, { kind: "ai", id: "emp-1", name: "Ada", slug: "ada", role: "Engineer" });

describe("countsAsUnread", () => {
  test("a message after the read mark, written by someone else, is unread", () => {
    assert.equal(
      countsAsUnread(theirs("m1", "2026-01-02T00:00:00.000Z"), "2026-01-01T00:00:00.000Z", {
        meId: ME,
      }),
      true,
    );
  });

  test("my own message is never unread, however new", () => {
    assert.equal(
      countsAsUnread(mine("m1", "2026-01-02T00:00:00.000Z"), "2026-01-01T00:00:00.000Z", {
        meId: ME,
      }),
      false,
    );
  });

  test("an AI employee's message counts — it is exactly what you came to read", () => {
    assert.equal(
      countsAsUnread(employee("m1", "2026-01-02T00:00:00.000Z"), "2026-01-01T00:00:00.000Z", {
        meId: ME,
      }),
      true,
    );
  });

  test("a message at or before the read mark is read", () => {
    const at = "2026-01-01T00:00:00.000Z";
    assert.equal(countsAsUnread(theirs("m1", at), at, { meId: ME }), false);
    assert.equal(countsAsUnread(theirs("m1", "2025-12-31T23:59:59.000Z"), at, { meId: ME }), false);
  });

  test("never having opened the channel makes everyone else's messages unread", () => {
    assert.equal(
      countsAsUnread(theirs("m1", "2026-01-02T00:00:00.000Z"), null, { meId: ME }),
      true,
    );
    assert.equal(countsAsUnread(mine("m2", "2026-01-02T00:00:00.000Z"), null, { meId: ME }), false);
  });

  test("a deleted message still counts, because the server counted its row", () => {
    const tombstone = {
      ...theirs("m1", "2026-01-02T00:00:00.000Z"),
      deletedAt: "2026-01-02T00:05:00.000Z",
    };
    assert.equal(countsAsUnread(tombstone, "2026-01-01T00:00:00.000Z", { meId: ME }), true);
  });

  test("an unparseable timestamp reads as read rather than planting the line at the top", () => {
    assert.equal(
      countsAsUnread(theirs("m1", "not-a-date"), "2026-01-01T00:00:00.000Z", {
        meId: ME,
      }),
      false,
    );
    assert.equal(
      countsAsUnread(theirs("m1", "2026-01-02T00:00:00.000Z"), "not-a-date", { meId: ME }),
      false,
    );
  });

  test("with no viewer id, nothing is treated as mine", () => {
    assert.equal(
      countsAsUnread(mine("m1", "2026-01-02T00:00:00.000Z"), "2026-01-01T00:00:00.000Z", {
        meId: null,
      }),
      true,
    );
  });
});

describe("firstUnreadMessageId", () => {
  const page = [
    theirs("old", "2026-01-01T09:00:00.000Z"),
    mine("my-reply", "2026-01-01T10:00:00.000Z"),
    theirs("new-1", "2026-01-01T11:00:00.000Z"),
    employee("new-2", "2026-01-01T12:00:00.000Z"),
  ];
  const readAt = "2026-01-01T10:30:00.000Z";

  test("names the first message of the unread run", () => {
    assert.equal(firstUnreadMessageId(page, readAt, { meId: ME }), "new-1");
  });

  test("skips my own message even when it is the newest thing after the mark", () => {
    const withMyLast = [...page, mine("my-latest", "2026-01-01T13:00:00.000Z")];
    assert.equal(firstUnreadMessageId(withMyLast, readAt, { meId: ME }), "new-1");
    assert.equal(
      firstUnreadMessageId([mine("only-mine", "2026-01-01T13:00:00.000Z")], readAt, { meId: ME }),
      null,
    );
  });

  test("returns null when the page is entirely read — no line is drawn", () => {
    assert.equal(firstUnreadMessageId(page, "2026-01-02T00:00:00.000Z", { meId: ME }), null);
    assert.equal(firstUnreadMessageId([], null, { meId: ME }), null);
  });

  test("everything is new for a channel that was never opened", () => {
    assert.equal(firstUnreadMessageId(page, null, { meId: ME }), "old");
  });
});

describe("unreadCountIn", () => {
  test("counts by the same rule the line is drawn by", () => {
    const page = [
      theirs("a", "2026-01-01T11:00:00.000Z"),
      mine("b", "2026-01-01T11:30:00.000Z"),
      employee("c", "2026-01-01T12:00:00.000Z"),
    ];
    assert.equal(unreadCountIn(page, "2026-01-01T10:00:00.000Z", { meId: ME }), 2);
    assert.equal(unreadCountIn(page, "2026-01-01T13:00:00.000Z", { meId: ME }), 0);
  });
});
