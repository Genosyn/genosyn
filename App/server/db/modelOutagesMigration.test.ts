import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { ModelOutages1793380112970 } from "./migrations/1793380112970-ModelOutages.js";

/**
 * The SQLite migration that records AI Model outages and why a Run paused,
 * run against a database that already holds Run history.
 *
 * SQLite cannot add the columns in place, so the generated migration rebuilds
 * `runs` — the busiest table in the app. Every Run, transcript and pause must
 * come through byte for byte with its indexes; a Run paused before the reason
 * was kept reads as never paused for an outage; and at most one outage per
 * model may be open at a time.
 */

type StoredRun = Record<string, string | number | null>;
const migrationTimestamp = 1793380112970;
const NEW_COLUMNS = ["pauseReason", "outagePauses"];

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

async function table(source: DataSource, name: string): Promise<Table | undefined> {
  const queryRunner = source.createQueryRunner();
  try {
    return await queryRunner.getTable(name);
  } finally {
    await queryRunner.release();
  }
}

const readRuns = (source: DataSource): Promise<StoredRun[]> =>
  source.query('SELECT * FROM "runs" ORDER BY "id"');

const withoutNew = (rows: StoredRun[]): StoredRun[] =>
  rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !NEW_COLUMNS.includes(key))),
  );

test("ModelOutages keeps every Run, its transcript, pause and indexes, and adds one open outage per model", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-model-outages-migration-"));
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
      logContent: '[tool] read_source {"name":"Résumé"}\nReconciled 12 invoices — “done”.\n',
      triggerKind: "schedule",
      tokensIn: 120000,
      tokensOut: 4000,
    },
    {
      id: "r-2-paused-for-restart",
      routineId: "routine-1",
      employeeId: "emp-1",
      status: "queued",
      startedAt: "2026-10-02 02:00:00.000",
      createdAt: "2026-10-02 02:00:00.000",
      logContent: "Working.\n[paused] Genosyn is restarting.\n",
      triggerKind: "schedule",
      pausedAt: "2026-10-02 02:10:00.000",
      pauseCount: 1,
      pauseRemainingMs: 3_000_000,
    },
  ];
  for (const row of history) {
    await source.createQueryBuilder().insert().into("runs", Object.keys(row)).values(row).execute();
  }
  const before = await readRuns(source);
  const beforeSchema = schemaSnapshot((await table(source, "runs"))!);
  assert.equal(await table(source, "ai_model_outages"), undefined);
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [ModelOutages1793380112970],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["ModelOutages1793380112970"],
  );

  const upgraded = await readRuns(source);
  assert.deepEqual(withoutNew(upgraded), before, "every Run survives the rebuild");
  for (const row of upgraded) {
    assert.deepEqual(
      NEW_COLUMNS.map((column) => row[column]),
      [null, 0],
      `${row.id} was never paused for an outage`,
    );
  }
  const after = schemaSnapshot((await table(source, "runs"))!);
  assert.deepEqual(after.indexes, beforeSchema.indexes, "the Run indexes are rebuilt as they were");
  assert.deepEqual(
    after.columns.filter((column) => !NEW_COLUMNS.includes(column.name)),
    beforeSchema.columns,
  );

  // One open outage per model, as many closed ones as history holds.
  const insertOutage = (id: string, endedAt: string | null) =>
    source!.query(
      `INSERT INTO "ai_model_outages" ("id","key","companyId","modelId","startedAt","endedAt","cause","lastError","nextCheckAt") VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        "co:model:m-1",
        "co",
        "m-1",
        "2026-10-30 10:00:00.000",
        endedAt,
        "overloaded",
        "The AI Model is overloaded (HTTP 529).",
        "2026-10-30 10:00:30.000",
      ],
    );
  await insertOutage("o-1", "2026-10-30 10:05:00.000");
  await insertOutage("o-2", "2026-10-30 11:05:00.000");
  await insertOutage("o-3", null);
  await assert.rejects(insertOutage("o-4", null), /UNIQUE/, "a second open outage is refused");

  // Rolling back drops only what it added; every Run is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot((await table(source, "runs"))!), beforeSchema);
  assert.deepEqual(await readRuns(source), before);
  assert.equal(await table(source, "ai_model_outages"), undefined);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same columns in place and the same outage table", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-ModelOutages.ts"));
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /CREATE TABLE "ai_model_outages"/);
  assert.match(up, /CREATE UNIQUE INDEX "[^"]+" ON "ai_model_outages" \("key"\) WHERE "endedAt" IS NULL/);
  assert.match(up, /ALTER TABLE "runs" ADD "pauseReason" character varying(?! NOT NULL)/);
  assert.match(up, /ALTER TABLE "runs" ADD "outagePauses" integer NOT NULL DEFAULT '0'/);
  assert.doesNotMatch(up, /DROP TABLE|CREATE TABLE "runs"/, "Postgres never rebuilds the Runs table");
  assert.equal([...down.matchAll(/DROP COLUMN/g)].length, 2, "down drops the two columns only");
  assert.match(down, /DROP TABLE "ai_model_outages"/);
});
