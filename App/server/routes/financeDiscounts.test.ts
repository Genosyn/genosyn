import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { overrideRuntimeSettingsForTests } from "../services/runtimeSettings.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * A discount on a whole estimate or invoice — a percentage or a fixed amount —
 * comes off before tax. What has to hold for it to be safe to send:
 *
 *   - the totals and the books agree: revenue is the discounted subtotal, tax
 *     is charged on the discounted price, and the receivable is the total;
 *   - the discount travels with the document — into the invoice an estimate
 *     converts into, a duplicate, and a full credit note, which credits what
 *     was charged rather than the undiscounted lines;
 *   - a sent invoice can be discounted after the fact, with the same limits as
 *     any other edit to one;
 *   - the customer's copy shows it, and an AI Employee can set it too.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let mcpToken = "";
let company: Company;
let customer: Customer;
let vat: TaxRate;

const originalLog = console.log;
const originalWarn = console.warn;

before(async () => {
  await initTestDb();
  overrideRuntimeSettingsForTests({
    browser: { executablePath: "/nonexistent/chrome-for-tests" },
  });
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", financeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (mcpToken) revokeMcpToken(mcpToken);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  overrideRuntimeSettingsForTests(null);
});

beforeEach(async () => {
  if (mcpToken) revokeMcpToken(mcpToken);
  mcpToken = "";
  await resetTestDb();
  const owner = await insert(User, {
    email: `discount-owner-${randomUUID()}@example.com`,
    name: "Finance Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Discount test",
    slug: `discount-test-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    currency: "USD",
  });
  vat = await insert(TaxRate, { companyId: company.id, name: "VAT", ratePercent: 10 });
  await seedChartOfAccounts(company.id);
});

type Doc = {
  id: string;
  slug: string;
  number: string;
  status: string;
  subtotalCents: number;
  discountPercent: number;
  discountAmountCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  balanceCents?: number;
  invoiceId?: string | null;
  lines?: Array<{ description: string; lineSubtotalCents: number; lineTaxCents: number }>;
  error?: string;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Doc }> {
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Doc };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

const totalsOf = (doc: Doc) => ({
  subtotalCents: doc.subtotalCents,
  discountCents: doc.discountCents,
  taxCents: doc.taxCents,
  totalCents: doc.totalCents,
});

/** One 1,000.00 line with 10% VAT, as the edit form sends it. */
const taxedLine = () => [
  {
    productId: null,
    description: "Consulting",
    quantity: 1,
    unitPriceCents: 100_000,
    taxRateId: vat.id,
    sortOrder: 0,
  },
];

async function draftInvoice(extra: Record<string, unknown> = {}): Promise<Doc> {
  const draft = await call("POST", "/invoices", {
    customerId: customer.id,
    issueDate: "2026-09-10T00:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    lines: taxedLine(),
    ...extra,
  });
  assert.equal(draft.status, 200, draft.body.error);
  return draft.body;
}

async function issuedInvoice(extra: Record<string, unknown> = {}): Promise<Doc> {
  const draft = await draftInvoice(extra);
  const issued = await call("POST", `/invoices/${draft.slug}/issue`);
  assert.equal(issued.status, 200, issued.body.error);
  return issued.body;
}

/** Signed (debit − credit) balance of each account code across the books. */
async function balances(): Promise<Record<string, number>> {
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId: company.id },
  });
  const out: Record<string, number> = {};
  for (const code of ["1100", "1200", "2100", "2400", "4000", "4100"]) {
    const account = await accountByCode(company.id, code);
    out[code] = lines
      .filter((l) => l.accountId === account!.id)
      .reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  }
  return out;
}

describe("a discounted invoice", () => {
  test("charges tax on the discounted price and books the discounted revenue", async () => {
    const draft = await draftInvoice({ discountPercent: 10 });

    assert.deepEqual(totalsOf(draft), {
      subtotalCents: 90_000,
      discountCents: 10_000,
      taxCents: 9_000,
      totalCents: 99_000,
    });
    await call("POST", `/invoices/${draft.slug}/issue`);
    const books = await balances();
    assert.equal(books["1200"], 99_000, "the customer owes the discounted total");
    assert.equal(books["4000"], -90_000, "revenue is net of the discount");
    assert.equal(books["2100"], -9_000, "tax is on the discounted price");
  });

  test("shows the discount on the customer's copy", async () => {
    const inv = await issuedInvoice({ discountPercent: 10 });

    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/invoices/${inv.slug}/html`,
    );
    const html = await response.text();

    assert.match(html, /<span>Subtotal<\/span><span class="num">\$1,000\.00<\/span>/);
    assert.match(html, /<span>Discount \(10%\)<\/span><span class="num">-\$100\.00<\/span>/);
    assert.match(html, /<span>Total<\/span><span class="num">\$990\.00<\/span>/);
  });

  test("a sent invoice can be discounted, and the books follow", async () => {
    const inv = await issuedInvoice();

    const edit = await call("PATCH", `/invoices/${inv.slug}`, { discountAmountCents: 20_000 });

    assert.equal(edit.status, 200, edit.body.error);
    assert.deepEqual(totalsOf(edit.body), {
      subtotalCents: 80_000,
      discountCents: 20_000,
      taxCents: 8_000,
      totalCents: 88_000,
    });
    const books = await balances();
    assert.equal(books["1200"], 88_000);
    assert.equal(books["4000"], -80_000);
    assert.equal(books["2100"], -8_000);
    const [revised] = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId: company.id,
      action: "finance.invoice.revise",
    });
    assert.deepEqual(JSON.parse(revised.metadataJson).fields, ["discount"]);
  });

  test("can't take the total below what has been paid", async () => {
    const inv = await issuedInvoice();
    await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 100_000 });

    const edit = await call("PATCH", `/invoices/${inv.slug}`, { discountPercent: 20 });

    assert.equal(edit.status, 400);
    assert.match(edit.body.error ?? "", /already paid/);
  });

  test("either field replaces the discount, and the two together are refused", async () => {
    const draft = await draftInvoice({ discountPercent: 10 });

    const toAmount = await call("PATCH", `/invoices/${draft.slug}`, {
      discountAmountCents: 5_000,
    });
    const both = await call("PATCH", `/invoices/${draft.slug}`, {
      discountPercent: 5,
      discountAmountCents: 5_000,
    });
    const removed = await call("PATCH", `/invoices/${draft.slug}`, { discountPercent: 0 });
    const createBoth = await call("POST", "/invoices", {
      customerId: customer.id,
      lines: taxedLine(),
      discountPercent: 5,
      discountAmountCents: 5_000,
    });

    assert.equal(toAmount.body.discountPercent, 0);
    assert.equal(toAmount.body.discountAmountCents, 5_000);
    assert.equal(both.status, 400);
    assert.match(both.body.error ?? "", /not both/);
    assert.equal(removed.body.discountCents, 0);
    assert.equal(removed.body.totalCents, 110_000);
    assert.equal(createBoth.status, 400);
  });

  test("a duplicate keeps the discount", async () => {
    const inv = await issuedInvoice({ discountAmountCents: 15_000 });

    const copy = await call("POST", `/invoices/${inv.slug}/duplicate`);

    assert.equal(copy.status, 200, copy.body.error);
    assert.equal(copy.body.discountAmountCents, 15_000);
    assert.deepEqual(totalsOf(copy.body), totalsOf(inv));
  });

  test("a full credit note credits what was charged, not the undiscounted lines", async () => {
    const inv = await issuedInvoice({ discountPercent: 10 });

    const credit = await call("POST", `/invoices/${inv.slug}/credit-note`, { mode: "full" });

    assert.equal(credit.status, 200, credit.body.error);
    assert.equal(credit.body.subtotalCents, 90_000);
    assert.equal(credit.body.taxCents, 9_000);
    assert.equal(credit.body.totalCents, 99_000);
    assert.deepEqual(
      credit.body.lines?.map((l) => [l.description, l.lineSubtotalCents, l.lineTaxCents]),
      [
        ["Consulting", 100_000, 10_000],
        ["Discount (10%)", -10_000, -1_000],
      ],
    );
    const books = await balances();
    assert.equal(books["1200"], 0, "the receivable is fully credited");
    assert.equal(books["4100"], 90_000, "returns reverse the revenue that was booked");
    assert.equal(books["2100"], 0, "and exactly the tax that was charged");
  });
});

