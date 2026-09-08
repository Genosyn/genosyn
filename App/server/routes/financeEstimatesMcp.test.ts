import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Product } from "../db/entities/Product.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let customer: Customer;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;
let member: Membership;
let memberUser: User;

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
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Finance partner",
    slug: "finance-partner",
    role: "Finance partner",
    soulBody: "",
  });
  grant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  memberUser = await insert(User, {
    email: "member@finance.example",
    passwordHash: "hash",
    name: "Finance Member",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  member = await insert(Membership, {
    companyId: company.id,
    userId: memberUser.id,
    role: "member",
    financeAccess: "full",
  });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "BaFin",
    slug: "bafin",
    email: "billing@bafin.example",
    currency: "EUR",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

function useMemberToken(userId = member.userId): void {
  if (token) revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: userId,
    requesterSessionVersion: memberUser.sessionVersion,
  });
}

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function aiCall(
  body: Record<string, unknown>,
  tool = "create_estimate",
): Promise<{ status: number; body: Record<string, unknown> & { error?: string } }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

test("create_estimate writes an unsent, ledger-neutral draft with an AI audit trail", async () => {
  const taxRate = await insert(TaxRate, {
    companyId: company.id,
    name: "VAT 20%",
    ratePercent: 20,
    inclusive: false,
    archivedAt: null,
  });
  const issueDate = "2026-08-06T09:00:00.000Z";
  const validUntil = "2026-09-05T09:00:00.000Z";

  const response = await aiCall({
    customerSlug: customer.slug,
    issueDate,
    validUntil,
    notes: "Regulatory advisory",
    lines: [
      {
        description: "Advisory services",
        quantity: 2,
        unitPriceCents: 10_000,
        taxRateId: taxRate.id,
      },
    ],
  });

  assert.equal(response.status, 200, response.body.error);
  const payload = response.body.estimate as Record<string, unknown>;
  assert.equal(payload.status, "draft");
  assert.equal(payload.number, null);
  assert.equal(payload.currency, "EUR");
  assert.equal(payload.totalCents, 24_000);
  assert.equal(payload.issueDate, issueDate);
  assert.equal(payload.validUntil, validUntil);
  assert.match(String(response.body.note), /nothing was emailed/);

  const estimate = await AppDataSource.getRepository(Estimate).findOneByOrFail({
    id: String(payload.id),
    companyId: company.id,
  });
  assert.match(estimate.slug, /^edraft-/);
  assert.equal(estimate.status, "draft");
  assert.equal(estimate.number, "");
  assert.equal(estimate.sentAt, null);
  assert.equal(estimate.createdById, null);
  assert.equal(
    await AppDataSource.getRepository(EstimateLineItem).countBy({
      estimateId: estimate.id,
    }),
    1,
  );
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);

  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id,
    action: "finance.estimate.create",
  });
  assert.equal(audit.actorKind, "ai");
  assert.equal(audit.actorEmployeeId, employee.id);
  assert.equal(audit.targetId, estimate.id);
  assert.equal(
    await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: employee.id }),
    1,
  );
});

test("create_estimate requires Invoicing access", async () => {
  grant.accessLevel = "read";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);

  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Advisory services", quantity: 1, unitPriceCents: 10_000 }],
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error ?? "", /needs the "invoice" finance access level/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("interactive Finance authority is the intersection of Member access and the employee Grant", async () => {
  member.financeAccess = "read";
  await AppDataSource.getRepository(Membership).save(member);
  useMemberToken();

  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Must stay read-only", quantity: 1, unitPriceCents: 10_000 }],
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error ?? "", /does not have full Finance access/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("a full-access Member may delegate only what the employee Grant also permits", async () => {
  useMemberToken();
  const allowed = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Delegated estimate", quantity: 1, unitPriceCents: 10_000 }],
  });
  assert.equal(allowed.status, 200, allowed.body.error);

  grant.accessLevel = "read";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);
  const denied = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Employee cannot invoice", quantity: 1, unitPriceCents: 10_000 }],
  });
  assert.equal(denied.status, 403);
});

