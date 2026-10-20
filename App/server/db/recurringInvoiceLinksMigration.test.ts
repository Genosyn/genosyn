import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { RecurringInvoiceLinks1792505706358 } from "./migrations/1792505706358-RecurringInvoiceLinks.js";
import { BackfillRecurringInvoiceLinks1792505958179 } from "./migrations/1792505958179-BackfillRecurringInvoiceLinks.js";

/**
 * The SQLite migrations that let an invoice name the recurring invoice
 * schedule that created it, run against a database that already holds both.
 *
 * SQLite cannot add the column in place, so the generated migration rebuilds
 * `invoices`; every invoice must come through byte for byte with its indexes.
 * The backfill then links only what the database proves — a scheduled run's
 * own record, the audit pair every generated invoice left, or the schedule's
 * pointer to its last invoice — and never a hand-made invoice, another
 * company's, or one whose schedule is gone.
 */

type Row = Record<string, string | number | null>;
const firstTimestamp = 1792505706358;

const invoice = (id: string, companyId: string, slug: string, createdAt: string): Row => ({
  id,
  companyId,
  customerId: "cust-1",
  slug,
  status: "draft",
  issueDate: createdAt,
  dueDate: createdAt,
  totalCents: 1000,
  balanceCents: 1000,
  notes: "Includes “premium” onboarding — ünïcode.",
  createdAt,
  updatedAt: createdAt,
});

const schedule = (
  id: string,
  companyId: string,
  name: string,
  createdAt: string,
  lastInvoiceSlug = "",
): Row => ({
  id,
  companyId,
  customerId: "cust-1",
  slug: id,
  name,
  cronExpr: "0 9 1 * *",
  status: "active",
  lastInvoiceSlug,
  createdAt,
  updatedAt: createdAt,
});

let auditSeq = 0;
/** One audit row; `createdAt` carries milliseconds as `recordAudit` writes them. */
const audit = (
  companyId: string,
  action: string,
  target: { type: string; id: string; label: string },
  metadata: Record<string, unknown>,
  createdAt: string,
  actor: { kind: string; userId: string | null } = { kind: "cron", userId: null },
): Row => ({
  id: `audit-${++auditSeq}`,
  companyId,
  actorKind: actor.kind,
  actorUserId: actor.userId,
  action,
  targetType: target.type,
  targetId: target.id,
  targetLabel: target.label,
  metadataJson: JSON.stringify(metadata),
  createdAt,
});

/** The audit pair `auditScheduleStep` writes when a schedule creates an invoice:
 *  the invoice's row at `[invoiceAt]`, then the schedule's a moment later. */
function generated(
  companyId: string,
  invoiceId: string,
  scheduleId: string,
  name: string,
  [invoiceAt, runAt]: [string, string],
  actor?: { kind: string; userId: string | null },
): Row[] {
  return [
    audit(
      companyId,
      "finance.invoice.create",
      { type: "invoice", id: invoiceId, label: "Draft invoice" },
      { totalCents: 1000, schedule: name },
      invoiceAt,
      actor,
    ),
    audit(
      companyId,
      "finance.recurring_invoice.run",
      { type: "recurring_invoice", id: scheduleId, label: name },
      { totalCents: 1000 },
      runAt,
      actor,
    ),
  ];
}

const MEMBER = { kind: "user", userId: "user-1" };

