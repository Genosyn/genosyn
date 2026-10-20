import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { InvoicePaymentBankTransaction1792501248926 } from "./migrations/1792501248926-InvoicePaymentBankTransaction.js";

/**
 * The SQLite migration that lets one bank deposit pay several invoices, run
 * against a database that already holds payments.
 *
 * SQLite cannot add the column in place, so the generated migration rebuilds
 * `invoice_payments`. Every payment — its amount, date, method, reference and
 * notes — must come through byte for byte with its invoice index, and come out
 * linked to no deposit: a deposit matched before this release keeps its link
 * on `bank_transactions.matchedPaymentId`, which the migration leaves alone.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1792501248926;
const TABLE = "invoice_payments";

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

async function snapshot(source: DataSource) {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable(TABLE);
    assert.ok(table, `the migration must retain ${TABLE}`);
    return schemaSnapshot(table);
  } finally {
    await queryRunner.release();
  }
}

async function readRows(source: DataSource): Promise<Row[]> {
  return source.query(`SELECT * FROM "${TABLE}" ORDER BY "id"`);
}

function withoutLink(rows: Row[]): Row[] {
  return rows.map(({ bankTransactionId: _bankTransactionId, ...rest }) => rest);
}

const fixtures: Row[] = [
  {
    id: "p-1-banking",
    invoiceId: "i-1",
    amountCents: 120000,
    currency: "USD",
    paidAt: "2026-10-18 00:00:00",
    method: "bank_transfer",
    notes: "Recorded from Banking: Checking · ACME CORP ACH — “October”",
    createdById: "user-1",
    createdAt: "2026-10-18 09:00:00",
  },
  {
    id: "p-2-by-hand",
    invoiceId: "i-2",
    amountCents: 4550,
    currency: "EUR",
    paidAt: "2026-09-30 12:00:00",
    method: "stripe",
    reference: "ch_3PayOnce",
    createdAt: "2026-09-30 12:05:00",
  },
  {
    id: "p-3-partial",
    invoiceId: "i-2",
    amountCents: 1,
    paidAt: "2026-10-01 08:00:00",
    reference: "WIRE-77",
    notes: "ünïcode",
    createdById: "user-2",
    createdAt: "2026-10-01 08:00:00",
  },
];

test("InvoicePaymentBankTransaction keeps every payment and its index, linked to no deposit", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-payment-deposit-migration-"));
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

  for (const row of fixtures) {
    await source.createQueryBuilder().insert().into(TABLE, Object.keys(row)).values(row).execute();
  }
  const before = await readRows(source);
  const beforeSchema = await snapshot(source);
  assert.equal(
    beforeSchema.columns.some((column) => column.name === "bankTransactionId"),
    false,
  );
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [InvoicePaymentBankTransaction1792501248926],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["InvoicePaymentBankTransaction1792501248926"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(withoutLink(upgraded), before);
  assert.ok(
    upgraded.every((row) => row.bankTransactionId === null),
    "existing payments start out in no deposit",
  );

  const after = await snapshot(source);
  assert.deepEqual(
    after.columns.find((column) => column.name === "bankTransactionId"),
    {
      name: "bankTransactionId",
      type: "varchar",
      nullable: true,
      primary: false,
      default: undefined,
    },
  );
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "bankTransactionId"),
    beforeSchema.columns,
  );
  const added = after.indexes.filter(
    (index) => !beforeSchema.indexes.some((prior) => prior.name === index.name),
  );
  assert.deepEqual(
    added.map((index) => [index.columns.join(","), index.unique]),
    [["bankTransactionId", false]],
  );
  assert.deepEqual(
    after.indexes.filter((index) => index !== added[0]),
    beforeSchema.indexes,
    "the invoice index survives the rebuild",
  );

  // A deposit paying two invoices is the link on each payment, and nothing else.
  await source.query(
    `UPDATE "${TABLE}" SET "bankTransactionId" = 'deposit-1' WHERE "id" IN ('p-1-banking', 'p-3-partial')`,
  );
  const linked = await readRows(source);
  assert.deepEqual(withoutLink(linked), before);
  assert.deepEqual(
    linked.map((row) => row.bankTransactionId),
    ["deposit-1", null, "deposit-1"],
  );

  // Rolling back removes only the column; every payment is still there.
  await source.undoLastMigration();
  assert.deepEqual(await snapshot(source), beforeSchema);
  assert.deepEqual(await readRows(source), before);

  // And it applies again cleanly.
  await source.runMigrations();
  assert.deepEqual(await snapshot(source), after);
  assert.deepEqual(withoutLink(await readRows(source)), before);
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same nullable column and index, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-InvoicePaymentBankTransaction.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /ALTER TABLE "invoice_payments" ADD "bankTransactionId" character varying`/);
  assert.match(up, /CREATE INDEX "IDX_\w+" ON "invoice_payments" \("bankTransactionId"\)/);
  assert.doesNotMatch(up, /NOT NULL|DROP/);
  assert.match(down, /ALTER TABLE "invoice_payments" DROP COLUMN "bankTransactionId"`/);
  assert.equal([...down.matchAll(/DROP /g)].length, 2, "down drops the index and column only");
});
