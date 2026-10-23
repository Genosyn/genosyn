import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";

import { AIModelKeyHealth1792761716910 } from "./migrations/1792761716910-AIModelKeyHealth.js";

/**
 * The migration that adds per-key health for AI Models' API keys, run on a
 * database that already holds an AI Model with a key. It only adds a table:
 * the keys themselves stay in `ai_models.configJson`, untouched.
 */

const migrationTimestamp = 1792761716910;

test("adds the key-health table beside an existing AI Model, and takes it away again", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-key-health-migration-"));
  const database = path.join(testDir, "migration.sqlite");
  let source: DataSource | null = null;
  t.after(async () => {
    if (source?.isInitialized) await source.destroy();
    await rm(testDir, { recursive: true, force: true });
  });

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
  await source.runMigrations();
  const configJson = JSON.stringify({ apiKeyEncrypted: "v2.cipher", apiKeyPreview: "sk-…0001" });
  await source.query(
    `INSERT INTO "ai_models" ("id", "employeeId", "provider", "model", "authMode", "configJson") VALUES ('model-1', 'emp-1', 'anthropic', 'claude-opus-5-5', 'apikey', ?)`,
    [configJson],
  );
  await source.destroy();

  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [AIModelKeyHealth1792761716910],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["AIModelKeyHealth1792761716910"],
  );

  const runner = source.createQueryRunner();
  try {
    const table = await runner.getTable("ai_model_key_health");
    assert.ok(table, "the table exists");
    assert.deepEqual(table.columns.map((column) => column.name).sort(), [
      "coolDownUntil",
      "createdAt",
      "id",
      "keyId",
      "lastErrorAt",
      "lastErrorKind",
      "lastErrorMessage",
      "lastErrorStatus",
      "lastUsedAt",
      "modelId",
    ]);
    const unique = table.indices.find((index) => index.isUnique);
    assert.deepEqual(unique?.columnNames, ["modelId", "keyId"]);
  } finally {
    await runner.release();
  }

  // One row per key: a second row for the same key is refused.
  await source.query(
    `INSERT INTO "ai_model_key_health" ("id", "modelId", "keyId", "lastErrorStatus") VALUES ('h-1', 'model-1', 'primary', 401)`,
  );
  await assert.rejects(
    source.query(
      `INSERT INTO "ai_model_key_health" ("id", "modelId", "keyId") VALUES ('h-2', 'model-1', 'primary')`,
    ),
    /UNIQUE/,
  );
  // The AI Model and its key are exactly as they were.
  const [model] = await source.query(`SELECT "configJson" FROM "ai_models" WHERE "id" = 'model-1'`);
  assert.equal(model.configJson, configJson);

  await source.undoLastMigration();
  const after = source.createQueryRunner();
  try {
    assert.equal(await after.getTable("ai_model_key_health"), undefined);
  } finally {
    await after.release();
  }
});

test("the Postgres stream adds the same table and unique index", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-AIModelKeyHealth.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  assert.match(up, /CREATE TABLE "ai_model_key_health"/);
  for (const column of [
    '"modelId" character varying NOT NULL',
    '"keyId" character varying NOT NULL',
    '"lastUsedAt" TIMESTAMP WITH TIME ZONE',
    '"lastErrorAt" TIMESTAMP WITH TIME ZONE',
    '"lastErrorStatus" integer',
    '"lastErrorMessage" character varying(300)',
    '"coolDownUntil" TIMESTAMP WITH TIME ZONE',
  ]) {
    assert.ok(up.includes(column), column);
  }
  assert.match(up, /CREATE UNIQUE INDEX "[^"]+" ON "ai_model_key_health" \("modelId", "keyId"\)/);
  assert.doesNotMatch(up, /ai_models/, "the AI Models table is not touched");
});
