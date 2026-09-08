import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, mock, test } from "node:test";

import express from "express";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright-core";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { renderEstimatePdf } from "../services/estimateHtml.js";
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
let provider: EmailProvider;
let renderedHtml: string[] = [];
let mailMessages: nodemailer.SendMailOptions[] = [];
let sendError: Error | null = null;
let pdfBytes: Buffer;

before(async () => {
  await initTestDb();
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  pdfBytes = Buffer.from(await doc.save());
  // Exercise the actual estimate rendering and mail orchestration while
  // keeping Chromium and SMTP outside the test's process boundary.
  mock.method(chromium, "launch", async () => ({
    newContext: async () => ({
      newPage: async () => ({
        setContent: async (html: string) => { renderedHtml.push(html); },
        pdf: async () => pdfBytes,
        close: async () => {},
      }),
      close: async () => {},
    }),
    close: async () => {},
  }));
  mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message: nodemailer.SendMailOptions) => {
      mailMessages.push(message);
      if (sendError) throw sendError;
      return { messageId: `test-message-${mailMessages.length}` };
    },
  }));
  mock.method(console, "log", () => {});
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
  renderedHtml = [];
  mailMessages = [];
  sendError = null;
  company = await insert(Company, { name: "Quote Co", slug: "quote-co", ownerId: "owner" });
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
  customer = await insert(Customer, {
    companyId: company.id,
    name: "BaFin",
    slug: "bafin",
    email: "billing@bafin.example",
    currency: "EUR",
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
  provider = await insert(EmailProvider, {
    companyId: company.id,
    name: "Test SMTP",
    kind: "smtp",
    fromAddress: "finance@quote.example",
    isDefault: true,
    encryptedConfig: encryptSecret(JSON.stringify({
      host: "smtp.quote.example", port: 587, secure: false, user: "", pass: "",
    }), `company:${company.id}`),
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  mock.restoreAll();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});

function setMemberToken(): void {
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: memberUser.id,
    requesterSessionVersion: memberUser.sessionVersion,
  });
}

type EstimatePayload = { id: string; slug: string; number: string; status: string; totalCents: number };
type ToolResponse = {
  error?: string;
  estimate?: EstimatePayload;
  send?: { status: string; logId: string; errorMessage: string };
  note?: string;
};

async function call(tool: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as ToolResponse };
}

async function draft(values: Partial<Estimate> = {}): Promise<Estimate> {
  const estimate = await insert(Estimate, {
    companyId: company.id,
    customerId: customer.id,
    slug: `edraft-${randomUUID()}`,
    issueDate: new Date(),
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    currency: "EUR",
    subtotalCents: 24000,
    totalCents: 24000,
    ...values,
  });
  await insert(EstimateLineItem, {
    estimateId: estimate.id,
    description: "Advisory services",
    quantity: 2,
    unitPriceCents: 12000,
    lineSubtotalCents: 24000,
    lineTotalCents: 24000,
  });
  return estimate;
}

async function reload(estimate: Estimate) {
  return AppDataSource.getRepository(Estimate).findOneByOrFail({ id: estimate.id });
}

test("issue_estimate marks a quote Sent with a permanent number and non-draft PDF, without emailing", async () => {
  const created = await call("create_estimate", {
    customerSlug: customer.slug,
    lines: [{ description: "Advisory services", quantity: 2, unitPriceCents: 12000 }],
  });
  assert.equal(created.status, 200, created.body.error);
  const response = await call("issue_estimate", { estimateSlug: created.body.estimate?.slug });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.estimate?.slug, "bafin-est-0001");
  assert.equal(response.body.estimate?.number, "BAFIN-EST-0001");
  assert.equal(response.body.estimate?.status, "sent");
  assert.equal(response.body.estimate?.totalCents, 24000);
  assert.match(response.body.note ?? "", /no.*email|nothing.*email/i);
  const estimate = await AppDataSource.getRepository(Estimate).findOneByOrFail({
    id: created.body.estimate?.id,
  });
  assert.ok(estimate.sentAt);
  const pdf = await renderEstimatePdf(company.id, estimate);
  assert.equal(pdf?.filename, "BAFIN-EST-0001.pdf");
  assert.deepEqual(pdf?.buffer, pdfBytes);
  assert.match(renderedHtml[0], /<h1 class="estimate-number">BAFIN-EST-0001<\/h1>/);
  assert.doesNotMatch(renderedHtml[0], /DRAFT/);
  assert.equal(mailMessages.length, 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id, action: "finance.estimate.issue",
  });
  assert.equal(audit.actorKind, "ai");
  assert.equal(audit.actorEmployeeId, employee.id);
  assert.equal(audit.targetId, estimate.id);
});

