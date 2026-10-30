import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";

import { ModelWaits1793398880775 } from "./migrations/1793398880775-ModelWaits.js";

/**
 * The migration that adds `ai_model_waits` — AI work with no queue of its own
 * waiting for an unavailable AI Model. It only creates a table: nothing an
 * install already holds is rebuilt, a piece of work waits once (the unique
 * `(kind, targetId)`), and rolling back leaves the database as it was.
 */

const migrationTimestamp = 1793398880775;

test("ModelWaits adds the wait table alone, one row per piece of work, and rolls back cleanly", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-model-waits-migration-"));
  const database = path.join(testDir, "migration.sqlite");
  let source: DataSource | null = null;
  t.after(async () => {
    if (source?.isInitialized) await source.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  const migrationDir = fileURLToPath(new URL("./migrations/", import.meta.url));
  const priorMigrations = (await readdir(migrationDir))
    .filter(
      (name) => /^\d+-.*\.(?:ts|js)$/.test(name) && Number(name.split("-")[0]) < migrationTimestamp,
    )
    .map((name) => path.join(migrationDir, name));
  assert.ok(priorMigrations.length > 0);
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: priorMigrations,
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.equal((await source.runMigrations()).length, priorMigrations.length);
  const tablesBefore: Array<{ name: string; sql: string }> = await source.query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'migrations' ORDER BY name`,
  );
  await source.destroy();

  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [ModelWaits1793398880775],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["ModelWaits1793398880775"],
  );
  const tablesAfter: Array<{ name: string; sql: string }> = await source.query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'migrations' ORDER BY name`,
  );
  assert.deepEqual(
    tablesAfter.filter((table) => table.name !== "ai_model_waits"),
    tablesBefore,
    "no existing table is rebuilt or changed",
  );

  const insertWait = (id: string, kind: string, targetId: string) =>
    source!.query(
      `INSERT INTO "ai_model_waits" ("id","companyId","kind","targetId","employeeId","resumeAt") VALUES (?,?,?,?,?,?)`,
      [id, "co", kind, targetId, "emp-1", "2026-10-30 10:00:30.000"],
    );
  await insertWait("w-1", "pipeline_run", "run-1");
  await insertWait("w-2", "mail_arrival_read", "run-1");
  await assert.rejects(
    insertWait("w-3", "pipeline_run", "run-1"),
    /UNIQUE/,
    "a piece of work waits once",
  );
  const [row] = await source.query(`SELECT * FROM "ai_model_waits" WHERE "id" = 'w-1'`);
  assert.equal(row.status, "waiting");
  assert.equal(row.attempts, 0);
  assert.equal(row.payloadJson, "{}");

  await source.undoLastMigration();
  const rolledBack: Array<{ name: string; sql: string }> = await source.query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'migrations' ORDER BY name`,
  );
  assert.deepEqual(rolledBack, tablesBefore);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream creates the same table and indexes, and touches nothing else", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-ModelWaits.ts"));
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /CREATE TABLE "ai_model_waits"/);
  assert.match(up, /CREATE UNIQUE INDEX "[^"]+" ON "ai_model_waits" \("kind", "targetId"\)/);
  assert.match(up, /CREATE INDEX "[^"]+" ON "ai_model_waits" \("status", "resumeAt"\)/);
  assert.match(up, /CREATE INDEX "[^"]+" ON "ai_model_waits" \("companyId", "modelId"\)/);
  assert.match(up, /CREATE INDEX "[^"]+" ON "ai_model_waits" \("kind", "groupKey"\)/);
  assert.doesNotMatch(up, /ALTER TABLE|DROP TABLE/, "nothing an install holds is altered");
  assert.match(down, /DROP TABLE "ai_model_waits"/);
});
