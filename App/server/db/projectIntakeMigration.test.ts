import assert from "node:assert/strict";
import { test } from "node:test";

import { ProjectIntake1793883722455 } from "./migrations/1793883722455-ProjectIntake.js";
import { ProjectIntake1793883740726 } from "./migrations/postgres/1793883740726-ProjectIntake.js";

/**
 * Email intake starts off for everyone. Both streams only add its table and two
 * columns, and neither turns anything on for a company that hasn't asked.
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

test("Postgres only adds", async () => {
  const queries = await queriesOf(new ProjectIntake1793883740726());
  assert.ok(queries.some((sql) => sql.startsWith(`CREATE TABLE "project_intakes"`)));
  assert.ok(queries.some((sql) => /ALTER TABLE "todo_pickups" ADD "trustedSender" boolean NOT NULL DEFAULT false/.test(sql)));
  assert.ok(queries.some((sql) => /ALTER TABLE "mail_inbound_analyses" ADD "intakeJson" text NOT NULL DEFAULT ''/.test(sql)));
  assert.ok(!queries.some((sql) => /^(DROP TABLE|DELETE|UPDATE)/.test(sql)));
});

test("SQLite adds the same, and new rows start with nothing trusted or filed", async () => {
  const queries = await queriesOf(new ProjectIntake1793883722455());
  const intakes = queries.find((sql) => sql.startsWith(`CREATE TABLE "project_intakes"`))!;
  assert.match(intakes, /"enabled" boolean NOT NULL DEFAULT \(0\)/);
  assert.match(intakes, /"replyMode" varchar NOT NULL DEFAULT \('review'\)/);
  assert.match(intakes, /"trustedSenders" text NOT NULL DEFAULT \(''\)/);
  const pickups = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_todo_pickups"`))!;
  assert.match(pickups, /"trustedSender" boolean NOT NULL DEFAULT \(0\)/);
  const analyses = queries.find((sql) =>
    sql.startsWith(`CREATE TABLE "temporary_mail_inbound_analyses"`),
  )!;
  assert.match(analyses, /"intakeJson" text NOT NULL DEFAULT \(''\)/);
});
