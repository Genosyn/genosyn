import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * `send_invoice` is the AI Employee's version of the Member "Issue & send"
 * button, and it carried the same defect: it auto-issued the draft — which
 * renumbers the row and changes its slug — and only then tried to address the
 * email. A customer with no address on file therefore left the employee with
 * a 400 that never named the new slug, so its next lookup by `invoiceSlug`
 * 404'd and the invoice read as deleted. Worse than the browser case: an AI
 * that believes a send failed will reasonably try again, and the books have
 * already moved.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let customer: Customer;
let employee: AIEmployee;

const originalChromePath = config.browser.executablePath;
const originalLog = console.log;
const originalWarn = console.warn;

before(async () => {
  await initTestDb();
  // See financeSendStrandedSlug.test.ts: keep the PDF renderer from launching
  // a real browser, which costs ~24s per send and is not what this tests.
  (config.browser as { executablePath: string }).executablePath =
    "/nonexistent/chrome-for-tests";
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
  (config.browser as { executablePath: string }).executablePath = originalChromePath;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Acme",
    slug: `acme-${randomUUID()}`,
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
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
  // No address on file — the case that stranded the invoice.
  customer = await insert(Customer, {
    companyId: company.id,
    name: "BaFin",
    slug: "bafin",
    currency: "USD",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function quietly<T>(operation: () => Promise<T>): Promise<T> {
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function draftInvoice(): Promise<Invoice> {
  const invoice = await insert(Invoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: `draft-${randomUUID().slice(0, 6)}`,
    number: "",
    numberSeq: 0,
    status: "draft",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    dueDate: new Date("2026-09-05T00:00:00.000Z"),
    subtotalCents: 25_000,
    totalCents: 25_000,
    balanceCents: 25_000,
  });
  await insert(InvoiceLineItem, {
    invoiceId: invoice.id,
    description: "Retainer",
    quantity: 1,
    unitPriceCents: 25_000,
    lineTotalCents: 25_000,
    sortOrder: 0,
  });
  return invoice;
}

async function sendInvoice(
  body: Record<string, unknown>,
): Promise<{
  status: number;
  body: { error?: string; invoice?: { slug: string; status: string } };
}> {
  const response = await quietly(() =>
    fetch(`${baseUrl}/internal/mcp/tools/send_invoice`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: string;
      invoice?: { slug: string; status: string };
    },
  };
}

test("send_invoice refuses an unreachable customer without issuing the draft", async () => {
  const invoice = await draftInvoice();

  const response = await sendInvoice({ invoiceSlug: invoice.slug });

  assert.equal(response.status, 400);
  assert.match(response.body.error ?? "", /no email address/i);
  const after = await AppDataSource.getRepository(Invoice).findOneByOrFail({
    id: invoice.id,
  });
  assert.equal(after.slug, invoice.slug, "the slug the employee holds still works");
  assert.equal(after.status, "draft");
  assert.equal(after.number, "");
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("the slug a refused send reported is still resolvable by a retry", async () => {
  const invoice = await draftInvoice();

  await sendInvoice({ invoiceSlug: invoice.slug });
  // What the employee does next: try again with the slug it was given. Before
  // the fix this was a 404 and read as "the invoice was deleted".
  const retry = await sendInvoice({ invoiceSlug: invoice.slug });

  assert.equal(retry.status, 400);
  assert.match(retry.body.error ?? "", /no email address/i);
});

test("send_invoice issues and reports the new slug once there is somewhere to send", async () => {
  customer.email = "billing@bafin.example";
  await AppDataSource.getRepository(Customer).save(customer);
  const invoice = await draftInvoice();

  const response = await sendInvoice({ invoiceSlug: invoice.slug });

  assert.equal(response.status, 200);
  assert.equal(response.body.invoice?.slug, "bafin-inv-0001");
  assert.equal(response.body.invoice?.status, "sent");
});

test("an explicit recipient on the customer's own domain still sends", async () => {
  customer.email = "billing@bafin.example";
  await AppDataSource.getRepository(Customer).save(customer);
  const invoice = await draftInvoice();

  const response = await sendInvoice({
    invoiceSlug: invoice.slug,
    to: ["ap@bafin.example"],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.invoice?.slug, "bafin-inv-0001");
});

test("the recipient allowlist still refuses an off-domain address, and issues nothing", async () => {
  customer.email = "billing@bafin.example";
  await AppDataSource.getRepository(Customer).save(customer);
  const invoice = await draftInvoice();

  const response = await sendInvoice({
    invoiceSlug: invoice.slug,
    to: ["attacker@elsewhere.example"],
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error ?? "", /aren't allowed for an AI-sent invoice/i);
  const after = await AppDataSource.getRepository(Invoice).findOneByOrFail({
    id: invoice.id,
  });
  assert.equal(after.status, "draft");
  assert.equal(after.slug, invoice.slug);
});
