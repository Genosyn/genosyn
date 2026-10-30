import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Bill } from "../db/entities/Bill.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { Vendor } from "../db/entities/Vendor.js";
import { errorHandler } from "../middleware/error.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import {
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  TOOL_PAGE_BUDGET_CHARS,
} from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Every Finance list an AI Employee reads pages, through the tool endpoint it
 * actually calls: Banking, Entry review, invoices, bills, recurring invoices
 * and customers. The first test is the report this work came from, replayed:
 * 1,069 card purchases, 569 of them older than August 2023, which the old
 * Banking list could not reach past its newest 500.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;
let cardFeed: CardFeed;
let bankFeed: BankFeed;
let general: Account;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function feeds(companyId: string) {
  await seedChartOfAccounts(companyId);
  const bank = (await accountByCode(companyId, "1100"))!;
  const g = (await accountByCode(companyId, "6000"))!;
  const card = await insert(CardFeed, {
    companyId,
    name: "Brex Primary",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: (await accountByCode(companyId, "2300"))!.id,
    defaultExpenseAccountId: g.id,
    paymentAccountId: bank.id,
  });
  const checking = await insert(BankFeed, {
    companyId,
    name: "Wise",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  return { card, checking, general: g };
}

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Bookkeeper",
    soulBody: "",
  });
  grant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  ({ card: cardFeed, checking: bankFeed, general } = await feeds(company.id));
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function callTool(name: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & {
      error?: string;
      total?: number;
      hasMore?: boolean;
      nextCursor?: string | null;
      note?: string;
    },
  };
}

