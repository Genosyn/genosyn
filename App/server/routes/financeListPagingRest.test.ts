import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Bill } from "../db/entities/Bill.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import type { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership } from "../db/entities/Membership.js";
import type { User } from "../db/entities/User.js";
import { Vendor } from "../db/entities/Vendor.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { CURSOR_OTHER_FILTERS } from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { categorizeBankTransaction } from "../services/reconcile.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * The REST twins of the paged AI tools, end to end through `createApp()` with
 * a real API key: `GET /banking/transactions` and `GET /finance/transactions`
 * answer the same pages, from the same functions, as `list_banking_transactions`
 * and `list_finance_transactions`; `GET /invoices` and `GET /bills` page when
 * asked and keep their plain arrays when not. Finance access gates them like
 * every other Finance read, and the API reference documents them.
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
let cardFeed: CardFeed;

beforeEach(async () => {
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  ownerKey = (await mintTestApiKey(owner.id, company.id)).token;
  await seedChartOfAccounts(company.id);
  cardFeed = await insert(CardFeed, {
    companyId: company.id,
    name: "Brex Primary",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: (await accountByCode(company.id, "2300"))!.id,
    defaultExpenseAccountId: (await accountByCode(company.id, "6000"))!.id,
    paymentAccountId: (await accountByCode(company.id, "1100"))!.id,
  });
});

async function get(path: string, token = ownerKey, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

async function purchases(count: number) {
  const rows: Partial<CardTransaction>[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: randomUUID(),
      companyId: company.id,
      feedId: cardFeed.id,
      externalId: randomUUID(),
      postedAt: new Date(Date.UTC(2023, 0, 1 + Math.floor(i / 3))),
      amountCents: 1_000 + i,
      currency: "USD",
      description: i % 20 === 0 ? "Google Ads" : `Vendor ${i}`,
      accountingKind: "expense",
      expenseAccountId: cardFeed.defaultExpenseAccountId,
      ledgerEntryId: "posted",
      needsReview: true,
      raw: "",
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await AppDataSource.getRepository(CardTransaction).insert(rows.slice(i, i + 200));
  }
}

test("GET /banking/transactions pages every transaction with an API key, and filters like the tool", async () => {
  await purchases(250);
  const seen: string[] = [];
  let cursor = "";
  for (let guard = 0; guard < 20; guard++) {
    const page = await get(
      `/banking/transactions?status=all&limit=60${cursor ? `&cursor=${cursor}` : ""}`,
    );
    assert.equal(page.status, 200, page.body.error);
    assert.equal(page.body.total, 250);
    seen.push(...(page.body.transactions as Array<{ id: string }>).map((row) => row.id));
    if (!page.body.hasMore) break;
    cursor = page.body.nextCursor as string;
  }
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250);

  const ads = await get("/banking/transactions?q=google%20ads&to=2023-01-31");
  assert.equal(ads.status, 200, ads.body.error);
  assert.equal(ads.body.total, 5, "Google Ads purchases in January (days 0, 6, 13, 20, 26)");

  const clamped = await get("/banking/transactions?status=all&limit=900");
  assert.equal(
    (clamped.body.transactions as unknown[]).length,
    200,
    "a larger limit is cut to 200",
  );

  const otherFilters = await get(
    `/banking/transactions?status=review&cursor=${clamped.body.nextCursor as string}`,
  );
  assert.equal(otherFilters.status, 400);
  assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
  assert.equal((await get("/banking/transactions?status=maybe")).status, 400, "query validation");
  assert.equal(
    (await get("/banking/transactions?to=2023-02-30")).status,
    400,
    "an impossible date",
  );
});

