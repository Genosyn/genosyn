import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingCustomerChosen1793898299840 } from "./migrations/1793898299840-MeetingCustomerChosen.js";
import { MeetingCustomerChosen1793898345442 } from "./migrations/postgres/1793898345442-MeetingCustomerChosen.js";

/**
 * Every meeting starts out with nobody having chosen its customer, so the
 * automatic link applies to it. Both streams only add the column, and neither
 * touches a meeting's customer on the way past.
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

test("Postgres only adds the column, false for every meeting", async () => {
  const queries = await queriesOf(new MeetingCustomerChosen1793898345442());
  assert.deepEqual(queries, [
    `ALTER TABLE "meetings" ADD "customerChosen" boolean NOT NULL DEFAULT false`,
  ]);
});

test("SQLite adds the same and keeps each meeting's customer", async () => {
  const queries = await queriesOf(new MeetingCustomerChosen1793898299840());
  const created = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_meetings"`))!;
  assert.match(created, /"customerChosen" boolean NOT NULL DEFAULT \(0\)/);
  const copied = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_meetings"`))!;
  assert.match(copied, /"customerId"/);
  assert.doesNotMatch(copied, /"customerChosen"/);
});
