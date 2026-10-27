import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { errorHandler } from "../middleware/error.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The rest of an invoice's life, and the journal, through an AI Employee's
 * tools: what the invoice and journal pages let a Member do.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;
let customer: Customer;

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

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
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
    accessLevel: "full",
  });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Globex",
    slug: "globex",
    email: "ap@globex.example",
    currency: "USD",
  });
  await seedChartOfAccounts(company.id);
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function callTool(name: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

type InvoiceRow = { slug: string; status: string; totalCents: number; number: string };

test("tax rates are listable, so a line can carry one", async () => {
  const vat = await insert(TaxRate, {
    companyId: company.id,
    name: "VAT",
    ratePercent: 20,
    inclusive: false,
  });
  await insert(TaxRate, {
    companyId: company.id,
    name: "Old",
    ratePercent: 5,
    inclusive: false,
    archivedAt: new Date(),
  });
  const listed = await callTool("list_tax_rates");
  assert.equal(listed.status, 200, listed.body.error);
  assert.deepEqual(
    (listed.body.taxRates as Array<{ id: string }>).map((rate) => rate.id),
    [vat.id],
  );

  const created = await callTool("create_invoice", {
    customerSlug: customer.slug,
    lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000, taxRateId: vat.id }],
  });
  assert.equal(created.status, 200, created.body.error);
  assert.equal((created.body.invoice as InvoiceRow).totalCents, 12_000);
});

test("a draft is edited, issued without email, and a stray draft deleted", async () => {
  const created = await callTool("create_invoice", {
    customerSlug: customer.slug,
    lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
  });
  const slug = (created.body.invoice as InvoiceRow).slug;

  const edited = await callTool("update_invoice", {
    invoiceSlug: slug,
    notes: "Thanks!",
    lines: [{ description: "Work", quantity: 2, unitPriceCents: 10_000 }],
  });
  assert.equal(edited.status, 200, edited.body.error);
  assert.equal((edited.body.invoice as InvoiceRow).totalCents, 20_000);

  const issued = await callTool("issue_invoice", { invoiceSlug: slug });
  assert.equal(issued.status, 200, issued.body.error);
  const invoice = issued.body.invoice as InvoiceRow;
  assert.notEqual(invoice.status, "draft");
  assert.ok(invoice.number);
  assert.equal((await callTool("delete_invoice", { invoiceSlug: invoice.slug })).status, 409);

  const stray = await callTool("create_invoice", {
    customerSlug: customer.slug,
    lines: [{ description: "Oops", quantity: 1, unitPriceCents: 500 }],
  });
  const straySlug = (stray.body.invoice as InvoiceRow).slug;
  const deleted = await callTool("delete_invoice", { invoiceSlug: straySlug });
  assert.equal(deleted.status, 200, deleted.body.error);
  assert.equal(await AppDataSource.getRepository(Invoice).countBy({ slug: straySlug }), 0);
});

test("an issued estimate becomes an issued invoice with its lines", async () => {
  const estimate = await callTool("create_estimate", {
    customerSlug: customer.slug,
    lines: [{ description: "Design", quantity: 3, unitPriceCents: 5_000 }],
  });
  assert.equal(estimate.status, 200, estimate.body.error);
  const draftSlug = (estimate.body.estimate as { slug: string }).slug;
  const notYet = await callTool("convert_estimate_to_invoice", { estimateSlug: draftSlug });
  assert.equal(notYet.status, 400);

  const issued = await callTool("issue_estimate", { estimateSlug: draftSlug });
  assert.equal(issued.status, 200, issued.body.error);
  const issuedSlug = (issued.body.estimate as { slug: string }).slug;
  const converted = await callTool("convert_estimate_to_invoice", {
    estimateSlug: issuedSlug,
    dueInDays: 14,
  });
  assert.equal(converted.status, 200, converted.body.error);
  const invoice = converted.body.invoice as InvoiceRow;
  assert.equal(invoice.status, "sent");
  assert.ok(invoice.number);
  assert.equal(invoice.totalCents, 15_000);
});