test("view=records gives every row its whole transaction, as the Banking page reads the list", async () => {
  await purchases(30);
  const bankAccount = (await accountByCode(company.id, "1100"))!;
  const software = (await accountByCode(company.id, "6000"))!;
  const feed = await insert(BankFeed, {
    companyId: company.id,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bankAccount.id,
  });
  const lines: BankTransaction[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(
      await insert(BankTransaction, {
        companyId: company.id,
        feedId: feed.id,
        externalId: null,
        // Shares its instant with the card purchases dated that day.
        date: new Date(Date.UTC(2023, 0, 1 + i)),
        amountCents: i % 2 ? -(2_000 + i) : 5_000 + i,
        description: `Line ${i}`,
        reference: `REF-${i}`,
        raw: "",
      }),
    );
  }
  // One categorized, so its record carries the category it was filed under.
  await categorizeBankTransaction(lines[3], software.id, owner.id);

  const [bankList, cardList] = await Promise.all([
    get("/bank-transactions"),
    get("/card-transactions"),
  ]);
  const bankById = new Map(
    (bankList.body as unknown as Array<{ id: string }>).map((row) => [row.id, row]),
  );
  const cardById = new Map(
    (cardList.body as unknown as Array<{ id: string }>).map((row) => [row.id, row]),
  );

  type Row = { id: string; kind: "bank" | "card"; record?: { id: string; match?: unknown } };
  const seenSummary: string[] = [];
  const seenRecords: string[] = [];
  let cursor = "";
  for (let guard = 0; guard < 10; guard++) {
    const summary = await get(
      `/banking/transactions?status=all&limit=15${cursor ? `&cursor=${cursor}` : ""}`,
    );
    const records = await get(
      `/banking/transactions?status=all&limit=15&view=records${cursor ? `&cursor=${cursor}` : ""}`,
    );
    assert.equal(summary.status, 200, summary.body.error);
    assert.equal(records.status, 200, records.body.error);
    const summaryRows = summary.body.transactions as Row[];
    const recordRows = records.body.transactions as Row[];
    assert.deepEqual(
      recordRows.map((row) => row.id),
      summaryRows.map((row) => row.id),
      "the view changes what a row carries, never which rows a page holds",
    );
    assert.equal(records.body.total, summary.body.total);
    assert.equal(records.body.nextCursor, summary.body.nextCursor, "one cursor for both views");
    for (const row of summaryRows) assert.equal("record" in row, false, "the default is compact");
    for (const row of recordRows) {
      const expected = row.kind === "bank" ? bankById.get(row.id) : cardById.get(row.id);
      assert.deepEqual(
        row.record,
        expected,
        `${row.kind} ${row.id}: the record is what its own list answers`,
      );
    }
    seenSummary.push(...summaryRows.map((row) => row.id));
    seenRecords.push(...recordRows.map((row) => row.id));
    if (!summary.body.hasMore) break;
    // Alternate which view's cursor carries on: either continues the other.
    cursor = (guard % 2 ? summary.body.nextCursor : records.body.nextCursor) as string;
  }
  assert.equal(seenRecords.length, 42);
  assert.equal(new Set(seenRecords).size, 42);
  assert.deepEqual(seenRecords, seenSummary);

  const filed = await get(`/banking/transactions?status=done&view=records&kind=bank`);
  const [row] = filed.body.transactions as Array<
    Row & { record: { match: { kind: string; categoryAccountId: string } } }
  >;
  assert.equal(row.id, lines[3].id);
  assert.equal(row.record.match.kind, "ledger_entry");
  assert.equal(row.record.match.categoryAccountId, software.id);

  assert.equal((await get("/banking/transactions?view=everything")).status, 400);
});

test("the REST twin and the AI tool answer the same page", async () => {
  await purchases(80);
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Bookkeeper",
    soulBody: "",
  });
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  const mcp = issueMcpToken(employee.id, company.id, { authority: "employee" });
  try {
    const tool = await fetch(`${baseUrl}/api/internal/mcp/tools/list_banking_transactions`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "review", from: "2023-01-05", limit: 25 }),
    });
    const fromTool = (await tool.json()) as {
      transactions: Array<{ id: string }>;
      total: number;
      nextCursor: string;
    };
    const fromRest = await get("/banking/transactions?status=review&from=2023-01-05&limit=25");
    assert.deepEqual(
      (fromRest.body.transactions as Array<{ id: string }>).map((row) => row.id),
      fromTool.transactions.map((row) => row.id),
    );
    assert.equal(fromRest.body.total, fromTool.total);
    // A cursor from one continues the other: they are one list.
    const next = await get(
      `/banking/transactions?status=review&from=2023-01-05&limit=25&cursor=${fromTool.nextCursor}`,
    );
    assert.equal(next.status, 200, next.body.error);
  } finally {
    revokeMcpToken(mcp);
  }
});

