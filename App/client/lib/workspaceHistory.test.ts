import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkspaceMessage } from "./workspace";
import {
  type ChannelHistoryPage,
  channelHistoryUrl,
  foldHistoryPage,
  olderCursorOf,
  WORKSPACE_HISTORY_MAX,
} from "./workspaceHistory";
import { applyWorkspaceMessageEvent, mergeWorkspaceMessages } from "./workspaceMessages";

/**
 * Scrolling a Workspace channel back, as the Workspace page and the Home peek
 * do: the newest page, then older pages by the server's cursor until there
 * are none. Scrolling up used to ask for the messages before the oldest one
 * on screen — a timestamp — and SQLite stamps a message to the second, so a
 * busy channel lost the messages sharing a second at every page boundary.
 */

const CHANNEL = "channel-1";

function message(id: string, createdAt: string, extra: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
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
    ...extra,
  };
}

/**
 * A channel of `count` messages stamped to the second, `perSecond` at a time,
 * with one long burst of 100 in a single second in the middle.
 */
function busyChannel(count: number, perSecond: number): WorkspaceMessage[] {
  const base = Date.UTC(2026, 6, 26, 18, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const offset = i >= 100 && i < 200 ? 1_000 : Math.floor(i / perSecond) + (i >= 200 ? 2_000 : 0);
    // Ids sort independently of time, as uuids do.
    const id = `m-${((i * 7_919) % 100_003).toString(36).padStart(6, "0")}-${i}`;
    return message(id, new Date(base + offset * 1_000).toISOString(), {
      ...(i % 9 === 8 ? { content: "", deletedAt: new Date(base).toISOString() } : {}),
    });
  });
}

/** The conversation as the Workspace shows it: oldest first, a shared second by id. */
function conversation(messages: WorkspaceMessage[]): string[] {
  return mergeWorkspaceMessages(messages).map((row) => row.id);
}

/** The server's keyset on (createdAt, id), newest page first, each page oldest first. */
function historyServer(messages: WorkspaceMessage[]) {
  const calls: string[] = [];
  const key = (row: WorkspaceMessage) => `${row.createdAt}|${row.id}`;
  const fetchPage = async (url: string): Promise<ChannelHistoryPage> => {
    calls.push(url);
    const params = new URL(url, "http://x").searchParams;
    const limit = Number(params.get("limit"));
    const cursor = params.get("cursor");
    const newestFirst = [...messages].sort((a, b) => (key(a) < key(b) ? 1 : -1));
    const rest = cursor ? newestFirst.filter((row) => key(row) < cursor) : newestFirst;
    const page = rest.slice(0, limit);
    const hasMore = rest.length > limit;
    return {
      total: messages.length,
      hasMore,
      nextCursor: hasMore ? key(page[page.length - 1]) : null,
      messages: [...page].reverse(),
    };
  };
  return { calls, fetchPage, messages };
}

describe("scrolling a channel back by cursor", () => {
  test("reaches every message once, a hundred of them sharing one second", async () => {
    const all = busyChannel(450, 4);
    for (const limit of [1, 13, 40, WORKSPACE_HISTORY_MAX]) {
      const server = historyServer(all);
      const first = await server.fetchPage(channelHistoryUrl("co", CHANNEL, { limit }));
      let { messages: loaded, olderCursor } = foldHistoryPage([], first);
      let pages = 1;
      while (olderCursor) {
        const page = await server.fetchPage(channelHistoryUrl("co", CHANNEL, { cursor: olderCursor, limit }));
        ({ messages: loaded, olderCursor } = foldHistoryPage(loaded, page));
        pages += 1;
      }
      assert.deepEqual(
        loaded.map((row) => row.id),
        conversation(all),
        `limit ${limit}: the whole conversation, in order`,
      );
      assert.equal(pages, Math.ceil(450 / limit), `limit ${limit}: full pages until the start`);
      assert.equal(
        loaded.filter((row) => row.deletedAt).length,
        50,
        "deleted messages keep their place",
      );
    }
  });

  test("the timestamp loader it replaces skipped the messages sharing a boundary second", async () => {
    const all = busyChannel(450, 4);
    // What the old `before` asked for: strictly before the oldest on screen.
    const before = (instant: string | null, limit: number) =>
      [...all]
        .filter((row) => instant === null || row.createdAt < instant)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .reverse();
    let loaded = before(null, 40);
    let page = loaded;
    while (page.length === 40) {
      page = before(loaded[0].createdAt, 40);
      loaded = mergeWorkspaceMessages(page, loaded);
    }
    assert.ok(loaded.length < 450, `the old loader reached ${loaded.length} of 450`);
  });

  test("messages arriving, edited or reacted to while scrolling keep their freshest copy", async () => {
    const all = busyChannel(120, 3);
    const server = historyServer(all);
    const first = await server.fetchPage(channelHistoryUrl("co", CHANNEL, { limit: 40 }));
    let { messages: loaded, olderCursor } = foldHistoryPage([], first);
    // Live frames while the reader scrolls up: a new message at the bottom,
    // and an edit to one the next page also holds.
    const arriving = message("live-1", new Date(Date.UTC(2026, 6, 27)).toISOString());
    loaded = applyWorkspaceMessageEvent(
      loaded,
      { type: "message.new", channelId: CHANNEL, message: arriving },
      { meId: "me" },
    );
    const target = all.find((row) => !loaded.some((shown) => shown.id === row.id))!;
    const edited = { ...target, content: "edited live", editedAt: "2026-07-27T00:00:00.000Z" };
    loaded = mergeWorkspaceMessages(loaded, [edited]);
    while (olderCursor) {
      const page = await server.fetchPage(channelHistoryUrl("co", CHANNEL, { cursor: olderCursor, limit: 40 }));
      ({ messages: loaded, olderCursor } = foldHistoryPage(loaded, page));
    }
    assert.deepEqual(loaded.map((row) => row.id), conversation([...all, arriving]));
    assert.equal(
      loaded.find((row) => row.id === target.id)!.content,
      "edited live",
      "the live copy beats the page's older one",
    );
  });
});

describe("channelHistoryUrl", () => {
  test("asks for one page of history, with the cursor going back", () => {
    const first = new URL(channelHistoryUrl("co", "ch", { limit: 40 }), "http://x");
    assert.equal(first.pathname, "/api/companies/co/workspace/channels/ch/history");
    assert.equal(first.searchParams.get("limit"), "40");
    assert.equal(first.searchParams.get("cursor"), null);
    assert.equal(first.searchParams.get("before"), null, "never a timestamp");
    const older = new URL(channelHistoryUrl("co", "ch", { cursor: "eyJ2+/=", limit: 30 }), "http://x");
    assert.equal(older.searchParams.get("cursor"), "eyJ2+/=");
    assert.equal(
      new URL(channelHistoryUrl("co", "ch", { limit: 999 }), "http://x").searchParams.get("limit"),
      String(WORKSPACE_HISTORY_MAX),
      "never more than one page holds",
    );
    assert.equal(
      new URL(channelHistoryUrl("co", "ch", { limit: 0 }), "http://x").searchParams.get("limit"),
      "1",
    );
  });

  test("a page that reached the start has nothing older", () => {
    const page = (hasMore: boolean): ChannelHistoryPage => ({
      total: 1,
      hasMore,
      nextCursor: "c",
      messages: [],
    });
    assert.equal(olderCursorOf(page(true)), "c");
    assert.equal(olderCursorOf(page(false)), null);
  });
});