const fixtures = {
  recurring_invoices: [
    schedule("r-run", "co-1", "Retainer", "2026-09-01 09:00:00"),
    schedule("r-last", "co-1", "Licence", "2026-06-01 09:00:00", "acme-inv-0007"),
    schedule("r-late", "co-1", "Support", "2026-10-01 09:00:00", "acme-inv-0002"),
    schedule("r-twin-a", "co-1", "Acme Corp", "2026-10-01 09:00:00"),
    schedule("r-twin-b", "co-1", "Acme Corp", "2026-10-01 09:00:00"),
    schedule("r-other-co", "co-2", "Retainer", "2026-09-01 09:00:00"),
  ],
  invoices: [
    invoice("i-run", "co-1", "acme-inv-0010", "2026-10-06 09:00:00"),
    invoice("i-run-now", "co-1", "draft-aaaaaa", "2026-10-14 10:00:00"),
    invoice("i-by-hand", "co-1", "draft-bbbbbb", "2026-10-14 10:00:00"),
    invoice("i-last", "co-1", "acme-inv-0007", "2026-07-01 09:00:00"),
    invoice("i-before-schedule", "co-1", "acme-inv-0002", "2026-08-01 09:00:00"),
    invoice("i-twin-a", "co-1", "draft-cccccc", "2026-10-15 09:00:00"),
    invoice("i-twin-b", "co-1", "draft-dddddd", "2026-10-15 09:00:00"),
    invoice("i-deleted-schedule", "co-1", "draft-eeeeee", "2026-10-16 09:00:00"),
    invoice("i-other-co", "co-2", "beta-inv-0001", "2026-10-06 09:00:00"),
    invoice("i-member-made", "co-1", "draft-ffffff", "2026-10-17 09:00:00"),
  ],
  recurring_invoice_runs: [
    {
      id: "run-1",
      companyId: "co-1",
      recurringInvoiceId: "r-run",
      scheduledFor: "2026-10-06 09:00:00",
      status: "succeeded",
      invoiceId: "i-run",
    },
    // Claims another company's invoice: never linked across companies.
    {
      id: "run-2",
      companyId: "co-1",
      recurringInvoiceId: "r-run",
      scheduledFor: "2026-10-07 09:00:00",
      status: "succeeded",
      invoiceId: "i-other-co",
    },
    // Its invoice was a draft someone deleted.
    {
      id: "run-3",
      companyId: "co-1",
      recurringInvoiceId: "r-run",
      scheduledFor: "2026-10-08 09:00:00",
      status: "cancelled",
      invoiceId: "i-gone",
    },
    { id: "run-4", companyId: "co-1", recurringInvoiceId: "r-run", scheduledFor: "2026-11-01 09:00:00", status: "pending", invoiceId: null },
  ] as Row[],
  audit_events: [
    // A Member's Run now: only the audit pair records it.
    ...generated(
      "co-1",
      "i-run-now",
      "r-run",
      "Retainer",
      ["2026-10-14 10:00:00.120", "2026-10-14 10:00:00.123"],
      MEMBER,
    ),
    // A hand-made invoice right before a run row: its row names no schedule.
    audit(
      "co-1",
      "finance.invoice.create",
      { type: "invoice", id: "i-by-hand", label: "Draft invoice" },
      { totalCents: 1000, currency: "USD" },
      "2026-10-14 10:00:01.000",
      MEMBER,
    ),
    audit(
      "co-1",
      "finance.recurring_invoice.run",
      { type: "recurring_invoice", id: "r-run", label: "Retainer" },
      { totalCents: 1000 },
      "2026-10-14 10:00:01.004",
      MEMBER,
    ),
    // Two schedules with the same name and total, run in one heartbeat pass:
    // each run row takes the invoice written just before it.
    // The second pair shares the first one's millisecond, so only insertion
    // order tells them apart.
    ...generated("co-1", "i-twin-a", "r-twin-a", "Acme Corp", [
      "2026-10-15 09:00:00.100",
      "2026-10-15 09:00:00.100",
    ]),
    ...generated("co-1", "i-twin-b", "r-twin-b", "Acme Corp", [
      "2026-10-15 09:00:00.100",
      "2026-10-15 09:00:00.101",
    ]),
    // A schedule since deleted: its run row names nothing that exists.
    ...generated("co-1", "i-deleted-schedule", "r-deleted", "Retainer", [
      "2026-10-16 09:00:00.100",
      "2026-10-16 09:00:00.103",
    ]),
    // A Member's invoice beside the Scheduler's run row: actors differ.
    audit(
      "co-1",
      "finance.invoice.create",
      { type: "invoice", id: "i-member-made", label: "Draft invoice" },
      { totalCents: 1000, schedule: "Retainer" },
      "2026-10-17 09:00:00.100",
      MEMBER,
    ),
    audit(
      "co-1",
      "finance.recurring_invoice.run",
      { type: "recurring_invoice", id: "r-run", label: "Retainer" },
      { totalCents: 1000 },
      "2026-10-17 09:00:00.104",
    ),
  ],
};

const EXPECTED_LINKS: Record<string, string | null> = {
  "i-run": "r-run",
  "i-run-now": "r-run",
  "i-by-hand": null,
  "i-last": "r-last",
  "i-before-schedule": null,
  "i-twin-a": "r-twin-a",
  "i-twin-b": "r-twin-b",
  "i-deleted-schedule": null,
  "i-other-co": null,
  "i-member-made": null,
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

async function invoicesSchema(source: DataSource) {
  const queryRunner = source.createQueryRunner();
  try {
    const table = await queryRunner.getTable("invoices");
    assert.ok(table, "the migration must retain invoices");
    return schemaSnapshot(table);
  } finally {
    await queryRunner.release();
  }
}

const readInvoices = (source: DataSource): Promise<Row[]> =>
  source.query(`SELECT * FROM "invoices" ORDER BY "id"`);

const withoutLink = (rows: Row[]) =>
  rows.map(({ recurringInvoiceId: _recurringInvoiceId, ...rest }) => rest);

const links = (rows: Row[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row.recurringInvoiceId ?? null]));

