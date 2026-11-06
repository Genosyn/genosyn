import assert from "node:assert/strict";
import { test } from "node:test";

import { InputRequests1793961681985 } from "./migrations/1793961681985-InputRequests.js";
import { InputRequests1793961695491 } from "./migrations/postgres/1793961695491-InputRequests.js";
import { RunTaint1793966555903 } from "./migrations/1793966555903-RunTaint.js";
import { RunTaint1793966558152 } from "./migrations/postgres/1793966558152-RunTaint.js";

/**
 * Nothing already there starts waiting on a person. Every Run an install has must come
 * through with nothing holding it, or the queue would pass over it forever.
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

test("Postgres only adds, and no Run starts held", async () => {
  const queries = await queriesOf(new InputRequests1793961695491());
  assert.ok(queries.some((sql) => /^CREATE TABLE "input_requests"/.test(sql)));
  assert.ok(
    queries.some((sql) =>
      /ALTER TABLE "runs" ADD "waitingOnInputRequestId" character varying$/.test(sql),
    ),
    "nullable, with no default",
  );
  assert.ok(
    queries.some((sql) =>
      /ALTER TABLE "runs" ADD "personPauses" integer NOT NULL DEFAULT '0'/.test(sql),
    ),
  );
  assert.ok(!queries.some((sql) => /^(DROP|DELETE|UPDATE)/.test(sql)));
});

test("SQLite keeps every Run it rebuilds, and none starts held", async () => {
  const queries = await queriesOf(new InputRequests1793961681985());
  const table = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_runs"`))!;
  assert.match(table, /"waitingOnInputRequestId" varchar[,)]/);
  assert.match(table, /"personPauses" integer NOT NULL DEFAULT \(0\)/);
  const copy = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_runs"`))!;
  // The copy lists what it carries over, and leaves the new columns to their defaults.
  assert.ok(!copy.includes("waitingOnInputRequestId"));
  assert.ok(!copy.includes("personPauses"));
  for (const kept of ["logContent", "checkpointJson", "pauseCount", "outagePauses", "retryAt"]) {
    assert.ok(copy.includes(`"${kept}"`), kept);
  }
});

test("no Run starts tainted, and SQLite's rebuild keeps what holds a Run", async () => {
  const postgres = await queriesOf(new RunTaint1793966558152());
  assert.deepEqual(postgres, [`ALTER TABLE "runs" ADD "tainted" boolean NOT NULL DEFAULT false`]);
  const sqlite = await queriesOf(new RunTaint1793966555903());
  const table = sqlite.find((sql) => sql.startsWith(`CREATE TABLE "temporary_runs"`))!;
  assert.match(table, /"tainted" boolean NOT NULL DEFAULT \(0\)/);
  const copy = sqlite.find((sql) => sql.startsWith(`INSERT INTO "temporary_runs"`))!;
  assert.ok(!copy.includes(`"tainted"`));
  for (const kept of ["logContent", "personPauses", "waitingOnInputRequestId"]) {
    assert.ok(copy.includes(`"${kept}"`), kept);
  }
});

test("a code's column is never given a default or an index", async () => {
  for (const migration of [new InputRequests1793961681985(), new InputRequests1793961695491()]) {
    const queries = await queriesOf(migration);
    const table = queries.find((sql) => sql.startsWith(`CREATE TABLE "input_requests"`))!;
    assert.match(table, /"encryptedAnswer" text[,)]/);
    assert.ok(!queries.some((sql) => /CREATE INDEX.*encryptedAnswer/.test(sql)));
  }
});
