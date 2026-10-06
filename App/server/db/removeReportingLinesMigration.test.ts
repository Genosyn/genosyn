import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource, type Table } from "typeorm";

import { RemoveReportingLines1791278784463 } from "./migrations/1791278784463-RemoveReportingLines.js";

/**
 * The SQLite migration that removes reporting lines, run against a database
 * that has them.
 *
 * SQLite cannot drop a column in place, so the generated migration rebuilds
 * `ai_employees` (and `decision_policies`, whose `deciderKind` default moves
 * from the retired `manager` to `employee`). A rebuild is exactly where rows,
 * columns, or the unique slug index can go missing, so this builds the real
 * previous schema from the migration chain, fills it with employees that
 * report to employees and to Members, and checks what survives.
 */

type Row = Record<string, string | number | null>;
const migrationTimestamp = 1791278784463;
const REMOVED = ["reportsToEmployeeId", "reportsToUserId"];

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
      .map((index) => ({
        name: index.name,
        columns: index.columnNames,
        unique: index.isUnique,
      }))
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

const employees: Row[] = [
  {
    id: "emp-1-lead",
    companyId: "co-1",
    name: "Lead",
    slug: "lead",
    role: "Head of Ops",
    createdAt: "2026-09-01 09:00:00.000",
    soulBody: "Run the floor.\n```\nfenced\n```",
    avatarKey: "lead.png",
    teamId: "team-ops",
    reportsToEmployeeId: null,
    reportsToUserId: "user-manager",
    browserEnabled: 1,
    browserAllowedHosts: "*.example.com\nexample.org",
    browserApprovalRequired: 0,
  },
  {
    id: "emp-2-ada",
    companyId: "co-1",
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    createdAt: "2026-09-02 09:00:00.000",
    soulBody: "Résumé & <details>",
    avatarKey: null,
    teamId: "team-ops",
    reportsToEmployeeId: "emp-1-lead",
    reportsToUserId: null,
    browserEnabled: 0,
    browserAllowedHosts: null,
    browserApprovalRequired: 1,
  },
  {
    id: "emp-3-bo",
    companyId: "co-1",
    name: "Bo",
    slug: "bo",
    role: "Writer",
    createdAt: "2026-09-03 09:00:00.000",
    soulBody: "",
    avatarKey: null,
    teamId: null,
    reportsToEmployeeId: null,
    reportsToUserId: null,
    browserEnabled: 0,
    browserAllowedHosts: null,
    browserApprovalRequired: 1,
  },
  {
    // Same slug, another company: the unique index is per company.
    id: "emp-4-other",
    companyId: "co-2",
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    createdAt: "2026-09-04 09:00:00.000",
    soulBody: "",
    avatarKey: null,
    teamId: null,
    reportsToEmployeeId: "emp-4-other",
    reportsToUserId: null,
    browserEnabled: 0,
    browserAllowedHosts: null,
    browserApprovalRequired: 1,
  },
];

const policies: Row[] = [
  {
    id: "rule-1-manager",
    companyId: "co-1",
    askingEmployeeId: null,
    deciderKind: "manager",
    deciderEmployeeId: null,
    sortOrder: 0,
    enabled: 1,
    createdAt: "2026-09-05 09:00:00.000",
    updatedAt: "2026-09-05 09:00:00.000",
  },
  {
    id: "rule-2-named",
    companyId: "co-1",
    askingEmployeeId: "emp-3-bo",
    deciderKind: "employee",
    deciderEmployeeId: "emp-1-lead",
    sortOrder: 1,
    enabled: 0,
    createdAt: "2026-09-06 09:00:00.000",
    updatedAt: "2026-09-06 09:00:00.000",
  },
];

