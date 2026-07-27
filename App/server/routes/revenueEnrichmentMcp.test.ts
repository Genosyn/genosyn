import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;

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
    name: "Revenue analyst",
    slug: "revenue-analyst",
    role: "Revenue analyst",
    soulBody: "",
  });
  await insert(EmployeeRevenueGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "write",
  });
  token = issueMcpToken(employee.id, company.id);
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function aiCall(
  tool: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { error?: string } }> {
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
    body: (await response.json()) as { error?: string },
  };
}

test("Stripe reconciliation requires an explicit granted Connection", async () => {
  const missing = await aiCall("propose_stripe_commercial_values", {
    confirm: "PROPOSE",
  });
  assert.equal(missing.status, 400);

  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "Stripe",
    authMode: "apikey",
    encryptedConfig: "not-used-without-a-grant",
    status: "connected",
  });
  const ungranted = await aiCall("propose_stripe_commercial_values", {
    connectionId: connection.id,
    confirm: "PROPOSE",
  });
  assert.equal(ungranted.status, 403);
  assert.match(ungranted.body.error ?? "", /Grant/);
});

test("custom-field external provenance is explicit and cross-grant gated", async () => {
  const base = {
    resourceType: "account",
    resourceId: "11111111-1111-4111-8111-111111111111",
    values: { enrichment_note: "Observed" },
  };
  const unverified = await aiCall("set_revenue_custom_fields", {
    ...base,
    provenance: {
      sourceType: "manual",
      sourceId: "manual-observation",
      verificationState: "unverified",
    },
  });
  assert.equal(unverified.status, 400);
  assert.match(unverified.body.error ?? "", /direct-write/);

  const finance = await aiCall("set_revenue_custom_fields", {
    ...base,
    provenance: {
      sourceType: "finance",
      sourceId: "11111111-1111-4111-8111-111111111112",
      verificationState: "verified",
    },
  });
  assert.equal(finance.status, 403);
  assert.match(finance.body.error ?? "", /finance/i);

  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "Stripe",
    authMode: "apikey",
    encryptedConfig: "not-used-without-a-grant",
    status: "connected",
  });
  const integration = await aiCall("set_revenue_custom_fields", {
    ...base,
    provenance: {
      sourceType: "integration",
      sourceId: "sub_external",
      verificationState: "verified",
      metadata: { connectionId: connection.id },
    },
  });
  assert.equal(integration.status, 403);
  assert.match(integration.body.error ?? "", /Grant/);

  const mailAccount = await insert(MailAccount, {
    companyId: company.id,
    connectionId: "11111111-1111-4111-8111-111111111113",
    address: "sales@example.com",
    status: "active",
  });
  const message = await insert(MailMessage, {
    companyId: company.id,
    accountId: mailAccount.id,
    threadId: "mail-thread-1",
    gmailMessageId: "gmail-message-1",
    gmailThreadId: "gmail-thread-1",
    fromEmail: "buyer@example.com",
  });
  const email = await aiCall("set_revenue_custom_fields", {
    ...base,
    provenance: {
      sourceType: "email",
      sourceId: message.id,
      verificationState: "verified",
    },
  });
  assert.equal(email.status, 403);
  assert.match(email.body.error ?? "", /grant/i);
});
