import assert from "node:assert/strict";
import { test } from "node:test";

import { SupportChatWidget1793904296957 } from "./migrations/1793904296957-SupportChatWidget.js";
import { SupportChatWidget1793904310621 } from "./migrations/postgres/1793904310621-SupportChatWidget.js";

/**
 * The Chat widget starts off for everyone. Both streams only add its tables and
 * columns, and neither opens a door for a company that hasn't asked.
 */

async function queriesOf(migration: { up: (runner: never) => Promise<void> }): Promise<string[]> {
  const queries: string[] = [];
  await migration.up({
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as never);
  return queries;
}

test("Postgres only adds, and a new widget starts off", async () => {
  const queries = await queriesOf(new SupportChatWidget1793904310621());
  const widgets = queries.find((sql) => sql.startsWith(`CREATE TABLE "support_chat_widgets"`))!;
  assert.match(widgets, /"enabled" boolean NOT NULL DEFAULT false/);
  assert.match(widgets, /"allowedOriginsJson" text NOT NULL DEFAULT '\[\]'/);
  assert.ok(queries.some((sql) => sql.startsWith(`CREATE TABLE "support_chat_visitors"`)));
  assert.ok(queries.some((sql) => /ALTER TABLE "support_messages" ADD "chatVisitorId"/.test(sql)));
  assert.ok(queries.some((sql) => /ALTER TABLE "support_tickets" ADD "chatVisitorId"/.test(sql)));
  assert.ok(!queries.some((sql) => /^(DROP TABLE|DELETE|UPDATE)/.test(sql)));
});

test("SQLite adds the same, and keeps every row's mail ids as they were", async () => {
  const queries = await queriesOf(new SupportChatWidget1793904296957());
  const widgets = queries.find((sql) => sql.startsWith(`CREATE TABLE "support_chat_widgets"`))!;
  assert.match(widgets, /"enabled" boolean NOT NULL DEFAULT \(0\)/);
  assert.match(widgets, /"allowedOriginsJson" text NOT NULL DEFAULT \('\[\]'\)/);
  const messages = queries.find((sql) => sql.startsWith(`CREATE TABLE "temporary_support_messages"`))!;
  assert.match(messages, /"chatVisitorId" varchar/);
  const copied = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_support_messages"`))!;
  assert.match(copied, /"gmailMessageId"/);
  const settings = queries.find((sql) => sql.startsWith(`INSERT INTO "temporary_support_settings"`))!;
  assert.match(settings, /"helpCenterEnabled"/, "a rebuild must keep what later columns hold");
  assert.ok(queries.some((sql) => /UNIQUE INDEX .* "support_messages" \("chatVisitorId", "chatClientId"\)/.test(sql)));
  assert.ok(queries.some((sql) => /UNIQUE INDEX .* "support_messages" \("chatVisitorId", "chatSeq"\)/.test(sql)));
});
