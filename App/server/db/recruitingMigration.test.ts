import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";

import { EmployeeRecruitingGrant } from "./entities/EmployeeRecruitingGrant.js";
import { RecruitingApplication } from "./entities/RecruitingApplication.js";
import { RecruitingApplicationEvent } from "./entities/RecruitingApplicationEvent.js";
import { RecruitingOpening } from "./entities/RecruitingOpening.js";
import { RecruitingScorecard } from "./entities/RecruitingScorecard.js";
import { RecruitingSettings } from "./entities/RecruitingSettings.js";
import { Recruiting1792568830336 } from "./migrations/1792568830336-Recruiting.js";

/**
 * The migration that adds Recruiting: six new tables and nothing else.
 *
 * What matters is that it touches no existing table, that the unique indexes
 * the feature leans on are really there — one settings row per company, one
 * custom domain per install, one slug per company, one Grant per employee,
 * and one Application per browser submission (which is what makes a retried
 * apply idempotent) — and that the tables are exactly what the entities
 * describe, so a fresh install that migrates and a test database that
 * synchronizes see the same schema. The Postgres stream is checked by reading
 * its SQL, the way the other migration tests do.
 */

const migrationTimestamp = 1792568830336;

const NEW_TABLES = [
  "employee_recruiting_grants",
  "recruiting_application_events",
  "recruiting_applications",
  "recruiting_openings",
  "recruiting_scorecards",
  "recruiting_settings",
];

const ENTITIES = [
  RecruitingSettings,
  RecruitingOpening,
  RecruitingApplication,
  RecruitingScorecard,
  RecruitingApplicationEvent,
  EmployeeRecruitingGrant,
];

type IndexShape = { columns: string; unique: boolean };

/** The indexes each table must carry, as `columns` in declaration order. */
const EXPECTED_INDEXES: Record<string, IndexShape[]> = {
  employee_recruiting_grants: [
    { columns: "companyId", unique: false },
    { columns: "employeeId", unique: true },
  ],
  recruiting_application_events: [
    { columns: "applicationId,occurredAt", unique: false },
    { columns: "companyId,occurredAt", unique: false },
  ],
  recruiting_applications: [
    { columns: "companyId,candidateEmail", unique: false },
    { columns: "companyId,createdAt", unique: false },
    { columns: "openingId,clientSubmissionId", unique: true },
    { columns: "openingId,stage,createdAt", unique: false },
    { columns: "screenStatus,screenQueuedAt", unique: false },
  ],
  recruiting_openings: [
    { columns: "companyId,slug", unique: true },
    { columns: "companyId,status,updatedAt", unique: false },
  ],
  recruiting_scorecards: [
    { columns: "applicationId,createdAt", unique: false },
    { columns: "companyId,createdAt", unique: false },
  ],
  recruiting_settings: [
    { columns: "companyId", unique: true },
    { columns: "customDomain", unique: true },
  ],
};

async function tableNames(source: DataSource): Promise<string[]> {
  const rows: Array<{ name: string }> = await source.query(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
  );
  return rows.map((row) => row.name);
}

/** Every table and index definition outside the new tables, to prove they are untouched. */
async function otherSchema(
  source: DataSource,
): Promise<Array<{ name: string; sql: string | null }>> {
  const rows: Array<{ name: string; tbl_name: string; sql: string | null }> = await source.query(
    `SELECT "name", "tbl_name", "sql" FROM "sqlite_master" WHERE "name" NOT LIKE 'sqlite_%' ORDER BY "type", "name"`,
  );
  return rows
    .filter((row) => !NEW_TABLES.includes(row.tbl_name))
    .map((row) => ({ name: row.name, sql: row.sql }));
}

async function indexes(source: DataSource, table: string): Promise<IndexShape[]> {
  const runner = source.createQueryRunner();
  try {
    const found = await runner.getTable(table);
    assert.ok(found, `${table} exists`);
    return found.indices
      .map((index) => ({ columns: index.columnNames.join(","), unique: Boolean(index.isUnique) }))
      .sort((a, b) => a.columns.localeCompare(b.columns));
  } finally {
    await runner.release();
  }
}

