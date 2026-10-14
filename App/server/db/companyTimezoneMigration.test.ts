import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { CompanyTimezone1791966710602 } from "./migrations/1791966710602-CompanyTimezone.js";

/**
 * The SQLite migration that gives every company a time zone, run against a
 * database that already has companies.
 *
 * SQLite cannot add the column in place without a rebuild, so the generated
 * migration recreates `companies` — every other table's rows hang off its ids,
 * so a lost row, column or unique slug here would be the worst kind of upgrade
 * bug. It also decides what every existing install does the day it upgrades:
 * an existing company must come out on *server time* (the empty string), so
 * its Routines fire exactly when they did yesterday until somebody picks a
 * zone.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1791966710602;

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
    uniques: table.uniques
      .map((unique) => ({ name: unique.name, columns: unique.columnNames }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  };
}

async function tableOf(source: DataSource, name: string): Promise<Table> {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable(name);
    assert.ok(table, `the migration must retain ${name}`);
    return table;
  } finally {
    await queryRunner.release();
  }
}

const readRows = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "companies" ORDER BY "id"`);

function without(rows: Row[], columns: string[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column))),
  );
}

const NEW_COLUMNS = ["timezone"];

const companies: Row[] = [
  {
    id: "co-1-acme",
    name: "Acme",
    slug: "acme",
    ownerId: "user-1",
    createdAt: "2026-01-02 03:04:05",
    requireTwoFactor: 1,
    mission: "Make widgets people love.",
    vision: "Every desk has a widget.",
    proactiveAutoSetup: 0,
    proactiveDefaultsJson: '{"version":1,"assignments":{"spam-cleanup":"rule-1"}}',
    decisionStackEnabled: 0,
    decisionStackInstructions: "Only ask about hiring.",
  },
  {
    id: "co-2-globex",
    name: "Globex — “Quotes” & ünïcode",
    slug: "globex",
    ownerId: "user-2",
    createdAt: "2026-09-30 23:59:59",
    requireTwoFactor: 0,
    mission: "",
    vision: "",
    proactiveAutoSetup: 1,
    proactiveDefaultsJson: "",
    decisionStackEnabled: 1,
    decisionStackInstructions: null,
  },
];

test("CompanyTimezone keeps every company and starts each one on server time", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-company-timezone-migration-"));
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

  await source
    .createQueryBuilder()
    .insert()
    .into("companies", Object.keys(companies[0]))
    .values(companies)
    .execute();
  const before = await readRows(source);
  const beforeSchema = schemaSnapshot(await tableOf(source, "companies"));
  for (const column of NEW_COLUMNS) {
    assert.equal(
      beforeSchema.columns.some((entry) => entry.name === column),
      false,
      `${column} does not exist before the migration`,
    );
  }
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [CompanyTimezone1791966710602],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["CompanyTimezone1791966710602"],
  );

  // Every company survives intact, on server time — the clock Routines have
  // always run on.
  const upgraded = await readRows(source);
  assert.deepEqual(without(upgraded, NEW_COLUMNS), before);
  assert.deepEqual(
    upgraded.map((row) => row.timezone),
    ["", ""],
    "existing companies keep scheduling on server time",
  );

  const after = schemaSnapshot(await tableOf(source, "companies"));
  assert.deepEqual(
    after.columns.find((column) => column.name === "timezone"),
    { name: "timezone", type: "varchar", nullable: false, primary: false, default: "''" },
  );
  assert.deepEqual(
    after.columns.filter((column) => !NEW_COLUMNS.includes(column.name)),
    beforeSchema.columns,
  );
  assert.deepEqual(after.indexes, beforeSchema.indexes);
  assert.deepEqual(after.uniques, beforeSchema.uniques);

  // The unique slug still holds after the rebuild.
  await assert.rejects(
    source.query(
      `INSERT INTO "companies" ("id", "name", "slug", "ownerId") VALUES ('dup', 'Dup', 'acme', 'user-3')`,
    ),
    /UNIQUE constraint failed/,
  );

  // A company created after the upgrade starts the same way, and a zone
  // written to either kind round-trips.
  await source.query(
    `INSERT INTO "companies" ("id", "name", "slug", "ownerId") VALUES ('co-3-new', 'New', 'new-co', 'user-3')`,
  );
  await source.query(`UPDATE "companies" SET "timezone" = 'Europe/Berlin' WHERE "id" = 'co-1-acme'`);
  assert.deepEqual(
    (await readRows(source)).map((row) => [row.id, row.timezone]),
    [
      ["co-1-acme", "Europe/Berlin"],
      ["co-2-globex", ""],
      ["co-3-new", ""],
    ],
  );
  await source.query(`DELETE FROM "companies" WHERE "id" = 'co-3-new'`);
  await source.query(`UPDATE "companies" SET "timezone" = '' WHERE "id" = 'co-1-acme'`);

  // Rolling back removes only the new column; every row is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "companies")), beforeSchema);
  assert.deepEqual(await readRows(source), before);
  assert.equal(await source.showMigrations(), true);

  // And it applies again cleanly.
  await source.runMigrations();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "companies")), after);
  assert.deepEqual(without(await readRows(source), NEW_COLUMNS), before);
  assert.equal(await source.showMigrations(), false);
});
