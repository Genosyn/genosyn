import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_PANEL_MEMORY_ID_LIMIT,
  CHAT_PANEL_MEMORY_KEY,
  CHAT_PANEL_MEMORY_LIMIT,
  chatPanelMemoryStorage,
  readChatPanelMemory,
  writeChatPanelMemory,
  type ChatPanelMemoryStorage,
} from "./chatPanelMemory";

/**
 * What survives a reload, and what a corrupt or overfull store is allowed to
 * do to the page that reads it.
 *
 * The rule this exists to hold: a panel a Member sent away stays away, a
 * panel they left open comes back, and nothing in localStorage — theirs,
 * another version's, or somebody's fat-fingered devtools edit — is ever
 * allowed to throw on the way to rendering chat.
 */

function fakeStorage(seed?: unknown) {
  let cell: string | null = seed === undefined ? null : JSON.stringify(seed);
  return {
    getItem: (key: string) => (key === CHAT_PANEL_MEMORY_KEY ? cell : null),
    setItem: (key: string, value: string) => {
      if (key === CHAT_PANEL_MEMORY_KEY) cell = value;
    },
    /** What is actually written, for the tests that care about the shape. */
    stored: () => (cell === null ? null : JSON.parse(cell)),
  };
}

const A = { repositorySlug: "oneuptime", sessionId: "session-a" };

describe("remembering a work panel", () => {
  test("comes back exactly as it was left", () => {
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-1", {
      work: { open: A, collapsed: true, offered: ["session-a"] },
    });
    assert.deepEqual(readChatPanelMemory(storage, "conv-1").work, {
      open: A,
      collapsed: true,
      offered: ["session-a"],
    });
  });

  test("a panel that was closed is remembered as closed, not as absent", () => {
    // The difference matters: absent means "never been here", and the panel
    // would happily open the next thing the transcript offers.
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-1", {
      work: { open: null, collapsed: false, offered: ["session-a"] },
    });
    const remembered = readChatPanelMemory(storage, "conv-1").work;
    assert.equal(remembered?.open, null);
    assert.deepEqual(remembered?.offered, ["session-a"]);
  });

  test("a thread nobody has opened a panel in remembers nothing", () => {
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-1", {
      work: { open: A, collapsed: false, offered: [] },
    });
    assert.deepEqual(readChatPanelMemory(storage, "conv-2"), {});
  });
});

describe("remembering a browser panel", () => {
  test("dismissals and the rail come back", () => {
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-1", {
      browser: { dismissed: ["bs-1", "bs-2"], collapsed: true },
    });
    assert.deepEqual(readChatPanelMemory(storage, "conv-1").browser, {
      dismissed: ["bs-1", "bs-2"],
      collapsed: true,
    });
  });

  test("the two panels do not overwrite each other", () => {
    // They write independently — a browser dismissal must not take the open
    // work session down with it.
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-1", {
      work: { open: A, collapsed: false, offered: ["session-a"] },
    });
    writeChatPanelMemory(storage, "conv-1", {
      browser: { dismissed: ["bs-1"], collapsed: false },
    });
    const memory = readChatPanelMemory(storage, "conv-1");
    assert.deepEqual(memory.work?.open, A);
    assert.deepEqual(memory.browser?.dismissed, ["bs-1"]);
  });
});

describe("keeping the store small", () => {
  test("only the most recent threads are kept", () => {
    const storage = fakeStorage();
    for (let i = 0; i < CHAT_PANEL_MEMORY_LIMIT + 10; i++) {
      writeChatPanelMemory(storage, `conv-${i}`, {
        browser: { dismissed: [`bs-${i}`], collapsed: false },
      });
    }
    const rows = storage.stored() as { id: string }[];
    assert.equal(rows.length, CHAT_PANEL_MEMORY_LIMIT);
    const newest = CHAT_PANEL_MEMORY_LIMIT + 9;
    assert.equal(rows[0].id, `conv-${newest}`);
    assert.deepEqual(readChatPanelMemory(storage, "conv-0"), {}, "the oldest fell off the end");
    assert.deepEqual(readChatPanelMemory(storage, `conv-${newest}`).browser?.dismissed, [
      `bs-${newest}`,
    ]);
  });

  test("touching a thread moves it back to the front", () => {
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-old", { browser: { dismissed: [], collapsed: false } });
    for (let i = 0; i < CHAT_PANEL_MEMORY_LIMIT - 1; i++) {
      writeChatPanelMemory(storage, `conv-${i}`, { browser: { dismissed: [], collapsed: false } });
    }
    // One more thread would evict it — unless it is touched first.
    writeChatPanelMemory(storage, "conv-old", {
      browser: { dismissed: ["bs-1"], collapsed: true },
    });
    writeChatPanelMemory(storage, "conv-new", { browser: { dismissed: [], collapsed: false } });
    assert.equal(readChatPanelMemory(storage, "conv-old").browser?.collapsed, true);
  });

  test("a thread's session ids stop growing", () => {
    const storage = fakeStorage();
    const many = Array.from({ length: CHAT_PANEL_MEMORY_ID_LIMIT + 25 }, (_, i) => `session-${i}`);
    writeChatPanelMemory(storage, "conv-1", {
      work: { open: null, collapsed: false, offered: many },
    });
    const offered = readChatPanelMemory(storage, "conv-1").work?.offered ?? [];
    assert.equal(offered.length, CHAT_PANEL_MEMORY_ID_LIMIT);
    assert.equal(offered.at(-1), many.at(-1), "the newest ids are the ones worth keeping");
  });
});

