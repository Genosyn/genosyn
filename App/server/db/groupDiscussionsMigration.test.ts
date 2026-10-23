import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DataSource } from "typeorm";

import { GroupDiscussions1792781452666 } from "./migrations/1792781452666-GroupDiscussions.js";

/**
 * The migration behind group discussions, run on a database that already holds
 * a channel with messages. On SQLite, adding columns to `channel_messages`
 * rebuilds the table, so the thing worth pinning is that every existing
 * message, reaction target and index comes through it unchanged — reading as
 * outside any discussion and untainted — and that it can be taken back.
 */

const migrationTimestamp = 1792781452666;

test("adds group discussions and keeps every existing message, untainted", async (t) => {
  const testDir = await mkdtemp(path.join(tmpdir(), "genosyn-group-discussions-migration-"));
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
  await source.query(
    `INSERT INTO "channels" ("id", "companyId", "kind", "name", "slug", "topic") VALUES ('ch-1', 'co-1', 'public', 'general', 'general', '')`,
  );
  await source.query(
    `INSERT INTO "channel_messages" ("id", "channelId", "authorKind", "authorUserId", "content", "createdAt") VALUES ('m-1', 'ch-1', 'user', 'u-1', 'Hello there', '2026-10-01 09:00:00.123'), ('m-2', 'ch-1', 'system', NULL, 'Deploy done', '2026-10-01 09:01:00')`,
  );
  await source.destroy();

  source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [],
    migrations: [GroupDiscussions1792781452666],
    synchronize: false,
    logging: false,
  });
  await source.initialize();
  assert.deepEqual(
    (await source.runMigrations()).map((migration) => migration.name),
    ["GroupDiscussions1792781452666"],
  );

  const rows = await source.query(
    `SELECT "id", "content", "authorUserId", "createdAt", "discussionId", "discussionRole", "tainted" FROM "channel_messages" ORDER BY "createdAt"`,
  );
  assert.deepEqual(rows, [
    {
      id: "m-1",
      content: "Hello there",
      authorUserId: "u-1",
      createdAt: "2026-10-01 09:00:00.123",
      discussionId: null,
      discussionRole: null,
      tainted: 0,
    },
    {
      id: "m-2",
      content: "Deploy done",
      authorUserId: null,
      createdAt: "2026-10-01 09:01:00",
      discussionId: null,
      discussionRole: null,
      tainted: 0,
    },
  ]);

  const runner = source.createQueryRunner();
  try {
    const messages = await runner.getTable("channel_messages");
    assert.ok(messages);
    const indexed = messages.indices.map((index) => index.columnNames.join(","));
    assert.ok(indexed.includes("channelId"), "the channel index survived the rebuild");
    assert.ok(indexed.includes("channelId,createdAt"), "so did the history index");
    assert.ok(indexed.includes("discussionId,createdAt"), "and a discussion reads in order");

    const discussions = await runner.getTable("group_discussions");
    assert.ok(discussions, "the table exists");
    for (const column of [
      "companyId",
      "channelId",
      "startedByUserId",
      "requesterSessionVersion",
      "participantsJson",
      "status",
      "phase",
      "endReason",
      "round",
      "maxRounds",
      "turnsTaken",
      "maxTurns",
      "tokensUsed",
      "tokenBudget",
      "stateJson",
      "tainted",
      "stopRequestedAt",
      "wrapUpRequestedAt",
      "heartbeatAt",
      "outcomeJson",
      "followThroughStartedAt",
    ]) {
      assert.ok(
        discussions.columns.some((c) => c.name === column),
        `group_discussions.${column}`,
      );
    }
    assert.ok(
      discussions.indices.some((i) => i.columnNames.join(",") === "status,heartbeatAt"),
      "the restart sweep finds running discussions by index",
    );
  } finally {
    await runner.release();
  }

  // A new discussion takes the defaults a running one starts from.
  await source.query(
    `INSERT INTO "group_discussions" ("id", "companyId", "channelId") VALUES ('d-1', 'co-1', 'ch-1')`,
  );
  const [fresh] = await source.query(
    `SELECT "status", "phase", "round", "maxRounds", "participantsJson", "stateJson", "tainted" FROM "group_discussions"`,
  );
  assert.deepEqual(fresh, {
    status: "running",
    phase: "discussing",
    round: 0,
    maxRounds: 3,
    participantsJson: "[]",
    stateJson: "{}",
    tainted: 0,
  });

  await source.undoLastMigration();
  const after = source.createQueryRunner();
  try {
    assert.equal(await after.getTable("group_discussions"), undefined);
    const messages = await after.getTable("channel_messages");
    assert.equal(messages?.columns.some((c) => c.name === "discussionId"), false);
  } finally {
    await after.release();
  }
  const kept = await source.query(`SELECT "id" FROM "channel_messages" ORDER BY "id"`);
  assert.deepEqual(kept, [{ id: "m-1" }, { id: "m-2" }], "undoing it keeps the messages too");
});

test("the Postgres stream adds the same table and columns, without rebuilding messages", async () => {
  const migrationDir = fileURLToPath(new URL("./migrations/postgres/", import.meta.url));
  const [file] = (await readdir(migrationDir)).filter((name) =>
    name.endsWith("-GroupDiscussions.ts"),
  );
  assert.ok(file, "a generated Postgres migration ships with the SQLite one");
  const source = await readFile(path.join(migrationDir, file), "utf8");
  const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
  assert.match(up, /CREATE TABLE "group_discussions"/);
  for (const fragment of [
    'ALTER TABLE "channel_messages" ADD "discussionId" character varying',
    'ALTER TABLE "channel_messages" ADD "discussionRole" character varying',
    'ALTER TABLE "channel_messages" ADD "tainted" boolean NOT NULL DEFAULT false',
    '"heartbeatAt" TIMESTAMP WITH TIME ZONE',
    '"outcomeJson" text',
  ]) {
    assert.ok(up.includes(fragment), fragment);
  }
  assert.match(up, /CREATE INDEX "[^"]+" ON "channel_messages" \("discussionId", "createdAt"\)/);
  assert.doesNotMatch(up, /DROP TABLE "channel_messages"/);
});
