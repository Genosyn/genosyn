import "reflect-metadata";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The migration that adds `todo_pickups` and the columns pickups read. Every
 * existing Todo keeps its text as a Member's and its depth at zero, because an
 * upgrade must start nothing and change how nothing reads.
 */
for (const [stream, dir] of [
  ["SQLite", "./migrations/"],
  ["Postgres", "./migrations/postgres/"],
] as const) {
  test(`the ${stream} stream adds pickups with one active per Todo, and safe defaults`, async () => {
    const migrationDir = fileURLToPath(new URL(dir, import.meta.url));
    const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-TodoPickups.ts"));
    assert.ok(file, "a generated migration ships for this stream");
    const source = await readFile(path.join(migrationDir, file), "utf8");
    const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
    assert.match(up, /CREATE TABLE "todo_pickups"/);
    assert.match(
      up,
      /CREATE UNIQUE INDEX "[^"]+" ON "todo_pickups" \("todoId"\) WHERE "status" IN \('queued', 'running'\)/,
    );
    assert.match(up, /"untrustedText" boolean NOT NULL DEFAULT (\(0\)|false)/);
    assert.match(up, /"tainted" boolean NOT NULL DEFAULT (\(0\)|false)/);
    assert.match(up, /"aiChainDepth" integer NOT NULL DEFAULT (\(0\)|'0')/);
    assert.match(up, /"pickupId"/);
  });
}
