import "reflect-metadata";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The migration that lets a Todo wait. No existing Todo is waiting, nothing is
 * counted against it, and no comment becomes a server note.
 */
for (const [stream, dir] of [
  ["SQLite", "./migrations/"],
  ["Postgres", "./migrations/postgres/"],
] as const) {
  test(`the ${stream} stream starts every Todo not waiting`, async () => {
    const migrationDir = fileURLToPath(new URL(dir, import.meta.url));
    const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-TodoWaits.ts"));
    assert.ok(file, "a generated migration ships for this stream");
    const source = await readFile(path.join(migrationDir, file), "utf8");
    const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
    assert.match(up, /"waitingOn" (varchar|character varying)[,`) ]/);
    assert.match(up, /"followUpCount" integer NOT NULL DEFAULT (\(0\)|'0')/);
    assert.match(up, /"systemNote" boolean NOT NULL DEFAULT (\(0\)|false)/);
    assert.match(up, /CREATE INDEX "[^"]+" ON "todos" \("waitingOn", "waitingRefId"\)/);
  });
}
