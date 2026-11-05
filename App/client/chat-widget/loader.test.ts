import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SUPPORT_CHAT_POST_SOURCE, chatUnreadCount } from "../../shared/supportChat";
import { pollDelayMs, textParts } from "./lib";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the loader imports nothing at runtime, so it can run as a plain script on any page", () => {
  const source = fs.readFileSync(path.join(here, "loader.ts"), "utf8");
  const imports = source.match(/^import\s.*$/gm) ?? [];
  assert.ok(imports.length > 0);
  for (const line of imports) assert.match(line, /^import type /);
  assert.ok(!/\bimport\(/.test(source), "no dynamic import either");
  assert.ok(source.includes(`"${SUPPORT_CHAT_POST_SOURCE}"`));
});

test("a message becomes plain words and http links, and nothing else", () => {
  assert.deepEqual(textParts("See https://example.com/a?b=1, then write back."), [
    { kind: "text", value: "See " },
    { kind: "link", value: "https://example.com/a?b=1" },
    { kind: "text", value: ", then write back." },
  ]);
  assert.deepEqual(textParts("javascript:alert(1) and <b>bold</b>"), [
    { kind: "text", value: "javascript:alert(1) and <b>bold</b>" },
  ]);
  assert.deepEqual(textParts(""), []);
});

test("only replies count as unread, and only past where they had read", () => {
  const messages = [
    { seq: 1, from: "visitor" as const },
    { seq: 2, from: "ai" as const },
    { seq: 3, from: "visitor" as const },
    { seq: 4, from: "team" as const },
  ];
  assert.equal(chatUnreadCount(messages, 0), 2);
  assert.equal(chatUnreadCount(messages, 2), 1);
  assert.equal(chatUnreadCount(messages, 4), 0);
});

test("polling is quick while someone looks, slow while nobody does, and backs off on failure", () => {
  assert.equal(pollDelayMs({ open: true, failures: 0 }), 3_000);
  assert.equal(pollDelayMs({ open: false, failures: 0 }), 30_000);
  assert.equal(pollDelayMs({ open: true, failures: 2 }), 12_000);
  assert.equal(pollDelayMs({ open: true, failures: 20 }), 60_000);
});
