import assert from "node:assert/strict";
import { test } from "node:test";

import { TodoBrowserRecordings1793892447405 } from "./migrations/1793892447405-TodoBrowserRecordings.js";
import { TodoBrowserRecordings1793892450083 } from "./migrations/postgres/1793892450083-TodoBrowserRecordings.js";

/**
 * Every browser session already recorded belongs to a Run or a chat, and stays there:
 * these columns start empty, and nothing is moved onto a Todo.
 */

async function queriesOf(migration: { up: (runner: never) => Promise<void> }): Promise<string[]> {
  const queries: string[] = [];
  await migration.up({
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as never);
  return queries;
}

test("Postgres adds two empty columns and finds sessions by Todo", async () => {
  const queries = await queriesOf(new TodoBrowserRecordings1793892450083());
  assert.equal(queries[0], `ALTER TABLE "browser_sessions" ADD "todoId" character varying`);
  assert.equal(queries[1], `ALTER TABLE "browser_sessions" ADD "todoPickupId" character varying`);
  assert.match(queries[2], /^CREATE INDEX "[^"]+" ON "browser_sessions" \("todoId"\)/);
  assert.equal(queries.length, 3);
});

test("SQLite carries every session across with both empty", async () => {
  const queries = await queriesOf(new TodoBrowserRecordings1793892447405());
  const created = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_browser_sessions"`));
  assert.match(created ?? "", /"todoId" varchar\b(?! NOT NULL)/);
  assert.match(created ?? "", /"todoPickupId" varchar\b(?! NOT NULL)/);
  const copied = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_browser_sessions"`));
  assert.ok(copied, "the rows are carried over");
  assert.doesNotMatch(copied ?? "", /"todoId"/);
  assert.doesNotMatch(copied ?? "", /"todoPickupId"/);
  assert.ok(
    queries.some((sql) => /^CREATE INDEX "[^"]+" ON "browser_sessions" \("todoId"\)/.test(sql)),
    "sessions are found by Todo",
  );
});
