import assert from "node:assert/strict";
import { test } from "node:test";

import { TodoCeiling1793890916694 } from "./migrations/1793890916694-TodoCeiling.js";
import { TodoCeiling1793890925972 } from "./migrations/postgres/1793890925972-TodoCeiling.js";

/**
 * A Todo's limits start empty for everything already on the board: nothing here can
 * change what an existing Todo may do until a restricted session touches it.
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

test("Postgres adds one empty column", async () => {
  assert.deepEqual(await queriesOf(new TodoCeiling1793890925972()), [
    `ALTER TABLE "todos" ADD "ceilingJson" text`,
  ]);
});

test("SQLite carries every row across with it empty", async () => {
  const queries = await queriesOf(new TodoCeiling1793890916694());
  const created = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_todos"`));
  assert.match(created ?? "", /"ceilingJson" text\b(?! NOT NULL)/);
  const copied = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_todos"`));
  assert.ok(copied, "the rows are carried over");
  assert.doesNotMatch(copied ?? "", /^[^)]*"ceilingJson"[^)]*\) SELECT/);
});
