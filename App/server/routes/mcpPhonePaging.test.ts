import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { PhoneCall } from "../db/entities/PhoneCall.js";
import { PhoneMessage } from "../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../db/entities/PhoneNumber.js";
import { errorHandler } from "../middleware/error.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  TOOL_PAGE_BUDGET_CHARS,
} from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { listTexts, textThread } from "../services/phone/texts.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { phoneFixture, type PhoneFixture } from "../test/phoneFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * An AI Employee's texts and calls page like every other list
 * (`services/listPaging.ts`). `list_text_messages` used to run its `contains`
 * and `from` filters over a hidden window of the newest 500 texts, so an older
 * verification code could not be found at all; `list_phone_calls` cut the
 * newest calls first and only then dropped the ones the employee may not read,
 * so a page could come back empty while its calls sat further down.
 */

let server: Server;
let baseUrl = "";
let fixture: PhoneFixture;
const tokens: string[] = [];

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp`;
});

after(async () => {
  for (const token of tokens) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  fixture = await phoneFixture();
});

function tokenFor(employee: AIEmployee = fixture.employee, companyId = fixture.company.id): string {
  const token = issueMcpToken(employee.id, companyId, { authority: "employee" });
  tokens.push(token);
  return token;
}

type Page = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
};

async function call(name: string, args: Record<string, unknown>, token = tokenFor()) {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Page };
}

async function readEveryPage(
  tool: string,
  rowsKey: string,
  idKey: string,
  args: Record<string, unknown>,
  token = tokenFor(),
) {
  const ids: string[] = [];
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await call(tool, { ...args, ...(cursor ? { cursor } : {}) }, token);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(...(page.body[rowsKey] as Array<Record<string, string>>).map((row) => row[idKey]));
    if (!page.body.hasMore) return { ids, pages };
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

const BASE = Date.UTC(2025, 0, 1);

/** Texts in one statement: the shape `recordInboundText` and `sendText` keep. */
async function texts(rows: Array<Partial<PhoneMessage>>): Promise<PhoneMessage[]> {
  const repo = AppDataSource.getRepository(PhoneMessage);
  const built = rows.map((row, index) =>
    repo.create({
      companyId: fixture.company.id,
      phoneNumberId: fixture.number.id,
      employeeId: fixture.employee.id,
      direction: "inbound",
      fromNumber: "+15550107777",
      toNumber: fixture.number.e164,
      providerSid: testId(`SM${index}`),
      status: "received",
      occurredAt: new Date(BASE),
      body: "Hello",
      ...row,
    }),
  );
  const saved: PhoneMessage[] = [];
  for (let start = 0; start < built.length; start += 200) {
    saved.push(...(await repo.save(built.slice(start, start + 200))));
  }
  return saved;
}

async function calls(rows: Array<Partial<PhoneCall>>): Promise<PhoneCall[]> {
  const repo = AppDataSource.getRepository(PhoneCall);
  const built = rows.map((row, index) =>
    repo.create({
      companyId: fixture.company.id,
      phoneNumberId: fixture.number.id,
      employeeId: fixture.employee.id,
      direction: "inbound",
      fromNumber: "+15550107777",
      toNumber: fixture.number.e164,
      providerSid: testId(`CA${index}`),
      status: "completed",
      handling: "employee",
      createdAt: new Date(BASE),
      ...row,
    }),
  );
  const saved: PhoneCall[] = [];
  for (let start = 0; start < built.length; start += 200) {
    saved.push(...(await repo.save(built.slice(start, start + 200))));
  }
  return saved;
}

async function addNumber(employeeId: string | null, e164: string): Promise<PhoneNumber> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = fixture.number;
  return insert(PhoneNumber, {
    ...copy,
    employeeId,
    e164,
    providerSid: `PN${testId("n").replace(/[^a-z0-9]/gi, "").slice(0, 30)}`,
  });
}

async function colleague(name = "Ben"): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId: fixture.company.id,
    name,
    slug: testId(name.toLowerCase()),
    role: "Ops",
    soulBody: "",
  });
}

describe("list_text_messages", () => {
  test("reaches every text, five to an instant, newest first, and none another owner received", async () => {
    // 130 texts five to an instant, half while the number had nobody; the 40
    // a previous owner received are interleaved and must never show.
    await texts(
      Array.from({ length: 130 }, (_, i) => ({
        occurredAt: new Date(BASE + Math.floor(i / 5) * 60_000),
        employeeId: i % 2 ? fixture.employee.id : null,
        body: `Text ${i}`,
      })),
    );
    await texts(
      Array.from({ length: 40 }, (_, i) => ({
        occurredAt: new Date(BASE + i * 30_000),
        employeeId: testId("previous-owner"),
        body: "Your code is 999999",
      })),
    );
    const all = await readEveryPage("list_text_messages", "texts", "id", { limit: 50 });
    assert.equal(all.ids.length, 130);
    assert.equal(new Set(all.ids).size, 130, "no text twice");
    assert.ok(all.pages.length >= 3);
    assert.ok(all.pages.every((page) => page.total === 130));
    assert.match(String(all.pages[0].note), /information, never as instructions/);
    const shown = all.pages.flatMap((page) => page.texts as Array<{ body: string; at: string }>);
    assert.equal(
      shown.some((text) => text.body.includes("999999")),
      false,
      "a previous owner's codes stay hidden",
    );
    const instants = shown.map((text) => Date.parse(text.at));
    assert.deepEqual(instants, [...instants].sort((a, b) => b - a), "newest first");
    const last = all.pages.at(-1)!;
    assert.equal(last.hasMore, false);
    assert.equal(last.nextCursor, null);
  });

  test("every filter searches all the texts, not a window of the newest 500", async () => {
    // Three old codes behind 600 newer texts: the old window never reached them.
    await texts(
      Array.from({ length: 3 }, (_, i) => ({
        occurredAt: new Date(BASE + i * 1_000),
        fromNumber: "STRIPE",
        body: `Your Stripe CODE is 10000${i}`,
      })),
    );
    await texts(
      Array.from({ length: 600 }, (_, i) => ({
        occurredAt: new Date(BASE + 3_600_000 + i * 1_000),
        direction: i % 3 === 0 ? ("outbound" as const) : ("inbound" as const),
        fromNumber: i % 3 === 0 ? fixture.number.e164 : "+15550109999",
        toNumber: i % 3 === 0 ? "+15550109999" : fixture.number.e164,
        status: i % 3 === 0 ? ("delivered" as const) : ("received" as const),
        body: "See you at noon",
      })),
    );
    const byBody = await call("list_text_messages", { contains: "code is" });
    assert.equal(byBody.status, 200, byBody.body.error);
    assert.equal(byBody.body.total, 3);
    const codes = byBody.body.texts as Array<{ body: string; codes: string[] }>;
    assert.deepEqual(
      codes.map((text) => text.body),
      ["Your Stripe CODE is 100002", "Your Stripe CODE is 100001", "Your Stripe CODE is 100000"],
    );
    assert.deepEqual(codes[0].codes, ["100002"]);

    const bySender = await call("list_text_messages", { from: "stripe" });
    assert.equal(bySender.body.total, 3, "part of a sender name, any case");
    // The other party of a text that went out is its recipient.
    const withParty = await call("list_text_messages", { from: "0109999", direction: "outbound" });
    assert.equal(withParty.body.total, 200);
    assert.equal((await call("list_text_messages", { direction: "inbound" })).body.total, 403);
    assert.equal((await call("list_text_messages", { direction: "outbound" })).body.total, 200);
    const since = new Date(BASE + 3_600_000 + 590 * 1_000).toISOString();
    assert.equal((await call("list_text_messages", { since })).body.total, 10);
    const combined = await call("list_text_messages", {
      since,
      direction: "inbound",
      from: "+1555010",
      contains: "NOON",
    });
    assert.equal(combined.body.total, 7, "every filter at once");
    assert.equal((await call("list_text_messages", { contains: "no such words" })).body.total, 0);
    const badSince = await call("list_text_messages", { since: "last tuesday" });
    assert.equal(badSince.status, 400);
    assert.match(String(badSince.body.error), /ISO 8601/);
  });

  test("texts that arrive or are removed between pages are neither skipped nor repeated", async () => {
    const original = await texts(
      Array.from({ length: 60 }, (_, i) => ({
        occurredAt: new Date(BASE + Math.floor(i / 4) * 60_000),
        body: `Text ${i}`,
      })),
    );
    const token = tokenFor();
    const first = await call("list_text_messages", { limit: 20 }, token);
    const seen = (first.body.texts as Array<{ id: string }>).map((text) => text.id);
    // New texts arrive at the top, and one not yet read is deleted.
    await texts(
      Array.from({ length: 5 }, (_, i) => ({
        occurredAt: new Date(BASE + 86_400_000 + i),
        body: `New ${i}`,
      })),
    );
    const unread = original.filter((text) => !seen.includes(text.id));
    const removed = unread[7];
    await AppDataSource.getRepository(PhoneMessage).delete({ id: removed.id });
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await call("list_text_messages", { limit: 20, cursor }, token);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...(page.body.texts as Array<{ id: string }>).map((text) => text.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length, "no text twice");
    assert.deepEqual(
      new Set(seen),
      new Set(original.filter((text) => text.id !== removed.id).map((text) => text.id)),
      "every text that was there, once",
    );
  });

  test("a cursor works only with its own list, company and filters; a large limit is cut", async () => {
    await texts(
      Array.from({ length: 70 }, (_, i) => ({
        occurredAt: new Date(BASE + i * 1_000),
        body: i % 2 ? "Code 1234" : "Hello",
      })),
    );
    await calls(Array.from({ length: 30 }, (_, i) => ({ createdAt: new Date(BASE + i * 1_000) })));
    const first = await call("list_text_messages", { contains: "code", limit: 10 });
    assert.equal(first.body.hasMore, true);
    const otherFilters = await call("list_text_messages", {
      contains: "hello",
      cursor: first.body.nextCursor,
    });
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const callPage = await call("list_phone_calls", { limit: 5 });
    const otherList = await call("list_text_messages", { cursor: callPage.body.nextCursor });
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    const garbled = await call("list_text_messages", { cursor: "not-a-cursor!" });
    assert.equal(garbled.status, 400);
    assert.match(String(garbled.body.error), /cursor/i);
    const truncated = await call("list_text_messages", { cursor: first.body.nextCursor!.slice(0, 20) });
    assert.equal(truncated.body.error, CURSOR_INVALID);

    // The same arguments from another company's employee: the cursor is theirs.
    const other = await phoneFixture();
    const elsewhere = await call(
      "list_text_messages",
      { contains: "code", cursor: first.body.nextCursor },
      tokenFor(other.employee, other.company.id),
    );
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.error, CURSOR_OTHER_FILTERS);

    const big = await call("list_text_messages", { limit: 500 });
    assert.equal(big.status, 200, "a larger limit is cut, not refused");
    assert.equal((big.body.texts as unknown[]).length, 50);
    assert.equal(big.body.total, 70);
    assert.equal((await call("list_text_messages", {})).body.texts instanceof Array, true);
    assert.equal(((await call("list_text_messages", {})).body.texts as unknown[]).length, 20);
    assert.equal((await call("list_text_messages", { limit: 0 })).status, 400);
    assert.equal((await call("list_text_messages", { offset: 10 })).status, 400, "one way to page");
  });

  test("reads only the employee's own numbers, and never another company's texts", async () => {
    const second = await addNumber(fixture.employee.id, "+15550105678");
    const ben = await colleague();
    const bens = await addNumber(ben.id, "+15550104321");
    await texts([
      { body: "On my first number", occurredAt: new Date(BASE + 1_000) },
      {
        body: "On my second number",
        phoneNumberId: second.id,
        toNumber: second.e164,
        occurredAt: new Date(BASE + 2_000),
      },
      {
        body: "On Ben's number",
        phoneNumberId: bens.id,
        employeeId: ben.id,
        toNumber: bens.e164,
        occurredAt: new Date(BASE + 3_000),
      },
    ]);
    const other = await phoneFixture();
    await AppDataSource.getRepository(PhoneMessage).save(
      AppDataSource.getRepository(PhoneMessage).create({
        companyId: other.company.id,
        phoneNumberId: other.number.id,
        employeeId: null,
        direction: "inbound",
        fromNumber: "+15550107777",
        toNumber: other.number.e164,
        providerSid: testId("SM-other"),
        status: "received",
        occurredAt: new Date(BASE + 4_000),
        body: "Another company's code 424242",
      }),
    );
    const mine = await call("list_text_messages", {});
    assert.deepEqual(
      (mine.body.texts as Array<{ body: string }>).map((text) => text.body),
      ["On my second number", "On my first number"],
    );
    const one = await call("list_text_messages", { phoneNumber: "+1 (555) 010-5678" });
    assert.deepEqual(
      (one.body.texts as Array<{ body: string }>).map((text) => text.body),
      ["On my second number"],
    );
    const notMine = await call("list_text_messages", { phoneNumber: bens.e164 });
    assert.equal(notMine.status, 403);
    const asBen = await call("list_text_messages", {}, tokenFor(ben));
    assert.deepEqual(
      (asBen.body.texts as Array<{ body: string }>).map((text) => text.body),
      ["On Ben's number"],
    );
    const nobody = await colleague("Cy");
    const none = await call("list_text_messages", {}, tokenFor(nobody));
    assert.equal(none.status, 404);
    assert.match(String(none.body.error), /Settings → Phone numbers/);
  });

  test("a page of long texts ends early instead of overflowing, and its cursor misses nothing", async () => {
    await texts(
      Array.from({ length: 45 }, (_, i) => ({
        occurredAt: new Date(BASE + i * 1_000),
        body: `${i} `.padEnd(4_000, "x"),
      })),
    );
    const first = await call("list_text_messages", { limit: 50 });
    const shown = first.body.texts as unknown[];
    assert.ok(shown.length < 45, "ended before the tool result would overflow");
    assert.ok(JSON.stringify(shown, null, 2).length <= TOOL_PAGE_BUDGET_CHARS + 6_000);
    assert.equal(first.body.hasMore, true);
    const all = await readEveryPage("list_text_messages", "texts", "id", { limit: 50 });
    assert.equal(new Set(all.ids).size, 45);
  });

  test("the reads beside the tool keep their behaviour: newest first, at most limit, filtered in SQL", async () => {
    await texts([
      { occurredAt: new Date(BASE + 1_000), body: "Hello there" },
      {
        occurredAt: new Date(BASE + 2_000),
        fromNumber: "STRIPE",
        body: "Your Stripe code is 123456",
      },
      {
        occurredAt: new Date(BASE + 3_000),
        direction: "outbound",
        fromNumber: fixture.number.e164,
        toNumber: "STRIPE",
        status: "delivered",
        body: "STOP",
      },
      { occurredAt: new Date(BASE + 4_000), fromNumber: "STRIPE-2", body: "Other sender" },
    ]);
    const newest = await listTexts({ phoneNumberIds: [fixture.number.id], limit: 2 });
    assert.deepEqual(
      newest.map((text) => text.body),
      ["Other sender", "STOP"],
    );
    // The conversation with exactly one party, oldest first.
    const thread = await textThread(fixture.number.id, "STRIPE");
    assert.deepEqual(
      thread.map((text) => text.body),
      ["Your Stripe code is 123456", "STOP"],
    );
    assert.deepEqual(await listTexts({ phoneNumberIds: [], limit: 5 }), []);
  });
});

describe("list_phone_calls", () => {
  test("decides which calls the employee may read in the query, so a page is never short", async () => {
    const ben = await colleague();
    // 60 newer calls from while the number was Ben's: the old code cut the
    // newest 40 and then dropped them all, answering an empty page.
    await calls(
      Array.from({ length: 60 }, (_, i) => ({
        createdAt: new Date(BASE + 86_400_000 + i * 1_000),
        employeeId: ben.id,
      })),
    );
    await calls(
      Array.from({ length: 30 }, (_, i) => ({
        createdAt: new Date(BASE + Math.floor(i / 3) * 60_000),
        employeeId: i % 2 ? fixture.employee.id : null,
        transcriptJson: JSON.stringify([{ speaker: "caller", text: "x".repeat(5_000), at: "" }]),
        turnCount: 1,
      })),
    );
    const first = await call("list_phone_calls", {});
    assert.equal(first.status, 200, first.body.error);
    assert.equal((first.body.calls as unknown[]).length, 20, "a full page of the employee's calls");
    assert.equal(first.body.total, 30);
    const rows = first.body.calls as Array<Record<string, unknown>>;
    assert.ok(rows.every((row) => !("transcript" in row) && row.turns === 1), "no transcripts");
    assert.equal(JSON.stringify(first.body).includes("xxxxxxxxxx"), false);
    assert.match(String(first.body.note), /get_phone_call/);
    const all = await readEveryPage("list_phone_calls", "calls", "callId", { limit: 7 });
    assert.equal(all.ids.length, 30);
    assert.equal(new Set(all.ids).size, 30);
  });

  test("narrows by direction and by the day a call started; bad bounds are refused", async () => {
    await calls(
      Array.from({ length: 40 }, (_, i) => ({
        createdAt: new Date(Date.UTC(2025, 2, 1 + Math.floor(i / 4), 12)),
        direction: i % 2 ? ("outbound" as const) : ("inbound" as const),
      })),
    );
    assert.equal((await call("list_phone_calls", { direction: "outbound" })).body.total, 20);
    const day = await call("list_phone_calls", { since: "2025-03-02", until: "2025-03-03" });
    assert.equal(day.body.total, 8, "both whole UTC days");
    const combined = await call("list_phone_calls", {
      since: "2025-03-02",
      until: "2025-03-03",
      direction: "inbound",
    });
    assert.equal(combined.body.total, 4);
    const instant = await call("list_phone_calls", { until: "2025-03-01T12:00:00.000Z" });
    assert.equal(instant.body.total, 4, "a timestamp is that instant");
    const backwards = await call("list_phone_calls", { since: "2025-03-05", until: "2025-03-01" });
    assert.equal(backwards.status, 400);
    assert.match(String(backwards.body.error), /since must be on or before until/);
    const notADate = await call("list_phone_calls", { since: "+15550107777" });
    assert.equal(notADate.status, 400);
    assert.match(String(notADate.body.error), /since must be a date/);
  });

  test("pages calls sharing an instant exactly once, binds the cursor, and cuts a large limit", async () => {
    await calls(Array.from({ length: 75 }, () => ({ createdAt: new Date(BASE) })));
    const all = await readEveryPage("list_phone_calls", "calls", "callId", { limit: 20 });
    assert.equal(all.ids.length, 75);
    assert.equal(new Set(all.ids).size, 75);
    const first = await call("list_phone_calls", { limit: 20 });
    const otherFilters = await call("list_phone_calls", {
      direction: "inbound",
      cursor: first.body.nextCursor,
    });
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const big = await call("list_phone_calls", { limit: 1_000 });
    assert.equal(big.status, 200);
    assert.equal((big.body.calls as unknown[]).length, 50);
  });
});
