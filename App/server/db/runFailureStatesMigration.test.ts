import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { RunFailureStates1789639730612 } from "./migrations/1789639730612-RunFailureStates.js";

type StoredRun = Record<string, string | number | null>;
const migrationTimestamp = 1789639730612;

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
      .map((index) => ({
        name: index.name,
        columns: index.columnNames,
        unique: index.isUnique,
      }))
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

async function readRuns(source: DataSource): Promise<StoredRun[]> {
  return source.query('SELECT * FROM "runs" ORDER BY "id"');
}

function historicalColumns(rows: StoredRun[]): StoredRun[] {
  return rows.map(
    ({ errorKind: _errorKind, failureReason: _failureReason, ...historical }) => historical,
  );
}

test("RunFailureStates preserves SQLite Run history, retry metadata and indexes through upgrade and rollback", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-run-failure-migration-"));
  const database = path.join(testDir, "migration.sqlite");
  let source: DataSource | null = null;
  t.after(async () => {
    if (source?.isInitialized) await source.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  // Build the actual previous schema, rather than inventing one with the new
  // entity or the migration's own down(). Historical filesystem migrations see
  // an empty database; fixtures are inserted only after that chain finishes.
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
  const applied = await source.runMigrations();
  assert.equal(applied.length, priorMigrations.length);

  const statuses = [
    "completed",
    "reviewed",
    "failed",
    "timeout",
    "interrupted",
    "running",
    "skipped",
  ] as const;
  const verdicts = ["achieved", "unverified", "off_goal", "unclear", null, null, null];
  const history: StoredRun[] = statuses.map((status, index) => ({
    id: `historical-${index}`,
    routineId: `routine-${index % 2}`,
    status,
    startedAt: "2026-09-10 09:00:00.000",
    finishedAt: status === "running" ? null : "2026-09-10 09:04:00.000",
    createdAt: "2026-09-10 09:00:00.000",
    exitCode: status === "completed" || status === "reviewed" ? 0 : null,
    logContent: `[tool] read_source {"name":"Résumé"}\nResult ${index}: <details> & evidence\n`,
    dismissedAt: status === "failed" ? "2026-09-10 09:05:00.000" : null,
    triggerKind: index === 4 ? "retry" : "schedule",
    attempt: index === 4 ? 2 : 1,
    parentRunId: index === 4 ? "historical-3" : null,
    retryAt: index === 4 ? "2026-09-10 10:04:00.000" : null,
    missedSlots: index,
    outcomeVerdict: verdicts[index],
    outcomeNote: verdicts[index] ? `Recorded assessment ${index}: preserve this evidence.` : null,
    outcomeCheckedAt: verdicts[index] ? "2026-09-10 09:04:30.000" : null,
    checksVerdict: index === 0 ? "passed" : index === 2 ? "failed" : null,
    checkRemediations: index === 2 ? 2 : 0,
    tokensIn: 1000 + index,
    tokensOut: 100 + index,
  }));
  await source
    .createQueryBuilder()
    .insert()
    .into("runs", Object.keys(history[0]))
    .values(history)
    .execute();
  const beforeRows = await readRuns(source);
  assert.deepEqual(beforeRows, history);
  const beforeSchema = schemaSnapshot(await runTable(source));
  assert.deepEqual(beforeSchema.indexes.map((index) => index.columns.join(",")).sort(), [
    "retryAt",
    "routineId,startedAt",
    "status,startedAt",
  ]);
  await source.destroy();

  // Re-open at this migration's historical schema, independent of columns
  // added to today's Run entity. Only the generated migration changes it.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RunFailureStates1789639730612],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RunFailureStates1789639730612"],
  );
  const upgradedRows = await readRuns(source);
  assert.deepEqual(historicalColumns(upgradedRows), beforeRows);
  for (const row of upgradedRows) {
    assert.equal(row.errorKind, null);
    assert.equal(row.failureReason, null);
  }
  const afterSchema = schemaSnapshot(await runTable(source));
  assert.deepEqual(afterSchema.indexes, beforeSchema.indexes);
  assert.deepEqual(
    afterSchema.columns.filter((column) => !["errorKind", "failureReason"].includes(column.name)),
    beforeSchema.columns,
  );
  for (const name of ["errorKind", "failureReason"]) {
    assert.equal(afterSchema.columns.find((column) => column.name === name)?.nullable, true);
  }

  // Write only columns belonging to this version. A modern entity would
  // silently add later columns to INSERT/SELECT and invalidate this fixture.
  const failed = {
    ...history[5],
    id: "new-failed",
    routineId: "routine-0",
    startedAt: "2026-09-17 10:00:00.000",
    finishedAt: "2026-09-17 10:02:00.000",
    status: "failed",
    errorKind: null,
    failureReason: "The source report is missing; the intended digest remains unfinished.",
    logContent: "[failed] Missing source report.\n",
  };
  const error = {
    ...failed,
    id: "new-error",
    routineId: "routine-1",
    finishedAt: "2026-09-17 10:03:00.000",
    status: "error",
    errorKind: "timeout",
    failureReason: "A reported incomplete result survives a later timeout.",
    logContent: "[timeout] The AI Model request timed out.\n",
  };
  await source
    .createQueryBuilder()
    .insert()
    .into("runs", Object.keys(failed))
    .values([failed, error])
    .execute();
  const savedRows = await readRuns(source);
  assert.deepEqual(
    savedRows.find((row) => row.id === failed.id),
    failed,
  );
  const savedError = savedRows.find((row) => row.id === error.id);
  assert.ok(savedError);
  assert.deepEqual(savedError, error);
  assert.equal(savedError.status, "error");
  assert.equal(savedError.errorKind, "timeout");
  assert.equal(savedError.failureReason, error.failureReason);
  const rowsBeforeRollback = historicalColumns(await readRuns(source));

  await source.undoLastMigration();
  assert.deepEqual(await readRuns(source), rowsBeforeRollback);
  assert.deepEqual(schemaSnapshot(await runTable(source)), beforeSchema);
  assert.equal(await source.showMigrations(), true);

  await source.runMigrations();
  assert.deepEqual(historicalColumns(await readRuns(source)), rowsBeforeRollback);
  assert.deepEqual(schemaSnapshot(await runTable(source)), afterSchema);
  assert.equal(await source.showMigrations(), false);
  for (const row of await readRuns(source)) {
    // Rolling back deliberately drops the two new fields; upgrading again
    // restores nullable columns without rewriting any historical Run evidence.
    assert.equal(row.errorKind, null);
    assert.equal(row.failureReason, null);
  }
});
