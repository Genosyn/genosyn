import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LIVE_SYNC_KINDS } from "../db/subscribers/resourceChangeSubscriber.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { BOARD_LETTER_KIND } from "./boardLetters.js";
import { assertValidTriggerKind, RoutineTriggerError } from "./routineTriggers.js";

/**
 * Letters to the board stay out of the company's reach.
 *
 * The board appoints the auditor; the AI Employees it audits must not be able
 * to appoint, replace or instruct it, edit a letter's figures, trace or audit,
 * or write a letter outside the restricted turn that asks for one. The
 * guarantee is structural — no MCP tool exists for any of it — so this pins
 * the structure: the tool manifest names nothing about letters, the internal
 * tool API never touches them, and only the files below may import the letter
 * services at all. Wiring letters into an AI Employee's tools fails here
 * first, and should be a product decision a person makes (AGENTS.md §12).
 */

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files allowed to import a `boardLetter*` service, relative to `server/`. */
const ALLOWED_IMPORTERS = new Set([
  "routes/boardLetters.ts",
  "routes/companies.ts",
  "routes/employees.ts",
  // The bell leaves letters out for a Member, through `boardLetterReads.ts`.
  "routes/notifications.ts",
  "services/cron.ts",
  // Home shows an owner or admin their newest unread letter, through the same reads.
  "services/home.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    return /\.(?:ts|tsx|mjs)$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
  });
}

test("no MCP tool is about letters to the board or their auditor", () => {
  const offending = STATIC_TOOLS.filter((tool) =>
    /board.?letter|letters? to the board|\bauditor\b/i.test(`${tool.name} ${tool.description}`),
  ).map((tool) => tool.name);
  assert.deepEqual(offending, []);
});

test("the internal tool API never touches a letter or its settings", () => {
  const source = readFileSync(path.join(serverDir, "routes/mcpInternal.ts"), "utf8");
  assert.doesNotMatch(source, /boardLetter|BoardLetter|board_letter/);
});

test("only the routes, Home, the scheduler and the cleanup paths import the letter services", () => {
  const importers = sources(serverDir)
    .filter((file) => {
      const relative = path.relative(serverDir, file).split(path.sep).join("/");
      if (/^services\/boardLetter\w*\.ts$/.test(relative)) return false;
      return /from "[./]+(?:services\/)?boardLetter\w*\.js"/.test(readFileSync(file, "utf8"));
    })
    .map((file) => path.relative(serverDir, file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(importers, [...ALLOWED_IMPORTERS].sort());
});

test("nothing under the agent runtime or the MCP servers mentions letters", () => {
  for (const dir of ["mcp", "mcp-browser", "services/agent"]) {
    for (const file of sources(path.join(serverDir, dir))) {
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /boardLetter|BoardLetter|board_letter/,
        path.relative(serverDir, file),
      );
    }
  }
});

test("a letter changing state refreshes the page but can never fire a Routine", () => {
  // Every kind the resource-change subscriber registers is a Trigger kind, so
  // letters announce themselves with `trigger: false` instead of registering.
  assert.equal(LIVE_SYNC_KINDS.includes(BOARD_LETTER_KIND), false);
  assert.throws(() => assertValidTriggerKind(BOARD_LETTER_KIND), RoutineTriggerError);
});
