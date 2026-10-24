import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { DataSource, type MigrationInterface } from "typeorm";

import { CompanyAIModels1792830643846 } from "./migrations/1792830643846-CompanyAIModels.js";
import { BackfillCompanyAIModels1792830733839 } from "./migrations/1792830733839-BackfillCompanyAIModels.js";
import { DropEmployeeOwnedModelColumns1792830870041 } from "./migrations/1792830870041-DropEmployeeOwnedModelColumns.js";
import { CompanyAIModels1792830665611 } from "./migrations/postgres/1792830665611-CompanyAIModels.js";
import { BackfillCompanyAIModels1792830737384 } from "./migrations/postgres/1792830737384-BackfillCompanyAIModels.js";
import { DropEmployeeOwnedModelColumns1792830885016 } from "./migrations/postgres/1792830885016-DropEmployeeOwnedModelColumns.js";

/**
 * The migrations that make AI Models company-owned, run both ways on a
 * database holding what installs really have: several companies and
 * employees, several models per employee with one active (and one employee
 * with none flagged), backup keys, key health, copies the old Reuse made,
 * Routine, mailbox and Work-session pins, and an orphan whose employee is gone.
 *
 * Up, every row keeps its id and becomes a company model attached to its
 * employee — credentials, backup keys, key health, active flag, context window
 * and concurrent-Run setting all carried — and nothing is merged. Down, every
 * model goes back to one employee: a model shared since gets a copy per extra
 * employee, with that employee's pins moved onto it.
 *
 * SQLite always runs; Postgres runs against the disposable loopback server
 * named by GENOSYN_TEST_POSTGRES_URL (as `npm run test:saas-postgres` does),
 * and its generated stream is checked statically everywhere.
 */

const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));
const postgresDir = path.join(migrationsDir, "postgres");
const FIRST_SQLITE = 1792830643846;
const FIRST_POSTGRES = 1792830665611;

async function priorMigrations(dir: string, before: number): Promise<string[]> {
  return (await readdir(dir))
    .filter((name) => /^\d+-.*\.(?:ts|js)$/.test(name) && Number(name.split("-")[0]) < before)
    .map((name) => path.join(dir, name));
}

/** One database, spoken to in SQLite's `?` placeholders whatever the driver. */
type Db = {
  kind: "sqlite" | "postgres";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  columns(table: string): Promise<string[]>;
  insert(table: string, values: Record<string, unknown>): Promise<void>;
};

/** better-sqlite3 binds no booleans or dates: store them the way TypeORM does. */
function sqliteValue(value: unknown): unknown {
  if (typeof value === "boolean") return Number(value);
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "");
  return value;
}

function sqliteDb(source: DataSource): Db {
  return {
    kind: "sqlite",
    query: (sql, params = []) => source.query(sql, params.map(sqliteValue)),
    async columns(table) {
      const rows: Array<{ name: string }> = await source.query(`PRAGMA table_info("${table}")`);
      return rows.map((row) => row.name);
    },
    async insert(table, values) {
      const info: Array<{ name: string; notnull: number; dflt_value: unknown; pk: number; type: string }> =
        await source.query(`PRAGMA table_info("${table}")`);
      const row = { ...values };
      for (const column of info) {
        if (column.name in row || column.pk || !column.notnull || column.dflt_value !== null) continue;
        row[column.name] = /int|bool/i.test(column.type) ? 0 : `fixture-${column.name}`;
      }
      const names = Object.keys(row);
      await source.query(
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        names.map((n) => sqliteValue(row[n])),
      );
    },
  };
}

