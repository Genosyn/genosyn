import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import type { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  encodeCursor,
} from "../services/listPaging.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * The audit log (`GET /audit`) and a record's History (`GET /history/…`) page
 * back through `audit_events`. Both used to hand out the oldest row's
 * timestamp as the cursor and read on strictly before it — so every other
 * event audited in the same instant was skipped, and a bulk action audits
 * dozens in one millisecond. The cursor is now a keyset on (createdAt, id).
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
let owner: User;
let ownerKey: string;

beforeEach(async () => {
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  ownerKey = (await mintTestApiKey(owner.id, company.id)).token;
});

type Item = { id: string; action: string; createdAt: string };
type Body = { error?: string; items?: Item[]; nextCursor?: string | null; hasMore?: boolean };

async function get(path: string, token = ownerKey, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Body };
}

type Seeded = { id: string; createdAt: string };

/** Audit rows as `recordAudit` writes them: to the millisecond, many sharing one. */
async function audit(
  count: number,
  perInstant: number,
  values: (i: number) => Partial<{ action: string; targetType: string; targetId: string }> = () => ({}),
  companyId = company.id,
  startAt = Date.UTC(2026, 3, 1, 12),
): Promise<Seeded[]> {
  const rows: Seeded[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const createdAt = new Date(startAt + Math.floor(i / perInstant) * 7)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    const value = values(i);
    await AppDataSource.query(
      `INSERT INTO audit_events (id, companyId, actorKind, actorUserId, action, targetType, targetId, targetLabel, createdAt)
       VALUES (?, ?, 'user', ?, ?, ?, ?, '', ?)`,
      [
        id,
        companyId,
        owner.id,
        value.action ?? "contact.update",
        value.targetType ?? "contact",
        value.targetId ?? `contact-${i % 9}`,
        createdAt,
      ],
    );
    rows.push({ id, createdAt });
  }
  return rows;
}

/** Newest first, ties by id: the log's order, worked out here. */
function newestFirst(rows: Seeded[]): string[] {
  return [...rows]
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    )
    .map((row) => row.id);
}

