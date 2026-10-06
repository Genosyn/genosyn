import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Membership } from "../db/entities/Membership.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { Subsidiary } from "../db/entities/Subsidiary.js";
import { User } from "../db/entities/User.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl: string;
let token = "";
let company: Company;
let customer: Customer;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;
let subsidiary: Subsidiary;

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
  company = await insert(Company, { name: "Group", slug: "group", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Finance",
    slug: "finance",
    role: "Finance",
    soulBody: "",
  });
  grant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Customer",
    slug: "customer",
    email: "billing@example.com",
    currency: "GBP",
  });
  subsidiary = await insert(Subsidiary, {
    companyId: company.id,
    name: "Group UK Ltd",
    address: "1 High Street",
    country: "United Kingdom",
    taxNumber: "GB123456789",
    registrationNumber: "12345678",
    email: "finance@example.co.uk",
    phone: "+44 20 1234 5678",
    website: "https://example.co.uk",
    footer: "Pay the UK bank account.",
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

function draft(subsidiaryId?: string | null) {
  return {
    customerSlug: customer.slug,
    ...(subsidiaryId !== undefined ? { subsidiaryId } : {}),
    lines: [{ description: "Services", quantity: 1, unitPriceCents: 10_000 }],
  };
}

function schedule(subsidiaryId?: string | null) {
  return {
    ...draft(subsidiaryId),
    name: "Monthly services",
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
  };
}

test("subsidiary discovery is scoped, read-only, and excludes archived issuers by default", async () => {
  const archived = await insert(Subsidiary, {
    companyId: company.id,
    name: "Old issuer",
    archived: true,
  });
  await insert(Subsidiary, { companyId: randomUUID(), name: "Other company issuer" });
  grant.accessLevel = "read";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);

  const response = await callTool("list_subsidiaries");
  assert.equal(response.status, 200, response.body.error);
  const rows = response.body.subsidiaries as Subsidiary[];
  assert.deepEqual(
    rows.map((row) => row.id),
    [subsidiary.id],
  );
  assert.equal(rows[0].taxNumber, subsidiary.taxNumber);
  assert.equal(rows[0].footer, subsidiary.footer);
  const all = await callTool("list_subsidiaries", { includeArchived: true });
  assert.deepEqual(
    (all.body.subsidiaries as Subsidiary[]).map((row) => row.id),
    [subsidiary.id, archived.id],
  );
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(STATIC_TOOLS.find((tool) => tool.name === "list_subsidiaries")?.readOnly, true);

  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ id: grant.id });
  assert.equal((await callTool("list_subsidiaries")).status, 403);
  assert.equal((await deadToolNames(employee.id, true)).has("list_subsidiaries"), true);
});

test("subsidiary reads honor the delegating Member's Finance access", async () => {
  const user = await insert(User, {
    name: "Member",
    email: "member@example.com",
    passwordHash: "hash",
    sessionVersion: 0,
  });
  const member = await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role: "member",
    financeAccess: "none",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: user.id,
    requesterSessionVersion: 0,
  });
  assert.equal((await callTool("list_subsidiaries")).status, 403);
  member.financeAccess = "read";
  await AppDataSource.getRepository(Membership).save(member);
  assert.equal((await callTool("list_subsidiaries")).status, 200);
  assert.equal((await callTool("create_invoice", draft(subsidiary.id))).status, 403);
});

test("AI invoice and estimate drafts freeze the selected issuer and expose it on reads", async () => {
  const invoiceResult = await callTool("create_invoice", draft(subsidiary.id));
  const estimateResult = await callTool("create_estimate", draft(subsidiary.id));
  assert.equal(invoiceResult.status, 200, invoiceResult.body.error);
  assert.equal(estimateResult.status, 200, estimateResult.body.error);
  const invoice = invoiceResult.body.invoice as Invoice;
  const estimate = estimateResult.body.estimate as Estimate;
  for (const document of [invoice, estimate]) {
    assert.equal(document.subsidiaryId, subsidiary.id);
    assert.equal(document.issuerSnapshot?.name, "Group UK Ltd");
    assert.equal(document.issuerSnapshot?.registrationNumber, "12345678");
    assert.equal(document.issuerSnapshot?.footer, "Pay the UK bank account.");
  }
  await AppDataSource.getRepository(Subsidiary).update(subsidiary.id, {
    name: "Renamed issuer",
    footer: "New bank account",
    archived: true,
  });
  const storedInvoice = await AppDataSource.getRepository(Invoice).findOneByOrFail({
    id: invoice.id,
  });
  const storedEstimate = await AppDataSource.getRepository(Estimate).findOneByOrFail({
    id: estimate.id,
  });
  assert.deepEqual(storedInvoice.issuerSnapshot, invoice.issuerSnapshot);
  assert.deepEqual(storedEstimate.issuerSnapshot, estimate.issuerSnapshot);
  const invoiceRead = await callTool("get_invoice", { invoiceSlug: invoice.slug });
  const estimateRead = await callTool("get_estimate", { estimateSlug: estimate.slug });
  assert.deepEqual((invoiceRead.body.invoice as Invoice).issuerSnapshot, invoice.issuerSnapshot);
  assert.deepEqual(
    (estimateRead.body.estimate as Estimate).issuerSnapshot,
    estimate.issuerSnapshot,
  );
  const invoiceList = await callTool("list_invoices");
  const estimateList = await callTool("list_estimates");
  assert.equal((invoiceList.body.invoices as Invoice[])[0].subsidiaryId, subsidiary.id);
  assert.equal((estimateList.body.estimates as Estimate[])[0].subsidiaryId, subsidiary.id);
});

