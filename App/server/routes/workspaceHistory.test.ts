import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel, type ChannelKind } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import type { Company } from "../db/entities/Company.js";
import type { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  encodeCursor,
} from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * The Workspace's own history, `GET …/workspace/channels/:channelId/history`,
 * end to end through `createApp()` with real API keys. Scrolling up in the
 * Workspace and the Home peek used to ask `GET …/messages` for the messages
 * written strictly before the oldest one on screen — a timestamp. SQLite
 * stamps a message to the second, so every other message sharing that second
 * was skipped. The history pages on (createdAt, id) instead, like the AI
 * tool `list_workspace_messages`, and keeps deleted messages as the line the
 * Workspace shows in their place.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let member: User;
let memberKey: string;

beforeEach(async () => {
  await resetTestDb();
  ({ user: member, company } = await createMemberOfNewCompany("member"));
  memberKey = (await mintTestApiKey(member.id, company.id)).token;
});

type Message = { id: string; content: string; createdAt: string; deletedAt: string | null };
type Body = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
  messages?: Message[];
};

async function get(path: string, token = memberKey, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function channel(kind: ChannelKind, slug: string, companyId = company.id) {
  return insert(Channel, {
    companyId,
    kind,
    name: kind === "dm" ? null : slug,
    slug: kind === "dm" ? null : slug,
    topic: "",
    webhookToken: null,
    createdByUserId: member.id,
    archivedAt: null,
    lastMessageAt: null,
  });
}

/** A second-precision stamp, the way SQLite's own `datetime('now')` writes one. */
function second(offset: number): string {
  return new Date(Date.UTC(2026, 6, 26, 18, 0, 0) + offset * 1_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

type Seeded = { id: string; createdAt: string; deleted: boolean };

/**
 * Messages stamped to the second as the Workspace posts them: `seconds[i]` is
 * the second message `i` was written in. Every fifth one is deleted.
 */
async function seed(ch: Channel, seconds: number[], from = 0): Promise<Seeded[]> {
  const rows = seconds.map((offset, i) => ({
    id: randomUUID(),
    content: `Message ${from + i}`,
    deleted: (from + i) % 5 === 4,
    createdAt: second(offset),
  }));
  // Written as SQLite writes them, text to the second: through an entity, a
  // Date would be stored to the millisecond and hide the very ties at issue.
  for (const row of rows) {
    await AppDataSource.query(
      `INSERT INTO channel_messages (id, channelId, authorKind, authorUserId, content, tainted, deletedAt, createdAt, updatedAt)
       VALUES (?, ?, 'user', ?, ?, 0, ?, ?, ?)`,
      [
        row.id,
        ch.id,
        member.id,
        row.deleted ? "" : row.content,
        row.deleted ? "2026-07-27 00:00:00.000" : null,
        row.createdAt,
        row.createdAt,
      ],
    );
  }
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, deleted: row.deleted }));
}

/** The conversation in the order the Workspace shows it: oldest first, ties by id. */
function conversation(rows: Seeded[]): string[] {
  return [...rows]
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
    .map((row) => row.id);
}

/**
 * 250 messages, the way a busy channel fills: 120 two to a second, then 60
 * in one second (an AI Employee's burst, a webhook flood), then 70 seven to a
 * second.
 */
function busySeconds(): number[] {
  return [
    ...Array.from({ length: 120 }, (_, i) => Math.floor(i / 2)),
    ...Array.from({ length: 60 }, () => 100),
    ...Array.from({ length: 70 }, (_, i) => 200 + Math.floor(i / 7)),
  ];
}

/** Scroll all the way up: every page, newest first, following nextCursor. */
async function scrollBack(ch: Channel, limit?: number, token = memberKey) {
  const pages: Message[][] = [];
  const bodies: Body[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 400; guard++) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const page = await get(`/workspace/channels/${ch.id}/history?${query}`, token);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body.messages!);
    bodies.push(page.body);
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null, "the last page has no cursor");
      // Oldest page last; each page reads oldest first.
      return { pages, bodies, ids: [...pages].reverse().flat().map((row) => row.id) };
    }
    assert.match(page.body.note ?? "", /nextCursor/);
    cursor = page.body.nextCursor!;
  }
  throw new Error("the history never ended");
}

