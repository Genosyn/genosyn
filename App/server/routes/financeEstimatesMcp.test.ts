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
): Promise<{ status: number; body: Record<string, unknown> & { error?: string } }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/create_estimate`, {
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
