import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { DEFAULT_ROUTINE_PRIORITY } from "../../shared/routinePriority.js";
import { RoutinePriority1792777617027 } from "./migrations/1792777617027-RoutinePriority.js";

/**
 * The SQLite migration that gives every Routine a priority, run against a
 * database that already holds Routines.
 *
 * SQLite cannot add a column with a default to a table TypeORM manages
 * without rebuilding it, so the generated migration rebuilds `routines`. Every
 * Routine must come through with its brief, schedule, webhook and indexes, and
 * every one of them must come out Normal — the default nobody chose.
 */

type StoredRoutine = Record<string, string | number | null>;
const migrationTimestamp = 1792777617027;

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

const withoutPriority = (rows: StoredRoutine[]): StoredRoutine[] =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "priority")));

test("every Routine keeps its row and indexes, and comes out Normal", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-routine-priority-migration-"));
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
    { id: "r-1-daily", cronExpr: "0 9 * * *" },
    {
      id: "r-2-webhook",
      cronExpr: "*/15 * * * *",
      body: "Reply to “every” Nostr thread.\n",
      webhookEnabled: 1,
      webhookToken: "hook-token",
      requiresApproval: 1,
    },
    { id: "r-3-paused", cronExpr: "0 18 * * 1-5", enabled: 0, timeoutSec: 600 },
  ];
  const routines: StoredRoutine[] = seeds.map((row, i) => ({
    employeeId: "emp-1",
    name: `Routine ${i + 1}`,
    slug: `routine-${i + 1}`,
    ...row,
  }));
  for (const row of routines) {
    await source.createQueryBuilder().insert().into("routines", Object.keys(row)).values(row).execute();
  }
  const before = await readRoutines(source);
  const beforeSchema = schemaSnapshot(await routineTable(source));
  assert.ok(!beforeSchema.columns.some((column) => column.name === "priority"));
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RoutinePriority1792777617027],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RoutinePriority1792777617027"],
  );

  const upgraded = await readRoutines(source);
  assert.deepEqual(withoutPriority(upgraded), withoutPriority(before), "every Routine survives");
  assert.deepEqual(
    upgraded.map((row) => row.priority),
    ["normal", "normal", "normal"],
    "no Routine starts out High: someone has to choose that",
  );
  const after = schemaSnapshot(await routineTable(source));
  assert.deepEqual(after.indexes, beforeSchema.indexes, "the Routine indexes are rebuilt");
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "priority"),
    beforeSchema.columns,
  );
  const priority = after.columns.find((column) => column.name === "priority");
  assert.equal(priority?.nullable, false);
  assert.equal(priority?.default, `'${DEFAULT_ROUTINE_PRIORITY}'`);

  // A Routine created afterwards, by anything that does not say, is Normal.
  await source.query(
    `INSERT INTO "routines" ("id", "employeeId", "name", "slug", "cronExpr") VALUES ('r-4-new', 'emp-1', 'New', 'new', '0 9 * * *')`,
  );
  const [created] = await source.query(`SELECT "priority" FROM "routines" WHERE "id" = 'r-4-new'`);
  assert.equal(created.priority, "normal");

  // And the way back keeps every Routine too.
  await source.undoLastMigration();
  const reverted = await readRoutines(source);
  assert.deepEqual(
    reverted.filter((row) => row.id !== "r-4-new"),
    withoutPriority(upgraded),
  );
  assert.deepEqual(schemaSnapshot(await routineTable(source)), beforeSchema);
});

test("the Postgres stream adds the same column in place, Normal by default", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-RoutinePriority.ts"));
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(
    up,
    /ALTER TABLE "routines" ADD "priority" character varying NOT NULL DEFAULT 'normal'/,
  );
  assert.doesNotMatch(up, /DROP|CREATE TABLE|"runs"/, "neither table is rebuilt, and runs is untouched");
  assert.match(down, /ALTER TABLE "routines" DROP COLUMN "priority"/);
});