describe("a store we cannot trust", () => {
  test("unparseable content reads as nothing at all", () => {
    const storage: ChatPanelMemoryStorage = {
      getItem: () => "{not json",
      setItem: () => {},
    };
    assert.deepEqual(readChatPanelMemory(storage, "conv-1"), {});
  });

  test("something that is not a list reads as nothing at all", () => {
    assert.deepEqual(readChatPanelMemory(fakeStorage({ "conv-1": {} }), "conv-1"), {});
  });

  test("entries without a usable id are skipped", () => {
    const storage = fakeStorage([
      { work: { open: A, collapsed: false, offered: [] } },
      { id: "", browser: { dismissed: ["bs-1"], collapsed: false } },
      { id: "conv-1", browser: { dismissed: ["bs-2"], collapsed: false } },
    ]);
    assert.deepEqual(readChatPanelMemory(storage, "conv-1").browser?.dismissed, ["bs-2"]);
  });

  test("a half-written session is read as no session, not as a broken one", () => {
    const storage = fakeStorage([
      {
        id: "conv-1",
        work: { open: { repositorySlug: "oneuptime" }, collapsed: true, offered: ["session-a", 7] },
      },
    ]);
    const work = readChatPanelMemory(storage, "conv-1").work;
    assert.equal(work?.open, null, "a target missing its session id opens nothing");
    assert.deepEqual(work?.offered, ["session-a"], "and the ids that are ids still count");
  });

  test("wrong types where a flag belongs are not truthy by accident", () => {
    const storage = fakeStorage([
      { id: "conv-1", browser: { dismissed: "bs-1", collapsed: "yes" } },
    ]);
    assert.deepEqual(readChatPanelMemory(storage, "conv-1").browser, {
      dismissed: [],
      collapsed: false,
    });
  });

  test("a store that throws on read does not take chat down with it", () => {
    const storage: ChatPanelMemoryStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    assert.deepEqual(readChatPanelMemory(storage, "conv-1"), {});
  });

  test("a store that throws on write does not take chat down with it", () => {
    const storage: ChatPanelMemoryStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    assert.doesNotThrow(() =>
      writeChatPanelMemory(storage, "conv-1", { work: { open: A, collapsed: false, offered: [] } }),
    );
  });

  test("no store at all is simply no memory", () => {
    assert.deepEqual(readChatPanelMemory(null, "conv-1"), {});
    assert.doesNotThrow(() =>
      writeChatPanelMemory(null, "conv-1", { work: { open: A, collapsed: false, offered: [] } }),
    );
  });

  test("outside a browser there is no store to reach for", () => {
    assert.equal(typeof globalThis.window, "undefined");
    assert.equal(chatPanelMemoryStorage(), null);
  });
});

describe("a thread we have no id for", () => {
  test("reads as nothing and is never written", () => {
    const storage = fakeStorage();
    assert.deepEqual(readChatPanelMemory(storage, null), {});
    writeChatPanelMemory(storage, null, { work: { open: A, collapsed: false, offered: [] } });
    assert.equal(storage.stored(), null, "chat with no thread selected has nothing to remember");
  });

  test("writing nothing about either panel writes nothing", () => {
    const storage = fakeStorage();
    writeChatPanelMemory(storage, "conv-1", {});
    assert.equal(storage.stored(), null);
  });
});
