import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { RunPauses1792403770382 } from "./migrations/1792403770382-RunPauses.js";

/**
 * The SQLite migration that lets a Run pause for a restart, run against a
 * database that already holds Run history.
 *
 * SQLite cannot add the columns in place, so the generated migration rebuilds
 * `runs` — the busiest table in the app. Every Run, transcript and retry
 * stamp included, must come through byte for byte with its indexes, and come
 * out never having been paused.
 */

type StoredRun = Record<string, string | number | null>;
const migrationTimestamp = 1792403770382;
const PAUSE_COLUMNS = ["pausedAt", "pauseCount", "pauseRemainingMs"];

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

async function runTable(source: DataSource): Promise<Table> {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable("runs");
    assert.ok(table, "the migration must retain the Runs table");
    return table;
  } finally {
    await queryRunner.release();
  }
}

const readRuns = (source: DataSource): Promise<StoredRun[]> =>
  source.query('SELECT * FROM "runs" ORDER BY "id"');

const withoutPause = (rows: StoredRun[]): StoredRun[] =>
  rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !PAUSE_COLUMNS.includes(key))),
  );

test("RunPauses keeps every Run, its transcript and its indexes, never paused", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-run-pauses-migration-"));
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

  const history: StoredRun[] = [
    {
      id: "r-1-completed",
      routineId: "routine-1",
      employeeId: "emp-1",
      status: "completed",
      startedAt: "2026-10-01 02:00:00.000",
      finishedAt: "2026-10-01 02:40:00.000",
      createdAt: "2026-10-01 02:00:00.000",
      exitCode: 0,
      logContent: '[tool] read_source {"name":"Résumé"}\nBackfilled 12 leads — “done”.\n',
      triggerKind: "schedule",
      tokensIn: 120000,
      tokensOut: 4000,
      checkpointJson: '{"state":"complete","completed":"All","remaining":"","resume":"","progressKey":"k"}',
    },
    {
      id: "r-2-queued",
      routineId: "routine-1",
      employeeId: "emp-1",
      status: "queued",
      startedAt: "2026-10-02 02:00:00.000",
      createdAt: "2026-10-02 02:00:00.000",
      logContent: "[queue] Waiting for Genosyn to restart for an upgrade.\n",
      triggerKind: "schedule",
    },
    {
      id: "r-3-retry",
      routineId: "routine-2",
      employeeId: "emp-2",
      status: "error",
      errorKind: "interrupted",
      startedAt: "2026-10-03 02:00:00.000",
      finishedAt: "2026-10-03 02:17:00.000",
      createdAt: "2026-10-03 02:00:00.000",
      logContent: "Reading.\n[interrupted] The server stopped while this run was executing.\n",
      triggerKind: "schedule",
      retryAt: "2026-10-03 03:17:00.000",
      continuationDeadlineAt: "2026-10-03 03:00:00.000",
    },
  ];
  for (const row of history) {
    await source.createQueryBuilder().insert().into("runs", Object.keys(row)).values(row).execute();
  }
  const before = await readRuns(source);
  const beforeSchema = schemaSnapshot(await runTable(source));
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RunPauses1792403770382],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RunPauses1792403770382"],
  );

  const upgraded = await readRuns(source);
  assert.deepEqual(withoutPause(upgraded), before, "every Run survives the rebuild");
  for (const row of upgraded) {
    assert.deepEqual(
      PAUSE_COLUMNS.map((column) => row[column]),
      [null, 0, null],
      `${row.id} has never been paused`,
    );
  }
  const after = schemaSnapshot(await runTable(source));
  assert.deepEqual(after.indexes, beforeSchema.indexes, "the Run indexes are rebuilt as they were");
  assert.deepEqual(
    after.columns.filter((column) => !PAUSE_COLUMNS.includes(column.name)),
    beforeSchema.columns,
  );
  assert.deepEqual(
    after.columns.filter((column) => PAUSE_COLUMNS.includes(column.name)),
    [
      { name: "pauseCount", type: "integer", nullable: false, primary: false, default: "0" },
      { name: "pausedAt", type: "datetime", nullable: true, primary: false, default: undefined },
      { name: "pauseRemainingMs", type: "integer", nullable: true, primary: false, default: undefined },
    ],
  );

  // Rolling back drops only the three columns; every Run is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await runTable(source)), beforeSchema);
  assert.deepEqual(await readRuns(source), before);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same three columns in place, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-RunPauses.ts"));
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /ALTER TABLE "runs" ADD "pausedAt" TIMESTAMP WITH TIME ZONE(?! NOT NULL)/);
  assert.match(up, /ALTER TABLE "runs" ADD "pauseCount" integer NOT NULL DEFAULT '0'/);
  assert.match(up, /ALTER TABLE "runs" ADD "pauseRemainingMs" integer(?! NOT NULL)/);
  assert.doesNotMatch(up, /DROP|CREATE TABLE/, "Postgres never rebuilds the Runs table");
  assert.equal([...down.matchAll(/DROP COLUMN/g)].length, 3, "down drops the three columns only");
});