function postgresDb(source: DataSource): Db {
  const numbered = (sql: string) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  return {
    kind: "postgres",
    query: (sql, params = []) => source.query(numbered(sql), params),
    async columns(table) {
      const rows: Array<{ column_name: string }> = await source.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      return rows.map((row) => row.column_name);
    },
    async insert(table, values) {
      const info: Array<{ column_name: string; is_nullable: string; column_default: unknown; data_type: string }> =
        await source.query(
          `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name = $1`,
          [table],
        );
      const row = { ...values };
      for (const column of info) {
        if (column.column_name in row || column.is_nullable === "YES" || column.column_default !== null) {
          continue;
        }
        row[column.column_name] = /int|numeric/.test(column.data_type)
          ? 0
          : column.data_type === "boolean"
            ? false
            : column.data_type === "uuid"
              ? randomUUID()
              : /timestamp/.test(column.data_type)
                ? new Date()
                : `fixture-${column.column_name}`;
      }
      const names = Object.keys(row);
      await source.query(
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map((_n, i) => `$${i + 1}`).join(", ")})`,
        names.map((n) => row[n]),
      );
    },
  };
}

const ids = () => ({
  co1: randomUUID(),
  co2: randomUUID(),
  ada: randomUUID(),
  grace: randomUUID(),
  linus: randomUUID(),
  mira: randomUUID(),
  gone: randomUUID(),
  claude: randomUUID(),
  endpoint: randomUUID(),
  copy: randomUUID(),
  chatgpt: randomUUID(),
  older: randomUUID(),
  newer: randomUUID(),
  orphan: randomUUID(),
  routine: randomUUID(),
  mailbox: randomUUID(),
  session: randomUUID(),
});
type Ids = ReturnType<typeof ids>;

const CLAUDE_CONFIG = JSON.stringify({
  apiKeyEncrypted: "v2.Y28x.aXYx.dGFnMQ.Y2xhdWRlLXByaW1hcnk",
  apiKeyPreview: "sk-…0001",
  apiKeyId: "key-primary",
  backupKeys: [
    { id: "key-backup", apiKeyEncrypted: "v2.Y28x.aXYy.dGFnMg.Y2xhdWRlLWJhY2t1cA", apiKeyPreview: "sk-…0002" },
  ],
});
const ENDPOINT_CONFIG = JSON.stringify({
  baseURLEncrypted: "v2.Y28x.aXYz.dGFnMw.ZW5kcG9pbnQ",
  baseURLPreview: "gpu-box:8000",
  modelId: "qwen3",
});
const CHATGPT_CONFIG = JSON.stringify({
  codexAccessTokenEncrypted: "v2.bW9kZWw.aXY0.dGFnNA.dG9rZW4",
  subscriptionCredentialKind: "accessToken",
});

/** Rows as an install upgrading today holds them, in the employee-owned schema. */
async function seedEmployeeOwned(db: Db, id: Ids): Promise<void> {
  for (const [employee, company, name] of [
    [id.ada, id.co1, "Ada"],
    [id.grace, id.co1, "Grace"],
    [id.mira, id.co1, "Mira"],
    [id.linus, id.co2, "Linus"],
  ] as const) {
    await db.insert("ai_employees", {
      id: employee,
      companyId: company,
      name,
      slug: `${name.toLowerCase()}-${employee.slice(0, 8)}`,
      role: "Operations",
    });
  }
  const model = (values: Record<string, unknown>) =>
    db.insert("ai_models", {
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: "{}",
      ...values,
    });
  await model({
    id: id.claude,
    employeeId: id.ada,
    isActive: true,
    configJson: CLAUDE_CONFIG,
    contextWindow: 1_000_000,
    contextWindowSource: "probed",
    connectedAt: new Date("2026-10-01T10:00:00.000Z"),
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
  });
  await model({
    id: id.endpoint,
    employeeId: id.ada,
    isActive: false,
    provider: "custom",
    model: "qwen3",
    authMode: "customEndpoint",
    configJson: ENDPOINT_CONFIG,
    contextWindow: 65_536,
    contextWindowSource: "manual",
    maxConcurrentRuns: 2,
    createdAt: new Date("2026-10-02T10:00:00.000Z"),
  });
  // What the old Reuse made: Grace's byte-for-byte copy of Ada's Claude.
  await model({
    id: id.copy,
    employeeId: id.grace,
    isActive: true,
    configJson: CLAUDE_CONFIG,
    createdAt: new Date("2026-10-03T10:00:00.000Z"),
  });
  await model({
    id: id.chatgpt,
    employeeId: id.linus,
    isActive: true,
    provider: "openai",
    model: "auto",
    authMode: "subscription",
    configJson: CHATGPT_CONFIG,
    createdAt: new Date("2026-10-04T10:00:00.000Z"),
  });
  // Mira has two models and neither flagged: the newest is the one she uses.
  await model({
    id: id.older,
    employeeId: id.mira,
    isActive: false,
    configJson: CLAUDE_CONFIG,
    createdAt: new Date("2026-10-05T10:00:00.000Z"),
  });
  await model({
    id: id.newer,
    employeeId: id.mira,
    isActive: false,
    provider: "openai",
    model: "gpt-5.5",
    configJson: JSON.stringify({ apiKeyEncrypted: "v2.a.b.c.d", apiKeyPreview: "sk-…0009" }),
    createdAt: new Date("2026-10-06T10:00:00.000Z"),
  });
  // An employee long gone left this one behind.
  await model({ id: id.orphan, employeeId: id.gone, isActive: true, configJson: CLAUDE_CONFIG });

  for (const [modelId, keyId, status] of [
    [id.claude, "key-primary", null],
    [id.claude, "key-backup", 402],
    [id.copy, "key-primary", 401],
    [id.orphan, "key-primary", null],
  ] as const) {
    await db.insert("ai_model_key_health", {
      id: randomUUID(),
      modelId,
      keyId,
      lastErrorStatus: status,
      lastUsedAt: new Date("2026-10-07T10:00:00.000Z"),
    });
  }
  await db.insert("routines", {
    id: id.routine,
    employeeId: id.ada,
    name: "Nightly",
    slug: "nightly",
    cronExpr: "0 3 * * *",
    modelId: id.endpoint,
  });
  await db.insert("mail_accounts", {
    id: id.mailbox,
    companyId: id.co1,
    address: "ops@example.test",
    aiAnalysisEmployeeId: id.grace,
    aiAnalysisModelId: id.copy,
  });
  await db.insert("repository_work_sessions", {
    id: id.session,
    companyId: id.co1,
    repositoryId: randomUUID(),
    employeeId: id.ada,
    instruction: "Plan",
    modelId: id.claude,
  });
}

type Attachment = { employeeId: string; modelId: string; companyId: string; isActive: boolean };

async function attachments(db: Db): Promise<Attachment[]> {
  const rows = await db.query<Attachment>(
    `SELECT "employeeId", "modelId", "companyId", "isActive" FROM "employee_models"`,
  );
  return rows
    .map((row) => ({ ...row, isActive: Boolean(row.isActive) }))
    .sort((a, b) => `${a.employeeId}${a.modelId}`.localeCompare(`${b.employeeId}${b.modelId}`));
}

async function modelsById(db: Db): Promise<Map<string, Record<string, unknown>>> {
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM "ai_models"`);
  return new Map(rows.map((row) => [String(row.id), row]));
}