/** Follow nextCursor to the end, returning every row's id (or slug) in order and the pages. */
async function readEveryPage(tool: string, rowsKey: string, args: Record<string, unknown>) {
  const ids: string[] = [];
  const pages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await callTool(tool, { ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    for (const row of page.body[rowsKey] as Array<{ id?: string; slug?: string }>) {
      const key = row.id ?? row.slug;
      assert.ok(key, "every row is identifiable");
      ids.push(key);
    }
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null);
      return { ids, pages };
    }
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

const DAY_MS = 86_400_000;

/** Card purchases two to an instant (so dates and instants repeat), the first on `firstDay`. */
async function cardPurchases(
  companyId: string,
  feed: CardFeed,
  count: number,
  firstDay: Date,
  at: (index: number) => Date = (index) =>
    new Date(firstDay.getTime() + Math.floor(index / 2) * DAY_MS),
) {
  const rows: Partial<CardTransaction>[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: randomUUID(),
      companyId,
      feedId: feed.id,
      externalId: randomUUID(),
      postedAt: at(i),
      amountCents: 1_000 + i,
      currency: "USD",
      description: i % 100 === 7 ? "WORLDREMIT" : i % 50 === 3 ? "Google Ads" : `Vendor ${i}`,
      accountingKind: "expense",
      expenseAccountId: feed.defaultExpenseAccountId,
      ledgerEntryId: `entry-${i}`,
      needsReview: true,
      raw: "",
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await AppDataSource.getRepository(CardTransaction).insert(rows.slice(i, i + 200));
  }
  return rows;
}

describe("list_banking_transactions", () => {
  test("reaches all 1,069 card purchases, and the 569 older than August 2023 by date", async () => {
    // 1,069 purchases, two to a day: the first 569 before 2023-08-01, the
    // newest 500 from it on — the 500 the old list stopped at.
    const august = Date.UTC(2023, 7, 1);
    const rows = await cardPurchases(
      company.id,
      cardFeed,
      1_069,
      new Date(august),
      (index) => new Date(august + Math.floor((index - 569) / 2) * DAY_MS),
    );
    const older = rows.filter((row) => row.postedAt! < new Date("2023-08-01T00:00:00Z"));
    assert.equal(older.length, 569, "the fixture matches the report");

    const all = await readEveryPage("list_banking_transactions", "transactions", {
      kind: "card",
      status: "all",
      limit: 200,
    });
    assert.equal(new Set(all.ids).size, 1_069, "every purchase, none twice");
    assert.equal(all.ids.length, 1_069);
    assert.ok(
      all.pages.every((page) => page.total === 1_069),
      "total is the whole list on every page",
    );

    const before = await readEveryPage("list_banking_transactions", "transactions", {
      kind: "card",
      status: "all",
      to: "2023-07-31",
    });
    assert.equal(before.pages[0].total, 569);
    assert.deepEqual(new Set(before.ids), new Set(older.map((row) => row.id)));

    // The merchants the report could not reach, found by name.
    const remit = await callTool("list_banking_transactions", {
      status: "all",
      q: "worldremit",
      to: "2023-07-31",
    });
    assert.equal(remit.status, 200, remit.body.error);
    assert.ok(
      (remit.body.transactions as Array<{ description: string; date: string }>).every(
        (row) => row.description === "WORLDREMIT" && row.date < "2023-08-01",
      ),
      "only WORLDREMIT purchases before August",
    );
    assert.equal(remit.body.total, older.filter((row) => row.description === "WORLDREMIT").length);
  });

  test("answers paging first and keeps every page within a tool result", async () => {
    await cardPurchases(company.id, cardFeed, 260, new Date("2024-01-01T00:00:00Z"));
    const page = await callTool("list_banking_transactions", { status: "all", limit: 5_000 });
    assert.equal(page.status, 200, page.body.error);
    assert.deepEqual(Object.keys(page.body).slice(0, 4), [
      "total",
      "hasMore",
      "nextCursor",
      "note",
    ]);
    const rows = page.body.transactions as unknown[];
    assert.ok(rows.length <= 200, "a larger limit is cut to 200");
    assert.ok(
      JSON.stringify(page.body, null, 2).length <= TOOL_PAGE_BUDGET_CHARS + 2_000,
      "fits the budget",
    );
    assert.equal(page.body.hasMore, true);
    assert.match(
      page.body.note!,
      new RegExp(`holds ${rows.length} of the 260 matching transactions`),
    );
    const defaults = await callTool("list_banking_transactions", { status: "all" });
    assert.equal((defaults.body.transactions as unknown[]).length, 50, "50 by default");
  });

  test("refuses a cursor from other filters or another list, and a filter it cannot read", async () => {
    await cardPurchases(company.id, cardFeed, 60, new Date("2024-01-01T00:00:00Z"));
    const first = await callTool("list_banking_transactions", { status: "all", limit: 10 });
    const otherFilters = await callTool("list_banking_transactions", {
      status: "review",
      limit: 10,
      cursor: first.body.nextCursor,
    });
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const ledger = await callTool("list_finance_transactions", { cursor: first.body.nextCursor });
    assert.equal(ledger.status, 400);
    assert.equal(ledger.body.error, CURSOR_OTHER_LIST);
    const garbled = await callTool("list_banking_transactions", { cursor: "not-a-cursor" });
    assert.equal(garbled.status, 400);
    assert.match(garbled.body.error!, /without cursor/);
    const badDate = await callTool("list_banking_transactions", { from: "last summer" });
    assert.equal(badDate.status, 400);
    assert.match(badDate.body.error!, /YYYY-MM-DD/);
    const backwards = await callTool("list_banking_transactions", {
      from: "2024-02-01",
      to: "2024-01-01",
    });
    assert.equal(backwards.status, 400);
    const zero = await callTool("list_banking_transactions", { limit: 0 });
    assert.equal(zero.status, 400, "a limit below one is a schema error");
    const unknownFeed = await callTool("list_banking_transactions", { feedId: randomUUID() });
    assert.equal(unknownFeed.status, 404);
    assert.match(unknownFeed.body.error!, /list_banking_accounts/);
  });

  test("never shows another company's transactions, even with its feed id", async () => {
    const theirs = await feeds(otherCompany.id);
    await cardPurchases(otherCompany.id, theirs.card, 30, new Date("2024-01-01T00:00:00Z"));
    await cardPurchases(company.id, cardFeed, 5, new Date("2024-01-01T00:00:00Z"));
    const mine = await callTool("list_banking_transactions", { status: "all" });
    assert.equal(mine.body.total, 5);
    const viaTheirFeed = await callTool("list_banking_transactions", { feedId: theirs.card.id });
    assert.equal(viaTheirFeed.status, 404);
  });

  test("is refused without a Finance Grant", async () => {
    await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ id: grant.id });
    const refused = await callTool("list_banking_transactions");
    assert.equal(refused.status, 403);
    assert.match(refused.body.error!, /No grant/);
  });

  test("passes every filter through, alone and combined", async () => {
    await insert(BankTransaction, {
      companyId: company.id,
      feedId: bankFeed.id,
      externalId: null,
      date: new Date("2023-07-15T00:00:00Z"),
      amountCents: -10_770_400,
      description: "WORLDREMIT LTD",
      reference: "WR-1",
      raw: "",
    });
    await insert(BankTransaction, {
      companyId: company.id,
      feedId: bankFeed.id,
      externalId: null,
      date: new Date("2023-07-16T00:00:00Z"),
      amountCents: 95_000_000,
      description: "Intercompany transfer",
      reference: "",
      raw: "",
    });
    await cardPurchases(company.id, cardFeed, 4, new Date("2023-07-15T00:00:00Z"));
    const count = async (args: Record<string, unknown>) => {
      const result = await callTool("list_banking_transactions", { status: "all", ...args });
      assert.equal(result.status, 200, result.body.error);
      return result.body.total;
    };
    assert.equal(await count({}), 6);
    assert.equal(await count({ kind: "bank" }), 2);
    assert.equal(await count({ feedId: cardFeed.id }), 4);
    assert.equal(await count({ direction: "in" }), 1);
    assert.equal(await count({ direction: "out", kind: "bank" }), 1);
    assert.equal(await count({ minAmountCents: 1_000_000 }), 2);
    assert.equal(await count({ maxAmountCents: 1_001 }), 2, "the two cheapest purchases");
    assert.equal(await count({ q: "worldremit" }), 1);
    assert.equal(await count({ q: "WR-1" }), 1, "a bank line's reference");
    assert.equal(await count({ from: "2023-07-16", to: "2023-07-16" }), 3);
    assert.equal(await count({ categoryAccountId: general.id }), 4);
    assert.equal(await count({ status: "review" }), 6);
    assert.equal(
      await count({ kind: "bank", direction: "in", from: "2023-07-16", q: "intercompany" }),
      1,
    );
  });
});

