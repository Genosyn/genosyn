import assert from "node:assert/strict";
import { test } from "node:test";

import { TodoLimits1793897067693 } from "./migrations/1793897067693-TodoLimits.js";
import { TodoLimits1793897070383 } from "./migrations/postgres/1793897070383-TodoLimits.js";

/**
 * Nothing already there gets past a Todo's limits by this: no row starts out lent, and
 * no comment starts out marked as a limited turn's.
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

test("Postgres adds two columns that start false", async () => {
  const queries = await queriesOf(new TodoLimits1793897070383());
  assert.ok(queries.includes(`ALTER TABLE "todo_pickups" ADD "overLimits" boolean NOT NULL DEFAULT false`));
  assert.ok(
    queries.includes(`ALTER TABLE "todo_comments" ADD "fromLimitedTurn" boolean NOT NULL DEFAULT false`),
  );
  assert.equal(queries.length, 2);
});

test("SQLite carries every row across with them false", async () => {
  const queries = await queriesOf(new TodoLimits1793897067693());
  const created = queries.filter((sql) => sql.startsWith(`CREATE TABLE "temporary_`));
  assert.ok(created.some((sql) => /"overLimits" boolean NOT NULL DEFAULT \(0\)/.test(sql)));
  assert.ok(created.some((sql) => /"fromLimitedTurn" boolean NOT NULL DEFAULT \(0\)/.test(sql)));
  for (const copied of queries.filter((sql) => sql.startsWith(`INSERT INTO "temporary_`))) {
    assert.doesNotMatch(copied, /"overLimits"|"fromLimitedTurn"/);
  }
});