describe("a discounted estimate", () => {
  test("converts into an invoice with the same discount and totals", async () => {
    const draft = await call("POST", "/estimates", {
      customerId: customer.id,
      issueDate: "2026-09-10T00:00:00.000Z",
      validUntil: "2026-12-10T00:00:00.000Z",
      lines: [
        ...taxedLine(),
        { description: "Training", quantity: 2, unitPriceCents: 25_000, sortOrder: 1 },
      ],
      discountAmountCents: 30_000,
    });
    assert.equal(draft.status, 200, draft.body.error);
    // 300.00 split across 1,000.00 (taxed) and 500.00 (untaxed): 200.00 + 100.00.
    assert.deepEqual(totalsOf(draft.body), {
      subtotalCents: 120_000,
      discountCents: 30_000,
      taxCents: 8_000,
      totalCents: 128_000,
    });
    const issued = await call("POST", `/estimates/${draft.body.slug}/issue`);

    const converted = await call("POST", `/estimates/${issued.body.slug}/convert`, {});

    assert.equal(converted.status, 200, converted.body.error);
    const invoice = (converted.body as unknown as { invoice: Doc }).invoice;
    assert.equal(invoice.discountAmountCents, 30_000);
    assert.deepEqual(totalsOf(invoice), totalsOf(draft.body));
    assert.equal((await balances())["1200"], 128_000);
  });

  test("a discount on a sent estimate is an edit like any other", async () => {
    const draft = await call("POST", "/estimates", {
      customerId: customer.id,
      lines: taxedLine(),
    });
    const issued = await call("POST", `/estimates/${draft.body.slug}/issue`);
    await call("POST", `/estimates/${issued.body.slug}/accept`);

    const edit = await call("PATCH", `/estimates/${issued.body.slug}`, { discountPercent: 15 });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.totalCents, 93_500);
    assert.equal(edit.body.status, "sent", "the customer accepted the undiscounted quote");
  });
});

describe("AI Employees", () => {
  test("create_estimate takes a discount and get_estimate reports it", async () => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Finance partner",
      slug: "finance-partner",
      role: "Finance partner",
      soulBody: "",
    });
    await insert(EmployeeFinanceGrant, {
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: "invoice",
    });
    mcpToken = issueMcpToken(employee.id, company.id, { authority: "employee" });

    const response = await fetch(`${baseUrl}/internal/mcp/tools/create_estimate`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        customerSlug: customer.slug,
        lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 200_000 }],
        discountPercent: 25,
      }),
    });
    const body = (await response.json()) as { estimate?: Doc; error?: string };

    assert.equal(response.status, 200, body.error);
    assert.equal(body.estimate?.discountPercent, 25);
    assert.equal(body.estimate?.discountCents, 50_000);
    assert.equal(body.estimate?.totalCents, 150_000);
  });
});