test("GET /finance/transactions pages Entry review's journal", async () => {
  for (let i = 0; i < 70; i++) {
    await insert(LedgerEntry, {
      companyId: company.id,
      date: new Date(Date.UTC(2023, 0, 1 + (i % 10))),
      memo: i % 7 === 0 ? `Citygate ${i}` : `Entry ${i}`,
      source: "manual",
      sourceRefId: null,
      reviewStatus: "unreviewed",
    });
  }
  const seen: string[] = [];
  let cursor = "";
  for (let guard = 0; guard < 20; guard++) {
    const page = await get(`/finance/transactions?limit=30${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200, page.body.error);
    seen.push(...(page.body.transactions as Array<{ id: string }>).map((row) => row.id));
    if (!page.body.hasMore) break;
    cursor = page.body.nextCursor as string;
  }
  assert.equal(new Set(seen).size, 70);
  const memo = await get("/finance/transactions?q=citygate&reviewStatus=unreviewed");
  assert.equal(memo.body.total, 10);
  const legacy = await get("/ledger-entries?limit=500");
  assert.ok(Array.isArray(legacy.body), "the Finance pages' plain array is unchanged");
});

test("GET /invoices and GET /bills page when asked, and keep their plain arrays when not", async () => {
  const customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Ltd",
    slug: "acme-ltd",
  });
  const vendor = await insert(Vendor, { companyId: company.id, name: "Twilio", slug: "twilio" });
  for (let i = 0; i < 45; i++) {
    await insert(Invoice, {
      companyId: company.id,
      customerId: customer.id,
      slug: `inv-${i}`,
      number: `INV-${i}`,
      status: "sent",
      currency: "USD",
      issueDate: new Date(Date.UTC(2023, 0, 1 + i)),
      dueDate: new Date(Date.UTC(2023, 1, 1 + i)),
    });
    await insert(Bill, {
      companyId: company.id,
      vendorId: vendor.id,
      slug: `bill-${i}`,
      number: `BILL-${i}`,
      status: "sent",
      currency: "USD",
      issueDate: new Date(Date.UTC(2023, 0, 1)),
      dueDate: new Date(Date.UTC(2023, 0, 1 + i)),
    });
  }
  const plain = await get("/invoices");
  assert.ok(Array.isArray(plain.body));
  assert.equal((plain.body as unknown as unknown[]).length, 45);
  const january = await get("/invoices?from=2023-01-01&to=2023-01-31");
  assert.equal(
    (january.body as unknown as unknown[]).length,
    31,
    "date filters apply to the plain list too",
  );
  const page = await get("/invoices?limit=20");
  assert.equal(page.body.total, 45);
  assert.equal((page.body.invoices as unknown[]).length, 20);
  const second = await get(`/invoices?limit=20&cursor=${page.body.nextCursor as string}`);
  const ids = [
    ...(page.body.invoices as Array<{ id: string }>),
    ...(second.body.invoices as Array<{ id: string }>),
  ].map((row) => row.id);
  assert.equal(new Set(ids).size, 40);

  const bills = await get("/bills?limit=10&dueTo=2023-01-15");
  assert.equal(bills.status, 200, bills.body.error);
  assert.equal(bills.body.total, 15);
  assert.ok(Array.isArray((await get("/bills")).body), "the plain list is unchanged");
});

test("Finance access gates the paged lists like every other Finance read", async () => {
  const { user: outsider, company: theirs } = await createMemberOfNewCompany("owner");
  const outsiderKey = (await mintTestApiKey(outsider.id, theirs.id)).token;
  const foreign = await get("/banking/transactions", outsiderKey);
  assert.ok(
    [401, 403, 404].includes(foreign.status),
    `another company's key is refused (${foreign.status})`,
  );

  const member = await createMemberOfNewCompany("owner");
  await AppDataSource.getRepository(Membership).insert({
    companyId: company.id,
    userId: member.user.id,
    role: "member",
    financeAccess: "none",
  });
  const memberKey = (await mintTestApiKey(member.user.id, company.id)).token;
  for (const path of [
    "/banking/transactions",
    "/finance/transactions",
    "/invoices?limit=5",
    "/bills?limit=5",
  ]) {
    assert.equal((await get(path, memberKey)).status, 403, path);
  }
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: member.user.id },
    { financeAccess: "read" },
  );
  assert.equal((await get("/banking/transactions", memberKey)).status, 200);
});

test("POST /accounts still adds an account, under the shared chart-of-accounts rules", async () => {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ code: "1400", name: "Digital Assets", type: "asset" }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    (
      await AppDataSource.getRepository(Account).findOneByOrFail({
        companyId: company.id,
        code: "1400",
      })
    ).name,
    "Digital Assets",
  );
  const duplicate = await fetch(`${baseUrl}/api/companies/${company.id}/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ code: "1400", name: "Crypto", type: "asset" }),
  });
  assert.equal(duplicate.status, 409);
  const bank = (await accountByCode(company.id, "1100"))!;
  const archiveSystem = await fetch(`${baseUrl}/api/companies/${company.id}/accounts/${bank.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archiveSystem.status, 409);
});

test("the API reference documents the paged twins with their filters and page shape", () => {
  const document = buildOpenApiDocument(app) as unknown as {
    paths: Record<
      string,
      Record<string, { parameters?: Array<{ name: string }>; description?: string }>
    >;
  };
  for (const [path, filters] of [
    [
      "/api/companies/{cid}/banking/transactions",
      [
        "status",
        "kind",
        "feedId",
        "from",
        "to",
        "direction",
        "minAmountCents",
        "maxAmountCents",
        "q",
        "categoryAccountId",
        "view",
        "limit",
        "cursor",
      ],
    ],
    [
      "/api/companies/{cid}/finance/transactions",
      [
        "reviewStatus",
        "source",
        "from",
        "to",
        "accountId",
        "q",
        "minAmountCents",
        "maxAmountCents",
        "limit",
        "cursor",
      ],
    ],
    ["/api/companies/{cid}/invoices", ["from", "to", "dueFrom", "dueTo", "limit", "cursor"]],
  ] as const) {
    const operation = document.paths[path]?.get;
    assert.ok(operation, `${path} is documented`);
    const names = (operation.parameters ?? []).map((parameter) => parameter.name);
    for (const filter of filters) assert.ok(names.includes(filter), `${path} documents ${filter}`);
    assert.match(operation.description ?? "", /nextCursor/);
  }
});
