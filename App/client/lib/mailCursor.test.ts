import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  mailListKey,
  rememberReturnCursor,
  returnCursorIndex,
  takeReturnCursor,
} from "./mailCursor.js";

/**
 * Archiving, trashing or marking a thread unread now returns to the list it
 * was opened from. The keyboard cursor comes back with it — to the same
 * thread, or to the row that took its place — instead of the top of the list.
 */

const inbox = mailListKey({ accountId: "mailbox", view: "inbox", label: "", q: "" });
const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("mailListKey", () => {
  test("tells lists apart by mailbox, folder, label and search", () => {
    const keys = new Set([
      inbox,
      mailListKey({ accountId: "other", view: "inbox", label: "", q: "" }),
      mailListKey({ accountId: "mailbox", view: "starred", label: "", q: "" }),
      mailListKey({ accountId: "mailbox", view: "inbox", label: "Label_1", q: "" }),
      mailListKey({ accountId: "mailbox", view: "inbox", label: "", q: "acme" }),
    ]);
    assert.equal(keys.size, 5);
  });

  test("never confuses parts that run together", () => {
    assert.notEqual(
      mailListKey({ accountId: "a", view: "b|c", label: "", q: "" }),
      mailListKey({ accountId: "a|b", view: "c", label: "", q: "" }),
    );
  });
});

describe("the remembered cursor", () => {
  test("is handed back once, to the same list", () => {
    rememberReturnCursor({ key: inbox, threadId: "t3", index: 2 });
    assert.deepEqual(takeReturnCursor(inbox), { key: inbox, threadId: "t3", index: 2 });
    assert.equal(takeReturnCursor(inbox), null, "a later reload starts fresh");
  });

  test("another list never inherits it, and asking clears it", () => {
    rememberReturnCursor({ key: inbox, threadId: "t3", index: 2 });
    const starred = mailListKey({ accountId: "mailbox", view: "starred", label: "", q: "" });
    assert.equal(takeReturnCursor(starred), null);
    assert.equal(takeReturnCursor(inbox), null);
  });
});

describe("returnCursorIndex", () => {
  const back = { key: inbox, threadId: "t3", index: 2 };

  test("the same thread, wherever it now sits", () => {
    assert.equal(returnCursorIndex(back, rows("t1", "t2", "t3", "t4")), 2);
    assert.equal(returnCursorIndex(back, rows("new", "t1", "t2", "t3")), 3);
  });

  test("archived or trashed: the row that took its place", () => {
    assert.equal(returnCursorIndex(back, rows("t1", "t2", "t4", "t5")), 2);
  });

  test("it was the last row: the new last row", () => {
    assert.equal(returnCursorIndex({ ...back, index: 3 }, rows("t1", "t2", "t4")), 2);
  });

  test("nothing left: the top", () => {
    assert.equal(returnCursorIndex(back, []), 0);
  });
});
