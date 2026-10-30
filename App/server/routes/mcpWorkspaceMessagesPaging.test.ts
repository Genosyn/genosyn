import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  encodeCursor,
  TOOL_PAGE_BUDGET_CHARS,
} from "../services/listPaging.js";
import { isTokenTainted, issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * `list_workspace_messages` pages by cursor on (createdAt, id). It used to
 * page back with `before`, a timestamp: SQLite stamps a message to the
 * second, so every message sharing a second with the oldest one on a page was
 * skipped when the next page asked for what came strictly before it.
 */

let server: Server;
let baseUrl = "";
let company: Company;
let employee: AIEmployee;
let user: User;
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
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
    soulBody: "",
  });
  user = await insert(User, {
    name: "Ada",
    email: "ada@acme.example",
    passwordHash: "hash",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "member" });
});

function token(origin: Parameters<typeof issueMcpToken>[2] = { authority: "employee" }): string {
  const issued = issueMcpToken(employee.id, company.id, origin);
  tokens.push(issued);
  return issued;
}

type Page = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
};

type Row = { id: string; content: string; createdAt: string };

async function call(args: Record<string, unknown>, bearer = token()) {
  const response = await fetch(`${baseUrl}/tools/list_workspace_messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Page };
}

async function readEveryPage(args: Record<string, unknown>, bearer = token()) {
  const pages: Row[][] = [];
  const bodies: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await call({ ...args, ...(cursor ? { cursor } : {}) }, bearer);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body.messages as Row[]);
    bodies.push(page.body);
    if (!page.body.hasMore) return { pages, bodies, ids: pages.flat().map((row) => row.id) };
    assert.match(page.body.note ?? "", /nextCursor/);
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

async function channel(kind: "public" | "private", slug: string, companyId = company.id) {
  return insert(Channel, {
    companyId,
    kind,
    name: slug,
    slug,
    topic: "",
    webhookToken: null,
    createdByUserId: user.id,
    archivedAt: null,
    lastMessageAt: null,
  });
}

const BASE = Date.UTC(2026, 6, 26, 18, 0, 0);

/** Messages stamped to the second, as SQLite stamps the ones the Workspace posts. */
async function messages(
  ch: Channel,
  count: number,
  perSecond: number,
  extra: (index: number) => Partial<ChannelMessage> = () => ({}),
): Promise<ChannelMessage[]> {
  const repo = AppDataSource.getRepository(ChannelMessage);
  const rows = Array.from({ length: count }, (_, i) =>
    repo.create({
      channelId: ch.id,
      authorKind: "user",
      authorUserId: user.id,
      authorEmployeeId: null,
      content: `Message ${i}`,
      parentMessageId: null,
      tainted: false,
      createdAt: new Date(BASE + Math.floor(i / perSecond) * 1_000),
      ...extra(i),
    }),
  );
  const saved: ChannelMessage[] = [];
  for (let start = 0; start < rows.length; start += 200) {
    saved.push(...(await repo.save(rows.slice(start, start + 200))));
  }
  return saved;
}

const at = (row: Row) => Date.parse(row.createdAt);

describe("list_workspace_messages", () => {
  test("reaches every message, five to a second; each page reads oldest first and the next is older", async () => {
    const general = await channel("public", "general");
    await messages(general, 95, 5);
    const all = await readEveryPage({ channel: "general" });
    assert.equal(all.ids.length, 95);
    assert.equal(new Set(all.ids).size, 95, "no message twice, none skipped at a boundary");
    assert.deepEqual(
      all.pages.map((page) => page.length),
      [30, 30, 30, 5],
      "30 by default",
    );
    assert.ok(all.bodies.every((body) => body.total === 95));
    for (const page of all.pages) {
      const times = page.map(at);
      assert.deepEqual(times, [...times].sort((a, b) => a - b), "each page oldest first");
    }
    for (let i = 1; i < all.pages.length; i++) {
      assert.ok(at(all.pages[i].at(-1)!) <= at(all.pages[i - 1][0]), "the next page is older");
    }
    assert.equal(at(all.pages[0].at(-1)!), BASE + 18_000, "the first page ends at the newest");
    assert.match(String(all.bodies[0].note), /oldest first/);
    assert.equal(all.bodies.at(-1)!.nextCursor, null);
  });

  test("leaves deleted messages out in the query, so a page is full while more follow", async () => {
    const general = await channel("public", "general");
    await messages(general, 50, 1, (i) => (i >= 30 ? { deletedAt: new Date(BASE + 90_000) } : {}));
    const first = await call({ channel: "general", limit: 10 });
    assert.equal(first.status, 200, first.body.error);
    const rows = first.body.messages as Row[];
    assert.equal(rows.length, 10);
    assert.equal(first.body.total, 30);
    assert.deepEqual(
      rows.map((row) => row.content),
      Array.from({ length: 10 }, (_, i) => `Message ${20 + i}`),
    );
  });

  test("messages posted or deleted between pages are neither skipped nor repeated", async () => {
    const general = await channel("public", "general");
    const original = await messages(general, 60, 4);
    const bearer = token();
    const first = await call({ channel: "general", limit: 20 }, bearer);
    const seen = (first.body.messages as Row[]).map((row) => row.id);
    await messages(general, 3, 1, (i) => ({
      content: `Later ${i}`,
      createdAt: new Date(BASE + 3_600_000 + i * 1_000),
    }));
    const unread = original.filter((row) => !seen.includes(row.id));
    await AppDataSource.getRepository(ChannelMessage).update(
      { id: unread[5].id },
      { deletedAt: new Date() },
    );
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await call({ channel: "general", limit: 20, cursor }, bearer);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...(page.body.messages as Row[]).map((row) => row.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(
      new Set(seen),
      new Set(original.filter((row) => row.id !== unread[5].id).map((row) => row.id)),
    );
  });

  test("before narrows to an instant, and a cursor works only with its own channel and filters", async () => {
    const general = await channel("public", "general");
    const random = await channel("public", "random");
    await messages(general, 80, 5);
    await messages(random, 40, 5);
    const before = new Date(BASE + 10_000).toISOString();
    const narrowed = await readEveryPage({ channel: "general", before, limit: 15 });
    assert.equal(narrowed.ids.length, 50, "strictly before the second named");
    assert.equal(new Set(narrowed.ids).size, 50);
    assert.ok(narrowed.bodies.every((body) => body.total === 50));

    const first = await call({ channel: "general", before, limit: 15 });
    const withoutBefore = await call({ channel: "general", cursor: first.body.nextCursor });
    assert.equal(withoutBefore.status, 400);
    assert.equal(withoutBefore.body.error, CURSOR_OTHER_FILTERS);
    const otherChannel = await call({ channel: "random", before, cursor: first.body.nextCursor });
    assert.equal(otherChannel.body.error, CURSOR_OTHER_FILTERS);
    const otherList = await call({
      channel: "general",
      cursor: encodeCursor("phone.texts", "x", [new Date(BASE).toISOString(), "id"]),
    });
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);

    const big = await call({ channel: "general", limit: 500 });
    assert.equal(big.status, 200, "a larger limit is cut, not refused");
    assert.equal((big.body.messages as Row[]).length, 80);
    const cut = await call({ channel: "general", limit: 101 });
    assert.equal((cut.body.messages as Row[]).length, 80);
    assert.equal((await call({ channel: "general", limit: 0 })).status, 400);
  });

  test("a page holding a message a tainted turn wrote taints the turn; one without does not", async () => {
    const general = await channel("public", "general");
    await messages(general, 40, 1, (i) => (i === 0 ? { tainted: true } : {}));
    const bearer = token();
    const first = await call({ channel: "general", limit: 20 }, bearer);
    assert.equal(first.status, 200);
    assert.equal(isTokenTainted(bearer), false, "the newest 20 hold no tainted message");
    const second = await call({ channel: "general", limit: 20, cursor: first.body.nextCursor }, bearer);
    assert.equal(second.status, 200);
    assert.equal(isTokenTainted(bearer), true, "the page that shows it taints");
  });

  test("reads the same rooms as before: membership, DMs, delegated Members and the company", async () => {
    const board = await channel("private", "board");
    await messages(board, 35, 5);
    assert.equal((await call({ channel: "board" })).status, 404);
    await insert(ChannelMember, {
      channelId: board.id,
      memberKind: "ai",
      userId: null,
      employeeId: employee.id,
      lastReadAt: null,
    });
    const member = await readEveryPage({ channel: "board", limit: 10 });
    assert.equal(new Set(member.ids).size, 35);

    const other = await insert(Company, { name: "Globex", slug: "globex", ownerId: "owner" });
    const theirs = await channel("public", "theirs", other.id);
    await messages(theirs, 5, 1);
    assert.equal((await call({ channel: "theirs" })).status, 404, "another company's channel");
    assert.equal((await call({ channel: theirs.id })).status, 404);

    const dm = await call({ dmUser: user.id });
    assert.equal(dm.status, 200, dm.body.error);
    assert.equal(dm.body.total, 0);
    const stranger = await insert(User, {
      name: "Eve",
      email: "eve@acme.example",
      passwordHash: "hash",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: stranger.id, role: "member" });
    const delegated = await call(
      { dmUser: user.id },
      token({ authority: "member", requesterUserId: stranger.id, requesterSessionVersion: 0 }),
    );
    assert.equal(delegated.status, 403, "a delegated Member reads only their own DM");
    assert.equal((await call({ channel: "general", dmUser: user.id })).status, 400);
  });

  test("a page of long messages ends early instead of overflowing, and its cursor misses nothing", async () => {
    const general = await channel("public", "general");
    await messages(general, 40, 1, (i) => ({ content: `${i} `.padEnd(3_000, "x") }));
    const first = await call({ channel: "general", limit: 100 });
    const rows = first.body.messages as Row[];
    assert.ok(rows.length < 40);
    assert.ok(JSON.stringify(rows, null, 2).length <= TOOL_PAGE_BUDGET_CHARS + 4_000);
    assert.equal(first.body.hasMore, true);
    // The budget keeps the newest messages, and the page still reads oldest first.
    assert.equal(rows.at(-1)!.content.startsWith("39 "), true);
    const all = await readEveryPage({ channel: "general", limit: 100 });
    assert.equal(new Set(all.ids).size, 40);
  });
});
