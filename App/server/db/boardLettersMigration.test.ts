import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";

import { BoardLetters1792495456153 } from "./migrations/1792495456153-BoardLetters.js";

/**
 * The migration that adds letters to the board: two new tables and nothing
 * else. What matters is that it touches no existing table, and that the two
 * unique indexes the scheduler relies on are really there — one letter per
 * company per month, and one number per company — because a claim that
 * cannot collide is what makes "written exactly once" true.
 */

const migrationTimestamp = 1792495456153;

async function tableNames(source: DataSource): Promise<string[]> {
  const rows: Array<{ name: string }> = await source.query(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
  );
  return rows.map((row) => row.name);
}

async function indexes(source: DataSource, table: string) {
  const runner = source.createQueryRunner();
  try {
    const found = await runner.getTable(table);
    assert.ok(found, `${table} exists`);
    return found.indices
      .map((index) => ({ columns: index.columnNames.join(","), unique: Boolean(index.isUnique) }))
      .sort((a, b) => a.columns.localeCompare(b.columns));
  } finally {
    await runner.release();
  }
}

function letterRow(id: string, companyId: string, month: string, number: number) {
  return {
    id,
    companyId,
    number,
    month,
    periodStart: "2026-09-01 00:00:00",
    periodEnd: "2026-10-01 00:00:00",
    startedAt: "2026-10-01 06:00:00",
  };
}

test("BoardLetters adds its two tables, with the indexes that make a letter unique, and nothing else", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-board-letters-migration-"));
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
  const before = await tableNames(source);
  assert.equal(before.includes("board_letters"), false);
  await source.destroy();

  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [BoardLetters1792495456153],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["BoardLetters1792495456153"],
  );
  assert.deepEqual(
    await tableNames(source),
    [...before, "board_letter_settings", "board_letters"].sort(),
    "only the two new tables appear",
  );
  assert.deepEqual(await indexes(source, "board_letters"), [
    { columns: "companyId,month", unique: true },
    { columns: "companyId,number", unique: true },
    { columns: "status,startedAt", unique: false },
  ]);
  assert.deepEqual(await indexes(source, "board_letter_settings"), [
    { columns: "companyId", unique: true },
    { columns: "enabled,nextLetterAt", unique: false },
  ]);

  // The defaults a claimed letter starts from.
  const insert = (row: Record<string, unknown>) =>
    source!
      .createQueryBuilder()
      .insert()
      .into("board_letters", Object.keys(row))
      .values(row)
      .execute();
  await insert(letterRow("l-1", "co-1", "2026-09", 1));
  const [stored] = await source.query(`SELECT * FROM "board_letters" WHERE "id" = 'l-1'`);
  assert.equal(stored.status, "writing");
  assert.equal(stored.auditStatus, "pending");
  assert.equal(stored.attempts, 0);
  assert.equal(stored.untracedCount, 0);
  assert.equal(stored.auditFindingsJson, "[]");
  assert.equal(stored.deliveredAt, null);

  // One letter per company per month, one number per company; another
  // company may use both.
  await assert.rejects(insert(letterRow("l-2", "co-1", "2026-09", 2)), /UNIQUE/);
  await assert.rejects(insert(letterRow("l-3", "co-1", "2026-10", 1)), /UNIQUE/);
  await insert(letterRow("l-4", "co-2", "2026-09", 1));
  await source.query(
    `INSERT INTO "board_letter_settings" ("id", "companyId") VALUES ('s-1', 'co-1')`,
  );
  await assert.rejects(
    source.query(`INSERT INTO "board_letter_settings" ("id", "companyId") VALUES ('s-2', 'co-1')`),
    /UNIQUE/,
  );
  const [settings] = await source.query(`SELECT * FROM "board_letter_settings" WHERE "id" = 's-1'`);
  assert.equal(settings.enabled, 0, "letters start switched off");

  await source.undoLastMigration();
  assert.deepEqual(await tableNames(source), before);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream creates the same tables and indexes, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-BoardLetters.ts"));
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /CREATE TABLE "board_letters" \(/);
  assert.match(up, /CREATE TABLE "board_letter_settings" \(/);
  assert.match(up, /"periodStart" TIMESTAMP WITH TIME ZONE NOT NULL/);
  assert.match(up, /CREATE UNIQUE INDEX "IDX_\w+" ON "board_letters" \("companyId", "month"\)/);
  assert.match(up, /CREATE UNIQUE INDEX "IDX_\w+" ON "board_letters" \("companyId", "number"\)/);
  assert.match(up, /CREATE INDEX "IDX_\w+" ON "board_letters" \("status", "startedAt"\)/);
  assert.match(up, /CREATE UNIQUE INDEX "IDX_\w+" ON "board_letter_settings" \("companyId"\)/);
  assert.match(
    up,
    /CREATE INDEX "IDX_\w+" ON "board_letter_settings" \("enabled", "nextLetterAt"\)/,
  );
  assert.doesNotMatch(up, /ALTER TABLE|DROP/);
  assert.deepEqual(
    [...down.matchAll(/DROP TABLE "(\w+)"/g)].map((match) => match[1]),
    ["board_letter_settings", "board_letters"],
  );
  assert.equal([...down.matchAll(/DROP INDEX/g)].length, 5);
});
