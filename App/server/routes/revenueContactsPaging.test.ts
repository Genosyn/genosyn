import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { Activity } from "../db/entities/Activity.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { RevenueCustomField } from "../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../db/entities/RevenueCustomValue.js";
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
import { ACTIVITY_EXPORT_ROW_CAP, recordActivity } from "../services/revenue/activities.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * Revenue → Contacts and Revenue → Activities' export, end to end through
 * `createApp()` with real API keys.
 *
 * `GET …/revenue/contacts` used to page by offset: logging an Activity moves
 * a contact to the top and archiving one takes it out, so the next offset page
 * skipped or repeated a contact for every one that moved. It now answers a
 * keyset page when sent `limit` or `cursor` — the list `list_contacts` reads —
 * and keeps `{ rows, total }` otherwise.
 *
 * The activity export answers at most 10,000 activities a file; the Revenue
 * page now follows `X-Export-Next-Cursor` to the end, so these follow it too.
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
let employee: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
  ({ user: member, company } = await createMemberOfNewCompany("member"));
  memberKey = (await mintTestApiKey(member.id, company.id)).token;
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rae",
    slug: "rae",
    role: "Revenue",
    soulBody: "",
  });
  await insert(EmployeeRevenueGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "write",
  });
});

type Row = { id: string; name: string };
type Body = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
  rows?: Row[];
};

async function get(path: string, token = memberKey, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function tool(name: string, args: Record<string, unknown>) {
  const token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  try {
    const response = await fetch(`${baseUrl}/api/internal/mcp/tools/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: (await response.json()) as Body };
  } finally {
    revokeMcpToken(token);
  }
}

/** A second-precision stamp, as SQLite's `datetime('now')` writes a creation time. */
function second(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

/** A millisecond stamp, as a timestamp written from JS is stored. */
function millis(at: number): string {
  return new Date(at).toISOString().replace("T", " ").replace("Z", "");
}

type Seeded = {
  id: string;
  name: string;
  lastActivityAt: string | null;
  createdAt: string;
  archived: boolean;
};

/** Contacts written as the database writes them: raw, so the ties are real. */
async function seedContacts(
  rows: Array<Partial<Omit<Seeded, "id">> & { name: string; createdAt: string }>,
  extra: (index: number) => Record<string, string | null> = () => ({}),
  companyId = company.id,
): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  for (const [index, row] of rows.entries()) {
    const id = randomUUID();
    const more = extra(index);
    const columns = [
      "id",
      "companyId",
      "name",
      "email",
      "lastActivityAt",
      "archivedAt",
      "createdAt",
      "updatedAt",
      ...Object.keys(more),
    ];
    await AppDataSource.query(
      `INSERT INTO contacts (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      [
        id,
        companyId,
        row.name,
        `${row.name.toLowerCase().replaceAll(" ", ".")}@example.com`,
        row.lastActivityAt ?? null,
        row.archived ? "2026-01-01 00:00:00.000" : null,
        row.createdAt,
        row.createdAt,
        ...Object.values(more),
      ],
    );
    seeded.push({
      id,
      name: row.name,
      lastActivityAt: row.lastActivityAt ?? null,
      createdAt: row.createdAt,
      archived: !!row.archived,
    });
  }
  return seeded;
}

/**
 * The list's order, worked out here rather than read from the server: the
 * contacts someone has spoken to, most recently first, then the ones nobody
 * has, newest first — ties broken by id, larger first.
 */
function listOrder(rows: Seeded[]): string[] {
  const desc = (a: string, b: string) => (a === b ? 0 : a < b ? 1 : -1);
  const touched = rows
    .filter((row) => row.lastActivityAt !== null)
    .sort(
      (a, b) =>
        desc(a.lastActivityAt!, b.lastActivityAt!) ||
        desc(a.createdAt, b.createdAt) ||
        desc(a.id, b.id),
    );
  const quiet = rows
    .filter((row) => row.lastActivityAt === null)
    .sort((a, b) => desc(a.createdAt, b.createdAt) || desc(a.id, b.id));
  return [...touched, ...quiet].map((row) => row.id);
}

const IMPORT = Date.UTC(2026, 0, 5, 9, 30, 0);
const TOUCH = Date.UTC(2026, 2, 1, 10, 0, 0);

/**
 * 130 live contacts in the shapes that trip a cursor: 40 touched at the same
 * instant and imported in the same second, 40 touched at distinct times, and
 * 50 never touched imported in one second — plus 10 archived and another
 * company's 20.
 */
async function seedList(): Promise<Seeded[]> {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => ({
      name: `Shared ${i}`,
      lastActivityAt: millis(TOUCH),
      createdAt: second(IMPORT),
    })),
    ...Array.from({ length: 40 }, (_, i) => ({
      name: `Touched ${i}`,
      lastActivityAt: millis(TOUCH - (i + 1) * 60_000),
      createdAt: second(IMPORT + 1_000),
    })),
    ...Array.from({ length: 50 }, (_, i) => ({
      name: `Quiet ${i}`,
      createdAt: second(IMPORT + 2_000),
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      name: `Archived ${i}`,
      createdAt: second(IMPORT + 3_000),
      archived: true,
    })),
  ];
  const seeded = await seedContacts(rows, (i) => ({
    lifecycleStage: i < 80 ? (i % 2 ? "customer" : "lead") : i % 5 === 0 ? "qualified" : "lead",
  }));
  const other = await createMemberOfNewCompany("owner");
  await seedContacts(
    Array.from({ length: 20 }, (_, i) => ({ name: `Theirs ${i}`, createdAt: second(IMPORT) })),
    () => ({}),
    other.company.id,
  );
  return seeded;
}

