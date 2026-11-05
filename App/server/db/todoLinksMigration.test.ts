import "reflect-metadata";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The migration that adds `todo_links`: a new table and nothing else, in both
 * streams, so an install keeps every Todo as it was and Todos start with no
 * links.
 */
for (const [stream, dir] of [
  ["SQLite", "./migrations/"],
  ["Postgres", "./migrations/postgres/"],
] as const) {
  test(`the ${stream} stream only creates the links table and its two indexes`, async () => {
    const migrationDir = fileURLToPath(new URL(dir, import.meta.url));
    const [file] = (await readdir(migrationDir)).filter((name) => name.endsWith("-TodoLinks.ts"));
    assert.ok(file, "a generated migration ships for this stream");
    const source = await readFile(path.join(migrationDir, file), "utf8");
    const up = source.slice(source.indexOf("async up("), source.indexOf("async down("));
    const down = source.slice(source.indexOf("async down("));
    assert.match(up, /CREATE TABLE "todo_links"/);
    assert.match(up, /CREATE UNIQUE INDEX "[^"]+" ON "todo_links" \("todoId", "kind", "targetId"\)/);
    assert.match(up, /CREATE INDEX "[^"]+" ON "todo_links" \("companyId", "kind", "targetId"\)/);
    assert.doesNotMatch(up, /ALTER TABLE|DROP TABLE/, "nothing an install holds is altered");
    assert.match(down, /DROP TABLE "todo_links"/);
  });
}
