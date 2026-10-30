import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import type { EntityTarget, ObjectLiteral } from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity.js";

import { AppDataSource } from "../db/datasource.js";
import { Activity } from "../db/entities/Activity.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { Deal } from "../db/entities/Deal.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { Membership } from "../db/entities/Membership.js";
import { Partnership } from "../db/entities/Partnership.js";
import { RevenueCustomField } from "../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../db/entities/RevenueCustomValue.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  encodeCursor,
  TOOL_PAGE_BUDGET_CHARS,
} from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  ACTIVITY_EXPORT_ROW_CAP,
  exportActivitiesCsv,
  recordActivity,
} from "../services/revenue/activities.js";
import { listRevenueAccounts } from "../services/revenue/accounts.js";
import { andWhereCustomFieldMatches, resolveCustomFieldFilter } from "../services/revenue/customFields.js";
import { listContacts, pageContacts } from "../services/revenue/contacts.js";
import { listDeals } from "../services/revenue/deals.js";
import { listFollowUpPage, listFollowUps } from "../services/revenue/followUps.js";
import { listPartnerships } from "../services/revenue/partnerships.js";
import { runRevenueBulkOperation } from "../services/revenue/bulk.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { mcpInternalRouter } from "./mcpInternal.js";
import { revenueRouter } from "./revenue.js";
import { revenueOperationsRouter } from "./revenueOperations.js";

/**
 * The Revenue lists an AI Employee works through, paged so every row is
 * reachable: contacts (by list and by search), the activity export, archived
 * partnerships, follow-ups with no due date, and custom-field filters that no
 * longer turn into one bound parameter per matching record.
 */

let server: Server;
let baseUrl = "";
let token = "";
let otherToken = "";
let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let otherEmployee: AIEmployee;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(async (req, _res, next) => {
    if (req.path.startsWith("/api/")) {
      (req as unknown as { session: unknown }).session = actingUserId
        ? { userId: actingUserId, sessionVersion: 0 }
        : null;
      await persistTestSession(req);
    }
    next();
  });
  app.use("/api/companies/:cid", revenueRouter);
  app.use("/api/companies/:cid", revenueOperationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const issued of [token, otherToken]) if (issued) revokeMcpToken(issued);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  for (const issued of [token, otherToken]) if (issued) revokeMcpToken(issued);
  await resetTestDb();
  actingUserId = null;
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  otherCompany = await insert(Company, { name: "Globex", slug: "globex", ownerId: "owner-2" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rae",
    slug: "rae",
    role: "Revenue",
    soulBody: "",
  });
  otherEmployee = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Gus",
    slug: "gus",
    role: "Revenue",
    soulBody: "",
  });
  for (const [cid, eid] of [
    [company.id, employee.id],
    [otherCompany.id, otherEmployee.id],
  ]) {
    await insert(EmployeeRevenueGrant, { companyId: cid, employeeId: eid, accessLevel: "write" });
  }
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  otherToken = issueMcpToken(otherEmployee.id, otherCompany.id, { authority: "employee" });
});

type Answer = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
};

async function callTool(name: string, body: Record<string, unknown> = {}, as = token) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Answer };
}

async function readEveryPage(tool: string, rowsKey: string, args: Record<string, unknown>) {
  const ids: string[] = [];
  const pages: Answer[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await callTool(tool, { ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(...(page.body[rowsKey] as Array<{ id: string }>).map((row) => row.id));
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null, "the last page has no cursor");
      return { ids, pages };
    }
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

async function insertChunks<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  rows: QueryDeepPartialEntity<T>[],
): Promise<void> {
  const repo = AppDataSource.getRepository(entity);
  for (let offset = 0; offset < rows.length; offset += 200) {
    await repo.insert(rows.slice(offset, offset + 200));
  }
}

function assertExactlyOnce(ids: string[], expected: string[], label: string) {
  assert.equal(new Set(ids).size, ids.length, `${label}: no row repeats`);
  assert.deepEqual(ids, expected, `${label}: every row once, in the list's order`);
}

// ─────────────────────────────── Contacts ───────────────────────────────

/**
 * 100 live contacts in three groups the order has to keep straight: 30 who
 * share one last-activity instant, 30 touched at distinct times, and 40 never
 * touched (null lastActivityAt) inserted in one batch, so they share a
 * `createdAt` too. Plus archived ones and another company's.
 */
async function seedContacts(): Promise<{ live: string[] }> {
  const sharedTouch = new Date("2026-03-01T10:00:00.000Z");
  const customer = await insert(Customer, {
    companyId: company.id,
    name: "Northwind",
    slug: "northwind",
  });
  const rows: QueryDeepPartialEntity<Contact>[] = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      companyId: company.id,
      name: `Shared ${i}`,
      email: `shared${i}@example.com`,
      lastActivityAt: sharedTouch,
      lifecycleStage: i % 2 ? "lead" : "customer",
      customerId: i % 3 === 0 ? customer.id : null,
    });
  }
  for (let i = 0; i < 30; i++) {
    rows.push({
      companyId: company.id,
      name: `Touched ${i}`,
      email: `touched${i}@example.com`,
      lastActivityAt: new Date(Date.UTC(2026, 1, 1, 0, i)),
      lifecycleStage: "lead",
      ownerEmployeeId: i < 10 ? employee.id : null,
    });
  }
  for (let i = 0; i < 40; i++) {
    rows.push({
      companyId: company.id,
      name: `Quiet ${i}`,
      email: `quiet${i}@example.com`,
      lastActivityAt: null,
      lifecycleStage: i % 4 === 0 ? "qualified" : "lead",
      title: i % 5 === 0 ? "VP Engineering" : "Analyst",
    });
  }
  await insertChunks(Contact, rows);
  await insertChunks(
    Contact,
    Array.from({ length: 12 }, (_, i) => ({
      companyId: company.id,
      name: `Archived ${i}`,
      email: `archived${i}@example.com`,
      archivedAt: new Date("2026-01-01T00:00:00.000Z"),
    })),
  );
  await insertChunks(
    Contact,
    Array.from({ length: 15 }, (_, i) => ({
      companyId: otherCompany.id,
      name: `Shared other ${i}`,
      email: `other${i}@example.com`,
    })),
  );
  const { rows: ordered } = await listContacts(company.id, { limit: 200 });
  return { live: ordered.map((row) => row.id) };
}

