import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { ChartBaseSource1793106599575 } from "./migrations/1793106599575-ChartBaseSource.js";

/**
 * The SQLite migration that lets a Chart read a Base, run against a database
 * that already has SQL Charts.
 *
 * SQLite cannot add the Base columns or relax `connectionId` to nullable in
 * place, so the generated migration rebuilds `charts` — twice. Every existing
 * Chart must come through byte for byte, with its indexes, still reading its
 * Connection; afterwards a Chart can hold a Base instead.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1793106599575;
const NEW_COLUMNS = ["baseId", "baseQueryJson"];

const charts: Row[] = [
  {
    id: "c-1",
    companyId: "co-1",
    title: "MRR — “net” & ünïcode",
    slug: "mrr",
    description: "Monthly recurring revenue",
    connectionId: "conn-1",
    sql: "SELECT SUM(amount) AS mrr\nFROM subscriptions WHERE status = 'active'",
    vizType: "scalar",
    vizConfig: '{"prefix":"$"}',
    createdById: "user-1",
    createdByEmployeeId: null,
    createdAt: "2026-10-01 09:00:00",
    updatedAt: "2026-10-02 09:00:00",
  },
  {
    id: "c-2",
    companyId: "co-1",
    title: "Signups by week",
    slug: "signups-by-week",
    description: "",
    connectionId: "conn-2",
    sql: "SELECT week, signups FROM weekly",
    vizType: "line",
    vizConfig: '{"dimension":"week","measures":["signups"]}',
    createdById: null,
    createdByEmployeeId: "emp-1",
    createdAt: "2026-10-03 09:00:00",
    updatedAt: "2026-10-03 09:00:00",
  },
];

function schemaSnapshot(table: Table) {
  return {
    columns: table.columns
      .map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.isNullable,
        default: column.default,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    indexes: table.indices
      .map((index) => ({ columns: index.columnNames, unique: index.isUnique }))
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
  };
}

async function tableOf(source: DataSource): Promise<Table> {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable("charts");
    assert.ok(table, "the migration must retain charts");
    return table;
  } finally {
    await queryRunner.release();
  }
}

const readRows = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "charts" ORDER BY "id"`);

test("ChartBaseSource keeps every SQL Chart and its indexes, and lets a Chart read a Base", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-chart-base-source-migration-"));
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

  for (const row of charts) {
    await source
      .createQueryBuilder()
      .insert()
      .into("charts", Object.keys(row))
      .values(row)
      .execute();
  }
  const before = await readRows(source);
  const beforeSchema = schemaSnapshot(await tableOf(source));
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [ChartBaseSource1793106599575],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["ChartBaseSource1793106599575"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(
    upgraded.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([column]) => !NEW_COLUMNS.includes(column))),
    ),
    before,
  );
  assert.deepEqual(
    upgraded.map((row) => [row.baseId, row.baseQueryJson]),
    [
      [null, null],
      [null, null],
    ],
  );

  const after = schemaSnapshot(await tableOf(source));
  const nullable = (name: string) => after.columns.find((column) => column.name === name)?.nullable;
  assert.equal(nullable("connectionId"), true, "a Base chart has no Connection");
  assert.equal(nullable("baseId"), true);
  assert.equal(nullable("baseQueryJson"), true);
  assert.deepEqual(
    after.indexes,
    [...beforeSchema.indexes, { columns: ["companyId", "baseId"], unique: false }].sort((a, b) =>
      a.columns.join().localeCompare(b.columns.join()),
    ),
  );

  await source.query(
    `INSERT INTO "charts" ("id", "companyId", "title", "slug", "baseId", "baseQueryJson") VALUES ('c-3', 'co-1', 'Deals', 'deals', 'base-1', '{"tableId":"t-1"}')`,
  );
  const [baseChart] = await source.query(`SELECT * FROM "charts" WHERE "id" = 'c-3'`);
  assert.equal(baseChart.connectionId, null);
  assert.equal(baseChart.sql, "");
});