/** Every page of `GET /revenue/contacts`, following nextCursor. */
async function readContacts(query: Record<string, string>, token = memberKey) {
  const ids: string[] = [];
  const pages: Body[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 400; guard++) {
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    const page = await get(`/revenue/contacts?${params}`, token);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(...page.body.rows!.map((row) => row.id));
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null, "the last page has no cursor");
      assert.equal(page.body.note, undefined);
      return { ids, pages };
    }
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

function assertExactlyOnce(ids: string[], expected: string[], label: string) {
  assert.equal(new Set(ids).size, ids.length, `${label}: no contact twice`);
  assert.deepEqual(ids, expected, `${label}: every contact once, in the list's order`);
}

describe("GET …/revenue/contacts, a page at a time", () => {
  test("reaches every contact exactly once in the list's order, ties and never-touched included", async () => {
    const seeded = await seedList();
    const live = listOrder(seeded.filter((row) => !row.archived));
    assert.equal(live.length, 130);
    for (const limit of [1, 7, 25, 200]) {
      const { ids, pages } = await readContacts({ limit: String(limit) });
      assertExactlyOnce(ids, live, `limit ${limit}`);
      assert.ok(pages.every((page) => page.total === 130), "total counts every match");
      const keys = Object.keys(pages[0]);
      assert.deepEqual(keys, ["total", "hasMore", ...(pages[0].hasMore ? ["nextCursor", "note"] : ["nextCursor"]), "rows"]);
    }
  });

  test("contacts touched, archived, created or deleted between pages never make the rest skip or repeat", async () => {
    const seeded = await seedList();
    const live = listOrder(seeded.filter((row) => !row.archived));
    const first = await get("/revenue/contacts?limit=25");
    const seen = first.body.rows!.map((row) => row.id);
    assert.deepEqual(seen, live.slice(0, 25));
    // Work through page one the way someone does: archive some of it, log
    // calls with others (they move to the top), delete the contact the cursor
    // names, and add new contacts meanwhile.
    for (const id of seen.slice(0, 6)) {
      await AppDataSource.getRepository(Contact).update({ id }, { archivedAt: new Date() });
    }
    for (const id of seen.slice(6, 12)) {
      await recordActivity(company.id, { kind: "call", subject: "Called", contactId: id });
    }
    await AppDataSource.getRepository(Contact).delete({ id: seen[24] });
    const added = await seedContacts([
      { name: "New 1", createdAt: second(Date.UTC(2026, 9, 1)) },
      { name: "New 2", createdAt: second(Date.UTC(2026, 9, 1)) },
    ]);

    // The offset this page used to send skips as many contacts as left the list.
    const offsetPage = await get("/revenue/contacts?limit=25&offset=25");
    assert.notDeepEqual(
      offsetPage.body.rows!.map((row) => row.id),
      live.slice(25, 50),
      "an offset no longer lands where page one ended",
    );

    const rest: string[] = [];
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await get(`/revenue/contacts?limit=25&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.status, 200, page.body.error);
      rest.push(...page.body.rows!.map((row) => row.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    const expectedRest = [
      ...live.slice(25, 80),
      // New contacts nobody has touched are the newest of the never-touched.
      ...added.map((row) => row.id).sort((a, b) => (a < b ? 1 : -1)),
      ...live.slice(80),
    ];
    assertExactlyOnce(rest, expectedRest, "after page one's work");
  });

  test("a cursor carries on between this route and list_contacts, both ways", async () => {
    const seeded = await seedList();
    const live = listOrder(seeded.filter((row) => !row.archived && row.name.startsWith("Shared")));
    const rest = await get("/revenue/contacts?limit=15&q=shared");
    assert.equal(rest.status, 200, rest.body.error);
    const fromTool = await tool("list_contacts", { q: "shared", limit: 15, cursor: rest.body.nextCursor });
    assert.equal(fromTool.status, 200, fromTool.body.error);
    const toolRows = fromTool.body.contacts as Row[];
    assert.deepEqual(
      [...rest.body.rows!, ...toolRows].map((row) => row.id),
      live.slice(0, 30),
    );
    const back = await get(
      `/revenue/contacts?limit=15&q=shared&cursor=${encodeURIComponent(fromTool.body.nextCursor as string)}`,
    );
    assert.equal(back.status, 200, back.body.error);
    assert.deepEqual(
      back.body.rows!.map((row) => row.id),
      live.slice(30, 40),
    );
    assert.equal(back.body.hasMore, false);
  });

  test("without limit or cursor it answers { rows, total } as it always did, and an offset still places a page", async () => {
    const seeded = await seedList();
    const live = listOrder(seeded.filter((row) => !row.archived));
    const plain = await get("/revenue/contacts");
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.body), ["rows", "total"]);
    assert.deepEqual(plain.body.rows!.map((row) => row.id), live.slice(0, 50));
    assert.equal(plain.body.total, 130);
    const offsetOnly = await get("/revenue/contacts?offset=50");
    assert.deepEqual(Object.keys(offsetOnly.body), ["rows", "total"]);
    assert.deepEqual(offsetOnly.body.rows!.map((row) => row.id), live.slice(50, 100));
    // An older caller's limit and offset: the same rows it always got, plus
    // the page facts — and the cursor goes on from there by keyset.
    for (const offset of [0, 20, 75, 80, 125, 130, 400]) {
      const page = await get(`/revenue/contacts?limit=10&offset=${offset}`);
      assert.equal(page.status, 200, page.body.error);
      assert.deepEqual(page.body.rows!.map((row) => row.id), live.slice(offset, offset + 10), `offset ${offset}`);
      assert.equal(page.body.total, 130);
      assert.equal(page.body.hasMore, offset + 10 < 130, `offset ${offset} hasMore`);
      if (page.body.hasMore) {
        const next = await get(`/revenue/contacts?limit=10&cursor=${encodeURIComponent(page.body.nextCursor!)}`);
        assert.deepEqual(
          next.body.rows!.map((row) => row.id),
          live.slice(offset + 10, offset + 20),
          `after offset ${offset}`,
        );
      }
    }
    const fields = plain.body.rows![0] as Record<string, unknown>;
    for (const field of ["id", "name", "email", "lifecycleStage", "lastActivityAt", "customerName"]) {
      assert.ok(field in fields, `a row still carries ${field}`);
    }
  });

  test("a large limit is cut to 200, and a nonsense one is refused", async () => {
    await seedContacts(
      Array.from({ length: 230 }, (_, i) => ({ name: `Bulk ${i}`, createdAt: second(IMPORT) })),
    );
    const big = await get("/revenue/contacts?limit=5000");
    assert.equal(big.status, 200, "cut, not refused");
    assert.equal(big.body.rows!.length, 200);
    assert.equal(big.body.hasMore, true);
    assert.equal(big.body.total, 230);
    for (const limit of ["0", "10001", "-1", "lots"]) {
      assert.equal((await get(`/revenue/contacts?limit=${limit}`)).status, 400, `limit ${limit}`);
    }
    const all = await readContacts({ limit: "5000" });
    assert.equal(new Set(all.ids).size, 230);
  });

  test("a cursor is refused for other filters, another company and another list", async () => {
    await seedList();
    const first = await get("/revenue/contacts?limit=5&q=shared");
    const cursor = encodeURIComponent(first.body.nextCursor!);
    for (const query of ["q=quiet", "q=shared&lifecycleStage=lead", "q=shared&includeArchived=true"]) {
      const refused = await get(`/revenue/contacts?limit=5&${query}&cursor=${cursor}`);
      assert.equal(refused.status, 400, query);
      assert.equal(refused.body.error, CURSOR_OTHER_FILTERS, query);
    }
    const { user: owner, company: other } = await createMemberOfNewCompany("owner");
    const otherKey = (await mintTestApiKey(owner.id, other.id)).token;
    const theirs = await get(`/revenue/contacts?limit=5&q=shared&cursor=${cursor}`, otherKey, other.id);
    assert.equal(theirs.status, 400);
    assert.equal(theirs.body.error, CURSOR_OTHER_FILTERS);
    const foreign = encodeCursor("banking.transactions", "x", ["2026-01-01", 0, "id"]);
    const otherList = await get(`/revenue/contacts?cursor=${foreign}`);
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    const garbled = await get("/revenue/contacts?cursor=!!!");
    assert.equal(garbled.status, 400);
    assert.equal(garbled.body.error, CURSOR_INVALID);
    const cut = await get(`/revenue/contacts?q=shared&cursor=${cursor.slice(0, -5)}`);
    assert.equal(cut.status, 400);
  });

  test("every filter narrows on the server, and each one's pages add up to its total", async () => {
    const seeded = await seedList();
    const customer = await insert(Customer, { companyId: company.id, name: "Northwind", slug: "northwind" });
    await AppDataSource.getRepository(Contact).update(
      { id: seeded[3].id },
      { customerId: customer.id, ownerId: member.id },
    );
    await AppDataSource.getRepository(Contact).update(
      { id: seeded[4].id },
      { customerId: customer.id, ownerEmployeeId: employee.id },
    );
    const field = await insert(RevenueCustomField, {
      companyId: company.id,
      resourceType: "contact",
      key: "tier",
      name: "Tier",
      fieldType: "text",
      optionsJson: "[]",
      required: false,
      sortOrder: 0,
      archivedAt: null,
    });
    for (const row of seeded.slice(0, 12)) {
      await insert(RevenueCustomValue, {
        companyId: company.id,
        fieldId: field.id,
        resourceType: "contact",
        resourceId: row.id,
        valueJson: JSON.stringify("Enterprise"),
        searchValue: "enterprise",
      });
    }
    const count = async (query: Record<string, string>) => {
      const { ids, pages } = await readContacts({ limit: "9", ...query });
      assert.equal(pages[0].total, ids.length, JSON.stringify(query));
      return ids.length;
    };
    assert.equal(await count({ q: "quiet" }), 50);
    assert.equal(await count({ lifecycleStage: "customer" }), 40);
    assert.equal(await count({ lifecycleStage: "qualified" }), 10);
    assert.equal(await count({ customerId: customer.id }), 2);
    assert.equal(await count({ ownerId: member.id }), 1);
    assert.equal(await count({ ownerEmployeeId: employee.id }), 1);
    assert.equal(await count({ includeArchived: "true" }), 140);
    assert.equal(await count({ q: "archived" }), 0);
    assert.equal(await count({ q: "archived", includeArchived: "true" }), 10);
    assert.equal(await count({ customFieldKey: "tier", customFieldValue: "enterprise" }), 12);
    assert.equal(await count({ customFieldKey: "nope", customFieldValue: "x" }), 0);
    // The stage chips page through one stage in the list's own order.
    const stage = await readContacts({ limit: "4", lifecycleStage: "lead" });
    assert.deepEqual(
      stage.ids,
      listOrder(
        seeded.filter((row, i) => !row.archived && (i < 80 ? i % 2 === 0 : i % 5 !== 0)),
      ),
    );
  });

  test("another company's contacts never appear, and its keys read nothing here", async () => {
    await seedList();
    const { ids } = await readContacts({ limit: "50", includeArchived: "true" });
    const theirs = await AppDataSource.getRepository(Contact)
      .createQueryBuilder("c")
      .where("c.companyId != :cid", { cid: company.id })
      .getMany();
    assert.equal(theirs.length, 20);
    for (const row of theirs) assert.equal(ids.includes(row.id), false);
    const { user: outsider, company: other } = await createMemberOfNewCompany("owner");
    const outsiderKey = (await mintTestApiKey(outsider.id, other.id)).token;
    assert.equal((await get("/revenue/contacts?limit=5", outsiderKey)).status, 401);
    const own = await get("/revenue/contacts?limit=5", outsiderKey, other.id);
    assert.equal(own.status, 200, own.body.error);
    assert.equal(own.body.total, 0);
  });
});

describe("GET …/revenue/activities/export, followed to the end", () => {
  /** Every file of an export, following X-Export-Next-Cursor; between files, `between` runs. */
  async function exportAll(query = "", between: (part: number, ids: string[]) => Promise<void> = async () => {}) {
    const ids: string[] = [];
    const files: Array<{ rows: number; total: number; header: string }> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const params = new URLSearchParams(query);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(
        `${baseUrl}/api/companies/${company.id}/revenue/activities/export?${params}`,
        { headers: { authorization: `Bearer ${memberKey}` } },
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
      const lines = (await response.text()).split("\r\n");
      const partIds = lines.slice(1).map((line) => line.split(",")[0].replaceAll('"', ""));
      ids.push(...partIds);
      files.push({
        rows: Number(response.headers.get("x-exported-rows")),
        total: Number(response.headers.get("x-export-total")),
        header: lines[0],
      });
      assert.equal(Number(response.headers.get("x-exported-rows")), partIds.length);
      cursor = response.headers.get("x-export-next-cursor");
      assert.equal(response.headers.get("x-export-truncated"), String(cursor !== null));
      if (!cursor) return { ids, files };
      await between(files.length, ids);
    }
    throw new Error("the export never ended");
  }

  test("every activity exactly once across three files, ties included, while activities are logged and removed", async () => {
    const count = ACTIVITY_EXPORT_ROW_CAP * 2 + 37;
    const base = Date.UTC(2025, 0, 1);
    const rows = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      companyId: company.id,
      kind: (i % 3 === 0 ? "email_in" : "note") as Activity["kind"],
      subject: `A ${i}`,
      bodyText: "",
      // Mail sync records a burst at one instant; 40 share each occurredAt and
      // 200 each creation second.
      occurredAt: new Date(base + Math.floor(i / 40) * 1_000),
    }));
    const repo = AppDataSource.getRepository(Activity);
    for (let start = 0; start < rows.length; start += 500) {
      await repo.insert(rows.slice(start, start + 500));
    }
    await AppDataSource.query(
      `UPDATE activities SET createdAt = ? WHERE companyId = ?`,
      [second(base), company.id],
    );
    const removed = new Set<string>();
    const { ids, files } = await exportAll("", async (part, sofar) => {
      if (part !== 1) return;
      // Activities keep arriving (newer than anything still to come), one not
      // yet exported is deleted, and so is the one the cursor names.
      for (let i = 0; i < 5; i++) {
        await recordActivity(company.id, { kind: "note", subject: `Late ${i}` });
      }
      // Newest first, so the oldest activities are still to come.
      const unexported = rows[3];
      assert.equal(new Set(sofar).has(unexported.id), false);
      await repo.delete({ id: unexported.id });
      removed.add(unexported.id);
      await repo.delete({ id: sofar.at(-1)! });
    });
    assert.equal(files.length, 3);
    assert.deepEqual(
      files.map((file) => file.rows),
      [ACTIVITY_EXPORT_ROW_CAP, ACTIVITY_EXPORT_ROW_CAP, 36],
    );
    assert.ok(files.every((file) => file.header === files[0].header), "every file repeats the header");
    assert.equal(new Set(ids).size, ids.length, "no activity twice");
    const expected = new Set(rows.filter((row) => !removed.has(row.id)).map((row) => row.id));
    assert.deepEqual(new Set(ids), expected, "every activity once, the late ones not shifting anything");
  });

  test("a filtered export follows its own cursor, and refuses one issued for other filters", async () => {
    const base = Date.UTC(2025, 0, 1);
    const repo = AppDataSource.getRepository(Activity);
    const rows = Array.from({ length: ACTIVITY_EXPORT_ROW_CAP + 30 }, (_, i) => ({
      companyId: company.id,
      kind: (i % 2 === 0 ? "call" : "note") as Activity["kind"],
      subject: `B ${i}`,
      bodyText: "",
      occurredAt: new Date(base + Math.floor(i / 25) * 1_000),
    }));
    for (let start = 0; start < rows.length; start += 500) {
      await repo.insert(rows.slice(start, start + 500));
    }
    const calls = await exportAll("kinds=call");
    assert.equal(calls.files.length, 1, "5,015 calls fit one file");
    assert.equal(calls.ids.length, (ACTIVITY_EXPORT_ROW_CAP + 30) / 2);
    const everything = await fetch(
      `${baseUrl}/api/companies/${company.id}/revenue/activities/export`,
      { headers: { authorization: `Bearer ${memberKey}` } },
    );
    const next = everything.headers.get("x-export-next-cursor")!;
    await everything.text();
    const refused = await fetch(
      `${baseUrl}/api/companies/${company.id}/revenue/activities/export?kinds=call&cursor=${encodeURIComponent(next)}`,
      { headers: { authorization: `Bearer ${memberKey}` } },
    );
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { error: string }).error, CURSOR_OTHER_FILTERS);
  });
});

describe("the API reference", () => {
  test("documents the contact list's cursor and the export's continuation header", () => {
    const document = buildOpenApiDocument(app) as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{ name: string }>;
            description?: string;
            responses?: Record<string, { headers?: Record<string, unknown> }>;
          }
        >
      >;
    };
    const contacts = document.paths["/api/companies/{cid}/revenue/contacts"]?.get;
    assert.ok(contacts);
    const names = (contacts.parameters ?? []).map((parameter) => parameter.name);
    for (const name of ["limit", "cursor", "q", "lifecycleStage", "includeArchived"]) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(names.includes("offset"), false, "an offset is taken but not advertised");
    assert.match(contacts.description ?? "", /list_contacts/);
    const exported = document.paths["/api/companies/{cid}/revenue/activities/export"]?.get;
    assert.ok(exported);
    assert.ok(exported.responses?.["200"]?.headers?.["X-Export-Next-Cursor"]);
    assert.ok((exported.parameters ?? []).some((parameter) => parameter.name === "cursor"));
  });
});