test("Member authority is revalidated on every call and fails closed after removal", async () => {
  useMemberToken();
  await AppDataSource.getRepository(Membership).delete({ id: member.id });
  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "No longer a Member", quantity: 1, unitPriceCents: 10_000 }],
  });
  assert.equal(response.status, 403);
  assert.match(response.body.error ?? "", /no longer has access/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("a cross-company membership never satisfies interactive authority", async () => {
  const otherCompany = await insert(Company, {
    name: "Other Membership Co",
    slug: "other-membership-co",
    ownerId: "owner-2",
  });
  await AppDataSource.getRepository(Membership).update(
    { id: member.id },
    { companyId: otherCompany.id },
  );
  useMemberToken();
  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Cross-company", quantity: 1, unitPriceCents: 10_000 }],
  });
  assert.equal(response.status, 403);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("an unauthenticated chat token cannot call company tools", async () => {
  if (token) revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id);
  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Untrusted", quantity: 1, unitPriceCents: 10_000 }],
  });
  assert.equal(response.status, 403);
  assert.match(response.body.error ?? "", /authenticated Genosyn Member/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("create_estimate refuses unknown tax rates without leaving a partial draft", async () => {
  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [
      {
        description: "Advisory services",
        quantity: 1,
        unitPriceCents: 10_000,
        taxRateId: randomUUID(),
      },
    ],
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error ?? "", /Unknown tax rate/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("create_estimate uses the customer currency and a thirty-day validity window by default", async () => {
  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Advisory services", quantity: 1.5, unitPriceCents: 8_000 }],
  });

  assert.equal(response.status, 200, response.body.error);
  const estimate = response.body.estimate as Record<string, unknown>;
  assert.equal(estimate.currency, "EUR");
  assert.equal(estimate.totalCents, 12_000);
  const issueDate = new Date(String(estimate.issueDate));
  const validUntil = new Date(String(estimate.validUntil));
  assert.equal(validUntil.getTime() - issueDate.getTime(), 30 * 24 * 60 * 60 * 1_000);
});

test("create_estimate scopes customers to the employee company", async () => {
  const otherCompany = await insert(Company, {
    name: "Other Co",
    slug: "other-co",
    ownerId: "owner-2",
  });
  const otherCustomer = await insert(Customer, {
    companyId: otherCompany.id,
    name: "Other Customer",
    slug: "other-customer",
    email: "billing@other.example",
    currency: "USD",
  });

  const response = await aiCall({
    customerSlug: otherCustomer.slug,
    lines: [{ description: "Should not exist", quantity: 1, unitPriceCents: 10_000 }],
  });

  assert.equal(response.status, 404);
  assert.match(response.body.error ?? "", /not found/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("create_estimate rejects zero-value work before it writes or audits anything", async () => {
  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Free placeholder", quantity: 2, unitPriceCents: 0 }],
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error ?? "", /more than zero/);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("create_estimate validates a non-empty strict line-item payload", async () => {
  const empty = await aiCall({ customerSlug: customer.slug, lines: [] });
  assert.equal(empty.status, 400);

  const unknownField = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Advisory", quantity: 1, unitPriceCents: 1_000 }],
    sendNow: true,
  });
  assert.equal(unknownField.status, 400);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("create_estimate is grant-dead when the employee has no Finance access", async () => {
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ employeeId: employee.id });
  const dead = await deadToolNames(employee.id);
  assert.equal(dead.has("create_estimate"), true);

  const response = await aiCall({
    customerSlug: customer.slug,
    lines: [{ description: "Advisory", quantity: 1, unitPriceCents: 1_000 }],
  });
  assert.equal(response.status, 403);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

async function quotation(values: Partial<Estimate> = {}): Promise<Estimate> {
  return insert(Estimate, {
    companyId: company.id,
    customerId: customer.id,
    slug: `edraft-${randomUUID()}`,
    issueDate: new Date("2026-09-08T00:00:00Z"),
    validUntil: new Date("2099-01-01T00:00:00Z"),
    currency: "EUR",
    totalCents: 12000,
    notes: "Source mail thread: quote-request",
    ...values,
  });
}

test("list_estimates pages compact prior quotations without exposing another company", async () => {
  const older = await quotation({ createdAt: new Date("2026-09-01"), notes: "a".repeat(1200) });
  const newer = await quotation({ createdAt: new Date("2026-09-02") });
  await quotation({ companyId: randomUUID(), createdAt: new Date("2026-09-03") });
  const first = await aiCall({ limit: 1 }, "list_estimates");
  assert.equal(first.status, 200, first.body.error);
  assert.equal(first.body.total, 2);
  assert.equal(first.body.nextOffset, 1);
  assert.deepEqual(
    (first.body.estimates as Array<{ slug: string }>).map((row) => row.slug),
    [newer.slug],
  );
  const second = await aiCall({ limit: 1, offset: 1 }, "list_estimates");
  const summary = (second.body.estimates as Array<Record<string, unknown>>)[0];
  assert.equal(summary.slug, older.slug);
  assert.equal(summary.notesTruncated, true);
  assert.equal(String(summary.notes).length, 1000);
  assert.equal(summary.lines, undefined);
  assert.equal(second.body.nextOffset, null);
  assert.equal((await aiCall({ offset: 100 }, "list_estimates")).body.nextOffset, null);
});

test("list_estimates filters Customer and stored status and refuses foreign Customer slugs", async () => {
  const draft = await quotation();
  await quotation({ status: "sent" });
  const another = await insert(Customer, { companyId: company.id, name: "Other", slug: "other" });
  await quotation({ customerId: another.id });
  const listed = await aiCall({ customerSlug: customer.slug, status: "draft" }, "list_estimates");
  assert.equal(listed.status, 200, listed.body.error);
  assert.deepEqual(
    (listed.body.estimates as Array<{ slug: string }>).map((row) => row.slug),
    [draft.slug],
  );
  await insert(Customer, { companyId: randomUUID(), name: "Foreign", slug: "foreign-customer" });
  assert.equal((await aiCall({ customerSlug: "foreign-customer" }, "list_estimates")).status, 404);
});

test("get_estimate returns full scoped line snapshots and notes without issuing anything", async () => {
  const quote = await quotation({ notes: "Complete " + "notes ".repeat(300) });
  await insert(EstimateLineItem, {
    estimateId: quote.id,
    description: "Second",
    quantity: 1,
    unitPriceCents: 5000,
    sortOrder: 1,
  });
  await insert(EstimateLineItem, {
    estimateId: quote.id,
    description: "First",
    quantity: 2,
    unitPriceCents: 3500,
    taxName: "VAT",
    taxPercent: 20,
    sortOrder: 0,
  });
  const response = await aiCall({ estimateSlug: quote.slug }, "get_estimate");
  assert.equal(response.status, 200, response.body.error);
  const result = response.body.estimate as Record<string, unknown>;
  assert.equal(result.notes, quote.notes);
  assert.equal(result.status, "draft");
  assert.equal(result.number, null);
  assert.deepEqual(
    (result.lines as Array<{ description: string }>).map((line) => line.description),
    ["First", "Second"],
  );
  assert.equal(
    (await AppDataSource.getRepository(Estimate).findOneByOrFail({ id: quote.id })).sentAt,
    null,
  );
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  const foreign = await quotation({ companyId: randomUUID() });
  assert.equal((await aiCall({ estimateSlug: foreign.slug }, "get_estimate")).status, 404);
  assert.equal((await aiCall({ estimateSlug: "missing" }, "get_estimate")).status, 404);
});

test("quote read tools require current company Finance access and honor Member Read", async () => {
  const quote = await quotation();
  const inputs: Array<[string, Record<string, unknown>]> = [
    ["list_estimates", {}],
    ["get_estimate", { estimateSlug: quote.slug }],
    ["list_finance_products", {}],
  ];
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete(grant.id);
  for (const [tool, body] of inputs) assert.equal((await aiCall(body, tool)).status, 403);
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  await AppDataSource.getRepository(Membership).update(member.id, { financeAccess: "read" });
  useMemberToken();
  for (const [tool, body] of inputs) assert.equal((await aiCall(body, tool)).status, 200);
  await AppDataSource.getRepository(Membership).update(member.id, { financeAccess: "none" });
  for (const [tool, body] of inputs) assert.equal((await aiCall(body, tool)).status, 403);
});

test("list_finance_products provides verified active prices and scoped tax defaults", async () => {
  const tax = await insert(TaxRate, {
    companyId: company.id,
    name: "VAT 20%",
    ratePercent: 20,
    inclusive: false,
  });
  const foreignTax = await insert(TaxRate, {
    companyId: randomUUID(),
    name: "Foreign private tax",
    ratePercent: 7,
  });
  await insert(Product, {
    companyId: company.id,
    name: "Advisory",
    slug: "advisory",
    currency: "EUR",
    unitPriceCents: 10000,
    defaultTaxRateId: tax.id,
  });
  await insert(Product, {
    companyId: company.id,
    name: "Broken tax link",
    slug: "broken",
    currency: "EUR",
    unitPriceCents: 8000,
    defaultTaxRateId: foreignTax.id,
  });
  await insert(Product, {
    companyId: company.id,
    name: "Archived",
    slug: "archived",
    archivedAt: new Date(),
  });
  await insert(Product, {
    companyId: randomUUID(),
    name: "Foreign private product",
    slug: "private",
    currency: "EUR",
    unitPriceCents: 1,
  });
  const response = await aiCall({ currency: "EUR", limit: 1 }, "list_finance_products");
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.nextOffset, 1);
  const product = (response.body.products as Array<Record<string, unknown>>)[0];
  assert.equal(product.slug, "advisory");
  assert.equal(product.unitPriceCents, 10000);
  assert.equal(product.defaultTaxRateId, tax.id);
  assert.equal((product.defaultTaxRate as { ratePercent: number }).ratePercent, 20);
  assert.equal(product.needsTaxReview, false);
  const next = await aiCall({ currency: "EUR", offset: 1 }, "list_finance_products");
  const broken = (next.body.products as Array<Record<string, unknown>>)[0];
  assert.equal(broken.defaultTaxRate, null);
  assert.equal(broken.defaultTaxRateId, null);
  assert.equal(broken.needsTaxReview, true);
  assert.equal(JSON.stringify(next.body).includes("Foreign private"), false);
  const archived = await aiCall({ includeArchived: true }, "list_finance_products");
  assert.equal(archived.body.total, 3);
  assert.equal((await aiCall({ currency: "GBP" }, "list_finance_products")).body.total, 0);
  await AppDataSource.getRepository(TaxRate).update(tax.id, { archivedAt: new Date() });
  const stale = await aiCall({ currency: "EUR", limit: 1 }, "list_finance_products");
  assert.equal((stale.body.products as Array<{ needsTaxReview: boolean }>)[0].needsTaxReview, true);
});

test("quote read pagination and filters are strictly validated", async () => {
  for (const tool of ["list_estimates", "list_finance_products"]) {
    for (const body of [
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { offset: -1 },
      { offset: "1" },
      { companyId: randomUUID() },
    ]) {
      assert.equal((await aiCall(body, tool)).status, 400, `${tool} ${JSON.stringify(body)}`);
    }
  }
  assert.equal((await aiCall({ status: "invented" }, "list_estimates")).status, 400);
  assert.equal((await aiCall({ currency: "EURO" }, "list_finance_products")).status, 400);
  assert.equal((await aiCall({ estimateSlug: "", extra: true }, "get_estimate")).status, 400);
});

test("new quotation reads are Finance-grant-dead when access is missing", async () => {
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete(grant.id);
  const dead = await deadToolNames(employee.id);
  for (const name of ["list_estimates", "get_estimate", "list_finance_products"])
    assert.ok(dead.has(name), name);
});
