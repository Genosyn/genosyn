import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { DEFAULT_ROUTINE_TIMEOUT_SEC } from "./entities/Routine.js";
import { RoutineTimeoutBackfill6h1792751466958 } from "./migrations/1792751466958-RoutineTimeoutBackfill6h.js";
import { RoutineTimeoutDefault6h1792751434134 } from "./migrations/1792751434134-RoutineTimeoutDefault6h.js";

/**
 * The SQLite migrations that give every Routine a 6 hour timeout, run against
 * a database that already holds Routines.
 *
 * SQLite cannot change a column default in place, so the generated migration
 * rebuilds `routines`. Every Routine must come through with its brief, webhook
 * and indexes, and every timeout below 6 hours must come out at 6 hours.
 */

type StoredRoutine = Record<string, string | number | null>;
const migrationTimestamp = 1792751434134;

function schemaSnapshot(table: Table) {
  return {
    columns: table.columns
      .map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.isNullable,
        primary: column.isPrimary,
        default: column.default,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    indexes: table.indices
      .map((index) => ({ name: index.name, columns: index.columnNames, unique: index.isUnique }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  };
}

async function routineTable(source: DataSource): Promise<Table> {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable("routines");
    assert.ok(table, "the migration must retain the Routines table");
    return table;
  } finally {
    await queryRunner.release();
  }
}

const readRoutines = (source: DataSource): Promise<StoredRoutine[]> =>
  source.query('SELECT * FROM "routines" ORDER BY "id"');

const withoutTimeout = (rows: StoredRoutine[]): StoredRoutine[] =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "timeoutSec")));

test("every Routine keeps its row and indexes, and none is left under 6 hours", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-routine-timeout-migration-"));
  const database = path.join(testDir, "migration.sqlite");
  let source: DataSource | null = null;
  t.after(async () => {
    if (source?.isInitialized) await source.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  // The real previous schema, built by the migration chain itself.
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

  const seeds: StoredRoutine[] = [
    { id: "r-1-fast", timeoutSec: 10 },
    { id: "r-2-old-default", timeoutSec: 3600 },
    {
      id: "r-3-two-hours",
      timeoutSec: 7200,
      body: "Review the inbox — “every” thread.\n",
      webhookEnabled: 1,
      webhookToken: "hook-token",
    },
    { id: "r-4-ceiling", timeoutSec: 21600 },
  ];
  const routines: StoredRoutine[] = seeds.map((row, i) => ({
    employeeId: "emp-1",
    name: `Routine ${i + 1}`,
    slug: `routine-${i + 1}`,
    cronExpr: "0 9 * * *",
    ...row,
  }));
  for (const row of routines) {
    await source.createQueryBuilder().insert().into("routines", Object.keys(row)).values(row).execute();
  }
  const before = await readRoutines(source);
  const beforeSchema = schemaSnapshot(await routineTable(source));
  await source.destroy();

  // Re-open at these migrations alone, so nothing later can mask what they do.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RoutineTimeoutDefault6h1792751434134, RoutineTimeoutBackfill6h1792751466958],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RoutineTimeoutDefault6h1792751434134", "RoutineTimeoutBackfill6h1792751466958"],
  );

  const upgraded = await readRoutines(source);
  assert.deepEqual(withoutTimeout(upgraded), withoutTimeout(before), "every Routine survives");
  assert.deepEqual(
    upgraded.map((row) => row.timeoutSec),
    [21600, 21600, 21600, 21600],
    "no Routine is left under 6 hours",
  );
  const after = schemaSnapshot(await routineTable(source));
  assert.deepEqual(after.indexes, beforeSchema.indexes, "the Routine indexes are rebuilt");
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "timeoutSec"),
    beforeSchema.columns.filter((column) => column.name !== "timeoutSec"),
  );
  assert.equal(
    after.columns.find((column) => column.name === "timeoutSec")?.default,
    String(DEFAULT_ROUTINE_TIMEOUT_SEC),
  );

  // A Routine created afterwards starts at the new default.
  await source.query(
    `INSERT INTO "routines" ("id", "employeeId", "name", "slug", "cronExpr") VALUES ('r-5-new', 'emp-1', 'New', 'new', '0 9 * * *')`,
  );
  const [created] = await source.query(`SELECT "timeoutSec" FROM "routines" WHERE "id" = 'r-5-new'`);
  assert.equal(created.timeoutSec, DEFAULT_ROUTINE_TIMEOUT_SEC);
});

test("the Postgres stream sets the same default in place and lifts the same Routines", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const files = await readdir(migrationDir);
  const [schemaFile] = files.filter((name) => name.endsWith("-RoutineTimeoutDefault6h.ts"));
  const [backfillFile] = files.filter((name) => name.endsWith("-RoutineTimeoutBackfill6h.ts"));
  assert.ok(schemaFile, "a generated Postgres migration ships with the SQLite one");
  assert.ok(backfillFile, "the Postgres stream backfills existing Routines too");
  assert.ok(schemaFile < backfillFile, "the default changes before the backfill runs");

  const schema = await readFile(path.join(migrationDir, schemaFile), "utf8");
  const up = schema.slice(schema.indexOf("async up("), schema.indexOf("async down("));
  assert.match(up, /ALTER TABLE "routines" ALTER COLUMN "timeoutSec" SET DEFAULT '21600'/);
  assert.doesNotMatch(up, /DROP|CREATE TABLE/, "Postgres never rebuilds the Routines table");

  const backfill = await readFile(path.join(migrationDir, backfillFile), "utf8");
  assert.match(
    backfill,
    /UPDATE "routines" SET "timeoutSec" = 21600 WHERE "timeoutSec" < 21600/,
  );
});