describe("list_finance_transactions", () => {
  async function entries(count: number) {
    const bank = (await accountByCode(company.id, "1100"))!;
    const rent = await insert(Account, {
      companyId: company.id,
      code: "6085",
      name: "Rent",
      type: "expense",
    });
    for (let i = 0; i < count; i++) {
      const entry = await insert(LedgerEntry, {
        companyId: company.id,
        date: new Date(Date.UTC(2023, 0, 1 + Math.floor(i / 3))),
        memo: i % 10 === 0 ? `Wembley Park rent ${i}` : `Entry ${i}`,
        source: "manual",
        sourceRefId: null,
        reviewStatus: i % 4 === 0 ? "approved" : "unreviewed",
      });
      await insert(LedgerLine, {
        ledgerEntryId: entry.id,
        companyId: company.id,
        accountId: i % 10 === 0 ? rent.id : general.id,
        debitCents: 100 * (i + 1),
        creditCents: 0,
        sortOrder: 0,
      });
      await insert(LedgerLine, {
        ledgerEntryId: entry.id,
        companyId: company.id,
        accountId: bank.id,
        debitCents: 0,
        creditCents: 100 * (i + 1),
        sortOrder: 1,
      });
    }
    return { rent };
  }

  test("pages through every journal entry, and filters by account, memo, total and review status", async () => {
    const { rent } = await entries(130);
    const all = await readEveryPage("list_finance_transactions", "transactions", { limit: 20 });
    assert.equal(all.ids.length, 130);
    assert.equal(new Set(all.ids).size, 130);
    const unreviewed = await readEveryPage("list_finance_transactions", "transactions", {
      reviewStatus: "unreviewed",
      limit: 25,
    });
    assert.equal(unreviewed.ids.length, 130 - 33);
    const rentEntries = await callTool("list_finance_transactions", { accountId: rent.id });
    assert.equal(rentEntries.body.total, 13);
    const memo = await callTool("list_finance_transactions", { q: "wembley" });
    assert.equal(memo.body.total, 13);
    const big = await callTool("list_finance_transactions", { minAmountCents: 12_001 });
    assert.equal(big.body.total, 10, "entries 121…130 total more than 12,000 cents");
    const window = await callTool("list_finance_transactions", {
      from: "2023-01-01",
      to: "2023-01-02",
    });
    assert.equal(window.body.total, 6, "three a day, both days whole");
    const unknown = await callTool("list_finance_transactions", { accountId: randomUUID() });
    assert.equal(unknown.status, 404);
  });
});