/** Everything the up migrations promise, read back with plain SQL. */
async function assertCompanyOwned(db: Db, id: Ids): Promise<void> {
  const columns = await db.columns("ai_models");
  assert.ok(columns.includes("companyId"));
  assert.ok(!columns.includes("employeeId"), "employeeId is gone from ai_models");
  assert.ok(!columns.includes("isActive"), "isActive moved to employee_models");

  const models = await modelsById(db);
  assert.deepEqual(
    [...models.keys()].sort(),
    [id.claude, id.endpoint, id.copy, id.chatgpt, id.older, id.newer].sort(),
    "every row kept its id; only the orphan went",
  );
  const companyOf = (modelId: string) => models.get(modelId)!.companyId;
  for (const modelId of [id.claude, id.endpoint, id.copy, id.older, id.newer]) {
    assert.equal(companyOf(modelId), id.co1);
  }
  assert.equal(companyOf(id.chatgpt), id.co2);
  // Credentials and backup keys untouched, byte for byte; settings carried.
  assert.equal(models.get(id.claude)!.configJson, CLAUDE_CONFIG);
  assert.equal(models.get(id.copy)!.configJson, CLAUDE_CONFIG);
  assert.equal(models.get(id.endpoint)!.configJson, ENDPOINT_CONFIG);
  assert.equal(models.get(id.chatgpt)!.configJson, CHATGPT_CONFIG);
  assert.equal(Number(models.get(id.endpoint)!.maxConcurrentRuns), 2);
  assert.equal(Number(models.get(id.endpoint)!.contextWindow), 65_536);
  assert.equal(models.get(id.endpoint)!.contextWindowSource, "manual");
  assert.equal(Number(models.get(id.claude)!.contextWindow), 1_000_000);

  assert.deepEqual(
    await attachments(db),
    [
      { employeeId: id.ada, modelId: id.claude, companyId: id.co1, isActive: true },
      { employeeId: id.ada, modelId: id.endpoint, companyId: id.co1, isActive: false },
      { employeeId: id.grace, modelId: id.copy, companyId: id.co1, isActive: true },
      { employeeId: id.linus, modelId: id.chatgpt, companyId: id.co2, isActive: true },
      { employeeId: id.mira, modelId: id.older, companyId: id.co1, isActive: false },
      { employeeId: id.mira, modelId: id.newer, companyId: id.co1, isActive: false },
    ].sort((a, b) => `${a.employeeId}${a.modelId}`.localeCompare(`${b.employeeId}${b.modelId}`)),
  );
  // Each attachment is as old as its model, so "the most recently attached"
  // picks Mira's newer model exactly as "the most recently created" did.
  const ages = await db.query<{ same: unknown }>(
    `SELECT (a."createdAt" = m."createdAt") AS "same" FROM "employee_models" a
     INNER JOIN "ai_models" m ON m."id"${db.kind === "postgres" ? "::text" : ""} = a."modelId"`,
  );
  assert.ok(ages.length === 6 && ages.every((row) => Boolean(row.same)));
  const [miraNewest] = await db.query<{ modelId: string }>(
    `SELECT "modelId" FROM "employee_models" WHERE "employeeId" = ? ORDER BY "createdAt" DESC LIMIT 1`,
    [id.mira],
  );
  assert.equal(miraNewest.modelId, id.newer);

  // Key health still names the same model ids; the orphan's went with it.
  const health = await db.query<{ modelId: string; keyId: string; lastErrorStatus: unknown }>(
    `SELECT "modelId", "keyId", "lastErrorStatus" FROM "ai_model_key_health"`,
  );
  assert.deepEqual(
    health
      .map((row) => `${row.modelId}/${row.keyId}/${row.lastErrorStatus ?? ""}`)
      .sort(),
    [
      `${id.claude}/key-primary/`,
      `${id.claude}/key-backup/402`,
      `${id.copy}/key-primary/401`,
    ].sort(),
  );
  // Pins name the same models, still attached to their employees.
  const [routine] = await db.query<{ modelId: string }>(
    `SELECT "modelId" FROM "routines" WHERE "id" = ?`,
    [id.routine],
  );
  assert.equal(routine.modelId, id.endpoint);
  const [mailbox] = await db.query<{ aiAnalysisModelId: string }>(
    `SELECT "aiAnalysisModelId" FROM "mail_accounts" WHERE "id" = ?`,
    [id.mailbox],
  );
  assert.equal(mailbox.aiAnalysisModelId, id.copy);
}

