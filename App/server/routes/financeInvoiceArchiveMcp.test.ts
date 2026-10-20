import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * AI Employees see archived invoices and schedules the way Members do: the
 * list tools leave them out unless asked, the read tools say when a record
 * was archived, and resuming an archived schedule brings it back.
 */

type ToolBody = Record<string, unknown> & { error?: string };

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let customer: Customer;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner-1" });
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
  customer = await insert(Customer, {
    companyId: company.id,
    name: "DreamIT Host",
    slug: "dreamit-host",
    email: "billing@dreamithost.example",
    currency: "USD",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function callTool(
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: ToolBody }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ToolBody };
}

const archivedAt = new Date("2026-10-05T10:00:00.000Z");

async function invoice(values: Partial<Invoice>): Promise<Invoice> {
  return insert(Invoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: `draft-${randomUUID().slice(0, 8)}`,
    currency: "USD",
    issueDate: new Date("2026-10-01T09:00:00.000Z"),
    dueDate: new Date("2026-10-31T09:00:00.000Z"),
    ...values,
  });
}

async function schedule(values: Partial<RecurringInvoice>): Promise<RecurringInvoice> {
  return insert(RecurringInvoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: `ri-${randomUUID().slice(0, 6)}`,
    name: "Retainer",
    cronExpr: "0 9 1 * *",
    status: "paused",
    ...values,
  });
}

test("list_invoices leaves out invoices a Member archived unless asked", async () => {
  const open = await invoice({ status: "sent", createdAt: new Date("2026-10-02") });
  const filed = await invoice({
    status: "paid",
    slug: "dreamit-host-inv-0001",
    number: "DREAMIT-HOST-INV-0001",
    numberSeq: 1,
    createdAt: new Date("2026-10-01"),
    archivedAt,
  });
  const rows = (body: ToolBody) =>
    (body.invoices as Array<{ slug: string; archived: boolean }>).map((row) => [
      row.slug,
      row.archived,
    ]);

  const listed = await callTool("list_invoices");
  assert.equal(listed.status, 200, listed.body.error);
  assert.deepEqual(rows(listed.body), [[open.slug, false]]);
  assert.deepEqual(rows((await callTool("list_invoices", { status: "paid" })).body), []);

  const everything = await callTool("list_invoices", { includeArchived: true });
  assert.equal(everything.status, 200, everything.body.error);
  assert.deepEqual(rows(everything.body), [
    [open.slug, false],
    [filed.slug, true],
  ]);

  // Archiving is filing, not deletion: the invoice still opens, and says so.
  const opened = await callTool("get_invoice", { invoiceSlug: filed.slug });
  assert.equal(opened.status, 200, opened.body.error);
  assert.equal((opened.body.invoice as { archivedAt: string }).archivedAt, archivedAt.toISOString());
});

test("list_recurring_invoices leaves out archived schedules, and resuming one restores it", async () => {
  await schedule({ name: "Running", status: "active" });
  const filed = await schedule({ name: "Filed", archivedAt });
  const names = (body: ToolBody) =>
    (body.recurringInvoices as Array<{ name: string; archived: boolean }>).map((row) => [
      row.name,
      row.archived,
    ]);

  const listed = await callTool("list_recurring_invoices");
  assert.equal(listed.status, 200, listed.body.error);
  assert.deepEqual(names(listed.body), [["Running", false]]);
  assert.deepEqual(
    names((await callTool("list_recurring_invoices", { includeArchived: true })).body).sort(),
    [
      ["Filed", true],
      ["Running", false],
    ],
  );

  const opened = await callTool("get_recurring_invoice", { recurringInvoiceSlug: filed.slug });
  assert.equal(opened.status, 200, opened.body.error);
  assert.equal(
    (opened.body.recurringInvoice as { archivedAt: string }).archivedAt,
    archivedAt.toISOString(),
  );

  const resumed = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: filed.slug,
    status: "active",
  });
  assert.equal(resumed.status, 200, resumed.body.error);
  const after = resumed.body.recurringInvoice as { status: string; archivedAt: string | null };
  assert.equal(after.status, "active");
  assert.equal(after.archivedAt, null, "a schedule that bills is back in the list");
  assert.equal(
    (await AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({ id: filed.id }))
      .archivedAt,
    null,
  );
  assert.deepEqual(
    names((await callTool("list_recurring_invoices")).body).sort(),
    [
      ["Filed", false],
      ["Running", false],
    ],
  );
});
