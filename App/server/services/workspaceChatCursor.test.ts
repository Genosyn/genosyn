import assert from "node:assert/strict";
import test from "node:test";
import { formatMessageBeforeCursor } from "./workspaceChat.js";

test("formats workspace message cursors for SQLite datetime comparison", () => {
  assert.equal(
    formatMessageBeforeCursor(
      "2026-07-26T18:00:56.000Z",
      "better-sqlite3",
    ),
    "2026-07-26 18:00:56.000",
  );
});

test("binds workspace message cursors as dates for Postgres", () => {
  const cursor = formatMessageBeforeCursor(
    "2026-07-26T18:00:56.000Z",
    "postgres",
  );
  assert.ok(cursor instanceof Date);
  assert.equal(cursor.toISOString(), "2026-07-26T18:00:56.000Z");
});

test("rejects invalid workspace message cursors", () => {
  assert.throws(
    () => formatMessageBeforeCursor("not-a-date", "better-sqlite3"),
    /Invalid message cursor/,
  );
});