async function readAll(path: string) {
  const ids: string[] = [];
  const pages: Body[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1_000; guard++) {
    const joiner = path.includes("?") ? "&" : "?";
    const page = await get(`${path}${cursor ? `${joiner}cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(...page.body.items!.map((item) => item.id));
    if (!page.body.nextCursor) {
      assert.equal(page.body.hasMore, false);
      return { ids, pages };
    }
    assert.equal(page.body.hasMore, true);
    cursor = page.body.nextCursor;
  }
  throw new Error("paging never ended");
}

describe("GET /audit", () => {
  test("pages every event exactly once, 40 of them sharing each instant", async () => {
    const rows = await audit(330, 40);
    for (const take of [1, 7, 40, 200]) {
      const { ids, pages } = await readAll(`/audit?take=${take}`);
      assert.equal(new Set(ids).size, ids.length, `take ${take}: no event twice`);
      assert.deepEqual(ids, newestFirst(rows), `take ${take}: every event once, newest first`);
      assert.equal(pages.length, Math.ceil(330 / take), "no empty page at the end");
    }
  });

  test("the timestamp it used to hand out skipped the events sharing the boundary instant", async () => {
    const rows = await audit(120, 40);
    const first = await get("/audit?take=50");
    const items = first.body.items!;
    // The old cursor: the oldest event's timestamp. It still reads on — from
    // that instant — so a script holding one is not refused…
    const legacy = await get(`/audit?take=200&cursor=${encodeURIComponent(items.at(-1)!.createdAt)}`);
    assert.equal(legacy.status, 200, legacy.body.error);
    const reached = new Set([...items, ...legacy.body.items!].map((item) => item.id));
    // …but it cannot say where among a shared instant to go on.
    assert.ok(reached.size < rows.length, `the timestamp reached ${reached.size} of ${rows.length}`);
    const { ids } = await readAll("/audit?take=50");
    assert.equal(new Set(ids).size, rows.length, "the keyset cursor reaches every event");
  });

  test("events written between pages never shift the next one, and filters page too", async () => {
    const rows = await audit(150, 30, (i) => ({ action: i % 3 === 0 ? "invoice.update" : "contact.update" }));
    const first = await get("/audit?take=25&action=invoice.");
    assert.equal(first.status, 200, first.body.error);
    const seen = first.body.items!.map((item) => item.id);
    // Newer than anything still to come: they belong to the top of the log.
    await audit(10, 10, () => ({ action: "invoice.create" }), company.id, Date.UTC(2026, 9, 1));
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await get(`/audit?take=25&action=invoice.&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...page.body.items!.map((item) => item.id));
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    const invoices = rows.filter((_, i) => i % 3 === 0);
    assert.deepEqual(seen, newestFirst(invoices), "the invoice family, every event once");
  });

  test("a cursor is refused for other filters, another company and another list", async () => {
    await audit(60, 20);
    const first = await get("/audit?take=10&action=contact.");
    const cursor = encodeURIComponent(first.body.nextCursor!);
    const otherFilters = await get(`/audit?take=10&action=invoice.&cursor=${cursor}`);
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const { user: someone, company: other } = await createMemberOfNewCompany("owner");
    const otherKey = (await mintTestApiKey(someone.id, other.id)).token;
    const otherCompany = await get(`/audit?take=10&action=contact.&cursor=${cursor}`, otherKey, other.id);
    assert.equal(otherCompany.status, 400);
    assert.equal(otherCompany.body.error, CURSOR_OTHER_FILTERS);
    const history = await get("/history/contact/contact-1?take=5");
    const fromHistory = await get(`/audit?cursor=${encodeURIComponent(history.body.nextCursor!)}`);
    assert.equal(fromHistory.status, 400);
    assert.equal(fromHistory.body.error, CURSOR_OTHER_LIST);
    const garbled = await get("/audit?cursor=not-a-cursor");
    assert.equal(garbled.status, 400);
    assert.equal(garbled.body.error, CURSOR_INVALID);
    const foreign = encodeCursor("revenue.contacts", "x", [0, "a", "b", "c"]);
    assert.equal((await get(`/audit?cursor=${foreign}`)).body.error, CURSOR_OTHER_LIST);
  });

  test("another company's events never appear, and a Member who is not an admin reads none", async () => {
    await audit(30, 10);
    const { user: someone, company: other } = await createMemberOfNewCompany("owner");
    await audit(20, 10, () => ({}), other.id);
    const { ids } = await readAll("/audit?take=7");
    assert.equal(ids.length, 30);
    const otherKey = (await mintTestApiKey(someone.id, other.id)).token;
    assert.equal((await get("/audit", otherKey)).status, 401, "a key reads only its own company");
    const member = await insert(User, {
      email: `member-${randomUUID()}@example.test`,
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
    const memberKey = (await mintTestApiKey(member.id, company.id)).token;
    assert.equal((await get("/audit", memberKey)).status, 403, "the whole log is an admin's");
    const history = await get("/history/contact/contact-1", memberKey);
    assert.equal(history.status, 200, "a contact's History is any Member's");
  });
});

describe("GET /history/:targetType/:targetId", () => {
  test("pages one record's changes exactly once, a bulk edit's dozens included", async () => {
    const rows = await audit(160, 25, (i) => ({ targetId: i % 2 === 0 ? "deal-1" : "deal-2", targetType: "deal" }));
    const mine = rows.filter((_, i) => i % 2 === 0);
    for (const take of [1, 9, 50]) {
      const { ids } = await readAll(`/history/deal/deal-1?take=${take}`);
      assert.deepEqual(ids, newestFirst(mine), `take ${take}: this deal's changes, every one once`);
    }
  });

  test("a cursor works only for the record that issued it", async () => {
    await audit(40, 20, (i) => ({ targetType: "deal", targetId: i % 2 ? "deal-1" : "deal-2" }));
    const first = await get("/history/deal/deal-1?take=5");
    assert.equal(first.status, 200, first.body.error);
    const cursor = encodeURIComponent(first.body.nextCursor!);
    const otherRecord = await get(`/history/deal/deal-2?cursor=${cursor}`);
    assert.equal(otherRecord.status, 400);
    assert.equal(otherRecord.body.error, CURSOR_OTHER_FILTERS);
    const auditCursor = (await get("/audit?take=3")).body.nextCursor!;
    const fromAudit = await get(`/history/deal/deal-1?cursor=${encodeURIComponent(auditCursor)}`);
    assert.equal(fromAudit.status, 400);
    assert.equal(fromAudit.body.error, CURSOR_OTHER_LIST);
  });
});
