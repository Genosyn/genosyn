import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { RecurringInvoiceDiscounts1792481163087 } from "./migrations/1792481163087-RecurringInvoiceDiscounts.js";

/**
 * The SQLite migration that gives recurring invoices a discount, run against a
 * database that already holds schedules.
 *
 * SQLite cannot add the columns in place, so the generated migration rebuilds
 * `recurring_invoices`. Every schedule — its cadence, anchor, caps and run
 * history — must come through byte for byte with its indexes, and come out
 * with no discount, so no customer is billed differently after an upgrade.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1792481163087;
const DISCOUNT_COLUMNS = ["discountAmountCents", "discountPercent"];

const rows: Row[] = [
  {
    id: "ri-1-active",
    companyId: "co-1",
    customerId: "cust-1",
    subsidiaryId: "sub-1",
    slug: "ri-abc123",
    name: "Acme — “premium” retainer, ünïcode",
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    intervalCount: 2,
    anchorAt: "2026-09-01 09:00:00",
    status: "active",
    daysUntilDue: 30,
    autoSend: 1,
    currency: "EUR",
    notes: "Thanks!",
    footer: "IBAN DE00",
    nextRunAt: "2026-11-01 09:00:00",
    lastRunAt: "2026-09-01 09:00:05",
    lastInvoiceSlug: "acme-inv-0007",
    runsCreated: 1,
    maxRuns: 12,
    endsOn: "2027-09-01 00:00:00",
    createdAt: "2026-08-20 10:00:00",
    updatedAt: "2026-09-01 09:00:05",
  },
  {
    id: "ri-2-paused",
    companyId: "co-2",
    customerId: "cust-2",
    slug: "ri-def456",
    name: "Globex",
    cronExpr: "0 9 * * 1",
    status: "paused",
    createdAt: "2026-10-01 09:00:00",
    updatedAt: "2026-10-01 09:00:00",
  },
];

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

async function recurringTable(source: DataSource): Promise<Table> {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable("recurring_invoices");
    assert.ok(table, "the migration must retain recurring_invoices");
    return table;
  } finally {
    await queryRunner.release();
  }
}

const readRows = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "recurring_invoices" ORDER BY "id"`);

const withoutDiscount = (all: Row[]): Row[] =>
  all.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !DISCOUNT_COLUMNS.includes(key))),
  );

test("RecurringInvoiceDiscounts keeps every schedule and its indexes, with no discount", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-recurring-discounts-migration-"));
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

  for (const row of rows) {
    await source
      .createQueryBuilder()
      .insert()
      .into("recurring_invoices", Object.keys(row))
      .values(row)
      .execute();
  }
  const before = await readRows(source);
  const beforeSchema = schemaSnapshot(await recurringTable(source));
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RecurringInvoiceDiscounts1792481163087],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RecurringInvoiceDiscounts1792481163087"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(withoutDiscount(upgraded), before, "every schedule survives the rebuild");
  for (const row of upgraded) {
    assert.deepEqual(
      DISCOUNT_COLUMNS.map((column) => row[column]),
      [0, 0],
      `${row.id} starts with no discount`,
    );
  }
  const after = schemaSnapshot(await recurringTable(source));
  assert.deepEqual(
    after.columns.filter((column) => DISCOUNT_COLUMNS.includes(column.name)),
    [
      {
        name: "discountAmountCents",
        type: "integer",
        nullable: false,
        primary: false,
        default: "0",
      },
      { name: "discountPercent", type: "real", nullable: false, primary: false, default: "0" },
    ],
  );
  assert.deepEqual(
    after.columns.filter((column) => !DISCOUNT_COLUMNS.includes(column.name)),
    beforeSchema.columns,
  );
  assert.deepEqual(after.indexes, beforeSchema.indexes, "the schedule indexes are kept");

  // Rolling back removes only the columns; every schedule is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await recurringTable(source)), beforeSchema);
  assert.deepEqual(await readRows(source), before);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same two columns, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-RecurringInvoiceDiscounts.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(
    up,
    /ALTER TABLE "recurring_invoices" ADD "discountPercent" real NOT NULL DEFAULT '0'/,
  );
  assert.match(
    up,
    /ALTER TABLE "recurring_invoices" ADD "discountAmountCents" integer NOT NULL DEFAULT '0'/,
  );
  assert.doesNotMatch(up, /DROP/);
  assert.equal([...up.matchAll(/ALTER TABLE/g)].length, 2, "up adds the two columns only");
  assert.equal([...down.matchAll(/DROP COLUMN/g)].length, 2, "down drops the two columns only");
});