describe("GET …/workspace/channels/:channelId/history", () => {
  test("reaches every message exactly once, 60 of them sharing one second, at any page size", async () => {
    const general = await channel("public", "general");
    const seeded = await seed(general, busySeconds());
    const expected = conversation(seeded);
    for (const limit of [1, 7, 40, 200]) {
      const { ids, pages, bodies } = await scrollBack(general, limit);
      assert.equal(new Set(ids).size, ids.length, `limit ${limit}: no message twice`);
      assert.deepEqual(ids, expected, `limit ${limit}: every message once, in the conversation's order`);
      assert.ok(bodies.every((body) => body.total === 250), "total counts every message");
      assert.ok(
        pages.slice(0, -1).every((page) => page.length === limit),
        "every page but the last is full",
      );
      const keys = Object.keys(bodies[0]);
      assert.ok(keys.indexOf("total") < keys.indexOf("messages"), "paging facts come first");
    }
    const firstPage = (await get(`/workspace/channels/${general.id}/history`)).body;
    assert.equal(firstPage.messages!.length, 50, "50 by default");
    assert.equal(firstPage.messages!.at(-1)!.id, expected.at(-1), "the first page ends at the newest");
  });

  test("keeps deleted messages, empty, as the line the Workspace shows in their place", async () => {
    const general = await channel("public", "general");
    const seeded = await seed(general, busySeconds());
    const { pages } = await scrollBack(general, 40);
    const byId = new Map(pages.flat().map((row) => [row.id, row]));
    for (const row of seeded) {
      const shown = byId.get(row.id)!;
      assert.equal(shown.deletedAt !== null, row.deleted);
    }
    assert.equal(seeded.filter((row) => row.deleted).length, 50);
  });

  test("the timestamp the Workspace paged back with passes over messages; the cursor does not", async () => {
    const general = await channel("public", "general");
    await seed(general, busySeconds());
    // The old loader: the newest 40, then whatever came strictly before the
    // oldest message on screen, until a page came back short.
    const seen = new Set<string>();
    let beforeInstant: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const query = new URLSearchParams({ limit: "40" });
      if (beforeInstant) query.set("before", beforeInstant);
      const page = await fetch(
        `${baseUrl}/api/companies/${company.id}/workspace/channels/${general.id}/messages?${query}`,
        { headers: { authorization: `Bearer ${memberKey}` } },
      );
      const rows = (await page.json()) as Message[];
      for (const row of rows) seen.add(row.id);
      if (rows.length < 40) break;
      beforeInstant = rows[0].createdAt;
    }
    assert.ok(seen.size < 250, `the timestamp loader reached only ${seen.size} of 250`);
    const { ids } = await scrollBack(general, 40);
    assert.equal(new Set(ids).size, 250);
  });

  test("messages posted, deleted or removed between pages are neither skipped nor repeated", async () => {
    const general = await channel("public", "general");
    const seeded = await seed(general, busySeconds());
    const first = await get(`/workspace/channels/${general.id}/history?limit=40`);
    const seen = first.body.messages!.map((row) => row.id);
    // Life goes on while the reader scrolls: new messages arrive at the
    // bottom, one not yet read is deleted, and the row the cursor names is
    // removed outright.
    await seed(general, [5_000, 5_000, 5_001], 1_000);
    const unread = seeded.filter((row) => !seen.includes(row.id));
    await AppDataSource.getRepository(ChannelMessage).update(
      { id: unread[10].id },
      { deletedAt: new Date(), content: "" },
    );
    await AppDataSource.getRepository(ChannelMessage).delete({ id: seen[0] });
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await get(
        `/workspace/channels/${general.id}/history?limit=40&cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(page.status, 200, page.body.error);
      seen.push(...page.body.messages!.map((row) => row.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length, "no message twice");
    assert.deepEqual(new Set(seen), new Set(seeded.map((row) => row.id)), "every message once");
  });

  test("before narrows the history to messages written before an instant", async () => {
    const general = await channel("public", "general");
    const seeded = await seed(general, busySeconds());
    const instant = new Date(Date.UTC(2026, 6, 26, 18, 0, 0) + 100_000).toISOString();
    const page = await get(
      `/workspace/channels/${general.id}/history?limit=25&before=${encodeURIComponent(instant)}`,
    );
    assert.equal(page.status, 200, page.body.error);
    assert.equal(page.body.total, 120, "strictly before the burst's second");
    let cursor = page.body.nextCursor!;
    const ids = page.body.messages!.map((row) => row.id);
    while (cursor) {
      const next = await get(
        `/workspace/channels/${general.id}/history?limit=25&before=${encodeURIComponent(instant)}&cursor=${encodeURIComponent(cursor)}`,
      );
      ids.push(...next.body.messages!.map((row) => row.id));
      cursor = next.body.nextCursor ?? "";
    }
    assert.deepEqual(new Set(ids), new Set(seeded.slice(0, 120).map((row) => row.id)));
    const withoutBefore = await get(
      `/workspace/channels/${general.id}/history?cursor=${encodeURIComponent(page.body.nextCursor!)}`,
    );
    assert.equal(withoutBefore.status, 400);
    assert.equal(withoutBefore.body.error, CURSOR_OTHER_FILTERS);
    assert.equal(
      (await get(`/workspace/channels/${general.id}/history?before=yesterday`)).status,
      400,
    );
  });

  test("a large limit is cut to 200, and a nonsense one is refused", async () => {
    const general = await channel("public", "general");
    await seed(general, busySeconds());
    const big = await get(`/workspace/channels/${general.id}/history?limit=5000`);
    assert.equal(big.status, 200, "cut, not refused");
    assert.equal(big.body.messages!.length, 200);
    assert.equal(big.body.hasMore, true);
    for (const limit of ["0", "10001", "many"]) {
      assert.equal((await get(`/workspace/channels/${general.id}/history?limit=${limit}`)).status, 400);
    }
  });

  test("a cursor works only for its own channel, company and list", async () => {
    const general = await channel("public", "general");
    const random = await channel("public", "random");
    await seed(general, busySeconds());
    await seed(random, busySeconds());
    const first = await get(`/workspace/channels/${general.id}/history?limit=10`);
    const cursor = encodeURIComponent(first.body.nextCursor!);
    const elsewhere = await get(`/workspace/channels/${random.id}/history?limit=10&cursor=${cursor}`);
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.error, CURSOR_OTHER_FILTERS);

    const foreign = encodeCursor("revenue.contacts", "f", [0, "2026-01-01", "2026-01-01", "id"]);
    const otherList = await get(`/workspace/channels/${general.id}/history?cursor=${foreign}`);
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    const garbled = await get(`/workspace/channels/${general.id}/history?cursor=!!!`);
    assert.equal(garbled.status, 400);
    assert.equal(garbled.body.error, CURSOR_INVALID);
    const cut = await get(
      `/workspace/channels/${general.id}/history?cursor=${cursor.slice(0, -6)}`,
    );
    assert.equal(cut.status, 400);

    // An AI Employee's pages leave deleted messages out, so its cursors are
    // its own, and the Workspace's are not the tool's.
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Jamie",
      slug: "jamie",
      role: "Operations",
      soulBody: "",
    });
    const token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    try {
      const tool = async (body: Record<string, unknown>) => {
        const response = await fetch(`${baseUrl}/api/internal/mcp/tools/list_workspace_messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Body };
      };
      const toolPage = await tool({ channel: "general", limit: 10 });
      assert.equal(toolPage.status, 200, toolPage.body.error);
      const toolCursor = encodeURIComponent(toolPage.body.nextCursor!);
      const fromTool = await get(`/workspace/channels/${general.id}/history?cursor=${toolCursor}`);
      assert.equal(fromTool.status, 400);
      assert.equal(fromTool.body.error, CURSOR_OTHER_FILTERS);
      const toTool = await tool({ channel: "general", cursor: first.body.nextCursor });
      assert.equal(toTool.status, 400);
      assert.equal(toTool.body.error, CURSOR_OTHER_FILTERS);
    } finally {
      revokeMcpToken(token);
    }
  });

  test("reads only rooms the caller can open, and never another company's", async () => {
    const board = await channel("private", "board");
    await seed(board, [1, 2, 3]);
    assert.equal((await get(`/workspace/channels/${board.id}/history`)).status, 404);
    await insert(ChannelMember, {
      channelId: board.id,
      memberKind: "user",
      userId: member.id,
      employeeId: null,
      lastReadAt: null,
    });
    const joined = await get(`/workspace/channels/${board.id}/history`);
    assert.equal(joined.status, 200, joined.body.error);
    assert.equal(joined.body.total, 3);

    const strangersDm = await channel("dm", "dm");
    await seed(strangersDm, [1]);
    assert.equal((await get(`/workspace/channels/${strangersDm.id}/history`)).status, 404);

    const { user: outsider, company: other } = await createMemberOfNewCompany("owner");
    const theirs = await channel("public", "theirs", other.id);
    await seed(theirs, [1, 2]);
    assert.equal(
      (await get(`/workspace/channels/${theirs.id}/history`)).status,
      404,
      "another company's channel, asked for under this company",
    );
    assert.equal(
      (await get(`/workspace/channels/${theirs.id}/history`, memberKey, other.id)).status,
      401,
      "an API key answers for its own company only",
    );
    const outsiderKey = (await mintTestApiKey(outsider.id, other.id)).token;
    const general = await channel("public", "general");
    await seed(general, [1]);
    assert.equal(
      (await get(`/workspace/channels/${general.id}/history`, outsiderKey, company.id)).status,
      401,
      "nor for another company's",
    );
    assert.equal(
      (await get(`/workspace/channels/${general.id}/history`, outsiderKey, other.id)).status,
      404,
    );
  });
});

