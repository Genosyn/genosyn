import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { ResourceFolders1792402358870 } from "./migrations/1792402358870-ResourceFolders.js";

/**
 * The SQLite migration that gives the Resources library its folders, run
 * against a database that already holds Resources.
 *
 * SQLite cannot add the column in place, so the generated migration rebuilds
 * `resources`. Every Resource — its extracted body, original file key, and
 * status — must come through byte for byte with its indexes, and come out
 * unfiled, so the library looks exactly as it did on upgrade.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1792402358870;

const RESOURCES: Row[] = [
  {
    id: "r-1-pdf",
    companyId: "co-1",
    title: "Vendor guide — “Zürich” edition",
    slug: "vendor-guide",
    sourceKind: "pdf",
    sourceUrl: null,
    sourceFilename: "guide.pdf",
    storageKey: "abc123.pdf",
    summary: "A guide.",
    bodyText: "Page one.\n\nPage two — ünïcode.",
    tags: "vendors",
    bytes: 20480,
    status: "ready",
    errorMessage: "",
    createdById: "user-1",
    createdByEmployeeId: null,
    createdAt: "2026-09-01 09:00:00",
    updatedAt: "2026-09-02 10:00:00",
  },
  {
    id: "r-2-text",
    companyId: "co-2",
    title: "Battlecard",
    slug: "battlecard",
    sourceKind: "text",
    sourceUrl: null,
    sourceFilename: null,
    storageKey: null,
    summary: "",
    bodyText: "# Acme\n\n**Wins** on price.",
    tags: "",
    bytes: 26,
    status: "ready",
    errorMessage: "",
    createdById: null,
    createdByEmployeeId: "emp-1",
    createdAt: "2026-10-01 09:00:00",
    updatedAt: "2026-10-01 09:00:00",
  },
  {
    id: "r-3-failed-url",
    companyId: "co-1",
    title: "https://example.com",
    slug: "example-com",
    sourceKind: "url",
    sourceUrl: "https://example.com",
    sourceFilename: null,
    storageKey: null,
    summary: "",
    bodyText: "",
    tags: "",
    bytes: 0,
    status: "failed",
    errorMessage: "No readable text on this page.",
    createdById: "user-1",
    createdByEmployeeId: null,
    createdAt: "2026-10-02 09:00:00",
    updatedAt: "2026-10-02 09:00:00",
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

async function tableOf(source: DataSource, name: string): Promise<Table | undefined> {
  const queryRunner = source.createQueryRunner();
  try {
    return await queryRunner.getTable(name);
  } finally {
    await queryRunner.release();
  }
}

const readRows = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "resources" ORDER BY "id"`);

const withoutFolder = (rows: Row[]): Row[] =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "folderId")));

test("ResourceFolders keeps every Resource and its indexes, unfiled", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-resource-folders-migration-"));
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
  for (const row of RESOURCES) {
    await source.createQueryBuilder().insert().into("resources", Object.keys(row)).values(row).execute();
  }
  const before = await readRows(source);
  const beforeTable = await tableOf(source, "resources");
  assert.ok(beforeTable);
  const beforeSchema = schemaSnapshot(beforeTable);
  assert.equal(await tableOf(source, "resource_folders"), undefined);
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [ResourceFolders1792402358870],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["ResourceFolders1792402358870"],
  );

  const upgraded = await readRows(source);
  assert.deepEqual(withoutFolder(upgraded), before, "every Resource survives the rebuild");
  assert.deepEqual(
    upgraded.map((row) => row.folderId),
    [null, null, null],
    "existing Resources start unfiled",
  );
  const after = schemaSnapshot((await tableOf(source, "resources"))!);
  assert.deepEqual(
    after.columns.filter((column) => column.name === "folderId"),
    [{ name: "folderId", type: "varchar", nullable: true, primary: false, default: undefined }],
  );
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "folderId"),
    beforeSchema.columns,
  );
  assert.deepEqual(
    after.indexes.filter((index) => !index.columns.includes("folderId")),
    beforeSchema.indexes,
    "the slug and status indexes are rebuilt as they were",
  );
  assert.deepEqual(
    after.indexes.filter((index) => index.columns.includes("folderId")).map((i) => i.columns),
    [["companyId", "folderId"]],
  );

  const folders = schemaSnapshot((await tableOf(source, "resource_folders"))!);
  assert.deepEqual(
    folders.columns.map((column) => column.name),
    ["companyId", "createdAt", "id", "name", "parentId", "slug", "sortOrder", "updatedAt"],
  );
  assert.deepEqual(
    folders.indexes.map((index) => [index.columns, index.unique]).sort(),
    [
      [["companyId"], false],
      [["companyId", "parentId"], false],
      [["companyId", "slug"], true],
    ].sort(),
  );

  // Rolling back drops the folders and the column; every Resource is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot((await tableOf(source, "resources"))!), beforeSchema);
  assert.deepEqual(await readRows(source), before);
  assert.equal(await tableOf(source, "resource_folders"), undefined);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the folder table and the column, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-ResourceFolders.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.match(up, /CREATE TABLE "resource_folders"/);
  assert.match(up, /ALTER TABLE "resources" ADD "folderId" character varying(?! NOT NULL)/);
  assert.match(up, /CREATE INDEX "[^"]+" ON "resources" \("companyId", "folderId"\)/);
  assert.match(up, /CREATE UNIQUE INDEX "[^"]+" ON "resource_folders" \("companyId", "slug"\)/);
  assert.doesNotMatch(up, /DROP/);
  assert.equal([...down.matchAll(/DROP COLUMN/g)].length, 1, "down drops only folderId");
  assert.match(down, /DROP TABLE "resource_folders"/);
  assert.doesNotMatch(down, /DROP TABLE "resources"/);
});