test("issuing again does not renumber a quote or append another issue audit", async () => {
  const quote = await draft();
  const first = await call("issue_estimate", { estimateSlug: quote.slug });
  assert.equal(first.status, 200, first.body.error);
  const issued = await reload(quote);
  const retry = await call("issue_estimate", { estimateSlug: issued.slug });
  assert.equal(retry.status, 409);
  const unchanged = await reload(quote);
  assert.equal(unchanged.numberSeq, 1);
  assert.equal(unchanged.slug, issued.slug);
  assert.deepEqual(unchanged.sentAt, issued.sentAt);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({
    action: "finance.estimate.issue",
  }), 1);
  const next = await draft();
  const second = await call("issue_estimate", { estimateSlug: next.slug });
  assert.equal(second.body.estimate?.number, "BAFIN-EST-0002");
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("issue_estimate refuses every already-issued status without changing it", async () => {
  for (const status of ["sent", "accepted", "declined", "void"] as const) {
    const quote = await draft({ status });
    const response = await call("issue_estimate", { estimateSlug: quote.slug });
    assert.equal(response.status, 409, status);
    assert.equal((await reload(quote)).status, status);
  }
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("estimate actions require Invoicing access and disappear without a Finance Grant", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(grant.id, { accessLevel: "read" });
  for (const tool of ["issue_estimate", "send_estimate"]) {
    assert.equal((await call(tool, { estimateSlug: quote.slug })).status, 403, tool);
  }
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete(grant.id);
  const dead = await deadToolNames(employee.id);
  for (const tool of ["issue_estimate", "send_estimate"]) {
    assert.ok(dead.has(tool), tool);
    assert.equal((await call(tool, { estimateSlug: quote.slug })).status, 403, tool);
  }
  assert.equal((await reload(quote)).status, "draft");
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("interactive estimate actions intersect current Member access with the employee Grant", async () => {
  const quote = await draft();
  setMemberToken();
  for (const financeAccess of ["read", "none"] as const) {
    await AppDataSource.getRepository(Membership).update(member.id, { financeAccess });
    for (const tool of ["issue_estimate", "send_estimate"]) {
      assert.equal((await call(tool, { estimateSlug: quote.slug })).status, 403, tool);
    }
  }
  await AppDataSource.getRepository(Membership).update(member.id, { financeAccess: "full" });
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(grant.id, { accessLevel: "read" });
  for (const tool of ["issue_estimate", "send_estimate"]) {
    assert.equal((await call(tool, { estimateSlug: quote.slug })).status, 403, tool);
  }
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(grant.id, { accessLevel: "invoice" });
  const issued = await call("issue_estimate", { estimateSlug: quote.slug });
  assert.equal(issued.status, 200, issued.body.error);
  const sent = await call("send_estimate", { estimateSlug: issued.body.estimate?.slug });
  assert.equal(sent.status, 200, sent.body.error);
  assert.equal(sent.body.send?.status, "sent");
});

test("removed Member authority cannot issue or send estimates", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(Membership).delete(member.id);
  for (const tool of ["issue_estimate", "send_estimate"]) {
    // Revalidation revokes a removed Member's token on the first call. Give
    // each route its own stale token so both exercise that same boundary.
    setMemberToken();
    assert.equal((await call(tool, { estimateSlug: quote.slug })).status, 403, tool);
  }
  assert.equal((await reload(quote)).status, "draft");
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("Full Finance Grants permit issuing and sending estimates", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(grant.id, { accessLevel: "full" });
  const issued = await call("issue_estimate", { estimateSlug: quote.slug });
  assert.equal(issued.status, 200, issued.body.error);
  const sent = await call("send_estimate", { estimateSlug: issued.body.estimate?.slug });
  assert.equal(sent.status, 200, sent.body.error);
  assert.equal(sent.body.send?.status, "sent");
});

test("mail delivery ceilings block send_estimate before issuing or rendering a draft", async () => {
  const quote = await draft();
  for (const mailDeliveryMode of ["draft", "triage"] as const) {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee", mailDeliveryMode });
    const response = await call("send_estimate", { estimateSlug: quote.slug });
    assert.equal(response.status, 403, mailDeliveryMode);
  }
  const unchanged = await reload(quote);
  assert.equal(unchanged.status, "draft");
  assert.equal(unchanged.slug, quote.slug);
  assert.equal(unchanged.number, "");
  assert.equal(unchanged.sentAt, null);
  assert.equal(renderedHtml.length, 0);
  assert.equal(mailMessages.length, 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("estimate action lookups stay inside the employee company", async () => {
  const foreign = await draft({ companyId: randomUUID() });
  for (const tool of ["issue_estimate", "send_estimate"]) {
    for (const estimateSlug of [foreign.slug, "missing-estimate"]) {
      assert.equal((await call(tool, { estimateSlug })).status, 404, tool);
    }
  }
  assert.equal((await reload(foreign)).status, "draft");
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("estimate actions strictly validate slugs and reject recipient overrides", async () => {
  const quote = await draft();
  for (const tool of ["issue_estimate", "send_estimate"]) {
    for (const body of [
      {},
      { estimateSlug: "" },
      { estimateSlug: 123 },
      { estimateSlug: quote.slug, companyId: randomUUID() },
      { estimateSlug: quote.slug, to: ["other@elsewhere.example"] },
    ]) {
      assert.equal((await call(tool, body)).status, 400, `${tool} ${JSON.stringify(body)}`);
    }
  }
  assert.equal((await reload(quote)).status, "draft");
  assert.equal(mailMessages.length, 0);
});

test("an estimate whose Customer left the company cannot be issued or emailed", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(Customer).update(customer.id, { companyId: randomUUID() });
  for (const tool of ["issue_estimate", "send_estimate"]) {
    assert.equal((await call(tool, { estimateSlug: quote.slug })).status, 400, tool);
  }
  const unchanged = await reload(quote);
  assert.equal(unchanged.status, "draft");
  assert.equal(unchanged.slug, quote.slug);
  assert.equal(mailMessages.length, 0);
});

test("send_estimate refuses a missing address before issuing, and the same slug remains retryable", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(Customer).update(customer.id, { email: "" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await call("send_estimate", { estimateSlug: quote.slug });
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /no email address/i);
  }
  const unchanged = await reload(quote);
  assert.equal(unchanged.status, "draft");
  assert.equal(unchanged.slug, quote.slug);
  assert.equal(unchanged.number, "");
  assert.equal(unchanged.sentAt, null);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
});

test("send_estimate auto-issues, sends the numbered PDF to the Customer, and records actual delivery", async () => {
  const quote = await draft();
  const response = await call("send_estimate", { estimateSlug: quote.slug });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.estimate?.slug, "bafin-est-0001");
  assert.equal(response.body.estimate?.status, "sent");
  assert.equal(response.body.send?.status, "sent");
  assert.equal(mailMessages.length, 1);
  assert.equal(mailMessages[0].to, customer.email);
  assert.equal(mailMessages[0].attachments?.[0].filename, "BAFIN-EST-0001.pdf");
  assert.deepEqual(mailMessages[0].attachments?.[0].content, pdfBytes);
  assert.match(String(mailMessages[0].html), /BAFIN-EST-0001/);
  assert.doesNotMatch(String(mailMessages[0].html), /DRAFT/);
  const log = await AppDataSource.getRepository(EmailLog).findOneByOrFail({
    id: response.body.send?.logId,
  });
  assert.equal(log.status, "sent");
  assert.equal(log.companyId, company.id);
  assert.equal(log.toAddress, customer.email);
  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id, action: "finance.estimate.send",
  });
  assert.equal(audit.actorKind, "ai");
  assert.equal(audit.actorEmployeeId, employee.id);
  assert.equal(audit.targetId, quote.id);
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
});

test("sending an issued estimate again intentionally resends without minting a new number", async () => {
  const quote = await draft();
  const first = await call("send_estimate", { estimateSlug: quote.slug });
  assert.equal(first.status, 200, first.body.error);
  const issued = await reload(quote);
  const retry = await call("send_estimate", { estimateSlug: issued.slug });
  assert.equal(retry.status, 200, retry.body.error);
  assert.equal(retry.body.send?.status, "sent");
  assert.equal(mailMessages.length, 2);
  const unchanged = await reload(quote);
  assert.equal(unchanged.slug, issued.slug);
  assert.equal(unchanged.numberSeq, 1);
  assert.deepEqual(unchanged.sentAt, issued.sentAt);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({
    action: "finance.estimate.issue",
  }), 1);
});

test("failed delivery reports the newly issued slug and can be retried without renumbering", async () => {
  const quote = await draft();
  sendError = new Error("SMTP rejected this delivery");
  const response = await call("send_estimate", { estimateSlug: quote.slug });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.estimate?.slug, "bafin-est-0001");
  assert.equal(response.body.send?.status, "failed");
  assert.match(response.body.send?.errorMessage ?? "", /SMTP rejected/);
  const log = await AppDataSource.getRepository(EmailLog).findOneByOrFail({
    id: response.body.send?.logId,
  });
  assert.equal(log.status, "failed");
  sendError = null;
  const retry = await call("send_estimate", { estimateSlug: response.body.estimate?.slug });
  assert.equal(retry.status, 200, retry.body.error);
  assert.equal(retry.body.send?.status, "sent");
  assert.equal((await reload(quote)).numberSeq, 1);
});

test("an unexpected post-issue email error still returns the usable permanent slug", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(EmailProvider).update(provider.id, {
    encryptedConfig: "unreadable-config",
  });
  const response = await call("send_estimate", { estimateSlug: quote.slug });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.estimate?.slug, "bafin-est-0001");
  assert.equal(response.body.send?.status, "failed");
  assert.ok(response.body.send?.errorMessage);
  assert.equal((await reload(quote)).status, "sent");
  assert.equal(mailMessages.length, 0);
});

test("console fallback is reported as skipped delivery despite the estimate's Sent status", async () => {
  const quote = await draft();
  await AppDataSource.getRepository(EmailProvider).delete(provider.id);
  const response = await call("send_estimate", { estimateSlug: quote.slug });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.estimate?.status, "sent");
  assert.equal(response.body.send?.status, "skipped");
  assert.equal(mailMessages.length, 0);
  const log = await AppDataSource.getRepository(EmailLog).findOneByOrFail({
    id: response.body.send?.logId,
  });
  assert.equal(log.status, "skipped");
});

test("send_estimate refuses void quotes while supporting accepted quotes like Member Send", async () => {
  const voided = await draft({ status: "void" });
  assert.equal((await call("send_estimate", { estimateSlug: voided.slug })).status, 409);
  assert.equal(mailMessages.length, 0);
  const accepted = await draft({
    status: "accepted", number: "BAFIN-EST-0001", numberSeq: 1, slug: "bafin-est-0001",
  });
  const response = await call("send_estimate", { estimateSlug: accepted.slug });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.estimate?.status, "accepted");
  assert.equal(response.body.send?.status, "sent");
  assert.equal(mailMessages.length, 1);
});
