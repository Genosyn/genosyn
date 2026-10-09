import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { DecisionSummaries1791535812457 } from "./migrations/1791535812457-DecisionSummaries.js";

/**
 * The SQLite migration that gives every Decision its short lines — the
 * employee's `summary` and `recommendation` — and a pickup `pickupReport`
 * apart from the log, run against a database that already has Decisions.
 *
 * SQLite cannot add the columns in place without a rebuild, so the generated
 * migration recreates `decisions`: every waiting question, every answer and
 * every pickup log must come through byte for byte, with its indexes, and an
 * existing row must come out with the new columns empty — which is what the
 * stack reads as "derive the lines from the old fields".
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1791535812457;
const NEW_COLUMNS = ["summary", "recommendation", "pickupReport"];

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

const readRows = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "decisions" ORDER BY "id"`);

function without(rows: Row[], columns: string[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column))),
  );
}

const narration = "I opened the deal.\n\nRegistered on BidNet — “quoted” & ünïcode.";

const decisions: Row[] = [
  {
    id: "d-1-waiting",
    companyId: "co-1",
    employeeId: "emp-1",
    routineId: "routine-1",
    runId: "run-1",
    conversationId: null,
    title: "Decide UTA RFP UTA27 response by Oct 8 15:00 CT",
    body: "## Why this needs a human decision\nA public-sector commitment.\n\nWhat happened: an RFP.",
    optionsJson: '[{"id":"bid","label":"Bid","detail":null,"tone":"primary"}]',
    status: "pending",
    urgency: "high",
    createdAt: "2026-10-08 09:00:00",
    snoozedUntil: "2026-10-10 09:00:00",
  },
  {
    id: "d-2-answered",
    companyId: "co-1",
    employeeId: "emp-1",
    routineId: null,
    runId: null,
    conversationId: "chat-1",
    title: "Sign Acme's renewal?",
    body: "",
    optionsJson: "[]",
    status: "decided",
    urgency: "normal",
    chosenOptionId: "sign",
    chosenOptionLabel: "Sign it",
    note: "Go ahead.",
    decidedByUserId: "user-1",
    decidedAt: "2026-10-08 10:00:00",
    createdAt: "2026-10-08 09:30:00",
    pickupStatus: "done",
    pickupSummary: narration,
    pickupStartedAt: "2026-10-08 10:00:01",
    pickupFinishedAt: "2026-10-08 11:04:00",
  },
];

test("DecisionSummaries keeps every Decision, its log and its indexes, with the new lines empty", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-decision-summaries-migration-"));
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

  for (const row of decisions) {
    await source
      .createQueryBuilder()
      .insert()
      .into("decisions", Object.keys(row))
      .values(row)
      .execute();
  }
  const before = await readRows(source);
  const beforeSchema = schemaSnapshot(await tableOf(source, "decisions"));
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
    migrations: [DecisionSummaries1791535812457],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["DecisionSummaries1791535812457"],
  );

  // Every Decision survives intact, its log included, with the new lines empty.
  const upgraded = await readRows(source);
  assert.deepEqual(without(upgraded, NEW_COLUMNS), before);
  assert.deepEqual(
    upgraded.map((row) => [row.summary, row.recommendation, row.pickupReport]),
    [
      [null, null, null],
      [null, null, null],
    ],
    "older rows derive their lines on read",
  );
  assert.equal(upgraded[1].pickupSummary, narration);

  const after = schemaSnapshot(await tableOf(source, "decisions"));
  assert.deepEqual(
    after.columns.filter((column) => NEW_COLUMNS.includes(column.name)),
    [
      { name: "pickupReport", type: "text", nullable: true, primary: false, default: undefined },
      {
        name: "recommendation",
        type: "varchar",
        nullable: true,
        primary: false,
        default: undefined,
      },
      { name: "summary", type: "varchar", nullable: true, primary: false, default: undefined },
    ],
  );
  assert.deepEqual(
    after.columns.filter((column) => !NEW_COLUMNS.includes(column.name)),
    beforeSchema.columns,
  );
  assert.deepEqual(after.indexes, beforeSchema.indexes, "the stack's indexes survive the rebuild");
  assert.ok(
    after.indexes.some(
      (index) => index.columns.join(",") === "companyId,status" && index.unique === false,
    ),
  );

  // New rows carry the lines; old rows keep reading as they did.
  await source.query(
    `UPDATE "decisions" SET "summary" = 'UTA wants bids by Oct 8.', "recommendation" = 'Bid.', "pickupReport" = NULL WHERE "id" = 'd-1-waiting'`,
  );
  await source.query(
    `UPDATE "decisions" SET "pickupReport" = 'Registered on BidNet.' WHERE "id" = 'd-2-answered'`,
  );
  assert.deepEqual(
    (await readRows(source)).map((row) => [
      row.id,
      row.summary,
      row.recommendation,
      row.pickupReport,
    ]),
    [
      ["d-1-waiting", "UTA wants bids by Oct 8.", "Bid.", null],
      ["d-2-answered", null, null, "Registered on BidNet."],
    ],
  );

  // Rolling back removes only the new columns; every row is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "decisions")), beforeSchema);
  assert.deepEqual(await readRows(source), before);
  assert.equal(await source.showMigrations(), true);

  // And it applies again cleanly.
  await source.runMigrations();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "decisions")), after);
  assert.deepEqual(without(await readRows(source), NEW_COLUMNS), before);
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same three nullable columns, and drops only them", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-DecisionSummaries.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  const down = source.slice(source.indexOf("async down("));
  assert.deepEqual(
    [...up.matchAll(/ADD "(\w+)" ([\w ]+)`/g)].map((match) => [match[1], match[2]]),
    [
      ["summary", "character varying"],
      ["recommendation", "character varying"],
      ["pickupReport", "text"],
    ],
  );
  assert.doesNotMatch(up, /NOT NULL|DROP/);
  assert.deepEqual(
    [...down.matchAll(/DROP COLUMN "(\w+)"/g)].map((match) => match[1]).sort(),
    [...NEW_COLUMNS].sort(),
  );
});