test("AI drafts without a subsidiary retain the default issuer", async () => {
  for (const [tool, key] of [
    ["create_invoice", "invoice"],
    ["create_estimate", "estimate"],
  ]) {
    for (const subsidiaryId of [undefined, null]) {
      const response = await callTool(tool, draft(subsidiaryId));
      assert.equal(response.status, 200, response.body.error);
      const document = response.body[key] as Invoice | Estimate;
      assert.equal(document.subsidiaryId, null);
      assert.equal(document.issuerSnapshot, null);
    }
  }
});

test("AI document creation rejects foreign, missing, and archived subsidiaries before writing", async () => {
  const foreign = await insert(Subsidiary, { companyId: randomUUID(), name: "Foreign issuer" });
  await AppDataSource.getRepository(Subsidiary).update(subsidiary.id, { archived: true });
  for (const subsidiaryId of [foreign.id, randomUUID(), subsidiary.id]) {
    for (const tool of ["create_invoice", "create_estimate", "create_recurring_invoice"]) {
      const response = await callTool(
        tool,
        tool === "create_recurring_invoice" ? schedule(subsidiaryId) : draft(subsidiaryId),
      );
      assert.equal(response.status, 400, `${tool}: ${response.body.error}`);
      assert.match(response.body.error ?? "", /subsidiar/i);
    }
  }
  assert.equal(await AppDataSource.getRepository(Invoice).count(), 0);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
  assert.equal(await AppDataSource.getRepository(RecurringInvoice).count(), 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("AI recurring schedules preserve, change, and clear issuer without creating invoices", async () => {
  const created = await callTool("create_recurring_invoice", schedule(subsidiary.id));
  assert.equal(created.status, 200, created.body.error);
  const recurring = created.body.recurringInvoice as RecurringInvoice;
  assert.equal(recurring.subsidiaryId, subsidiary.id);
  const other = await insert(Subsidiary, { companyId: company.id, name: "Group USA Inc" });
  const edited = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: recurring.slug,
    notes: "Keep issuer",
  });
  assert.equal(edited.status, 200, edited.body.error);
  assert.equal((edited.body.recurringInvoice as RecurringInvoice).subsidiaryId, subsidiary.id);
  await AppDataSource.getRepository(Subsidiary).update(subsidiary.id, { archived: true });
  const retained = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: recurring.slug,
    subsidiaryId: subsidiary.id,
    notes: "Retain the saved issuer",
  });
  assert.equal(retained.status, 200, retained.body.error);
  assert.equal((retained.body.recurringInvoice as RecurringInvoice).subsidiaryId, subsidiary.id);
  const changed = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: recurring.slug,
    subsidiaryId: other.id,
  });
  assert.equal(changed.status, 200, changed.body.error);
  assert.equal((changed.body.recurringInvoice as RecurringInvoice).subsidiaryId, other.id);
  const cleared = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: recurring.slug,
    subsidiaryId: null,
  });
  assert.equal(cleared.status, 200, cleared.body.error);
  assert.equal((cleared.body.recurringInvoice as RecurringInvoice).subsidiaryId, null);
  assert.equal(await AppDataSource.getRepository(Invoice).count(), 0);
});

test("AI recurring issuer edits reject foreign and archived issuers without partial changes", async () => {
  const created = await callTool("create_recurring_invoice", schedule(subsidiary.id));
  assert.equal(created.status, 200, created.body.error);
  const recurring = created.body.recurringInvoice as RecurringInvoice;
  const foreign = await insert(Subsidiary, { companyId: randomUUID(), name: "Foreign issuer" });
  const archived = await insert(Subsidiary, {
    companyId: company.id,
    name: "Old issuer",
    archived: true,
  });
  for (const subsidiaryId of [foreign.id, archived.id]) {
    const result = await callTool("update_recurring_invoice", {
      recurringInvoiceSlug: recurring.slug,
      subsidiaryId,
      name: "Should not be saved",
    });
    assert.equal(result.status, 400, result.body.error);
    const stored = await AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({
      id: recurring.id,
    });
    assert.equal(stored.subsidiaryId, subsidiary.id);
    assert.equal(stored.name, recurring.name);
  }
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({
      action: "finance.recurring_invoice.update",
    }),
    0,
  );
});