describe("list_contacts and search_contacts", () => {
  test("reach every contact exactly once in the list's order, ties and never-touched contacts included", async () => {
    const { live } = await seedContacts();
    assert.equal(live.length, 100);
    for (const limit of [1, 7, 50, 200]) {
      const { ids, pages } = await readEveryPage("list_contacts", "contacts", { limit });
      assertExactlyOnce(ids, live, `limit ${limit}`);
      assert.equal(pages[0].total, 100, "total counts every match, not the page");
      const keys = Object.keys(pages[0]);
      assert.ok(keys.indexOf("total") < keys.indexOf("contacts"), "paging facts come first");
    }
    // The shared instant is the most recent and one block, the distinct ones
    // follow newest first, and the never-touched contacts come last.
    const names = new Map(
      (await AppDataSource.getRepository(Contact).findBy({ companyId: company.id })).map(
        (row) => [row.id, row.name] as const,
      ),
    );
    const groups = live.map((id) => names.get(id)!.split(" ")[0]);
    assert.deepEqual(groups, [
      ...Array(30).fill("Shared"),
      ...Array(30).fill("Touched"),
      ...Array(40).fill("Quiet"),
    ]);
    assert.equal(names.get(live[30]), "Touched 29", "the most recently touched first");
  });

  test("archiving and deleting contacts between pages never skips the rest", async () => {
    const { live } = await seedContacts();
    const first = await callTool("list_contacts", { limit: 10 });
    const seen = (first.body.contacts as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(seen, live.slice(0, 10));
    // Work through page one: archive half of it, delete the last row shown
    // (the cursor's own anchor), and log an Activity on the rest — which moves
    // them to the top. An offset would now skip as many rows as left the list.
    for (const id of seen.slice(0, 5)) {
      await AppDataSource.getRepository(Contact).update({ id }, { archivedAt: new Date() });
    }
    await AppDataSource.getRepository(Contact).delete({ id: seen[9] });
    for (const id of seen.slice(5, 9)) {
      await recordActivity(company.id, { kind: "note", subject: "Called", contactId: id });
    }
    let cursor = first.body.nextCursor!;
    const rest: string[] = [];
    for (;;) {
      const page = await callTool("list_contacts", { limit: 10, cursor });
      assert.equal(page.status, 200, page.body.error);
      rest.push(...(page.body.contacts as Array<{ id: string }>).map((row) => row.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assertExactlyOnce(rest, live.slice(10), "after page one's work");
  });

  test("every filter narrows on its own and together, on the server", async () => {
    await seedContacts();
    const customer = await AppDataSource.getRepository(Customer).findOneByOrFail({
      slug: "northwind",
    });
    const count = async (args: Record<string, unknown>) => {
      const { ids, pages } = await readEveryPage("list_contacts", "contacts", { limit: 13, ...args });
      assert.equal(pages[0].total, ids.length, JSON.stringify(args));
      return ids.length;
    };
    assert.equal(await count({ q: "quiet" }), 40);
    assert.equal(await count({ q: "VP ENG" }), 8);
    assert.equal(await count({ lifecycleStage: "qualified" }), 10);
    assert.equal(await count({ customerId: customer.id }), 10);
    assert.equal(await count({ ownedByMe: true }), 10);
    assert.equal(await count({ includeArchived: true }), 112);
    assert.equal(await count({ q: "shared", lifecycleStage: "customer" }), 15);
    assert.equal(await count({ q: "shared", lifecycleStage: "customer", customerId: customer.id }), 5);
    assert.equal(await count({ q: "archived" }), 0);
    assert.equal(await count({ q: "archived", includeArchived: true }), 12);
    const search = await readEveryPage("search_contacts", "contacts", { query: "touched", limit: 4 });
    assert.equal(search.ids.length, 30);
    assert.equal(search.pages.length, 8);
  });

  test("search_contacts reaches past its old first page, 25 at a time by default", async () => {
    await seedContacts();
    const first = await callTool("search_contacts", { query: "@example.com" });
    assert.equal(first.status, 200, first.body.error);
    assert.equal((first.body.contacts as unknown[]).length, 25);
    assert.equal(first.body.total, 100);
    assert.equal(first.body.hasMore, true);
    const { ids } = await readEveryPage("search_contacts", "contacts", { query: "@example.com" });
    assert.equal(new Set(ids).size, 100);
  });

  test("a large limit is cut to 200, and a page ends early rather than overflow a tool result", async () => {
    await insertChunks(
      Contact,
      Array.from({ length: 260 }, (_, i) => ({
        companyId: company.id,
        name: `Contact ${i} ${"x".repeat(60)}`,
        email: `c${i}@example.com`,
        companyName: "Very Long Employer Name Incorporated ".repeat(3),
        title: "Head of Strategic Partnerships and Business Development",
      })),
    );
    const answer = await callTool("list_contacts", { limit: 5000 });
    assert.equal(answer.status, 200, answer.body.error);
    const shown = answer.body.contacts as Array<{ id: string }>;
    assert.ok(shown.length > 0 && shown.length < 200, `trimmed to fit: ${shown.length}`);
    assert.ok(
      JSON.stringify(shown, null, 2).length <= TOOL_PAGE_BUDGET_CHARS + 2_000,
      "the rows fit the tool budget",
    );
    assert.equal(answer.body.hasMore, true);
    const { ids } = await readEveryPage("list_contacts", "contacts", { limit: 5000 });
    assert.equal(new Set(ids).size, 260, "the trimmed pages still reach every row");
  });

  test("cursors are refused for another list, other filters or another company", async () => {
    await seedContacts();
    const first = await callTool("list_contacts", { limit: 5, q: "shared" });
    const cursor = first.body.nextCursor!;
    const otherFilters = await callTool("list_contacts", { limit: 5, q: "quiet", cursor });
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const otherCompanyAnswer = await callTool(
      "list_contacts",
      { limit: 5, q: "shared", cursor },
      otherToken,
    );
    assert.equal(otherCompanyAnswer.status, 400);
    assert.equal(otherCompanyAnswer.body.error, CURSOR_OTHER_FILTERS);
    const foreign = encodeCursor("banking.transactions", "x", ["2026-01-01", 0, "id"]);
    const otherList = await callTool("list_contacts", { cursor: foreign });
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    const garbled = await callTool("list_contacts", { cursor: `${cursor.slice(0, -4)}zzzz` });
    assert.equal(garbled.status, 400);
    assert.match(garbled.body.error ?? "", /cursor/);
    const bad = await callTool("list_contacts", { cursor: "!!!" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, CURSOR_INVALID);
    // search_contacts reads the same list: its cursor continues list_contacts with the same q.
    const searched = await callTool("search_contacts", { query: "shared", limit: 5 });
    const continued = await callTool("list_contacts", {
      q: "shared",
      limit: 5,
      cursor: searched.body.nextCursor,
    });
    assert.equal(continued.status, 200, continued.body.error);
  });

  test("another company's contacts never appear, and no Revenue Grant is a 403", async () => {
    await seedContacts();
    const mine = await readEveryPage("list_contacts", "contacts", { q: "shared", limit: 50 });
    const theirs = await AppDataSource.getRepository(Contact).findBy({ companyId: otherCompany.id });
    for (const row of theirs) assert.equal(mine.ids.includes(row.id), false);
    const otherSide = await callTool("list_contacts", { limit: 200 }, otherToken);
    assert.equal(otherSide.body.total, 15);
    await AppDataSource.getRepository(EmployeeRevenueGrant).delete({ employeeId: employee.id });
    for (const tool of ["list_contacts", "search_contacts"]) {
      const refused = await callTool(tool, tool === "search_contacts" ? { query: "a" } : {});
      assert.equal(refused.status, 403, tool);
    }
  });

  test("an older Skill's offset still positions the first page and hands over a cursor", async () => {
    const { live } = await seedContacts();
    const page = await callTool("list_contacts", { limit: 10, offset: 20 });
    assert.equal(page.status, 200, page.body.error);
    assert.deepEqual(
      (page.body.contacts as Array<{ id: string }>).map((row) => row.id),
      live.slice(20, 30),
    );
    const next = await callTool("list_contacts", { limit: 10, offset: 20, cursor: page.body.nextCursor });
    assert.deepEqual(
      (next.body.contacts as Array<{ id: string }>).map((row) => row.id),
      live.slice(30, 40),
      "with a cursor the offset is ignored",
    );
    // Across the touched/never-touched boundary (60 touched), at it, and past the end.
    for (const offset of [55, 60, 65, 99, 100, 150]) {
      const answer = await callTool("list_contacts", { limit: 10, offset });
      assert.equal(answer.status, 200, answer.body.error);
      assert.deepEqual(
        (answer.body.contacts as Array<{ id: string }>).map((row) => row.id),
        live.slice(offset, offset + 10),
        `offset ${offset}`,
      );
      assert.equal(answer.body.hasMore, offset + 10 < 100, `offset ${offset} hasMore`);
      if (answer.body.hasMore) {
        const after = await callTool("list_contacts", { limit: 10, cursor: answer.body.nextCursor });
        assert.deepEqual(
          (after.body.contacts as Array<{ id: string }>).map((row) => row.id),
          live.slice(offset + 10, offset + 20),
          `after offset ${offset}`,
        );
      }
    }
  });
});

// ───────────────────────────── Custom fields ─────────────────────────────

describe("custom-field filters", () => {
  async function field(resourceType: "contact" | "deal" | "account" | "partnership", key: string) {
    return insert(RevenueCustomField, {
      companyId: company.id,
      resourceType,
      key,
      name: key,
      fieldType: "text",
      optionsJson: "[]",
      required: false,
      sortOrder: 0,
      archivedAt: null,
    });
  }

  test("filter by a value 1,200 records share, as a bounded subquery", async () => {
    const tier = await field("contact", "tier");
    const contactIds = Array.from({ length: 1_500 }, () => randomUUID());
    await insertChunks(
      Contact,
      contactIds.map((id, i) => ({ id, companyId: company.id, name: `T ${i}`, email: `t${i}@x.io` })),
    );
    await insertChunks(
      RevenueCustomValue,
      contactIds.map((resourceId, i) => ({
        companyId: company.id,
        fieldId: tier.id,
        resourceType: "contact" as const,
        resourceId,
        valueJson: JSON.stringify(i < 1_200 ? "Enterprise" : "SMB"),
        searchValue: i < 1_200 ? "enterprise" : "smb",
      })),
    );
    // Another company's identical field and values stay out.
    const theirs = await insert(RevenueCustomField, {
      companyId: otherCompany.id,
      resourceType: "contact",
      key: "tier",
      name: "tier",
      fieldType: "text",
      optionsJson: "[]",
      required: false,
      sortOrder: 0,
      archivedAt: null,
    });
    const foreignContact = await insert(Contact, {
      companyId: otherCompany.id,
      name: "Foreign",
      email: "f@x.io",
    });
    await insert(RevenueCustomValue, {
      companyId: otherCompany.id,
      fieldId: theirs.id,
      resourceType: "contact",
      resourceId: foreignContact.id,
      valueJson: '"Enterprise"',
      searchValue: "enterprise",
    });

    const { ids, pages } = await readEveryPage("list_contacts", "contacts", {
      customFieldKey: "Tier",
      customFieldValue: " Enterprise ",
      limit: 200,
    });
    assert.equal(pages[0].total, 1_200);
    assert.equal(new Set(ids).size, 1_200);
    assert.deepEqual([...ids].sort(), contactIds.slice(0, 1_200).sort());
    assert.equal((await listContacts(company.id, { customFieldKey: "tier", customFieldValue: "smb" })).total, 300);

    // The statement carries the filter's four values, not one per record.
    const filter = await resolveCustomFieldFilter(company.id, "contact", "tier", "enterprise");
    assert.ok(filter);
    const qb = AppDataSource.getRepository(Contact)
      .createQueryBuilder("c")
      .where("c.companyId = :companyId", { companyId: company.id });
    const [sql, parameters] = andWhereCustomFieldMatches(qb, "c.id", filter).getQueryAndParameters();
    assert.match(sql, /EXISTS \(SELECT 1 FROM/);
    assert.ok(parameters.length <= 6, `bounded parameters: ${parameters.length}`);
  });

  test("an unknown or archived field matches nothing, and deals, accounts and partnerships filter the same way", async () => {
    assert.equal(
      (await listContacts(company.id, { customFieldKey: "nope", customFieldValue: "x" })).total,
      0,
    );
    const archived = await field("contact", "legacy");
    await AppDataSource.getRepository(RevenueCustomField).update(
      { id: archived.id },
      { archivedAt: new Date() },
    );
    const page = await pageContacts(
      company.id,
      { customFieldKey: "legacy", customFieldValue: "x" },
      {},
      (rows) => rows,
    );
    assert.deepEqual(page, { total: 0, hasMore: false, nextCursor: null, rows: [] });

    const region = {
      deal: await field("deal", "region"),
      account: await field("account", "region"),
      partnership: await field("partnership", "region"),
    };
    const deal = await insert(Deal, {
      companyId: company.id,
      title: "EMEA deal",
      stageId: "s",
      status: "open",
    });
    await insert(Deal, { companyId: company.id, title: "Other deal", stageId: "s", status: "open" });
    const account = await insert(Customer, { companyId: company.id, name: "EMEA Co", slug: "emea" });
    await insert(Customer, { companyId: company.id, name: "Other Co", slug: "other" });
    const partnership = await insert(Partnership, { companyId: company.id, name: "EMEA partner" });
    await insert(Partnership, { companyId: company.id, name: "Other partner" });
    for (const [type, id] of [
      ["deal", deal.id],
      ["account", account.id],
      ["partnership", partnership.id],
    ] as const) {
      await insert(RevenueCustomValue, {
        companyId: company.id,
        fieldId: region[type].id,
        resourceType: type,
        resourceId: id,
        valueJson: '"EMEA"',
        searchValue: "emea",
      });
    }
    const deals = await listDeals(company.id, { customFieldKey: "region", customFieldValue: "EMEA" });
    assert.deepEqual(deals.rows.map((row) => row.id), [deal.id]);
    const accounts = await listRevenueAccounts(company.id, {
      customFieldKey: "region",
      customFieldValue: "emea",
    });
    assert.deepEqual(accounts.rows.map((row) => row.id), [account.id]);
    const partnerships = await listPartnerships(company.id, {
      customFieldKey: "region",
      customFieldValue: "emea",
    });
    assert.deepEqual(partnerships.rows.map((row) => row.id), [partnership.id]);
    // A deal's field never matches a contact with the same id space.
    assert.equal(
      (await listContacts(company.id, { customFieldKey: "region", customFieldValue: "emea" })).total,
      0,
    );
  });
});

// ──────────────────────────── Activity export ────────────────────────────

describe("export_activities", () => {
  test("continues by cursor until every activity is exported exactly once, each part a CSV with its header", async () => {
    const contact = await insert(Contact, { companyId: company.id, name: "Ana", email: "ana@x.io" });
    const shared = new Date("2026-05-05T12:00:00.000Z");
    const rows = Array.from({ length: 90 }, (_, i) => ({
      companyId: company.id,
      kind: "note" as const,
      subject: `Note ${i}`,
      bodyText: `${"body ".repeat(300)}${i}`,
      contactId: contact.id,
      // A third share one instant, the export's own tie to break.
      occurredAt: i % 3 === 0 ? shared : new Date(Date.UTC(2026, 4, 1, 0, i)),
    }));
    await insertChunks(Activity, rows);
    await insert(Activity, {
      companyId: otherCompany.id,
      kind: "note",
      subject: "Foreign",
      bodyText: "",
      occurredAt: shared,
    });

    const exportedIds: string[] = [];
    let cursor: string | undefined;
    let parts = 0;
    for (;;) {
      const part = await callTool("export_activities", {
        kinds: ["note"],
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(part.status, 200, part.body.error);
      parts += 1;
      assert.equal(part.body.total, 90);
      const csv = part.body.contentText as string;
      const lines = csv.split("\r\n");
      assert.match(lines[0], /^"id","occurredAt","kind"/, "every part starts with the header");
      assert.equal(lines.length - 1, part.body.exported);
      assert.ok(
        JSON.stringify(csv).length <= TOOL_PAGE_BUDGET_CHARS + 2_000,
        "a part fits what the model can read",
      );
      exportedIds.push(...lines.slice(1).map((line) => JSON.parse(line.split(",")[0]) as string));
      assert.equal(part.body.truncated, part.body.hasMore, "truncated is hasMore's older name");
      if (!part.body.hasMore) break;
      assert.match(part.body.note ?? "", /nextCursor/);
      cursor = part.body.nextCursor!;
    }
    assert.ok(parts > 1, `the budget split the export: ${parts} parts`);
    const expected = await AppDataSource.getRepository(Activity)
      .createQueryBuilder("a")
      .where("a.companyId = :cid", { cid: company.id })
      .orderBy("a.occurredAt", "DESC")
      .addOrderBy("a.createdAt", "DESC")
      .addOrderBy("a.id", "DESC")
      .getMany();
    assertExactlyOnce(exportedIds, expected.map((row) => row.id), "export");
  });

  test("passes the 10,000-row cap by cursor, unshifted by activities logged meanwhile", async () => {
    const count = ACTIVITY_EXPORT_ROW_CAP + 37;
    const base = Date.UTC(2025, 0, 1);
    await insertChunks(
      Activity,
      Array.from({ length: count }, (_, i) => ({
        companyId: company.id,
        kind: "call" as const,
        subject: `Call ${i}`,
        bodyText: "",
        // Pairs share an instant.
        occurredAt: new Date(base + Math.floor(i / 2) * 60_000),
      })),
    );
    const first = await exportActivitiesCsv(company.id, { kinds: ["call"] });
    assert.equal(first.exported, ACTIVITY_EXPORT_ROW_CAP);
    assert.equal(first.total, count);
    assert.equal(first.hasMore, true);
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    // New calls logged after the first part are newer: they do not shift the second.
    await recordActivity(company.id, { kind: "call", subject: "Late call" });
    const second = await exportActivitiesCsv(
      company.id,
      { kinds: ["call"] },
      { cursor: first.nextCursor! },
    );
    assert.equal(second.exported, 37);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    const idsOf = (csv: string) => csv.split("\r\n").slice(1).map((line) => line.split(",")[0]);
    const all = [...idsOf(first.csv), ...idsOf(second.csv)];
    assert.equal(new Set(all).size, count, "every call once across the two parts");
    assert.equal(second.csv.includes("Late call"), false);
  });

  test("an export cursor is refused for other filters, another company and another list", async () => {
    await insertChunks(
      Activity,
      Array.from({ length: 30 }, (_, i) => ({
        companyId: company.id,
        kind: "note" as const,
        subject: `N ${i}`,
        bodyText: "y".repeat(3_000),
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      })),
    );
    const first = await callTool("export_activities", { q: "n" });
    assert.equal(first.body.hasMore, true);
    const cursor = first.body.nextCursor!;
    const otherFilters = await callTool("export_activities", { q: "x", cursor });
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const otherCompanyAnswer = await callTool("export_activities", { q: "n", cursor }, otherToken);
    assert.equal(otherCompanyAnswer.status, 400);
    const contacts = await callTool("list_contacts", { limit: 1 });
    assert.equal(contacts.status, 200);
    const listCursor = encodeCursor("revenue.contacts", "f", [0, "2026-01-01", "2026-01-01", "id"]);
    const otherList = await callTool("export_activities", { q: "n", cursor: listCursor });
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    await AppDataSource.getRepository(EmployeeRevenueGrant).delete({ employeeId: employee.id });
    assert.equal((await callTool("export_activities", {})).status, 403);
  });

  test("the REST export carries on through X-Export-Next-Cursor", async () => {
    const user = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: user.id, role: "member" });
    actingUserId = user.id;
    await insertChunks(
      Activity,
      Array.from({ length: ACTIVITY_EXPORT_ROW_CAP + 5 }, (_, i) => ({
        companyId: company.id,
        kind: "note" as const,
        subject: `R ${i}`,
        bodyText: "",
        occurredAt: new Date(Date.UTC(2024, 0, 1) + i * 1_000),
      })),
    );
    const first = await fetch(`${baseUrl}/api/companies/${company.id}/revenue/activities/export`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-exported-rows"), String(ACTIVITY_EXPORT_ROW_CAP));
    assert.equal(first.headers.get("x-export-truncated"), "true");
    assert.equal(first.headers.get("x-export-total"), String(ACTIVITY_EXPORT_ROW_CAP + 5));
    const next = first.headers.get("x-export-next-cursor");
    assert.ok(next);
    await first.text();
    const second = await fetch(
      `${baseUrl}/api/companies/${company.id}/revenue/activities/export?cursor=${encodeURIComponent(next)}`,
    );
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-exported-rows"), "5");
    assert.equal(second.headers.get("x-export-truncated"), "false");
    assert.equal(second.headers.get("x-export-next-cursor"), null);
    const text = await second.text();
    assert.equal(text.split("\r\n").length, 6);
    const refused = await fetch(
      `${baseUrl}/api/companies/${company.id}/revenue/activities/export?kinds=call&cursor=${encodeURIComponent(next)}`,
    );
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { error: string }).error, CURSOR_OTHER_FILTERS);
  });
});

// ───────────────────────────── Partnerships ─────────────────────────────

describe("list_partnerships", () => {
  test("reaches archived partnerships with includeArchived, which is not a status", async () => {
    const live = await insert(Partnership, { companyId: company.id, name: "Live", status: "active" });
    const archived = await insert(Partnership, {
      companyId: company.id,
      name: "Retired",
      status: "active",
      archivedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const plain = await callTool("list_partnerships", {});
    assert.equal(plain.status, 200, plain.body.error);
    assert.deepEqual((plain.body.rows as Array<{ id: string }>).map((row) => row.id), [live.id]);
    const withArchived = await callTool("list_partnerships", { includeArchived: true });
    assert.deepEqual(
      (withArchived.body.rows as Array<{ id: string }>).map((row) => row.id).sort(),
      [live.id, archived.id].sort(),
    );
    assert.equal(withArchived.body.total, 2);
    const byStatus = await callTool("list_partnerships", { status: "archived" });
    assert.equal(byStatus.body.total, 0, "archived is not a status");
    const foreign = await callTool("list_partnerships", { includeArchived: true }, otherToken);
    assert.equal(foreign.body.total, 0);
  });

  test("lists the soonest follow-up first and none last on any driver, ties broken by id across offset pages", async () => {
    const soon = new Date("2026-06-01T09:00:00.000Z");
    const later = new Date("2026-07-01T09:00:00.000Z");
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ name: `Later ${i}`, nextFollowUpAt: later })),
      ...Array.from({ length: 5 }, (_, i) => ({ name: `None ${i}`, nextFollowUpAt: null })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: `Soon ${i}`, nextFollowUpAt: soon })),
    ];
    await insertChunks(
      Partnership,
      rows.map((row) => ({ companyId: company.id, ...row })),
    );
    const ids: string[] = [];
    const names: string[] = [];
    for (let offset = 0; offset < 17; offset += 4) {
      const page = await callTool("list_partnerships", { limit: 4, offset });
      assert.equal(page.status, 200, page.body.error);
      for (const row of page.body.rows as Array<{ id: string; name: string }>) {
        ids.push(row.id);
        names.push(row.name);
      }
    }
    assert.equal(new Set(ids).size, 17, "no partnership on two pages, none on no page");
    assert.deepEqual(
      names.map((name) => name.split(" ")[0]),
      [...Array(6).fill("Soon"), ...Array(6).fill("Later"), ...Array(5).fill("None")],
    );
  });
});

// ────────────────────────────── Follow-ups ──────────────────────────────

describe("list_follow_ups", () => {
  async function seedFollowUps() {
    const due = new Date("2030-01-10T09:00:00.000Z");
    const dated: Array<QueryDeepPartialEntity<Activity>> = Array.from({ length: 7 }, (_, i) => ({
      companyId: company.id,
      kind: "task" as const,
      subject: `Dated ${i}`,
      bodyText: "",
      occurredAt: due,
      taskStatus: "open" as const,
      priority: "normal" as const,
      // Pairs share a due instant.
      dueAt: new Date(due.getTime() + Math.floor(i / 2) * 3_600_000),
    }));
    await insertChunks(Activity, dated);
    // Undated tasks inserted in one batch share their createdAt second.
    await insertChunks(
      Activity,
      Array.from({ length: 9 }, (_, i) => ({
        companyId: company.id,
        kind: "task" as const,
        subject: `Undated ${i}`,
        bodyText: "",
        occurredAt: due,
        taskStatus: "open" as const,
        priority: i === 0 ? ("high" as const) : ("normal" as const),
        dueAt: null,
      })),
    );
    const deal = await insert(Deal, {
      companyId: company.id,
      title: "Renewal",
      stageId: "s",
      status: "open",
      nextFollowUpAt: due,
    });
    // A deal with no next follow-up date is not a follow-up at all.
    await insert(Deal, { companyId: company.id, title: "Quiet deal", stageId: "s", status: "open" });
    await insert(Activity, {
      companyId: otherCompany.id,
      kind: "task",
      subject: "Foreign undated",
      bodyText: "",
      occurredAt: due,
      taskStatus: "open",
      dueAt: null,
    });
    return { deal };
  }

  test("lists tasks with no due date after every dated follow-up, and pages across the boundary exactly once", async () => {
    const { deal } = await seedFollowUps();
    const all = await listFollowUps(company.id, { limit: 500 });
    assert.equal(all.length, 17);
    assert.equal(all.slice(0, 8).every((item) => item.dueAt !== null), true);
    assert.equal(all.slice(8).every((item) => item.dueAt === null && item.source === "task"), true);
    assert.equal(all[0].id, deal.id, "a deal before a task due the same instant");
    assert.equal(all.slice(8).every((item) => item.overdue === false), true);
    for (const limit of [1, 3, 4, 8, 9]) {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard++) {
        const answer = await callTool("list_follow_ups", { limit, ...(cursor ? { cursor } : {}) });
        assert.equal(answer.status, 200, answer.body.error);
        ids.push(...(answer.body.followUps as Array<{ id: string }>).map((row) => row.id));
        if (!answer.body.nextCursor) break;
        cursor = answer.body.nextCursor;
      }
      assertExactlyOnce(ids, all.map((item) => item.id), `limit ${limit}`);
    }
  });

  test("undated include, only and exclude; due filters and states leave undated tasks out on their own", async () => {
    await seedFollowUps();
    const ids = async (args: Record<string, unknown>) => {
      const answer = await callTool("list_follow_ups", { limit: 500, ...args });
      assert.equal(answer.status, 200, answer.body.error);
      return answer.body.followUps as Array<{ id: string; dueAt: string | null; title: string }>;
    };
    assert.equal((await ids({})).length, 17);
    assert.equal((await ids({ undated: "include" })).length, 17);
    const only = await ids({ undated: "only" });
    assert.equal(only.length, 9);
    assert.equal(only.every((row) => row.dueAt === null), true);
    const excluded = await ids({ undated: "exclude" });
    assert.equal(excluded.length, 8);
    assert.equal(excluded.every((row) => row.dueAt !== null), true);
    assert.equal((await ids({ state: "upcoming" })).length, 8);
    assert.equal((await ids({ state: "overdue" })).length, 0);
    assert.equal((await ids({ dueFrom: "2030-01-01T00:00:00.000Z" })).length, 8);
    assert.equal((await ids({ dueTo: "2031-01-01T00:00:00.000Z", undated: "only" })).length, 0);
    assert.equal((await ids({ source: "deal" })).length, 1);
    assert.equal((await ids({ source: "deal", undated: "only" })).length, 0);
    const highOnly = await ids({ undated: "only", priority: "high" });
    assert.deepEqual(highOnly.map((row) => row.title), ["Undated 0"]);
    // REST and the tool agree.
    const user = await insert(User, {
      email: "rest@example.com",
      name: "Rest",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: user.id, role: "member" });
    actingUserId = user.id;
    for (const undated of ["include", "only", "exclude"] as const) {
      const response = await fetch(
        `${baseUrl}/api/companies/${company.id}/revenue/follow-ups?limit=500&undated=${undated}`,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { rows: Array<{ id: string }> };
      assert.deepEqual(
        body.rows.map((row) => row.id),
        (await ids({ undated })).map((row) => row.id),
        undated,
      );
    }
    const defaulted = (await (
      await fetch(`${baseUrl}/api/companies/${company.id}/revenue/follow-ups?limit=500`)
    ).json()) as { rows: Array<{ dueAt: string | null }> };
    assert.equal(defaulted.rows.length, 17, "REST includes undated tasks by default too");
  });

  test("bulk actions reach undated follow-ups by id and by the same filter the queue lists", async () => {
    await seedFollowUps();
    const undated = await listFollowUps(company.id, { undated: "only", limit: 500 });
    const preview = await runRevenueBulkOperation(company.id, {
      resourceType: "follow_up",
      target: { followUpIds: [{ source: "task", id: undated[0].id }] },
      action: { type: "update_follow_up", taskStatus: "completed" },
      dryRun: true,
    });
    assert.deepEqual(
      preview.rows.map((row) => row.resourceId),
      [undated[0].id],
      "an undated task picked by id is found",
    );
    for (const value of [undefined, "include", "only", "exclude"] as const) {
      const filter = {
        state: "all" as const,
        source: "task" as const,
        ...(value ? { undated: value } : {}),
      };
      const queue = await listFollowUps(company.id, { ...filter, limit: 500 });
      const matched = await runRevenueBulkOperation(company.id, {
        resourceType: "follow_up",
        target: { filter },
        action: { type: "update_follow_up", priority: "high" },
        dryRun: true,
      });
      assert.deepEqual(
        matched.rows.map((row) => row.resourceId),
        queue.map((item) => item.id),
        `undated ${value ?? "default"}`,
      );
    }
  });

  test("a follow-up page cursor in the undated part survives tasks completed meanwhile", async () => {
    await seedFollowUps();
    const first = await listFollowUpPage(company.id, { limit: 11 });
    const seen = first.rows.map((row) => row.id);
    assert.equal(first.rows.at(-1)?.dueAt, null, "the page ends among the undated tasks");
    // Complete every undated task already shown: the next page carries on after them.
    for (const row of first.rows.filter((item) => item.dueAt === null)) {
      await AppDataSource.getRepository(Activity).update({ id: row.id }, { taskStatus: "completed" });
    }
    const rest = await listFollowUpPage(company.id, { limit: 50, cursor: first.nextCursor! });
    const everything = await listFollowUps(company.id, {
      limit: 500,
      status: "open",
    });
    assert.equal(rest.nextCursor, null);
    assert.equal(rest.rows.length, 6);
    for (const row of rest.rows) assert.equal(seen.includes(row.id), false);
    assert.deepEqual(
      rest.rows.map((row) => row.id),
      everything.filter((item) => item.dueAt === null).map((item) => item.id),
    );
  });
});
