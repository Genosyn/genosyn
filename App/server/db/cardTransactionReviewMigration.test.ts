import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { CardTransactionReview1792562903926 } from "./migrations/1792562903926-CardTransactionReview.js";

/**
 * The SQLite migration that lets a card purchase wait in Banking's To review
 * after it is in the books, run against a database that already holds card
 * purchases.
 *
 * SQLite cannot add the column in place, so the generated migration rebuilds
 * `card_transactions`. Every purchase, refund and card bill payment — its
 * amount, category, ledger entry, posting error and raw Brex payload — must
 * come through byte for byte with its indexes, the unique one on the Brex id
 * above all, and come out reviewed: purchases from before the column existed
 * stay in Done.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1792562903926;
const TABLE = "card_transactions";

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

function withoutNeedsReview(rows: Row[]): Row[] {
  return rows.map(({ needsReview: _needsReview, ...rest }) => rest);
}

const raw = JSON.stringify({ id: "ctx_1", description: "Café “Zürich” — ünïcode", amount: 4_200 });

const fixtures: Row[] = [
  {
    id: "c-1-purchase",
    companyId: "co-1",
    feedId: "feed-1",
    externalId: "ctx_1",
    cardId: "card_074k",
    postedAt: "2026-10-15 12:00:00",
    amountCents: 20_485,
    currency: "USD",
    description: "Claude",
    providerType: "PURCHASE",
    accountingKind: "expense",
    expenseAccountId: "acct-6300",
    ledgerEntryId: "entry-1",
    raw,
    reclassifiedAt: "2026-10-20 09:00:00",
    createdAt: "2026-10-15 12:05:00",
    updatedAt: "2026-10-20 09:00:00",
  },
  {
    id: "c-2-refund",
    companyId: "co-1",
    feedId: "feed-1",
    externalId: "ctx_2",
    cardId: "card_074k",
    postedAt: "2026-10-16 12:00:00",
    amountCents: -1_500,
    currency: "EUR",
    description: "Refund: Stable",
    providerType: "REFUND",
    accountingKind: "refund",
    expenseAccountId: "acct-6000",
    ledgerEntryId: "entry-2",
    createdAt: "2026-10-16 12:05:00",
    updatedAt: "2026-10-16 12:05:00",
  },
  {
    id: "c-3-failed",
    companyId: "co-1",
    feedId: "feed-1",
    externalId: "ctx_3",
    postedAt: "2026-10-17 12:00:00",
    amountCents: 8_016,
    description: "Twilio",
    accountingKind: "expense",
    expenseAccountId: "acct-6000",
    postingError: "No exchange rate for GBP on 2026-10-17",
    createdAt: "2026-10-17 12:05:00",
    updatedAt: "2026-10-17 12:05:00",
  },
  {
    id: "c-4-payment",
    companyId: "co-2",
    feedId: "feed-2",
    externalId: "ctx_4",
    postedAt: "2026-10-20 12:00:00",
    amountCents: -221_515,
    description: "Payment - Thank you!",
    providerType: "COLLECTION",
    accountingKind: "payment",
    ledgerEntryId: "entry-4",
    createdAt: "2026-10-20 12:05:00",
    updatedAt: "2026-10-20 12:05:00",
  },
];

test("CardTransactionReview keeps every card transaction and its indexes, all reviewed", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-card-review-migration-"));
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
    beforeSchema.columns.some((column) => column.name === "needsReview"),
    false,
  );
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [CardTransactionReview1792562903926],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["CardTransactionReview1792562903926"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(withoutNeedsReview(upgraded), before);
  assert.ok(
    upgraded.every((row) => row.needsReview === 0),
    "existing card transactions start out reviewed",
  );

  const after = await snapshot(source);
  assert.deepEqual(
    after.columns.find((column) => column.name === "needsReview"),
    { name: "needsReview", type: "boolean", nullable: false, primary: false, default: "0" },
  );
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "needsReview"),
    beforeSchema.columns,
  );
  assert.deepEqual(
    after.indexes,
    beforeSchema.indexes,
    "the rebuild keeps every index, and adds none",
  );
  assert.ok(
    after.indexes.some((index) => index.columns.join(",") === "feedId,externalId" && index.unique),
    "a Brex transaction still lands once per card",
  );

  // Waiting for review is the flag and nothing else.
  await source.query(`UPDATE "${TABLE}" SET "needsReview" = 1 WHERE "id" = 'c-1-purchase'`);
  const waiting = await readRows(source);
  assert.deepEqual(withoutNeedsReview(waiting), before);
  assert.deepEqual(
    waiting.map((row) => row.needsReview),
    [1, 0, 0, 0],
  );

  // Rolling back removes only the column; every row is still there.
  await source.undoLastMigration();
  assert.deepEqual(await snapshot(source), beforeSchema);
  assert.deepEqual(await readRows(source), before);

  // And it applies again cleanly.
  await source.runMigrations();
  assert.deepEqual(await snapshot(source), after);
  assert.deepEqual(withoutNeedsReview(await readRows(source)), before);
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same column, reviewed by default, and drops only it", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-CardTransactionReview.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(
    up,
    /ALTER TABLE "card_transactions" ADD "needsReview" boolean NOT NULL DEFAULT false`/,
  );
  assert.doesNotMatch(up, /DROP|INDEX/);
  assert.match(down, /ALTER TABLE "card_transactions" DROP COLUMN "needsReview"`/);
  assert.equal([...down.matchAll(/DROP /g)].length, 1, "down drops the column only");
});
