import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";

import { AIModelKeySessions1793364422865 } from "./migrations/1793364422865-AIModelKeySessions.js";

/**
 * The migration that lets each API key's health row count the sessions the key
 * carried, run on a database whose keys already have health. SQLite rebuilds
 * the table to add the column, so every existing row — last use, refusal,
 * rest — must come through untouched, and the one-row-per-key rule with it.
 */

const migrationTimestamp = 1793364422865;

test("adds a session count to each key's health, keeping every row, and takes it away again", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-key-sessions-migration-"));
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
  await source.runMigrations();
  await source.query(
    `INSERT INTO "ai_model_key_health" ("id", "modelId", "keyId", "lastUsedAt", "lastErrorAt", "lastErrorStatus", "lastErrorKind", "lastErrorMessage", "coolDownUntil") VALUES ('h-1', 'model-1', 'primary', '2026-10-29 10:00:00.000', '2026-10-29 11:00:00.000', 429, 'rate_limit', 'Slow down.', '2026-10-29 11:01:00.000')`,
  );
  await source.query(
    `INSERT INTO "ai_model_key_health" ("id", "modelId", "keyId", "lastUsedAt") VALUES ('h-2', 'model-1', 'b1', '2026-10-29 12:00:00.000')`,
  );
  const before = await source.query(`SELECT * FROM "ai_model_key_health" ORDER BY "id"`);
  await source.destroy();

  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [AIModelKeySessions1793364422865],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["AIModelKeySessions1793364422865"],
  );

  const runner = source.createQueryRunner();
  try {
    const table = await runner.getTable("ai_model_key_health");
    assert.ok(table, "the table is still there");
    const column = table.findColumnByName("sessionsByHour");
    assert.ok(column, "the session count column exists");
    assert.equal(column.isNullable, true, "a key with no session yet has none");
    const unique = table.indices.find((index) => index.isUnique);
    assert.deepEqual(unique?.columnNames, ["modelId", "keyId"]);
  } finally {
    await runner.release();
  }

  // Every row came through, field for field, with no sessions counted yet.
  const after = await source.query(`SELECT * FROM "ai_model_key_health" ORDER BY "id"`);
  assert.deepEqual(
    after.map((row: Record<string, unknown>) => {
      const { sessionsByHour, ...rest } = row;
      assert.equal(sessionsByHour, null);
      return rest;
    }),
    before,
  );
  await source.query(
    `UPDATE "ai_model_key_health" SET "sessionsByHour" = '[[492011,3]]' WHERE "id" = 'h-2'`,
  );
  // Still one row per key.
  await assert.rejects(
    source.query(
      `INSERT INTO "ai_model_key_health" ("id", "modelId", "keyId") VALUES ('h-3', 'model-1', 'b1')`,
    ),
    /UNIQUE/,
  );

  await source.undoLastMigration();
  const undone = source.createQueryRunner();
  try {
    const table = await undone.getTable("ai_model_key_health");
    assert.ok(table);
    assert.equal(table.findColumnByName("sessionsByHour"), undefined);
  } finally {
    await undone.release();
  }
  assert.deepEqual(await source.query(`SELECT * FROM "ai_model_key_health" ORDER BY "id"`), before);
});

test("the Postgres stream adds the same nullable column, and nothing else", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-AIModelKeySessions.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /ALTER TABLE "ai_model_key_health" ADD "sessionsByHour" text`/);
  assert.doesNotMatch(up, /NOT NULL|DROP|ai_models"/);
  assert.match(down, /ALTER TABLE "ai_model_key_health" DROP COLUMN "sessionsByHour"/);
});
