import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { DocumentDiscounts1792385802779 } from "./migrations/1792385802779-DocumentDiscounts.js";

/**
 * The SQLite migration that gives estimates and invoices a discount, run
 * against a database that already holds both.
 *
 * SQLite cannot add the columns in place, so the generated migration rebuilds
 * `invoices` and `estimates`. Every document — its number, totals, payments
 * state and issuer snapshot — must come through byte for byte with its
 * indexes, and come out with no discount, so no total moves on upgrade.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1792385802779;
const DISCOUNT_COLUMNS = ["discountAmountCents", "discountCents", "discountPercent"];

const issuer = JSON.stringify({ name: "Acme GmbH — Zürich", taxNumber: "CHE-123" });

const rowsByTable: Record<"invoices" | "estimates", Row[]> = {
  invoices: [
    {
      id: "i-1-paid",
      companyId: "co-1",
      customerId: "cust-1",
      subsidiaryId: "sub-1",
      issuerSnapshot: issuer,
      slug: "acme-inv-0001",
      numberSeq: 1,
      number: "ACME-INV-0001",
      status: "paid",
      issueDate: "2026-09-01 09:00:00",
      dueDate: "2026-10-01 09:00:00",
      currency: "EUR",
      subtotalCents: 100000,
      taxCents: 20000,
      totalCents: 120000,
      paidCents: 120000,
      balanceCents: 0,
      notes: "Includes “premium” onboarding — ünïcode.",
      sentAt: "2026-09-01 09:05:00",
      paidAt: "2026-09-20 12:00:00",
      createdAt: "2026-09-01 09:00:00",
      updatedAt: "2026-09-20 12:00:00",
    },
    {
      id: "i-2-draft",
      companyId: "co-2",
      customerId: "cust-2",
      slug: "draft-a1b2c3",
      status: "draft",
      issueDate: "2026-10-01 09:00:00",
      dueDate: "2026-10-15 09:00:00",
      createdAt: "2026-10-01 09:00:00",
      updatedAt: "2026-10-01 09:00:00",
    },
  ],
  estimates: [
    {
      id: "e-1-accepted",
      companyId: "co-1",
      customerId: "cust-1",
      slug: "acme-est-0001",
      numberSeq: 1,
      number: "ACME-EST-0001",
      status: "accepted",
      issueDate: "2026-08-01 09:00:00",
      validUntil: "2026-08-31 09:00:00",
      currency: "USD",
      subtotalCents: 50000,
      taxCents: 5000,
      totalCents: 55000,
      acceptedAt: "2026-08-03 12:00:00",
      archivedAt: "2026-10-13 10:00:00",
      createdAt: "2026-08-01 09:00:00",
      updatedAt: "2026-10-13 10:00:00",
    },
  ],
};

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

const readRows = (source: DataSource, table: string): Promise<Row[]> =>
  source.query(`SELECT * FROM "${table}" ORDER BY "id"`);

const withoutDiscount = (rows: Row[]): Row[] =>
  rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !DISCOUNT_COLUMNS.includes(key))),
  );

test("DocumentDiscounts keeps every invoice and estimate and its indexes, with no discount", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-document-discounts-migration-"));
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

  const before: Record<string, Row[]> = {};
  const beforeSchema: Record<string, ReturnType<typeof schemaSnapshot>> = {};
  for (const [table, rows] of Object.entries(rowsByTable)) {
    for (const row of rows) {
      await source
        .createQueryBuilder()
        .insert()
        .into(table, Object.keys(row))
        .values(row)
        .execute();
    }
    before[table] = await readRows(source, table);
    beforeSchema[table] = schemaSnapshot(await tableOf(source, table));
  }
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [DocumentDiscounts1792385802779],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["DocumentDiscounts1792385802779"],
  );

  for (const table of Object.keys(rowsByTable)) {
    const upgraded = await readRows(source, table);
    assert.deepEqual(withoutDiscount(upgraded), before[table], `${table} rows survive the rebuild`);
    for (const row of upgraded) {
      assert.deepEqual(
        DISCOUNT_COLUMNS.map((column) => row[column]),
        [0, 0, 0],
        `${table} ${row.id} starts with no discount`,
      );
    }
    const after = schemaSnapshot(await tableOf(source, table));
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
        { name: "discountCents", type: "integer", nullable: false, primary: false, default: "0" },
        { name: "discountPercent", type: "real", nullable: false, primary: false, default: "0" },
      ],
    );
    assert.deepEqual(
      after.columns.filter((column) => !DISCOUNT_COLUMNS.includes(column.name)),
      beforeSchema[table].columns,
    );
    assert.deepEqual(after.indexes, beforeSchema[table].indexes, `${table} keeps its indexes`);
  }

  // Rolling back removes only the columns; every document is still there.
  await source.undoLastMigration();
  for (const table of Object.keys(rowsByTable)) {
    assert.deepEqual(schemaSnapshot(await tableOf(source, table)), beforeSchema[table]);
    assert.deepEqual(await readRows(source, table), before[table]);
  }
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same six columns, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-DocumentDiscounts.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  for (const table of ["invoices", "estimates"]) {
    assert.match(
      up,
      new RegExp(`ALTER TABLE "${table}" ADD "discountPercent" real NOT NULL DEFAULT '0'`),
    );
    assert.match(
      up,
      new RegExp(`ALTER TABLE "${table}" ADD "discountAmountCents" integer NOT NULL DEFAULT '0'`),
    );
    assert.match(
      up,
      new RegExp(`ALTER TABLE "${table}" ADD "discountCents" integer NOT NULL DEFAULT '0'`),
    );
  }
  assert.doesNotMatch(up, /DROP/);
  assert.equal([...up.matchAll(/ALTER TABLE/g)].length, 6, "up adds the six columns only");
  assert.equal([...down.matchAll(/DROP COLUMN/g)].length, 6, "down drops the six columns only");
});