test("a journal entry posts only when it balances, and needs Full access", async () => {
  const cash = (await accountByCode(company.id, "1100"))!;
  const expense = (await accountByCode(company.id, "6000"))!;
  const unbalanced = await callTool("create_finance_transaction", {
    memo: "Accrue rent",
    lines: [
      { accountId: expense.id, debitCents: 1_000 },
      { accountId: cash.id, creditCents: 900 },
    ],
  });
  assert.equal(unbalanced.status, 400);
  assert.match(unbalanced.body.error!, /unbalanced/);

  const posted = await callTool("create_finance_transaction", {
    memo: "Accrue rent",
    lines: [
      { accountId: expense.id, debitCents: 1_000, description: "October" },
      { accountId: cash.id, creditCents: 1_000 },
    ],
  });
  assert.equal(posted.status, 200, posted.body.error);
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    companyId: company.id,
    memo: "Accrue rent",
  });
  assert.equal(entry.source, "manual");
  assert.equal(entry.reviewStatus, "unreviewed");

  grant.accessLevel = "invoice";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);
  const refused = await callTool("create_finance_transaction", {
    memo: "Again",
    lines: [
      { accountId: expense.id, debitCents: 1 },
      { accountId: cash.id, creditCents: 1 },
    ],
  });
  assert.equal(refused.status, 403);
});

type BillRow = {
  slug: string;
  number: string;
  status: string;
  totalCents: number;
  balanceCents: number;
  payments: Array<{ id: string; amountCents: number }>;
};

test("a vendor's bill is entered, issued, paid in part, and its payment reversed", async () => {
  const expense = (await accountByCode(company.id, "6000"))!;
  const vendor = await callTool("create_vendor", { name: "Figma", currency: "USD" });
  assert.equal(vendor.status, 200, vendor.body.error);
  const vendorSlug = (vendor.body.vendor as { slug: string }).slug;

  const unready = await callTool("create_bill", {
    vendorSlug,
    vendorRef: "FIG-881",
    lines: [{ description: "Seats", quantity: 3, unitPriceCents: 1_500 }],
  });
  assert.equal(unready.status, 200, unready.body.error);
  const draftSlug = (unready.body.bill as BillRow).slug;
  const refused = await callTool("issue_bill", { billSlug: draftSlug });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error!, /expense account/);

  const fixed = await callTool("update_bill", {
    billSlug: draftSlug,
    lines: [
      { description: "Seats", quantity: 3, unitPriceCents: 1_500, expenseAccountId: expense.id },
    ],
  });
  assert.equal(fixed.status, 200, fixed.body.error);
  const issued = await callTool("issue_bill", { billSlug: draftSlug });
  assert.equal(issued.status, 200, issued.body.error);
  const bill = issued.body.bill as BillRow;
  assert.equal(bill.status, "sent");
  assert.equal(bill.totalCents, 4_500);
  assert.ok(bill.number);

  const lines = await callTool("update_bill", {
    billSlug: bill.slug,
    lines: [{ description: "More", quantity: 1, unitPriceCents: 1 }],
  });
  assert.equal(lines.status, 409);

  const tooMuch = await callTool("record_bill_payment", { billSlug: bill.slug, amountCents: 9_000 });
  assert.equal(tooMuch.status, 400);
  const paid = await callTool("record_bill_payment", {
    billSlug: bill.slug,
    amountCents: 2_000,
    method: "bank_transfer",
  });
  assert.equal(paid.status, 200, paid.body.error);
  const afterPayment = paid.body.bill as BillRow;
  assert.equal(afterPayment.balanceCents, 2_500);
  assert.equal((await callTool("void_bill", { billSlug: bill.slug })).status, 400);

  const reversed = await callTool("reverse_bill_payment", {
    billSlug: bill.slug,
    paymentId: afterPayment.payments[0].id,
  });
  assert.equal(reversed.status, 200, reversed.body.error);
  assert.equal((reversed.body.bill as BillRow).balanceCents, 4_500);
  const voided = await callTool("void_bill", { billSlug: bill.slug });
  assert.equal(voided.status, 200, voided.body.error);
  assert.equal((voided.body.bill as BillRow).status, "void");

  const listed = await callTool("list_bills", { vendorSlug });
  assert.equal((listed.body.bills as BillRow[]).length, 1);
});

test("payables writes need Full access; reads need Read", async () => {
  grant.accessLevel = "read";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);
  assert.equal((await callTool("list_vendors")).status, 200);
  assert.equal((await callTool("list_bills")).status, 200);
  assert.equal((await callTool("create_vendor", { name: "Nope" })).status, 403);
});