/** Share Ada's Claude with Grace and leave one company model unattached. */
async function shareAfterUpgrade(db: Db, id: Ids): Promise<{ spare: string }> {
  await db.query(`UPDATE "employee_models" SET "isActive" = ? WHERE "employeeId" = ?`, [false, id.grace]);
  await db.insert("employee_models", {
    id: randomUUID(),
    companyId: id.co1,
    employeeId: id.grace,
    modelId: id.claude,
    isActive: true,
    createdAt: new Date("2026-10-10T10:00:00.000Z"),
  });
  await db.insert("routines", {
    id: randomUUID(),
    employeeId: id.grace,
    name: "Weekly",
    slug: "weekly",
    cronExpr: "0 9 * * 1",
    modelId: id.claude,
  });
  const spare = randomUUID();
  await db.insert("ai_models", {
    id: spare,
    companyId: id.co1,
    provider: "anthropic",
    model: "claude-sonnet-5",
    authMode: "apikey",
    configJson: CLAUDE_CONFIG,
  });
  return { spare };
}

/** Everything the down migrations promise after sharing. */
async function assertEmployeeOwnedAgain(db: Db, id: Ids, spare: string): Promise<void> {
  const columns = await db.columns("ai_models");
  assert.ok(columns.includes("employeeId"));
  assert.ok(columns.includes("isActive"));
  assert.ok(!columns.includes("companyId"));
  assert.deepEqual(await db.columns("employee_models"), [], "employee_models is gone");

  const rows = await db.query<{ id: string; employeeId: string; isActive: unknown; configJson: string }>(
    `SELECT "id", "employeeId", "isActive", "configJson" FROM "ai_models"`,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.ok(!byId.has(spare), "a model attached to nobody has nowhere to go");
  // Ada keeps her rows by id; Grace's original copy comes back to her.
  assert.equal(byId.get(id.claude)!.employeeId, id.ada);
  assert.equal(Boolean(byId.get(id.claude)!.isActive), true);
  assert.equal(byId.get(id.endpoint)!.employeeId, id.ada);
  assert.equal(byId.get(id.copy)!.employeeId, id.grace);
  assert.equal(Boolean(byId.get(id.copy)!.isActive), false);
  assert.equal(byId.get(id.chatgpt)!.employeeId, id.linus);
  assert.equal(byId.get(id.newer)!.employeeId, id.mira);
  // Grace's share of Ada's Claude becomes her own copy, active, with its health.
  const gracesCopies = rows.filter((row) => row.employeeId === id.grace && row.id !== id.copy);
  assert.equal(gracesCopies.length, 1);
  const [copy] = gracesCopies;
  assert.equal(copy.configJson, CLAUDE_CONFIG);
  assert.equal(Boolean(copy.isActive), true);
  const copiedHealth = await db.query<{ keyId: string }>(
    `SELECT "keyId" FROM "ai_model_key_health" WHERE "modelId" = ?`,
    [copy.id],
  );
  assert.deepEqual(copiedHealth.map((row) => row.keyId).sort(), ["key-backup", "key-primary"]);
  // Grace's Routine pinned to the shared model now pins her copy; Ada's is unchanged.
  const pins = await db.query<{ employeeId: string; modelId: string }>(
    `SELECT "employeeId", "modelId" FROM "routines"`,
  );
  assert.deepEqual(
    pins.map((row) => `${row.employeeId}:${row.modelId}`).sort(),
    [`${id.ada}:${id.endpoint}`, `${id.grace}:${copy.id}`].sort(),
  );
  const [session] = await db.query<{ modelId: string }>(
    `SELECT "modelId" FROM "repository_work_sessions" WHERE "id" = ?`,
    [id.session],
  );
  assert.equal(session.modelId, id.claude);
}

async function runRoundTrip(
  db: Db,
  source: DataSource,
  migrations: Array<new () => MigrationInterface>,
): Promise<void> {
  const id = ids();
  await seedEmployeeOwned(db, id);
  const executed = await source.runMigrations({ transaction: "each" });
  assert.deepEqual(
    executed.map((migration) => migration.name),
    migrations.map((Migration) => new Migration().name),
  );
  await assertCompanyOwned(db, id);

  const { spare } = await shareAfterUpgrade(db, id);
  for (let step = 0; step < migrations.length; step += 1) await source.undoLastMigration();
  await assertEmployeeOwnedAgain(db, id, spare);

  // And up again: every row — the copy included — is a company model once more.
  await source.runMigrations({ transaction: "each" });
  const after = await attachments(db);
  assert.equal(after.filter((row) => row.employeeId === id.grace).length, 2);
  assert.ok(after.every((row) => row.companyId === (row.employeeId === id.linus ? id.co2 : id.co1)));
}

test("SQLite: employee-owned models become attached company models, and come back", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "genosyn-company-models-migration-"));
  const database = path.join(dir, "migration.sqlite");
  let source: DataSource | null = null;
  t.after(async () => {
    if (source?.isInitialized) await source.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  const prior = await priorMigrations(migrationsDir, FIRST_SQLITE);
  assert.ok(prior.length > 100);
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: prior,
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  await source.runMigrations();
  await source.destroy();

  const ours = [
    CompanyAIModels1792830643846,
    BackfillCompanyAIModels1792830733839,
    DropEmployeeOwnedModelColumns1792830870041,
  ];
  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: ours,
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  await runRoundTrip(sqliteDb(source), source, ours);
});