/** The migration's SQL for one stream, split into its `up` and `down` halves. */
async function migrationHalves(dir: string): Promise<{ up: string; down: string }> {
  const migrationDir = fileURLToPath(new URL(dir, import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-Recruiting.ts"));
  assert.ok(file, `a Recruiting migration ships in ${dir}`);
  const source = await readFile(path.join(migrationDir, file), "utf8");
  return {
    up: source.slice(source.indexOf("async up("), source.indexOf("async down(")),
    down: source.slice(source.indexOf("async down(")),
  };
}

/** Column names per `CREATE TABLE` statement, in the order the SQL declares them. */
function createdColumns(up: string): Record<string, string[]> {
  const tables: Record<string, string[]> = {};
  for (const match of up.matchAll(/CREATE TABLE "(\w+)" \((.+?)\)`\)/g)) {
    tables[match[1]] = [...match[2].matchAll(/(?:^|, )"(\w+)" /g)].map((column) => column[1]);
  }
  return tables;
}

/** Each `CREATE INDEX` as one comparable line: name, table, columns and uniqueness. */
function createdIndexes(up: string): string[] {
  return [...up.matchAll(/CREATE (UNIQUE )?INDEX "(IDX_\w+)" ON "(\w+)" \(([^)]*)\)/g)]
    .map((match) => `${match[1] ? "unique " : ""}${match[2]} ON ${match[3]} (${match[4]})`)
    .sort();
}

test("Recruiting adds its six tables with the indexes the feature relies on, touches nothing else, and rolls back", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-recruiting-migration-"));
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
  const before = await tableNames(source);
  for (const table of NEW_TABLES) assert.equal(before.includes(table), false, `${table} is new`);
  const schemaBefore = await otherSchema(source);
  await source.destroy();

  // Re-open at this migration alone, so nothing later can mask what it does.
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [Recruiting1792568830336],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["Recruiting1792568830336"],
  );
  assert.deepEqual(
    await tableNames(source),
    [...before, ...NEW_TABLES].sort(),
    "only the six Recruiting tables appear",
  );
  assert.deepEqual(await otherSchema(source), schemaBefore, "no existing table or index changes");
  for (const table of NEW_TABLES) {
    assert.deepEqual(await indexes(source, table), EXPECTED_INDEXES[table], table);
  }

  const db = source;
  const insert = (table: string, row: Record<string, unknown>) =>
    db.createQueryBuilder().insert().into(table, Object.keys(row)).values(row).execute();
  const read = async (table: string, id: string) =>
    (await db.query(`SELECT * FROM "${table}" WHERE "id" = ?`, [id]))[0] as Record<string, unknown>;

  // Settings: the defaults a company starts from, one row per company, and a
  // custom domain only one company may hold. Companies without a domain
  // (NULL) never collide with each other.
  await insert("recruiting_settings", { id: "s-1", companyId: "co-1" });
  const settings = await read("recruiting_settings", "s-1");
  assert.equal(settings.siteEnabled, 0, "the careers site starts switched off");
  assert.equal(settings.siteVisibility, "public");
  assert.equal(settings.accentColor, "#4f46e5");
  assert.equal(settings.allowIndexing, 1);
  assert.equal(settings.autoScreen, 1);
  assert.equal(settings.confirmationEmailEnabled, 1);
  assert.equal(settings.customDomain, null);
  assert.equal(settings.customDomainError, "");
  assert.equal(settings.screenerEmployeeId, null);
  assert.equal(settings.screeningInstructions, null);
  assert.equal(settings.rejectionEmailBody, null, "no template stored means the default one");
  await assert.rejects(insert("recruiting_settings", { id: "s-2", companyId: "co-1" }), /UNIQUE/);
  await insert("recruiting_settings", { id: "s-3", companyId: "co-2" });
  await db.query(
    `UPDATE "recruiting_settings" SET "customDomain" = 'jobs.acme.test' WHERE "id" = 's-1'`,
  );
  await assert.rejects(
    db.query(
      `UPDATE "recruiting_settings" SET "customDomain" = 'jobs.acme.test' WHERE "id" = 's-3'`,
    ),
    /UNIQUE/,
  );

  // Openings: a new one is a public, full-time, onsite draft with no
  // criteria, and a slug is unique within its company only.
  await insert("recruiting_openings", {
    id: "o-1",
    companyId: "co-1",
    slug: "backend",
    title: "Backend",
  });
  const opening = await read("recruiting_openings", "o-1");
  assert.equal(opening.status, "draft");
  assert.equal(opening.visibility, "public");
  assert.equal(opening.employmentType, "full_time");
  assert.equal(opening.workplace, "onsite");
  assert.equal(opening.compensationCurrency, "USD");
  assert.equal(opening.compensationPeriod, "year");
  assert.equal(opening.compensationMinMinor, null);
  assert.equal(opening.headcount, 1);
  assert.equal(opening.criteriaSource, "member");
  assert.equal(opening.criteriaJson, "[]");
  assert.equal(opening.questionsJson, "[]");
  assert.equal(opening.formJson, "{}");
  assert.equal(opening.publishedAt, null);
  await assert.rejects(
    insert("recruiting_openings", {
      id: "o-2",
      companyId: "co-1",
      slug: "backend",
      title: "Again",
    }),
    /UNIQUE/,
  );
  await insert("recruiting_openings", {
    id: "o-3",
    companyId: "co-2",
    slug: "backend",
    title: "Theirs",
  });

  // Applications: a new one is applied and unscreened; the stage clock is
  // required; one browser submission makes one Application, while rows with
  // no submission id (people the company added) never collide.
  const application = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    companyId: "co-1",
    openingId: "o-1",
    candidateName: "Ada Lovelace",
    candidateEmail: "ada@example.test",
    stageChangedAt: "2026-10-01 09:00:00",
    ...extra,
  });
  await insert("recruiting_applications", application("a-1", { clientSubmissionId: "sub-1" }));
  const applied = await read("recruiting_applications", "a-1");
  assert.equal(applied.stage, "applied");
  assert.equal(applied.source, "careers_site");
  assert.equal(applied.screenStatus, "none");
  assert.equal(applied.screenAttempts, 0);
  assert.equal(applied.score, null);
  assert.equal(applied.latestScorecardId, null);
  assert.equal(applied.injectionFlag, 0);
  assert.equal(applied.confirmationEmailStatus, "");
  assert.equal(applied.resumeTextStatus, "none");
  assert.equal(applied.answersJson, "[]");
  assert.equal(applied.resumeText, "");
  await assert.rejects(
    insert("recruiting_applications", application("a-2", { clientSubmissionId: "sub-1" })),
    /UNIQUE/,
  );
  await insert(
    "recruiting_applications",
    application("a-3", { openingId: "o-3", clientSubmissionId: "sub-1" }),
  );
  await insert("recruiting_applications", application("a-4"));
  await insert("recruiting_applications", application("a-5"));
  const { stageChangedAt: _stageChangedAt, ...withoutStageClock } = application("a-6");
  await assert.rejects(insert("recruiting_applications", withoutStageClock), /NOT NULL/);

  // Scorecards and timeline lines start empty and unflagged.
  await insert("recruiting_scorecards", {
    id: "sc-1",
    companyId: "co-1",
    openingId: "o-1",
    applicationId: "a-1",
    authorKind: "screener",
  });
  const scorecard = await read("recruiting_scorecards", "sc-1");
  assert.equal(scorecard.score, null);
  assert.equal(scorecard.unverifiedQuotes, 0);
  assert.equal(scorecard.injectionDetected, 0);
  assert.equal(scorecard.criteriaFingerprint, "");
  assert.equal(scorecard.ratingsJson, "[]");
  await insert("recruiting_application_events", {
    id: "e-1",
    companyId: "co-1",
    openingId: "o-1",
    applicationId: "a-1",
    kind: "applied",
    actorKind: "candidate",
    occurredAt: "2026-10-01 09:00:00",
  });
  const event = await read("recruiting_application_events", "e-1");
  assert.equal(event.metaJson, "{}");
  assert.equal(event.body, "");
  assert.equal(event.actorName, "");

  // One Grant per employee, and a bare one reads.
  await insert("employee_recruiting_grants", { id: "g-1", companyId: "co-1", employeeId: "emp-1" });
  assert.equal((await read("employee_recruiting_grants", "g-1")).accessLevel, "read");
  await assert.rejects(
    insert("employee_recruiting_grants", { id: "g-2", companyId: "co-1", employeeId: "emp-1" }),
    /UNIQUE/,
  );

  // Rolling back removes the six tables and leaves everything else as it was.
  await source.undoLastMigration();
  assert.deepEqual(await tableNames(source), before);
  assert.deepEqual(await otherSchema(source), schemaBefore);
  await source.runMigrations();
  assert.equal(await source.showMigrations(), false);
});

test("the migrated tables are exactly what the entities describe", async (t) => {
  const source = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: ENTITIES,
    migrations: [Recruiting1792568830336],
    synchronize: false,
    logging: false,
  });
  t.after(async () => {
    if (source.isInitialized) await source.destroy();
  });
  await source.initialize();
  await source.runMigrations();

  assert.deepEqual(source.entityMetadatas.map((metadata) => metadata.tableName).sort(), NEW_TABLES);
  const runner = source.createQueryRunner();
  try {
    for (const metadata of source.entityMetadatas) {
      const table = await runner.getTable(metadata.tableName);
      assert.ok(table, `${metadata.tableName} was migrated`);
      assert.deepEqual(
        table.columns.map((column) => column.name).sort(),
        metadata.columns.map((column) => column.databaseName).sort(),
        `${metadata.tableName} has the entity's columns, no more and no fewer`,
      );
    }
  } finally {
    await runner.release();
  }

  // The drift check `scripts/testSaasPostgres.ts` runs against Postgres: with
  // the migration applied, synchronizing the entities has nothing left to do.
  const drift = await source.driver.createSchemaBuilder().log();
  assert.deepEqual(
    drift.upQueries.map((query) => query.query),
    [],
    "the entities and the migrated schema agree on every column, default and index",
  );
});

