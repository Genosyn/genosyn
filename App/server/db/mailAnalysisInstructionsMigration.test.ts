import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { MailAnalysisInstructions1791525532236 } from "./migrations/1791525532236-MailAnalysisInstructions.js";

/**
 * The SQLite migration that gives every mailbox its AI analysis instructions
 * and every analysis its record of automatic steps, run against a database
 * that already has mailboxes and analyses.
 *
 * SQLite cannot add these columns in place without a rebuild, so the
 * generated migration recreates `mail_accounts` and `mail_inbound_analyses`.
 * A rebuild is exactly where a row, a column, or a unique index can go
 * missing — and here it also decides how every existing install upgrades:
 * an existing mailbox must come out on the default instructions (null), and
 * an existing analysis must come out with an empty record of steps.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1791525532236;

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

function without(rows: Row[], columns: string[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column))),
  );
}

const mailboxes: Row[] = [
  {
    id: "mbx-1-gmail",
    companyId: "co-1",
    connectionId: "conn-1",
    address: "owner@example.com",
    status: "active",
    historyId: "12345",
    backfilledAt: "2026-09-01 09:00:00.000",
    backfilledCount: 1200,
    aiAnalysisEnabled: 1,
    aiAnalysisEmployeeId: "emp-1",
    aiAnalysisModelId: "model-1",
    provider: "gmail",
    syncCursor: "",
    senderName: "",
  },
  {
    id: "mbx-2-imap",
    companyId: "co-1",
    connectionId: "conn-2",
    address: "avery@example.org",
    status: "paused",
    historyId: "",
    backfilledAt: null,
    backfilledCount: 0,
    aiAnalysisEnabled: 0,
    aiAnalysisEmployeeId: null,
    aiAnalysisModelId: null,
    provider: "imap",
    syncCursor: '{"v":1,"folders":{"INBOX":{"uidValidity":7,"uidNext":42}}}',
    senderName: "Avery Monroe",
  },
];

const analyses: Row[] = [
  {
    id: "ana-1",
    companyId: "co-1",
    accountId: "mbx-1-gmail",
    threadId: "thr-1",
    messageId: "msg-1",
    status: "succeeded",
    employeeId: "emp-1",
    modelId: "model-1",
    category: "marketing",
    summary: "A shop newsletter.",
    actionsJson: JSON.stringify([
      { id: "0", kind: "unsubscribe", label: "Unsubscribe", executedAt: "2026-09-02T09:00:00.000Z" },
    ]),
    errorMessage: "",
    finishedAt: "2026-09-02 08:59:00.000",
  },
  {
    id: "ana-2",
    companyId: "co-1",
    accountId: "mbx-1-gmail",
    threadId: "thr-2",
    messageId: "msg-2",
    status: "failed",
    employeeId: "emp-1",
    modelId: "model-1",
    category: "",
    summary: "",
    actionsJson: "[]",
    errorMessage: "The model was unavailable.",
    finishedAt: "2026-09-03 08:59:00.000",
  },
];

test("MailAnalysisInstructions keeps every mailbox and analysis and starts them on the defaults", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-mail-instructions-migration-"));
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

  for (const [table, rows] of [
    ["mail_accounts", mailboxes],
    ["mail_inbound_analyses", analyses],
  ] as const) {
    await source.createQueryBuilder().insert().into(table, Object.keys(rows[0])).values(rows).execute();
  }
  const beforeAccounts = await readRows(source, "mail_accounts");
  const beforeAnalyses = await readRows(source, "mail_inbound_analyses");
  const accountsSchema = schemaSnapshot(await tableOf(source, "mail_accounts"));
  const analysesSchema = schemaSnapshot(await tableOf(source, "mail_inbound_analyses"));
  assert.equal(accountsSchema.columns.some((c) => c.name === "aiAnalysisInstructions"), false);
  assert.equal(analysesSchema.columns.some((c) => c.name === "autoActionsJson"), false);
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [MailAnalysisInstructions1791525532236],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["MailAnalysisInstructions1791525532236"],
  );

  // Every mailbox survives intact, on the default instructions.
  const upgradedAccounts = await readRows(source, "mail_accounts");
  assert.deepEqual(without(upgradedAccounts, ["aiAnalysisInstructions"]), beforeAccounts);
  assert.deepEqual(
    upgradedAccounts.map((row) => row.aiAnalysisInstructions),
    [null, null],
    "existing mailboxes follow the default instructions",
  );
  // Every analysis survives intact, including a pressed button's stamp, with
  // an empty record of automatic steps: nothing ran on its own before today.
  const upgradedAnalyses = await readRows(source, "mail_inbound_analyses");
  assert.deepEqual(without(upgradedAnalyses, ["autoActionsJson"]), beforeAnalyses);
  assert.deepEqual(
    upgradedAnalyses.map((row) => row.autoActionsJson),
    ["[]", "[]"],
  );

  const afterAccounts = schemaSnapshot(await tableOf(source, "mail_accounts"));
  const afterAnalyses = schemaSnapshot(await tableOf(source, "mail_inbound_analyses"));
  assert.deepEqual(
    afterAccounts.columns.find((column) => column.name === "aiAnalysisInstructions"),
    { name: "aiAnalysisInstructions", type: "text", nullable: true, primary: false, default: undefined },
  );
  assert.deepEqual(
    afterAnalyses.columns.find((column) => column.name === "autoActionsJson"),
    { name: "autoActionsJson", type: "text", nullable: false, primary: false, default: "'[]'" },
  );
  assert.deepEqual(
    afterAccounts.columns.filter((column) => column.name !== "aiAnalysisInstructions"),
    accountsSchema.columns,
  );
  assert.deepEqual(
    afterAnalyses.columns.filter((column) => column.name !== "autoActionsJson"),
    analysesSchema.columns,
  );
  assert.deepEqual(afterAccounts.indexes, accountsSchema.indexes);
  assert.deepEqual(afterAnalyses.indexes, analysesSchema.indexes);

  // The unique indexes still hold after the rebuild.
  await assert.rejects(
    source.query(
      `INSERT INTO "mail_accounts" ("id", "companyId", "connectionId", "address") VALUES ('dup', 'co-1', 'conn-1', 'x@example.com')`,
    ),
    /UNIQUE constraint failed/,
  );
  await assert.rejects(
    source.query(
      `INSERT INTO "mail_inbound_analyses" ("id", "companyId", "accountId", "threadId", "messageId") VALUES ('dup', 'co-1', 'mbx-1-gmail', 'thr-9', 'msg-1')`,
    ),
    /UNIQUE constraint failed/,
  );

  // A mailbox connected after the upgrade starts on the default too, and a new
  // analysis starts with an empty record.
  await source.query(
    `INSERT INTO "mail_accounts" ("id", "companyId", "connectionId", "address") VALUES ('mbx-3-new', 'co-1', 'conn-3', 'new@example.com')`,
  );
  await source.query(
    `INSERT INTO "mail_inbound_analyses" ("id", "companyId", "accountId", "threadId", "messageId") VALUES ('ana-3', 'co-1', 'mbx-3-new', 'thr-3', 'msg-3')`,
  );
  const [fresh] = await source.query(
    `SELECT "aiAnalysisInstructions" FROM "mail_accounts" WHERE "id" = 'mbx-3-new'`,
  );
  assert.equal(fresh.aiAnalysisInstructions, null);
  const [freshAnalysis] = await source.query(
    `SELECT "autoActionsJson" FROM "mail_inbound_analyses" WHERE "id" = 'ana-3'`,
  );
  assert.equal(freshAnalysis.autoActionsJson, "[]");
  // A customised mailbox and a recorded step round-trip as text.
  await source.query(
    `UPDATE "mail_accounts" SET "aiAnalysisInstructions" = 'Star mail from Ana.' WHERE "id" = 'mbx-1-gmail'`,
  );
  await source.query(`DELETE FROM "mail_accounts" WHERE "id" = 'mbx-3-new'`);
  await source.query(`DELETE FROM "mail_inbound_analyses" WHERE "id" = 'ana-3'`);

  // Rolling back removes only the new columns; every row is still there.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "mail_accounts")), accountsSchema);
  assert.deepEqual(schemaSnapshot(await tableOf(source, "mail_inbound_analyses")), analysesSchema);
  assert.deepEqual(await readRows(source, "mail_accounts"), beforeAccounts);
  assert.deepEqual(await readRows(source, "mail_inbound_analyses"), beforeAnalyses);
  assert.equal(await source.showMigrations(), true);

  await source.runMigrations();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "mail_accounts")), afterAccounts);
  assert.deepEqual(schemaSnapshot(await tableOf(source, "mail_inbound_analyses")), afterAnalyses);
  assert.equal(await source.showMigrations(), false);
});