describe("GET …/workspace/channels/:channelId/messages", () => {
  test("keeps its plain array: the newest messages oldest first, a shared second in one order", async () => {
    const general = await channel("public", "general");
    const seeded = await seed(general, busySeconds());
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/workspace/channels/${general.id}/messages`,
      { headers: { authorization: `Bearer ${memberKey}` } },
    );
    assert.equal(response.status, 200);
    const rows = (await response.json()) as Message[];
    assert.ok(Array.isArray(rows), "a plain array, as API clients have always read it");
    assert.deepEqual(
      rows.map((row) => row.id),
      conversation(seeded).slice(-50),
      "the newest 50, oldest first, messages sharing a second ordered by id",
    );
    const refused = await fetch(
      `${baseUrl}/api/companies/${company.id}/workspace/channels/${general.id}/messages?limit=201`,
      { headers: { authorization: `Bearer ${memberKey}` } },
    );
    assert.equal(refused.status, 400, "its own limit is unchanged");
  });
});

describe("the API reference", () => {
  test("documents the history with its cursor, and the messages route's before", () => {
    const document = buildOpenApiDocument(app) as unknown as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string }>; description?: string }>>;
    };
    const history = document.paths["/api/companies/{cid}/workspace/channels/{channelId}/history"]?.get;
    assert.ok(history, "the history is documented");
    const names = (history.parameters ?? []).map((parameter) => parameter.name);
    for (const name of ["limit", "cursor", "before"]) assert.ok(names.includes(name), name);
    assert.match(history.description ?? "", /never skipped or repeated/);
    const messages = document.paths["/api/companies/{cid}/workspace/channels/{channelId}/messages"]?.get;
    assert.ok(messages);
    assert.ok((messages.parameters ?? []).some((parameter) => parameter.name === "before"));
  });
});
