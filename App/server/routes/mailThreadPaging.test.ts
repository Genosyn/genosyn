import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { CURSOR_INVALID, CURSOR_OTHER_FILTERS, CURSOR_OTHER_LIST, encodeCursor } from "../services/listPaging.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { mailRouter } from "./mail.js";

/**
 * A mailbox's thread list pages with Load more. It used to ask for the threads
 * whose last message came strictly before the oldest one shown — a timestamp
 * — and mail is dated to the second, so every other thread sharing that
 * second was skipped. Load more now follows a keyset cursor on
 * (lastMessageAt, id), the way `search_mail` pages.
 */

let server: Server;
let origin = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", mailRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.test`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, { name: "Northwind", slug: `nw-${randomUUID()}`, ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "support@northwind.example",
    status: "paused",
    aiAnalysisEnabled: false,
  });
});

type Thread = { id: string; subject: string; lastMessageAt: string };
type ListBody = {
  error?: string;
  threads: Thread[];
  nextBefore: string | null;
  nextCursor: string | null;
};

async function list(query: string, mailbox = account) {
  const response = await fetch(`${origin}/api/companies/${company.id}/mail/accounts/${mailbox.id}/threads?${query}`);
  return { status: response.status, body: (await response.json()) as ListBody };
}

const BASE = Date.UTC(2026, 8, 24, 10, 0, 0);

/** Threads dated to the second, as mail is; `seconds[i]` is thread i's second. */
async function threads(seconds: number[], extra: (i: number) => Partial<MailThread> = () => ({}), mailbox = account) {
  const rows: MailThread[] = [];
  for (const [i, second] of seconds.entries()) {
    rows.push(
      await insert(MailThread, {
        companyId: company.id,
        accountId: mailbox.id,
        gmailThreadId: randomUUID(),
        subject: `Thread ${i}`,
        labelIds: " INBOX ",
        messageCount: 1,
        lastMessageAt: new Date(BASE + second * 1_000),
        ...extra(i),
      }),
    );
  }
  return rows;
}

/** 130 threads: 50 two to a second, then 40 in one second (a newsletter blast), then 40 more. */
function inboxSeconds(): number[] {
  return [
    ...Array.from({ length: 50 }, (_, i) => Math.floor(i / 2)),
    ...Array.from({ length: 40 }, () => 100),
    ...Array.from({ length: 40 }, (_, i) => 200 + i),
  ];
}

function newestFirst(rows: MailThread[]): string[] {
  return [...rows]
    .sort((a, b) => {
      const at = b.lastMessageAt!.getTime() - a.lastMessageAt!.getTime();
      return at || (a.id < b.id ? 1 : -1);
    })
    .map((row) => row.id);
}

async function loadAll(query: string, mailbox = account) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 400; guard++) {
    const page = await list(`${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, mailbox);
    assert.equal(page.status, 200, page.body.error);
    ids.push(...page.body.threads.map((row) => row.id));
    assert.equal(page.body.nextBefore === null, page.body.nextCursor === null);
    if (!page.body.nextCursor) return ids;
    cursor = page.body.nextCursor;
  }
  throw new Error("Load more never ended");
}

describe("GET /mail/accounts/:aid/threads, Load more by cursor", () => {
  test("reaches every thread exactly once, 40 sharing one second, at any page size", async () => {
    const rows = await threads(inboxSeconds());
    for (const limit of [1, 7, 50, 100]) {
      const ids = await loadAll(`limit=${limit}`);
      assert.equal(new Set(ids).size, ids.length, `limit ${limit}: no thread twice`);
      assert.deepEqual(ids, newestFirst(rows), `limit ${limit}: every thread once, newest first`);
    }
  });

  test("the timestamp Load more used to send skipped the threads sharing a second", async () => {
    await threads(inboxSeconds());
    const seen = new Set<string>();
    let beforeInstant: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await list(`limit=25${beforeInstant ? `&before=${encodeURIComponent(beforeInstant)}` : ""}`);
      for (const row of page.body.threads) seen.add(row.id);
      if (!page.body.nextBefore) break;
      beforeInstant = page.body.nextBefore;
    }
    assert.ok(seen.size < 130, `the timestamp reached ${seen.size} of 130`);
    assert.equal(new Set(await loadAll("limit=25")).size, 130);
  });

  test("threads arriving or archived between pages never make the rest skip or repeat", async () => {
    const rows = await threads(inboxSeconds());
    const first = await list("limit=30");
    const seen = first.body.threads.map((row) => row.id);
    // New mail arrives at the top, and an unread thread further down is archived.
    await threads([5_000, 5_000]);
    const archived = rows.find((row) => !seen.includes(row.id) && row.subject === "Thread 3")!;
    await AppDataSource.getRepository(MailThread).update({ id: archived.id }, { labelIds: "" });
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await list(`limit=30&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...page.body.threads.map((row) => row.id));
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    assert.deepEqual(
      seen,
      newestFirst(rows).filter((id) => id !== archived.id),
      "every inbox thread once; the archived one left the inbox",
    );
  });

  test("search, a label and another view each page by their own cursor", async () => {
    await threads(inboxSeconds(), (i) => ({
      subject: i % 2 ? `Invoice ${i}` : `Hello ${i}`,
      labelIds: i % 5 === 0 ? " INBOX STARRED " : " INBOX ",
    }));
    assert.equal(new Set(await loadAll("limit=9&q=invoice")).size, 65);
    assert.equal(new Set(await loadAll("limit=4&view=starred")).size, 26);
    assert.equal(new Set(await loadAll("limit=4&label=STARRED")).size, 26);
  });

  test("a cursor is refused for another view, search, mailbox or list", async () => {
    await threads(inboxSeconds());
    const second = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "finance@northwind.example",
      status: "paused",
      aiAnalysisEnabled: false,
    });
    await threads([1, 1, 1], () => ({}), second);
    const first = await list("limit=10");
    const cursor = encodeURIComponent(first.body.nextCursor!);
    for (const query of [`view=starred&cursor=${cursor}`, `q=invoice&cursor=${cursor}`]) {
      const refused = await list(query);
      assert.equal(refused.status, 400, query);
      assert.equal(refused.body.error, CURSOR_OTHER_FILTERS, query);
    }
    const otherMailbox = await list(`cursor=${cursor}`, second);
    assert.equal(otherMailbox.status, 400);
    assert.equal(otherMailbox.body.error, CURSOR_OTHER_FILTERS);
    const foreign = encodeCursor("mail.search", "x", ["2026-01-01", "id"]);
    assert.equal((await list(`cursor=${foreign}`)).body.error, CURSOR_OTHER_LIST);
    assert.equal((await list("cursor=%21%21")).body.error, CURSOR_INVALID);
  });

  test("the answer keeps nextBefore beside the cursor, for callers that page with it", async () => {
    const rows = await threads([1, 2, 3]);
    const page = await list("limit=2");
    assert.deepEqual(Object.keys(page.body), ["threads", "nextBefore", "nextCursor"]);
    assert.equal(page.body.nextBefore, rows[1].lastMessageAt!.toISOString());
    const rest = await list(`before=${encodeURIComponent(page.body.nextBefore!)}`);
    assert.deepEqual(rest.body.threads.map((row) => row.id), [rows[0].id]);
    assert.equal(rest.body.nextCursor, null);
  });
});