describe("the document lists", () => {
  test("list_invoices pages past 100 and filters by issue and due date", async () => {
    const customer = await insert(Customer, {
      companyId: company.id,
      name: "Acme Ltd",
      slug: "acme-ltd",
    });
    for (let i = 0; i < 130; i++) {
      await insert(Invoice, {
        companyId: company.id,
        customerId: customer.id,
        slug: `inv-${i}`,
        number: `INV-${i}`,
        status: i % 2 ? "sent" : "paid",
        currency: "USD",
        issueDate: new Date(Date.UTC(2023, 0, 1 + i)),
        dueDate: new Date(Date.UTC(2023, 1, 1 + i)),
      });
    }
    const all = await readEveryPage("list_invoices", "invoices", { limit: 1_000 });
    assert.equal(all.ids.length, 130, "every invoice past the old cap of 100");
    assert.equal(new Set(all.ids).size, 130);
    const january = await callTool("list_invoices", { from: "2023-01-01", to: "2023-01-31" });
    assert.equal(january.body.total, 31);
    const dueSoon = await callTool("list_invoices", { status: "sent", dueTo: "2023-02-10" });
    assert.equal(dueSoon.body.total, 5);
  });

  test("list_bills pages soonest due first and filters by due date", async () => {
    const vendor = await insert(Vendor, {
      companyId: company.id,
      name: "Cloudflare",
      slug: "cloudflare",
    });
    for (let i = 0; i < 70; i++) {
      await insert(Bill, {
        companyId: company.id,
        vendorId: vendor.id,
        slug: `bill-${i}`,
        number: `BILL-${i}`,
        status: "sent",
        currency: "USD",
        issueDate: new Date(Date.UTC(2023, 0, 1)),
        dueDate: new Date(Date.UTC(2023, 0, 1 + (i % 35))),
      });
    }
    const all = await readEveryPage("list_bills", "bills", { limit: 30 });
    assert.equal(all.ids.length, 70);
    assert.equal(new Set(all.ids).size, 70);
    const dueDates = all.pages.flatMap((page) =>
      (page.bills as Array<{ dueDate: string }>).map((bill) => bill.dueDate),
    );
    assert.deepEqual(dueDates, [...dueDates].sort(), "soonest due first, across pages");
    const firstWeek = await callTool("list_bills", { dueFrom: "2023-01-01", dueTo: "2023-01-07" });
    assert.equal(firstWeek.body.total, 14);
  });

  test("list_customers pages and finds a customer by name or contact", async () => {
    for (let i = 0; i < 230; i++) {
      await insert(Customer, {
        companyId: company.id,
        name: i === 117 ? "Citygate Motors" : `Customer ${i}`,
        slug: `customer-${i}`,
        email: `billing${i}@example.test`,
      });
    }
    const all = await readEveryPage("list_customers", "customers", { limit: 200 });
    assert.equal(all.ids.length, 230, "every customer past the old cap of 200");
    const found = await callTool("list_customers", { q: "citygate" });
    assert.equal(found.body.total, 1);
    assert.equal((found.body.customers as Array<{ name: string }>)[0].name, "Citygate Motors");
  });

  test("list_recurring_invoices pages past 100", async () => {
    const customer = await insert(Customer, {
      companyId: company.id,
      name: "Acme Ltd",
      slug: "acme-ltd",
    });
    for (let i = 0; i < 105; i++) {
      await insert(RecurringInvoice, {
        companyId: company.id,
        customerId: customer.id,
        name: `Retainer ${i}`,
        slug: `retainer-${i}`,
        status: "active",
        currency: "USD",
        cronExpr: "0 9 1 * *",
        nextRunAt: new Date("2030-01-01T00:00:00Z"),
      });
    }
    const all = await readEveryPage("list_recurring_invoices", "recurringInvoices", { limit: 100 });
    assert.equal(all.ids.length, 105);
    assert.equal(new Set(all.ids).size, 105);
  });
});