test("RemoveReportingLines drops the reporting columns and keeps every employee, team, and rule", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-reporting-lines-migration-"));
  const database = path.join(testDir, "migration.sqlite");
  let source: DataSource | null = null;
  t.after(async () => {
    if (source?.isInitialized) await source.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

  // The real previous schema, built by the migration chain itself rather than
  // by today's entities or by this migration's own down().
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
    ["ai_employees", employees],
    ["decision_policies", policies],
  ] as const) {
    await source
      .createQueryBuilder()
      .insert()
      .into(table, Object.keys(rows[0]))
      .values(rows)
      .execute();
  }
  assert.deepEqual(await readRows(source, "ai_employees"), employees);
  assert.deepEqual(await readRows(source, "decision_policies"), policies);
  const beforeEmployees = schemaSnapshot(await tableOf(source, "ai_employees"));
  const beforePolicies = schemaSnapshot(await tableOf(source, "decision_policies"));
  for (const column of REMOVED) {
    assert.ok(
      beforeEmployees.columns.some((c) => c.name === column),
      `${column} existed`,
    );
  }
  await source.destroy();

  // Re-open at this migration alone, so nothing later in the chain or in
  // today's entities can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [RemoveReportingLines1791278784463],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["RemoveReportingLines1791278784463"],
  );

  // Every employee survives with every other column intact; only the
  // reporting line is gone. The Team stays.
  const upgraded = await readRows(source, "ai_employees");
  assert.deepEqual(upgraded, without(employees, REMOVED));
  for (const row of upgraded) {
    for (const column of REMOVED) assert.ok(!(column in row), `${column} is gone`);
  }
  assert.deepEqual(
    upgraded.map((row) => row.teamId),
    ["team-ops", "team-ops", null, null],
  );
  const afterEmployees = schemaSnapshot(await tableOf(source, "ai_employees"));
  assert.deepEqual(
    afterEmployees.columns,
    beforeEmployees.columns.filter((column) => !REMOVED.includes(column.name)),
  );
  assert.deepEqual(afterEmployees.indexes, beforeEmployees.indexes);
  assert.ok(
    afterEmployees.indexes.some(
      (index) => index.unique && index.columns.join(",") === "companyId,slug",
    ),
    "the per-company slug stays unique",
  );
  await assert.rejects(
    source.query(
      `INSERT INTO "ai_employees" ("id", "companyId", "name", "slug", "role") VALUES ('dup', 'co-1', 'Ada Two', 'ada', 'Analyst')`,
    ),
    /UNIQUE constraint failed/,
  );

  // Decision rules survive exactly, the retired manager rule included — it is
  // data an admin decides about, not something a migration may drop.
  assert.deepEqual(await readRows(source, "decision_policies"), policies);
  const afterPolicies = schemaSnapshot(await tableOf(source, "decision_policies"));
  assert.deepEqual(afterPolicies.indexes, beforePolicies.indexes);
  assert.deepEqual(
    afterPolicies.columns.filter((column) => column.name !== "deciderKind"),
    beforePolicies.columns.filter((column) => column.name !== "deciderKind"),
  );
  await source.query(
    `INSERT INTO "decision_policies" ("id", "companyId", "deciderEmployeeId") VALUES ('rule-3-default', 'co-1', 'emp-1-lead')`,
  );
  const [defaulted] = await source.query(
    `SELECT "deciderKind" FROM "decision_policies" WHERE "id" = 'rule-3-default'`,
  );
  assert.equal(defaulted.deciderKind, "employee", "a rule now defaults to naming its decider");
  await source.query(`DELETE FROM "decision_policies" WHERE "id" = 'rule-3-default'`);

  // Rolling back restores the columns, empty: the reporting lines themselves
  // are not recoverable, which is the point of removing them.
  await source.undoLastMigration();
  assert.deepEqual(schemaSnapshot(await tableOf(source, "ai_employees")), beforeEmployees);
  assert.deepEqual(schemaSnapshot(await tableOf(source, "decision_policies")), beforePolicies);
  const rolledBack = await readRows(source, "ai_employees");
  assert.deepEqual(without(rolledBack, REMOVED), without(employees, REMOVED));
  for (const row of rolledBack) {
    for (const column of REMOVED) assert.equal(row[column], null);
  }
  assert.deepEqual(await readRows(source, "decision_policies"), policies);
  assert.equal(await source.showMigrations(), true);

  await source.runMigrations();
  assert.deepEqual(await readRows(source, "ai_employees"), without(employees, REMOVED));
  assert.deepEqual(schemaSnapshot(await tableOf(source, "ai_employees")), afterEmployees);
  assert.deepEqual(schemaSnapshot(await tableOf(source, "decision_policies")), afterPolicies);
  assert.equal(await source.showMigrations(), false);
});
