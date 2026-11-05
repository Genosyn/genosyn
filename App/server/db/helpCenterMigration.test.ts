import assert from "node:assert/strict";
import { test } from "node:test";

import { HelpCenter1793898259591 } from "./migrations/1793898259591-HelpCenter.js";
import { HelpCenter1793898281105 } from "./migrations/postgres/1793898281105-HelpCenter.js";

/**
 * A help center starts off for everyone, including every company upgrading with
 * Articles already published. Those Articles were written to be quoted in replies,
 * so nothing in either stream may put them in front of the public.
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

const ORDER_INDEX = /CREATE INDEX "[^"]+" ON "support_articles" \("companyId", "status", "title", "id"\)/;

test("Postgres only adds, and starts off", async () => {
  const queries = await queriesOf(new HelpCenter1793898281105());
  assert.ok(
    queries.some((sql) =>
      /ALTER TABLE "support_settings" ADD "helpCenterEnabled" boolean NOT NULL DEFAULT false/.test(sql),
    ),
  );
  assert.ok(queries.some((sql) => ORDER_INDEX.test(sql)));
  assert.ok(!queries.some((sql) => /^(DROP|DELETE|UPDATE)/.test(sql)));
});

test("SQLite keeps every setting a company has, and starts off", async () => {
  const queries = await queriesOf(new HelpCenter1793898259591());
  const table = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_support_settings"`))!;
  assert.match(table, /"helpCenterEnabled" boolean NOT NULL DEFAULT \(0\)/);
  const copy = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_support_settings"`))!;
  // The copy lists what it carries over, and leaves the new column to its default.
  assert.ok(!copy.includes("helpCenterEnabled"));
  for (const kept of ["aiInstructions", "topicsJson", "slaJson", "nextTicketNumber"]) {
    assert.ok(copy.includes(`"${kept}"`), kept);
  }
  assert.ok(queries.some((sql) => ORDER_INDEX.test(sql)));
});
