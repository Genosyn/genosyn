import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { EstimateArchive1791883996384 } from "./migrations/1791883996384-EstimateArchive.js";

/**
 * The SQLite migration that lets an estimate be archived, run against a
 * database that already holds estimates.
 *
 * SQLite cannot add the column in place, so the generated migration rebuilds
 * `estimates`. Every quotation — its number, status, dates, issuer snapshot
 * and converted-invoice link — must come through byte for byte with its
 * indexes, the unique slug index above all, and come out not archived.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1791883996384;

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

async function tableOf(source: DataSource): Promise<Table> {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable("estimates");
    assert.ok(table, "the migration must retain estimates");
    return table;
  } finally {
    await queryRunner.release();
  }
}

const readRows = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "estimates" ORDER BY "id"`);

const withoutArchivedAt = (rows: Row[]): Row[] =>
  rows.map(({ archivedAt: _archivedAt, ...rest }) => rest);

const issuer = JSON.stringify({ name: "Acme GmbH — Zürich", taxNumber: "CHE-123" });

const estimates: Row[] = [
  {
    id: "e-1-draft",
    companyId: "co-1",
    customerId: "cust-1",
    slug: "edraft-a1b2c3",
    status: "draft",
    issueDate: "2026-10-01 09:00:00",
    validUntil: "2026-10-31 09:00:00",
    currency: "EUR",
    notes: "Includes “premium” onboarding — ünïcode.",
    createdAt: "2026-10-01 09:00:00",
    updatedAt: "2026-10-01 09:00:00",
  },
  {
    id: "e-2-invoiced",
    companyId: "co-1",
    customerId: "cust-1",
    subsidiaryId: "sub-1",
    issuerSnapshot: issuer,
    slug: "acme-est-0001",
    numberSeq: 1,
    number: "ACME-EST-0001",
    status: "accepted",
    issueDate: "2026-09-01 09:00:00",
    validUntil: "2026-10-01 09:00:00",
    currency: "USD",
    subtotalCents: 100000,
    taxCents: 20000,
    totalCents: 120000,
    footer: "Thank you.",
    sentAt: "2026-09-01 09:05:00",
    acceptedAt: "2026-09-03 12:00:00",
    invoiceId: "inv-1",
    convertedAt: "2026-09-04 08:00:00",
    createdById: "user-1",
    createdAt: "2026-09-01 09:00:00",
    updatedAt: "2026-09-04 08:00:00",
  },
  {
    id: "e-3-void",
    companyId: "co-2",
    customerId: "cust-2",
    slug: "beta-est-0001",
    numberSeq: 1,
    number: "BETA-EST-0001",
    status: "void",
    issueDate: "2026-08-01 09:00:00",
    validUntil: "2026-08-31 09:00:00",
    sentAt: "2026-08-01 09:00:00",
    voidedAt: "2026-08-15 10:00:00",
    createdAt: "2026-08-01 09:00:00",
    updatedAt: "2026-08-15 10:00:00",
  },
];

test("EstimateArchive keeps every estimate and its indexes, with none archived", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-estimate-archive-migration-"));
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

  for (const row of estimates) {
    await source
      .createQueryBuilder()
      .insert()
      .into("estimates", Object.keys(row))
      .values(row)
      .execute();
  }
  const before = await readRows(source);
  const beforeSchema = schemaSnapshot(await tableOf(source));
  assert.equal(
    beforeSchema.columns.some((column) => column.name === "archivedAt"),
    false,
  );
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [EstimateArchive1791883996384],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["EstimateArchive1791883996384"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(withoutArchivedAt(upgraded), before);
  assert.deepEqual(
    upgraded.map((row) => row.archivedAt),
    [null, null, null],
    "existing estimates start out in the lists",
  );

  const after = schemaSnapshot(await tableOf(source));
  assert.deepEqual(
    after.columns.find((column) => column.name === "archivedAt"),
    { name: "archivedAt", type: "datetime", nullable: true, primary: false, default: undefined },
  );
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "archivedAt"),
    beforeSchema.columns,
  );
  const added = after.indexes.filter(
    (index) => !beforeSchema.indexes.some((prior) => prior.name === index.name),
  );
  assert.deepEqual(
    added.map((index) => [index.columns.join(","), index.unique]),
    [["companyId,archivedAt", false]],
  );
  assert.deepEqual(
    after.indexes.filter((index) => index !== added[0]),
    beforeSchema.indexes,
    "the slug, status, customer and number indexes survive the rebuild",
  );
  assert.ok(
    after.indexes.some((index) => index.columns.join(",") === "companyId,slug" && index.unique),
  );

  // Archiving is a timestamp and nothing else.
  await source.query(
    `UPDATE "estimates" SET "archivedAt" = '2026-10-13 10:00:00' WHERE "id" = 'e-2-invoiced'`,
  );
  const archived = await readRows(source);
  assert.deepEqual(withoutArchivedAt(archived), before);
  assert.deepEqual(
    archived.map((row) => row.archivedAt),
    [null, "2026-10-13 10:00:00", null],
  );

  // Rolling back removes only the column; every estimate is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await tableOf(source)), beforeSchema);
  assert.deepEqual(await readRows(source), before);

  // And it applies again cleanly.
  await source.runMigrations();
  assert.deepEqual(schemaSnapshot(await tableOf(source)), after);
  assert.deepEqual(withoutArchivedAt(await readRows(source)), before);
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same nullable column and index, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-EstimateArchive.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /ALTER TABLE "estimates" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`/);
  assert.match(up, /CREATE INDEX "IDX_\w+" ON "estimates" \("companyId", "archivedAt"\)/);
  assert.doesNotMatch(up, /NOT NULL|DROP/);
  assert.match(down, /ALTER TABLE "estimates" DROP COLUMN "archivedAt"`/);
  assert.equal([...down.matchAll(/DROP /g)].length, 2, "down drops the index and the column only");
});