test("RecurringInvoiceLinks keeps every invoice and links only the ones a record proves", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-recurring-links-migration-"));
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
      (name) => /^\d+-.*\.(?:ts|js)$/.test(name) && Number(name.split("-")[0]) < firstTimestamp,
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

  for (const [table, rows] of Object.entries(fixtures)) {
    for (const row of rows) {
      await source.createQueryBuilder().insert().into(table, Object.keys(row)).values(row).execute();
    }
  }
  const before = await readInvoices(source);
  const beforeSchema = await invoicesSchema(source);
  assert.equal(
    beforeSchema.columns.some((column) => column.name === "recurringInvoiceId"),
    false,
  );
  await source.destroy();

  // Re-open at these migrations alone, so nothing later can mask what they do.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RecurringInvoiceLinks1792505706358, BackfillRecurringInvoiceLinks1792505958179],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RecurringInvoiceLinks1792505706358", "BackfillRecurringInvoiceLinks1792505958179"],
  );

  const upgraded = await readInvoices(source);
  assert.deepEqual(withoutLink(upgraded), before, "every invoice comes through the rebuild intact");
  assert.deepEqual(links(upgraded), EXPECTED_LINKS);

  const after = await invoicesSchema(source);
  assert.deepEqual(
    after.columns.find((column) => column.name === "recurringInvoiceId"),
    {
      name: "recurringInvoiceId",
      type: "varchar",
      nullable: true,
      primary: false,
      default: undefined,
    },
  );
  assert.deepEqual(
    after.columns.filter((column) => column.name !== "recurringInvoiceId"),
    beforeSchema.columns,
  );
  const added = after.indexes.filter(
    (index) => !beforeSchema.indexes.some((prior) => prior.name === index.name),
  );
  assert.deepEqual(
    added.map((index) => [index.columns.join(","), index.unique]),
    [["companyId,recurringInvoiceId", false]],
  );
  assert.deepEqual(
    after.indexes.filter((index) => index !== added[0]),
    beforeSchema.indexes,
    "the slug, status, customer, number and archive indexes survive the rebuild",
  );

  // The backfill is a no-op on the way down; the schema step drops the column.
  await source.undoLastMigration();
  assert.deepEqual(links(await readInvoices(source)), EXPECTED_LINKS);
  await source.undoLastMigration();
  assert.deepEqual(await invoicesSchema(source), beforeSchema);
  assert.deepEqual(await readInvoices(source), before);

  // And both apply again cleanly, to the same links.
  await source.runMigrations();
  assert.deepEqual(await invoicesSchema(source), after);
  assert.deepEqual(links(await readInvoices(source)), EXPECTED_LINKS);
  assert.equal(await source.showMigrations(), false);
});

test("the Postgres stream adds the same column and index, and backfills from the same records", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const files = await readdir(migrationDir);
  const [schemaFile] = files.filter((name) => name.endsWith("-RecurringInvoiceLinks.ts"));
  const [backfillFile] = files.filter((name) => name.endsWith("-BackfillRecurringInvoiceLinks.ts"));
  assert.ok(schemaFile, "a generated Postgres migration ships with the SQLite one");
  assert.ok(backfillFile, "and so does its backfill");
  assert.ok(
    Number(backfillFile.split("-")[0]) > Number(schemaFile.split("-")[0]),
    "the backfill runs after the column exists",
  );
  const schema = await readFile(path.join(migrationDir, schemaFile), "utf8");
  const up = schema.slice(schema.indexOf("async up("), schema.indexOf("async down("));
  const down = schema.slice(schema.indexOf("async down("));
  assert.match(up, /ALTER TABLE "invoices" ADD "recurringInvoiceId" character varying`/);
  assert.match(up, /CREATE INDEX "IDX_\w+" ON "invoices" \("companyId", "recurringInvoiceId"\)/);
  assert.match(down, /ALTER TABLE "invoices" DROP COLUMN "recurringInvoiceId"`/);

  const backfill = await readFile(path.join(migrationDir, backfillFile), "utf8");
  for (const source of [
    /FROM "recurring_invoice_runs" "run"/,
    /'finance\.recurring_invoice\.run'/,
    /'finance\.invoice\.create'/,
    /"ri"\."lastInvoiceSlug"/,
    /"recurringInvoiceId" IS NULL/,
  ]) {
    assert.match(backfill, source);
  }
});