const postgresUrl = process.env.GENOSYN_TEST_POSTGRES_URL;

test(
  "Postgres: employee-owned models become attached company models, and come back",
  {
    skip: postgresUrl
      ? false
      : "set GENOSYN_TEST_POSTGRES_URL to a disposable loopback Postgres to run it",
  },
  async (t) => {
    const maintenanceUrl = new URL(postgresUrl!);
    assert.ok(
      ["127.0.0.1", "[::1]", "localhost"].includes(maintenanceUrl.hostname),
      "only a loopback Postgres",
    );
    const name = `genosyn_models_${randomUUID().replaceAll("-", "")}`;
    const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${name}"`);
    const url = new URL(maintenanceUrl);
    url.pathname = `/${name}`;
    let source: DataSource | null = null;
    t.after(async () => {
      if (source?.isInitialized) await source.destroy();
      await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await maintenance.end();
    });
    const prepare = new Client({ connectionString: url.toString() });
    await prepare.connect();
    await prepare.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await prepare.end();

    source = new DataSource({
      type: "postgres",
      url: url.toString(),
      entities: [],
      migrations: await priorMigrations(postgresDir, FIRST_POSTGRES),
      synchronize: false,
      logging: false,
    });
    await source.initialize();
    await source.runMigrations({ transaction: "each" });
    await source.destroy();

    const ours = [
      CompanyAIModels1792830665611,
      BackfillCompanyAIModels1792830737384,
      DropEmployeeOwnedModelColumns1792830885016,
    ];
    source = new DataSource({
      type: "postgres",
      url: url.toString(),
      entities: [],
      migrations: ours,
      synchronize: false,
      logging: false,
    });
    await source.initialize();
    await runRoundTrip(postgresDb(source), source, ours);
  },
);

