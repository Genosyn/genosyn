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
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { invoicePaidNotice } from "../services/invoicePaidNotice.js";
import { seedChartOfAccounts } from "../services/ledger.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * When an invoice is paid, the company's owners and admins get a confirmation
 * email — and the customer gets nothing. It is sent once, on the edge into
 * Paid, whoever recorded the payment that got it there.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let mcpToken = "";
let company: Company;
let customer: Customer;

const OWNER = "owner@sunwise.example";
const ADMIN = "admin@sunwise.example";
const MEMBER = "member@sunwise.example";
const CUSTOMER = "ap@acme.example";

const originalLog = console.log;

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
  const person = (email: string, name: string) =>
    insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
  const owner = await person(OWNER, "Owner");
  const admin = await person(ADMIN, "Admin");
  const member = await person(MEMBER, "Member");
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Sunwise",
    slug: `sunwise-${randomUUID()}`,
    ownerId: owner.id,
  });
  for (const [user, role] of [
    [owner, "owner"],
    [admin, "admin"],
    [member, "member"],
  ] as const) {
    await insert(Membership, { companyId: company.id, userId: user.id, role: role as Role });
  }
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: CUSTOMER,
    currency: "USD",
  });
  await seedChartOfAccounts(company.id);
});

type Doc = {
  slug: string;
  number: string;
  status: string;
  balanceCents: number;
  error?: string;
};

/** Quiet: an unconfigured transport prints every email to the console. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  console.log = () => undefined;
  try {
    return await work();
  } finally {
    console.log = originalLog;
  }
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Doc }> {
  return quietly(async () => {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Doc };
  });
}

async function issuedInvoice(): Promise<Doc> {
  const draft = await call("POST", "/invoices", {
    customerId: customer.id,
    issueDate: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-10-31T00:00:00.000Z",
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 100_000 }],
  });
  assert.equal(draft.status, 200, draft.body.error);
  const issued = await call("POST", `/invoices/${draft.body.slug}/issue`);
  assert.equal(issued.status, 200, issued.body.error);
  return issued.body;
}

async function sentTo(): Promise<string[]> {
  const logs = await AppDataSource.getRepository(EmailLog).find({
    where: { companyId: company.id },
  });
  return logs.map((log) => log.toAddress).sort();
}

describe("the paid confirmation", () => {
  test("goes to each owner and admin once the invoice is paid, never the customer", async () => {
    const inv = await issuedInvoice();

    const part = await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 40_000 });
    assert.equal(part.status, 200, part.body.error);
    assert.equal(part.body.status, "sent");
    assert.deepEqual(await sentTo(), [], "a part payment confirms nothing");

    const rest = await call("POST", `/invoices/${inv.slug}/payments`, {
      amountCents: 60_000,
      method: "bank_transfer",
      reference: "WIRE-778",
    });
    assert.equal(rest.status, 200, rest.body.error);
    assert.equal(rest.body.status, "paid");
    assert.deepEqual(await sentTo(), [ADMIN, OWNER]);

    const [log] = await AppDataSource.getRepository(EmailLog).find({
      where: { companyId: company.id },
    });
    assert.equal(log.subject, `Invoice ${inv.number} marked paid — Acme Corp, $1,000.00`);
    assert.match(log.bodyPreview, /WIRE-778/);
    assert.match(log.bodyPreview, /Acme Corp was not emailed/);
  });

  test("is sent again only after the invoice stops being paid and is paid again", async () => {
    const inv = await issuedInvoice();
    const paid = await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 100_000 });
    assert.equal(paid.body.status, "paid");
    assert.equal((await sentTo()).length, 2);

    // Overpaying a paid invoice moves no status, so it confirms nothing new.
    const extra = await call("POST", `/invoices/${inv.slug}/payments`, {
      amountCents: 5_000,
      allowOverpayment: true,
    });
    assert.equal(extra.status, 200, extra.body.error);
    assert.equal((await sentTo()).length, 2);

    const full = (await AppDataSource.query(
      "SELECT id FROM invoice_payments WHERE amountCents = 100000",
    )) as Array<{ id: string }>;
    const removed = await call("DELETE", `/invoices/${inv.slug}/payments/${full[0].id}`);
    assert.equal(removed.body.status, "sent");
    assert.equal((await sentTo()).length, 2);

    await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 100_000 });
    assert.equal((await sentTo()).length, 4);
  });

  test("is not sent when a write-off settles the invoice, since nobody paid it", async () => {
    const inv = await issuedInvoice();
    const writtenOff = await call("POST", `/invoices/${inv.slug}/write-off`, {
      amountCents: 100_000,
      kind: "bad_debt",
    });
    assert.equal(writtenOff.status, 200, writtenOff.body.error);
    assert.equal(writtenOff.body.balanceCents, 0);
    assert.deepEqual(await sentTo(), []);
  });

  test("goes out the same way when an AI Employee records the payment", async () => {
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
    const inv = await issuedInvoice();

    const response = await quietly(() =>
      fetch(`${baseUrl}/internal/mcp/tools/record_payment`, {
        method: "POST",
        headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
        body: JSON.stringify({ invoiceSlug: inv.slug, amountCents: 100_000 }),
      }),
    );

    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(await sentTo(), [ADMIN, OWNER]);
  });
});

describe("the confirmation's wording", () => {
  test("lists the amounts and payments and links to the invoice", () => {
    const { subject, text } = invoicePaidNotice({
      invoice: {
        number: "ACME-CORP-INV-0007",
        slug: "acme-corp-inv-0007",
        currency: "USD",
        totalCents: 8_820_000,
        paidCents: 8_000_000,
        creditedCents: 820_000,
        writtenOffCents: 0,
      },
      customerName: "Acme Corp",
      companyName: "Sunwise",
      companySlug: "sunwise",
      payments: [
        {
          amountCents: 8_000_000,
          paidAt: new Date("2026-10-20T10:00:00.000Z"),
          method: "bank_transfer",
          reference: "WIRE-9",
        },
      ],
      publicUrl: "https://genosyn.example",
    });

    assert.equal(subject, "Invoice ACME-CORP-INV-0007 marked paid — Acme Corp, $88,200.00");
    assert.match(text, /^Invoice ACME-CORP-INV-0007 to Acme Corp is now marked paid\./);
    assert.match(text, /Paid: \$80,000\.00\nCredited: \$8,200\.00/);
    assert.doesNotMatch(text, /Written off/);
    assert.match(text, /- 2026-10-20 · \$80,000\.00 · Bank transfer · ref WIRE-9/);
    assert.match(
      text,
      /Open the invoice: https:\/\/genosyn\.example\/c\/sunwise\/finance\/invoices\/acme-corp-inv-0007/,
    );
    assert.match(text, /owners and admins of Sunwise\. Acme Corp was not emailed\./);
  });
});
