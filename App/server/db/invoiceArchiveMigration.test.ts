import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { InvoiceArchive1792487182237 } from "./migrations/1792487182237-InvoiceArchive.js";

/**
 * The SQLite migration that lets invoices and recurring invoice schedules be
 * archived, run against a database that already holds both.
 *
 * SQLite cannot add the columns in place, so the generated migration rebuilds
 * `invoices` and `recurring_invoices`. Every invoice — its number, money,
 * dates, and issuer snapshot — and every schedule — its cadence, run counts,
 * and discount — must come through byte for byte with its indexes, the unique
 * slug indexes above all, and come out not archived.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1792487182237;
const TABLES = ["invoices", "recurring_invoices"] as const;

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

type Snapshot = ReturnType<typeof schemaSnapshot>;

async function snapshots(source: DataSource): Promise<Record<string, Snapshot>> {
  const queryRunner = source.createQueryRunner();
  try {
    const result: Record<string, Snapshot> = {};
    for (const name of TABLES) {
      const table = await queryRunner.getTable(name);
      assert.ok(table, `the migration must retain ${name}`);
      result[name] = schemaSnapshot(table);
    }
    return result;
  } finally {
    await queryRunner.release();
  }
}

async function readRows(source: DataSource): Promise<Record<string, Row[]>> {
  const result: Record<string, Row[]> = {};
  for (const name of TABLES) {
    result[name] = await source.query(`SELECT * FROM "${name}" ORDER BY "id"`);
  }
  return result;
}

function withoutArchivedAt(rows: Record<string, Row[]>): Record<string, Row[]> {
  return Object.fromEntries(
    Object.entries(rows).map(([name, list]) => [
      name,
      list.map(({ archivedAt: _archivedAt, ...rest }) => rest),
    ]),
  );
}

const issuer = JSON.stringify({ name: "Acme GmbH — Zürich", taxNumber: "CHE-123" });

const fixtures: Record<(typeof TABLES)[number], Row[]> = {
  invoices: [
    {
      id: "i-1-draft",
      companyId: "co-1",
      customerId: "cust-1",
      slug: "draft-a1b2c3",
      status: "draft",
      issueDate: "2026-10-01 09:00:00",
      dueDate: "2026-10-15 09:00:00",
      currency: "EUR",
      notes: "Includes “premium” onboarding — ünïcode.",
      createdAt: "2026-10-01 09:00:00",
      updatedAt: "2026-10-01 09:00:00",
    },
    {
      id: "i-2-paid",
      companyId: "co-1",
      customerId: "cust-1",
      subsidiaryId: "sub-1",
      issuerSnapshot: issuer,
      slug: "acme-inv-0001",
      numberSeq: 1,
      number: "ACME-INV-0001",
      status: "paid",
      issueDate: "2026-09-01 09:00:00",
      dueDate: "2026-09-15 09:00:00",
      currency: "USD",
      subtotalCents: 90000,
      discountPercent: 10,
      discountCents: 10000,
      taxCents: 18000,
      totalCents: 108000,
      paidCents: 100000,
      creditedCents: 8000,
      balanceCents: 0,
      footer: "Thank you.",
      sentAt: "2026-09-01 09:05:00",
      paidAt: "2026-09-10 12:00:00",
      createdById: "user-1",
      createdAt: "2026-09-01 09:00:00",
      updatedAt: "2026-09-10 12:00:00",
    },
    {
      id: "i-3-written-off",
      companyId: "co-2",
      customerId: "cust-2",
      slug: "beta-inv-0001",
      numberSeq: 1,
      number: "BETA-INV-0001",
      status: "paid",
      issueDate: "2026-08-01 09:00:00",
      dueDate: "2026-08-31 09:00:00",
      totalCents: 5000,
      writtenOffCents: 5000,
      discountAmountCents: 500,
      sentAt: "2026-08-01 09:00:00",
      createdAt: "2026-08-01 09:00:00",
      updatedAt: "2026-09-15 10:00:00",
    },
  ],
  recurring_invoices: [
    {
      id: "r-1-active",
      companyId: "co-1",
      customerId: "cust-1",
      slug: "ri-abc123",
      name: "Acme retainer — “gold”",
      cronExpr: "0 9 1 * *",
      status: "active",
      autoSend: 1,
      nextRunAt: "2026-11-01 09:00:00",
      lastRunAt: "2026-10-01 09:00:00",
      lastInvoiceSlug: "acme-inv-0001",
      runsCreated: 3,
      maxRuns: 12,
      createdAt: "2026-07-01 09:00:00",
      updatedAt: "2026-10-01 09:00:00",
    },
    {
      id: "r-2-ended",
      companyId: "co-2",
      customerId: "cust-2",
      subsidiaryId: "sub-2",
      slug: "ri-def456",
      name: "Beta licence",
      cronExpr: "0 9 20 8 *",
      frequency: "yearly",
      intervalCount: 2,
      anchorAt: "2025-08-20 09:00:00",
      status: "ended",
      daysUntilDue: 30,
      currency: "EUR",
      notes: "Licence renewal.",
      discountPercent: 12.5,
      endsOn: "2026-08-21 00:00:00",
      createdAt: "2025-08-01 09:00:00",
      updatedAt: "2026-08-21 00:00:00",
    },
  ],
};

test("InvoiceArchive keeps every invoice and schedule and their indexes, with none archived", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-invoice-archive-migration-"));
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

  for (const name of TABLES) {
    for (const row of fixtures[name]) {
      await source.createQueryBuilder().insert().into(name, Object.keys(row)).values(row).execute();
    }
  }
  const before = await readRows(source);
  const beforeSchema = await snapshots(source);
  for (const name of TABLES) {
    assert.equal(
      beforeSchema[name].columns.some((column) => column.name === "archivedAt"),
      false,
    );
  }
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [InvoiceArchive1792487182237],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["InvoiceArchive1792487182237"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(withoutArchivedAt(upgraded), before);
  for (const name of TABLES) {
    assert.ok(
      upgraded[name].every((row) => row.archivedAt === null),
      `existing ${name} start out in the lists`,
    );
  }

  const after = await snapshots(source);
  for (const name of TABLES) {
    assert.deepEqual(
      after[name].columns.find((column) => column.name === "archivedAt"),
      { name: "archivedAt", type: "datetime", nullable: true, primary: false, default: undefined },
    );
    assert.deepEqual(
      after[name].columns.filter((column) => column.name !== "archivedAt"),
      beforeSchema[name].columns,
    );
    const added = after[name].indexes.filter(
      (index) => !beforeSchema[name].indexes.some((prior) => prior.name === index.name),
    );
    assert.deepEqual(
      added.map((index) => [index.columns.join(","), index.unique]),
      [["companyId,archivedAt", false]],
    );
    assert.deepEqual(
      after[name].indexes.filter((index) => index !== added[0]),
      beforeSchema[name].indexes,
      `the ${name} slug, status, and customer indexes survive the rebuild`,
    );
    assert.ok(
      after[name].indexes.some(
        (index) => index.columns.join(",") === "companyId,slug" && index.unique,
      ),
    );
  }

  // Archiving is a timestamp and nothing else.
  await source.query(
    `UPDATE "invoices" SET "archivedAt" = '2026-10-20 10:00:00' WHERE "id" = 'i-2-paid'`,
  );
  await source.query(
    `UPDATE "recurring_invoices" SET "archivedAt" = '2026-10-20 10:00:00' WHERE "id" = 'r-2-ended'`,
  );
  const archived = await readRows(source);
  assert.deepEqual(withoutArchivedAt(archived), before);
  assert.deepEqual(
    archived.invoices.map((row) => row.archivedAt),
    [null, "2026-10-20 10:00:00", null],
  );
  assert.deepEqual(
    archived.recurring_invoices.map((row) => row.archivedAt),
    [null, "2026-10-20 10:00:00"],
  );

  // Rolling back removes only the columns; every row is still there.
  await source.undoLastMigration();
  assert.deepEqual(await snapshots(source), beforeSchema);
  assert.deepEqual(await readRows(source), before);

  // And it applies again cleanly.
  await source.runMigrations();
  assert.deepEqual(await snapshots(source), after);
  assert.deepEqual(withoutArchivedAt(await readRows(source)), before);
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same nullable columns and indexes, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-InvoiceArchive.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  for (const name of TABLES) {
    assert.match(up, new RegExp(`ALTER TABLE "${name}" ADD "archivedAt" TIMESTAMP WITH TIME ZONE\``));
    assert.match(up, new RegExp(`CREATE INDEX "IDX_\\w+" ON "${name}" \\("companyId", "archivedAt"\\)`));
    assert.match(down, new RegExp(`ALTER TABLE "${name}" DROP COLUMN "archivedAt"\``));
  }
  assert.doesNotMatch(up, /NOT NULL|DROP/);
  assert.equal([...down.matchAll(/DROP /g)].length, 4, "down drops the two indexes and columns only");
});