test("the Postgres stream ships the same three steps as SQLite", async () => {
  const files = await readdir(postgresDir);
  const read = async (suffix: string) => {
    const file = files.find((name) => name.endsWith(suffix));
    assert.ok(file, `${suffix} ships in the Postgres stream`);
    return readFile(path.join(postgresDir, file), "utf8");
  };
  const add = await read("-CompanyAIModels.ts");
  const up = add.slice(add.indexOf("async up("), add.indexOf("async down("));
  assert.match(up, /CREATE TABLE "employee_models"/);
  assert.match(up, /CREATE UNIQUE INDEX "[^"]+" ON "employee_models" \("employeeId", "modelId"\)/);
  assert.match(up, /ALTER TABLE "ai_models" ADD "companyId" character varying/);
  const backfill = await read("-BackfillCompanyAIModels.ts");
  assert.match(backfill, /INSERT INTO "employee_models"/);
  assert.match(backfill, /UPDATE "ai_models" SET "companyId"/);
  const drop = await read("-DropEmployeeOwnedModelColumns.ts");
  const dropUp = drop.slice(drop.indexOf("async up("), drop.indexOf("async down("));
  assert.match(dropUp, /DROP COLUMN "employeeId"/);
  assert.match(dropUp, /DROP COLUMN "isActive"/);
  assert.match(dropUp, /ALTER COLUMN "companyId" SET NOT NULL/);
});