test("the Postgres stream creates the same tables, columns and indexes, and drops only them", async () => {
  const sqlite = await migrationHalves("./migrations/");
  const postgres = await migrationHalves("./migrations/postgres/");

  const postgresTables = createdColumns(postgres.up);
  assert.deepEqual(Object.keys(postgresTables).sort(), NEW_TABLES);
  assert.deepEqual(
    postgresTables,
    createdColumns(sqlite.up),
    "both streams declare the same columns in the same order",
  );
  assert.deepEqual(
    createdIndexes(postgres.up),
    createdIndexes(sqlite.up),
    "both streams create the same indexes under the same names",
  );
  assert.equal(createdIndexes(postgres.up).length, 15);
  assert.doesNotMatch(postgres.up, /ALTER TABLE|DROP/);

  // Every moment the feature schedules or orders by is zone-aware, as every
  // `dateTimeColumnType` column is on Postgres.
  for (const column of [
    "stageChangedAt",
    "occurredAt",
    "screenQueuedAt",
    "screenStartedAt",
    "scoredAt",
    "consentAt",
    "applyBy",
    "publishedAt",
    "closedAt",
    "criteriaUpdatedAt",
    "customDomainVerifiedAt",
    "customDomainCheckedAt",
  ]) {
    assert.match(postgres.up, new RegExp(`"${column}" TIMESTAMP WITH TIME ZONE`), column);
  }
  assert.match(postgres.up, /"stageChangedAt" TIMESTAMP WITH TIME ZONE NOT NULL/);
  assert.match(postgres.up, /"occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL/);

  const reverse = [
    "employee_recruiting_grants",
    "recruiting_application_events",
    "recruiting_scorecards",
    "recruiting_applications",
    "recruiting_openings",
    "recruiting_settings",
  ];
  for (const half of [sqlite.down, postgres.down]) {
    assert.deepEqual(
      [...half.matchAll(/DROP TABLE "(\w+)"/g)].map((match) => match[1]),
      reverse,
    );
    assert.deepEqual(
      [...half.matchAll(/DROP INDEX (?:"public"\.)?"(IDX_\w+)"/g)].map((match) => match[1]).sort(),
      createdIndexes(sqlite.up)
        .map((line) => /(IDX_\w+)/.exec(line)![1])
        .sort(),
      "down drops exactly the indexes up created",
    );
    assert.doesNotMatch(half, /ALTER TABLE|CREATE/);
  }
});
