import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { Deal } from "../db/entities/Deal.js";
import { DealStage } from "../db/entities/DealStage.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { RevenueCustomField } from "../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../db/entities/RevenueCustomValue.js";
import { RevenueDocumentCandidate } from "../db/entities/RevenueDocumentCandidate.js";
import { RevenueFieldEvidence } from "../db/entities/RevenueFieldEvidence.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;

const NEW_REVENUE_AI_TOOLS = [
  "preview_revenue_rows_import",
  "run_revenue_rows_import",
  "preview_linked_revenue_rows_import",
  "run_linked_revenue_rows_import",
  "list_deal_history_coverage",
  "preview_deal_history_backfill",
  "backfill_deal_history",
  "list_commercial_value_backlog",
  "propose_finance_commercial_values",
  "propose_stripe_commercial_values",
  "export_revenue_snapshot",
] as const;

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
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
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
    body: (await response.json()) as { error?: string },
  };
}

test("every new Revenue tool is grant-dead without Revenue access", async () => {
  await AppDataSource.getRepository(EmployeeRevenueGrant).delete({
    employeeId: employee.id,
  });
  const dead = await deadToolNames(employee.id);
  assert.deepEqual(
    NEW_REVENUE_AI_TOOLS.filter((name) => !dead.has(name)),
    [],
  );
});

test("cross-gated Revenue tools are grant-dead without their secondary Grants", async () => {
  const dead = await deadToolNames(employee.id);
  for (const name of [
    "scan_revenue_mail_documents",
    "list_revenue_document_candidates",
    "review_revenue_document_candidate",
    "list_commercial_value_backlog",
    "propose_finance_commercial_values",
  ]) {
    assert.equal(dead.has(name), true, `${name} should be secondary-grant-dead`);
  }
  assert.equal(dead.has("export_revenue_snapshot"), false);
  assert.equal(dead.has("list_revenue_field_evidence"), false);
});

test("row imports support CSV, JSON, and explicitly granted Connection provenance", async () => {
  const rows = [{ sourceId: "source-row-1", values: { company_name: "Example Co" } }];
  const base = {
    sourceLabel: "Revenue migration",
    rows,
    resourceType: "account",
    mapping: { name: "company_name" },
  };

  for (const sourceKind of ["csv", "json"] as const) {
    const preview = await aiCall("preview_revenue_rows_import", {
      ...base,
      sourceKind,
    });
    assert.equal(preview.status, 200, preview.body.error);
  }

  const missingCommitConfirmation = await aiCall("run_revenue_rows_import", {
    ...base,
    sourceKind: "csv",
  });
  assert.equal(missingCommitConfirmation.status, 400);
  const missingLinkedCommitConfirmation = await aiCall("run_linked_revenue_rows_import", {
    sourceKind: "json",
    sourceLabel: "Linked migration",
    rows,
    mapping: { account: {}, contact: {}, deal: {} },
  });
  assert.equal(missingLinkedCommitConfirmation.status, 400);

  const missingConnectionId = await aiCall("preview_revenue_rows_import", {
    ...base,
    sourceKind: "connection",
  });
  assert.equal(missingConnectionId.status, 400);
  assert.match(missingConnectionId.body.error ?? "", /sourceConnectionId/);

  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "CRM source",
    authMode: "apikey",
    encryptedConfig: "not-used-by-row-imports",
    status: "connected",
  });
  const connectionInput = {
    ...base,
    sourceKind: "connection",
    sourceConnectionId: connection.id,
  };
  const ungrantedPreview = await aiCall("preview_revenue_rows_import", connectionInput);
  assert.equal(ungrantedPreview.status, 403);
  assert.match(ungrantedPreview.body.error ?? "", /Grant/);
  const ungrantedCommit = await aiCall("run_revenue_rows_import", {
    ...connectionInput,
    confirm: "IMPORT",
  });
  assert.equal(ungrantedCommit.status, 403);
  assert.match(ungrantedCommit.body.error ?? "", /Grant/);

  await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: connection.id,
  });
  const grantedPreview = await aiCall("preview_revenue_rows_import", connectionInput);
  assert.equal(grantedPreview.status, 200, grantedPreview.body.error);
});

test("Deal-history coverage and Activity backfill keep commits explicitly scoped", async () => {
  const stage = await insert(DealStage, {
    companyId: company.id,
    name: "Qualified",
    slug: "qualified",
    sortOrder: 0,
    probability: 50,
    kind: "open",
    archivedAt: null,
  });
  const deal = await insert(Deal, {
    companyId: company.id,
    title: "Historical Deal",
    customerId: null,
    primaryContactId: null,
    stageId: stage.id,
    amountCents: 0,
    currency: "USD",
    status: "open",
    archivedAt: null,
  });

  const coverage = await aiCall("list_deal_history_coverage", {
    dealIds: [deal.id],
  });
  assert.equal(coverage.status, 200, coverage.body.error);
  assert.equal(coverage.body.total, 1);

  const preview = await aiCall("preview_deal_history_backfill", {
    dealIds: [deal.id],
  });
  assert.equal(preview.status, 200, preview.body.error);
  assert.equal(preview.body.selectedDeals, 1);

  const unscopedCommit = await aiCall("backfill_deal_history", {
    dealIds: [],
    idempotencyKey: "history-1",
    confirm: "BACKFILL",
  });
  assert.equal(unscopedCommit.status, 400);
  const unconfirmedCommit = await aiCall("backfill_deal_history", {
    dealIds: [deal.id],
    idempotencyKey: "history-1",
  });
  assert.equal(unconfirmedCommit.status, 400);
  const scopedCommit = await aiCall("backfill_deal_history", {
    dealIds: [deal.id],
    idempotencyKey: "history-1",
    confirm: "BACKFILL",
  });
  assert.equal(scopedCommit.status, 200, scopedCommit.body.error);
  assert.equal(scopedCommit.body.selectedDeals, 1);
});

test("commercial-value backlog and proposals require explicit safe scopes", async () => {
  const stage = await insert(DealStage, {
    companyId: company.id,
    name: "Qualified",
    slug: "commercial-qualified",
    sortOrder: 0,
    probability: 50,
    kind: "open",
    archivedAt: null,
  });
  const account = await insert(Customer, {
    companyId: company.id,
    name: "Commercial Account",
    slug: "commercial-account",
    archivedAt: null,
  });
  const deal = await insert(Deal, {
    companyId: company.id,
    title: "Zero-value Deal",
    customerId: account.id,
    primaryContactId: null,
    stageId: stage.id,
    amountCents: 0,
    currency: "USD",
    status: "open",
    archivedAt: null,
  });
  const dealId = deal.id;
  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "Stripe",
    authMode: "apikey",
    encryptedConfig: "not-used-without-candidates",
    status: "connected",
  });
  const stripeField = await insert(RevenueCustomField, {
    companyId: company.id,
    resourceType: "account",
    key: "stripe_customer_id",
    name: "Stripe customer ID",
    fieldType: "text",
    archivedAt: null,
  });
  await insert(RevenueCustomValue, {
    companyId: company.id,
    fieldId: stripeField.id,
    resourceType: "account",
    resourceId: account.id,
    valueJson: JSON.stringify("cus_secret"),
    searchValue: "cus_secret",
  });
  await insert(RevenueFieldEvidence, {
    companyId: company.id,
    resourceType: "deal",
    resourceId: deal.id,
    fieldKey: "commercial_value",
    sourceType: "integration",
    sourceId: "sub_secret",
    sourceLabel: "Stripe subscription",
    extractedValueJson: JSON.stringify({
      amountCents: 10_000,
      currency: "USD",
      revenueType: "recurring",
    }),
    normalizedValue: "10000:USD",
    confidence: 90,
    status: "proposed",
    verificationState: "verified",
    extractionMethod: "stripe_subscription",
    extractedAt: new Date(),
  });
  const backlogWithoutFinance = await aiCall("list_commercial_value_backlog", {
    dealIds: [dealId],
  });
  assert.equal(backlogWithoutFinance.status, 403);
  assert.match(backlogWithoutFinance.body.error ?? "", /finance/i);

  const unscopedFinance = await aiCall("propose_finance_commercial_values", {
    confirm: "PROPOSE",
  });
  assert.equal(unscopedFinance.status, 400);
  const unconfirmedFinance = await aiCall("propose_finance_commercial_values", {
    dealIds: [dealId],
  });
  assert.equal(unconfirmedFinance.status, 400);
  const financeWithoutGrant = await aiCall("propose_finance_commercial_values", {
    dealIds: [dealId],
    confirm: "PROPOSE",
  });
  assert.equal(financeWithoutGrant.status, 403);
  assert.match(financeWithoutGrant.body.error ?? "", /finance/i);
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  const backlog = await aiCall("list_commercial_value_backlog", {
    dealIds: [dealId],
  });
  assert.equal(backlog.status, 200, backlog.body.error);
  const backlogRows = backlog.body.rows as Array<{
    stripeCandidate: unknown;
    proposals: Array<{ sourceType: string }>;
    disposition: string;
  }>;
  assert.equal(backlogRows[0]?.stripeCandidate, null);
  assert.deepEqual(backlogRows[0]?.proposals, []);
  assert.equal(backlogRows[0]?.disposition, "no_evidence");
  const financeWithReadGrant = await aiCall("propose_finance_commercial_values", {
    dealIds: [dealId],
    confirm: "PROPOSE",
  });
  assert.equal(financeWithReadGrant.status, 403);
  assert.match(financeWithReadGrant.body.error ?? "", /full/i);
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(
    { employeeId: employee.id },
    { accessLevel: "full" },
  );
  const scopedFinance = await aiCall("propose_finance_commercial_values", {
    dealIds: [dealId],
    confirm: "PROPOSE",
  });
  assert.equal(scopedFinance.status, 200, scopedFinance.body.error);

  const unscopedStripe = await aiCall("propose_stripe_commercial_values", {
    connectionId: connection.id,
    confirm: "PROPOSE",
  });
  assert.equal(unscopedStripe.status, 400);
  const unconfirmedStripe = await aiCall("propose_stripe_commercial_values", {
    connectionId: connection.id,
    dealIds: [dealId],
  });
  assert.equal(unconfirmedStripe.status, 400);
  const stripeWithoutGrant = await aiCall("propose_stripe_commercial_values", {
    connectionId: connection.id,
    dealIds: [dealId],
    confirm: "PROPOSE",
  });
  assert.equal(stripeWithoutGrant.status, 403);
  assert.match(stripeWithoutGrant.body.error ?? "", /Grant/);
  await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: connection.id,
  });
  const scopedStripe = await aiCall("propose_stripe_commercial_values", {
    connectionId: connection.id,
    dealIds: [dealId],
    confirm: "PROPOSE",
  });
  assert.equal(scopedStripe.status, 200, scopedStripe.body.error);
});

test("expanded Revenue audit and evidence exports resolve end to end", async () => {
  for (const [resource, filters] of [
    ["deal_history", { sourceKind: "live", kind: "created" }],
    ["field_evidence", { resourceType: "deal", sourceType: "manual", status: "proposed" }],
    ["duplicate_candidates", { resourceType: "account", status: "open", minScore: 50 }],
    ["operation_audit", { resourceType: "deal", kind: "bulk", status: "completed" }],
  ] as const) {
    const result = await aiCall("export_revenue_snapshot", {
      resource,
      format: "json",
      limit: 10,
      ...filters,
    });
    assert.equal(result.status, 200, `${resource}: ${result.body.error ?? "request failed"}`);
    assert.equal(result.body.resource, resource);
  }
  const unscopedMailboxExport = await aiCall("export_revenue_snapshot", {
    resource: "document_candidates",
    format: "json",
  });
  assert.equal(unscopedMailboxExport.status, 400);

  const grantedConnection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "google",
    label: "Granted Gmail",
    authMode: "oauth2",
    encryptedConfig: "not-used-by-export",
    status: "connected",
  });
  const grantedAccount = await insert(MailAccount, {
    companyId: company.id,
    connectionId: grantedConnection.id,
    address: "granted@example.com",
    status: "active",
  });
  const grantedMessage = await insert(MailMessage, {
    companyId: company.id,
    accountId: grantedAccount.id,
    threadId: "granted-thread",
    gmailMessageId: "granted-message",
    gmailThreadId: "granted-gmail-thread",
    subject: "Granted candidate",
  });
  const grantedCandidate = await insert(RevenueDocumentCandidate, {
    companyId: company.id,
    mailMessageId: grantedMessage.id,
    attachmentIndex: 0,
    gmailMessageId: grantedMessage.gmailMessageId,
    gmailThreadId: grantedMessage.gmailThreadId,
    gmailAttachmentId: "granted-attachment",
    filename: "granted.pdf",
    mimeType: "application/pdf",
    proposedKind: "contract",
    proposedResourceType: null,
    proposedResourceId: null,
    confidence: 90,
    alternativesJson: "[]",
    status: "pending",
  });

  const deniedConnection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "google",
    label: "Denied Gmail",
    authMode: "oauth2",
    encryptedConfig: "not-used-by-export",
    status: "connected",
  });
  const deniedAccount = await insert(MailAccount, {
    companyId: company.id,
    connectionId: deniedConnection.id,
    address: "denied@example.com",
    status: "active",
  });
  const deniedMessage = await insert(MailMessage, {
    companyId: company.id,
    accountId: deniedAccount.id,
    threadId: "denied-thread",
    gmailMessageId: "denied-message",
    gmailThreadId: "denied-gmail-thread",
    subject: "Denied candidate",
  });
  const deniedCandidate = await insert(RevenueDocumentCandidate, {
    companyId: company.id,
    mailMessageId: deniedMessage.id,
    attachmentIndex: 0,
    gmailMessageId: deniedMessage.gmailMessageId,
    gmailThreadId: deniedMessage.gmailThreadId,
    gmailAttachmentId: "denied-attachment",
    filename: "denied.pdf",
    mimeType: "application/pdf",
    proposedKind: "contract",
    proposedResourceType: null,
    proposedResourceId: null,
    confidence: 85,
    alternativesJson: "[]",
    status: "pending",
  });

  const ungrantedMailboxExport = await aiCall("export_revenue_snapshot", {
    resource: "document_candidates",
    format: "json",
    accountId: deniedAccount.id,
  });
  assert.equal(ungrantedMailboxExport.status, 403);
  assert.match(ungrantedMailboxExport.body.error ?? "", /Grant/i);

  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: grantedAccount.id,
    accessLevel: "read",
  });
  const grantedMailboxExport = await aiCall("export_revenue_snapshot", {
    resource: "document_candidates",
    format: "json",
    accountId: grantedAccount.id,
  });
  assert.equal(grantedMailboxExport.status, 200, grantedMailboxExport.body.error);
  assert.deepEqual(
    (grantedMailboxExport.body.rows as Array<{ id: string }>).map((row) => row.id),
    [grantedCandidate.id],
  );
  assert.notEqual(grantedCandidate.id, deniedCandidate.id);
});

test("Finance evidence is filtered without a Grant and review needs full access", async () => {
  const account = await insert(Customer, {
    companyId: company.id,
    name: "Evidence Account",
    slug: "evidence-account",
    archivedAt: null,
  });
  const evidenceBase = {
    companyId: company.id,
    resourceType: "account" as const,
    resourceId: account.id,
    fieldKey: "industry",
    sourceLabel: "",
    extractedValueJson: JSON.stringify("Software"),
    normalizedValue: "software",
    confidence: 80,
    status: "proposed" as const,
    verificationState: "verified" as const,
    extractionMethod: "test",
    extractedAt: new Date(),
  };
  const financeEvidence = await insert(RevenueFieldEvidence, {
    ...evidenceBase,
    sourceType: "finance",
    sourceId: "invoice-secret",
    sourceLabel: "Finance invoice",
  });
  const manualEvidence = await insert(RevenueFieldEvidence, {
    ...evidenceBase,
    sourceType: "manual",
    sourceId: "manual-safe",
    sourceLabel: "Member note",
  });
  const googleConnection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "google",
    label: "Gmail",
    authMode: "oauth2",
    encryptedConfig: "not-used",
    status: "connected",
  });
  const mailAccount = await insert(MailAccount, {
    companyId: company.id,
    connectionId: googleConnection.id,
    address: "sales@example.com",
  });
  const mailMessage = await insert(MailMessage, {
    companyId: company.id,
    accountId: mailAccount.id,
    threadId: "thread-1",
    gmailMessageId: "gmail-message-1",
    gmailThreadId: "gmail-thread-1",
    subject: "Confidential terms",
  });
  const emailEvidence = await insert(RevenueFieldEvidence, {
    ...evidenceBase,
    sourceType: "email",
    sourceId: mailMessage.id,
    sourceLabel: "Confidential terms",
  });
  const stripeConnection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "Private Stripe",
    authMode: "apikey",
    encryptedConfig: "not-used",
    status: "connected",
  });
  const integrationEvidence = await insert(RevenueFieldEvidence, {
    ...evidenceBase,
    sourceType: "integration",
    sourceId: "sub_private",
    sourceLabel: "Private Stripe subscription",
    metadataJson: JSON.stringify({ connectionId: stripeConnection.id }),
  });

  const unfiltered = await aiCall("list_revenue_field_evidence", {});
  assert.equal(unfiltered.status, 200, unfiltered.body.error);
  assert.equal(unfiltered.body.total, 1);
  assert.deepEqual(
    (unfiltered.body.rows as Array<{ id: string }>).map((row) => row.id),
    [manualEvidence.id],
  );
  const explicitFinance = await aiCall("list_revenue_field_evidence", {
    sourceType: "finance",
  });
  assert.equal(explicitFinance.status, 403);
  const emailWithoutGrant = await aiCall("list_revenue_field_evidence", {
    sourceType: "email",
  });
  assert.equal(emailWithoutGrant.status, 200, emailWithoutGrant.body.error);
  assert.equal(emailWithoutGrant.body.total, 0);
  assert.equal(
    (await aiCall("list_revenue_field_evidence", { sourceType: "integration" })).status,
    403,
  );
  const unfilteredExport = await aiCall("export_revenue_snapshot", {
    resource: "field_evidence",
    format: "json",
  });
  assert.equal(unfilteredExport.status, 200, unfilteredExport.body.error);
  assert.equal(unfilteredExport.body.total, 1);
  assert.deepEqual(
    (unfilteredExport.body.rows as Array<{ id: string }>).map((row) => row.id),
    [manualEvidence.id],
  );
  const explicitFinanceExport = await aiCall("export_revenue_snapshot", {
    resource: "field_evidence",
    sourceType: "finance",
    format: "json",
  });
  assert.equal(explicitFinanceExport.status, 403);
  assert.equal(
    (
      await aiCall("review_revenue_field_evidence", {
        evidenceId: emailEvidence.id,
        decision: "reject",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await aiCall("review_revenue_field_evidence", {
        evidenceId: integrationEvidence.id,
        decision: "reject",
      })
    ).status,
    403,
  );

  const manualReview = await aiCall("review_revenue_field_evidence", {
    evidenceId: manualEvidence.id,
    decision: "reject",
  });
  assert.equal(manualReview.status, 200, manualReview.body.error);
  const financeWithoutGrant = await aiCall("review_revenue_field_evidence", {
    evidenceId: financeEvidence.id,
    decision: "reject",
  });
  assert.equal(financeWithoutGrant.status, 403);

  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: mailAccount.id,
    accessLevel: "read",
  });
  await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: stripeConnection.id,
  });
  const grantedEmail = await aiCall("list_revenue_field_evidence", {
    sourceType: "email",
  });
  assert.equal(grantedEmail.status, 200, grantedEmail.body.error);
  assert.deepEqual(
    (grantedEmail.body.rows as Array<{ id: string }>).map((row) => row.id),
    [emailEvidence.id],
  );
  const grantedIntegration = await aiCall("list_revenue_field_evidence", {
    sourceType: "integration",
  });
  assert.equal(grantedIntegration.status, 200, grantedIntegration.body.error);
  assert.deepEqual(
    (grantedIntegration.body.rows as Array<{ id: string }>).map((row) => row.id),
    [integrationEvidence.id],
  );
  assert.equal(
    (
      await aiCall("review_revenue_field_evidence", {
        evidenceId: emailEvidence.id,
        decision: "reject",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await aiCall("review_revenue_field_evidence", {
        evidenceId: integrationEvidence.id,
        decision: "reject",
      })
    ).status,
    200,
  );

  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  const financeWithRead = await aiCall("review_revenue_field_evidence", {
    evidenceId: financeEvidence.id,
    decision: "reject",
  });
  assert.equal(financeWithRead.status, 403);
  assert.match(financeWithRead.body.error ?? "", /full/i);
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(
    { employeeId: employee.id },
    { accessLevel: "full" },
  );
  const financeWithFull = await aiCall("review_revenue_field_evidence", {
    evidenceId: financeEvidence.id,
    decision: "reject",
  });
  assert.equal(financeWithFull.status, 200, financeWithFull.body.error);
});

test("Contact-derived domain evidence stays available without a mailbox Grant", async () => {
  const account = await insert(Customer, {
    companyId: company.id,
    name: "Canonical Acme",
    slug: "canonical-acme",
    domain: "",
    archivedAt: null,
  });
  const contact = await insert(Contact, {
    companyId: company.id,
    name: "Acme Buyer",
    email: "buyer@canonical-acme.com",
    customerId: account.id,
    lifecycleStage: "lead",
    archivedAt: null,
  });

  const proposed = await aiCall("propose_revenue_account_domains", {
    accountIds: [account.id],
    verifiedContactIds: [contact.id],
  });
  assert.equal(proposed.status, 200, proposed.body.error);
  assert.equal(proposed.body.proposed, 1);

  const evidence = await AppDataSource.getRepository(RevenueFieldEvidence).findOneByOrFail({
    companyId: company.id,
    resourceType: "account",
    resourceId: account.id,
    fieldKey: "domain",
    sourceType: "email",
    sourceId: contact.id,
  });

  const collisionAccount = await insert(Customer, {
    companyId: company.id,
    name: "Collision Account",
    slug: "collision-account",
    domain: "",
    archivedAt: null,
  });
  const collisionContact = await insert(Contact, {
    companyId: company.id,
    name: "Collision Contact",
    email: "buyer@collision-example.com",
    customerId: collisionAccount.id,
    lifecycleStage: "lead",
    archivedAt: null,
  });
  const collisionMailAccount = await insert(MailAccount, {
    companyId: company.id,
    connectionId: "11111111-1111-4111-8111-111111111199",
    address: "private-mailbox@example.com",
    status: "active",
  });
  await insert(MailMessage, {
    id: collisionContact.id,
    companyId: company.id,
    accountId: collisionMailAccount.id,
    threadId: "collision-thread",
    gmailMessageId: "collision-message",
    gmailThreadId: "collision-gmail-thread",
    subject: "Mailbox identity takes precedence",
  });
  const collisionEvidence = await insert(RevenueFieldEvidence, {
    companyId: company.id,
    resourceType: "account",
    resourceId: collisionAccount.id,
    fieldKey: "domain",
    sourceType: "email",
    sourceId: collisionContact.id,
    sourceLabel: collisionContact.email,
    extractedValueJson: JSON.stringify("collision-example.com"),
    normalizedValue: "collision-example.com",
    confidence: 80,
    status: "proposed",
    verificationState: "unverified",
    extractionMethod: "email_candidate_generation",
    extractedAt: new Date(),
  });

  const listed = await aiCall("list_revenue_field_evidence", {
    sourceType: "email",
  });
  assert.equal(listed.status, 200, listed.body.error);
  assert.deepEqual(
    (listed.body.rows as Array<{ id: string }>).map((row) => row.id),
    [evidence.id],
  );

  const exported = await aiCall("export_revenue_snapshot", {
    resource: "field_evidence",
    sourceType: "email",
    format: "json",
  });
  assert.equal(exported.status, 200, exported.body.error);
  assert.deepEqual(
    (exported.body.rows as Array<{ id: string }>).map((row) => row.id),
    [evidence.id],
  );

  const collisionReview = await aiCall("review_revenue_field_evidence", {
    evidenceId: collisionEvidence.id,
    decision: "accept",
  });
  assert.equal(collisionReview.status, 403);
  assert.match(collisionReview.body.error ?? "", /Grant/i);

  const reviewed = await aiCall("review_revenue_field_evidence", {
    evidenceId: evidence.id,
    decision: "accept",
  });
  assert.equal(reviewed.status, 200, reviewed.body.error);
  assert.equal(
    (await AppDataSource.getRepository(Customer).findOneByOrFail({ id: account.id })).domain,
    "canonical-acme.com",
  );
});

test("MCP bulk standard-field updates require confirmation and normalize dates", async () => {
  const account = await insert(Customer, {
    companyId: company.id,
    name: "Acme account",
    slug: "acme-account",
    archivedAt: null,
  });
  const unconfirmed = await aiCall("preview_revenue_bulk_operation", {
    resourceType: "account",
    target: { ids: [account.id] },
    action: {
      type: "update_standard_fields",
      values: { name: "Updated account" },
    },
  });
  assert.equal(unconfirmed.status, 400);

  const preview = await aiCall("preview_revenue_bulk_operation", {
    resourceType: "account",
    target: { ids: [account.id] },
    action: {
      type: "update_standard_fields",
      confirm: "UPDATE_STANDARD_FIELDS",
      values: { name: "Updated account" },
    },
  });
  assert.equal(preview.status, 200, preview.body.error);
  assert.equal(preview.body.valid, 1);
});

test("Revenue import rollback requires destructive confirmation", async () => {
  const importId = "11111111-1111-4111-8111-111111111111";
  const unconfirmed = await aiCall("rollback_revenue_import", { importId });
  assert.equal(unconfirmed.status, 400);
  const confirmed = await aiCall("rollback_revenue_import", {
    importId,
    confirm: "ROLLBACK",
  });
  assert.equal(confirmed.status, 404);
});

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
    dealIds: ["11111111-1111-4111-8111-111111111111"],
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

test("Account tools leave billing details out without Finance access, in a Member's chat too", async () => {
  const billing = {
    email: "ap@acme.example",
    billingAddress: "1 Ledger Lane, London",
    shippingAddress: "2 Dock Road, Tilbury",
    taxNumber: "GB123456789",
  };
  const source = await insert(Customer, {
    companyId: company.id,
    name: "Acme Ltd",
    slug: "acme-ltd",
    domain: "acme.example",
    ...billing,
  });
  const target = await insert(Customer, {
    companyId: company.id,
    name: "Acme Group",
    slug: "acme-group",
    domain: "acme-group.example",
    email: "billing@acme-group.example",
  });
  const hidden = [...Object.values(billing), target.email];

  /** Every account tool that reads the source account or its billing conflicts. */
  async function readAccounts() {
    const responses = [
      await aiCall("list_revenue_accounts", {}),
      await aiCall("get_revenue_account", { accountId: source.id }),
      await aiCall("preview_revenue_record_merge", {
        resourceType: "account",
        sourceId: source.id,
        targetId: target.id,
      }),
      await aiCall("export_revenue_snapshot", { resource: "accounts", format: "json" }),
    ];
    for (const response of responses) assert.equal(response.status, 200, response.body.error);
    const [list, detail, preview, exported] = responses;
    const sourceRow = (rows: unknown) =>
      (rows as Array<{ id: string; billingWithheld?: boolean }>).find(
        (row) => row.id === source.id,
      );
    return {
      serialized: JSON.stringify(responses.map((response) => response.body)),
      withheld: [
        sourceRow(list.body.rows)?.billingWithheld,
        (detail.body.account as { billingWithheld?: boolean }).billingWithheld,
        preview.body.billingWithheld,
        sourceRow(exported.body.rows)?.billingWithheld,
      ],
    };
  }
  const assertWithheld = (read: Awaited<ReturnType<typeof readAccounts>>) => {
    for (const value of hidden) assert.equal(read.serialized.includes(value), false, value);
    assert.deepEqual(read.withheld, [true, true, true, true]);
  };
  const assertVisible = (read: Awaited<ReturnType<typeof readAccounts>>) => {
    for (const value of hidden) assert.ok(read.serialized.includes(value), value);
    assert.deepEqual(read.withheld, [undefined, undefined, undefined, undefined]);
  };

  // A Revenue Grant alone is no Finance access.
  assertWithheld(await readAccounts());
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  assertVisible(await readAccounts());

  // In a Member's chat, that Member's own Finance access caps the employee's.
  const member = await insert(User, {
    email: "member@acme.example",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const membership = await insert(Membership, {
    companyId: company.id,
    userId: member.id,
    role: "member",
    financeAccess: "none",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: member.id,
    requesterSessionVersion: member.sessionVersion,
  });
  assertWithheld(await readAccounts());
  await AppDataSource.getRepository(Membership).update(membership.id, { financeAccess: "read" });
  assertVisible(await readAccounts());
});

/** An Account standard-field bulk update, as the bulk tools take it. */
function accountFieldUpdate(ids: string[], values: Record<string, unknown>) {
  return {
    resourceType: "account",
    target: { ids },
    action: { type: "update_standard_fields", confirm: "UPDATE_STANDARD_FIELDS", values },
  };
}

async function finishedBulkJob(operationId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await aiCall("get_revenue_bulk_job", { operationId });
    assert.equal(job.status, 200, job.body.error);
    const status = (job.body.operation as { status: string }).status;
    if (["completed", "partial", "failed"].includes(status)) return job.body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return assert.fail(`bulk job ${operationId} never finished`);
}

test("a queued bulk job is journaled with the article its record kind takes", async () => {
  // Read "queued a account bulk operation" while the article was hard-coded.
  const account = await insert(Customer, {
    companyId: company.id,
    name: "Acme account",
    slug: "acme-account",
  });
  const queued = await aiCall("start_revenue_bulk_job", {
    ...accountFieldUpdate([account.id], { name: "Acme renamed" }),
    idempotencyKey: "journal-article",
  });
  assert.equal(queued.status, 202, queued.body.error);
  await finishedBulkJob((queued.body.job as { id: string }).id);
  const titles = (
    await AppDataSource.getRepository(JournalEntry).findBy({ employeeId: employee.id })
  ).map((entry) => entry.title);
  assert.deepEqual(titles, ["Revenue analyst queued an account bulk operation"]);
});

test("Account tools set billing details only with an invoice Finance Grant, in a Member's chat too", async () => {
  const source = await insert(Customer, {
    companyId: company.id,
    name: "Acme Ltd",
    slug: "acme-ltd",
    domain: "acme.example",
    email: "ap@acme.example",
    taxNumber: "GB123456789",
  });
  const target = await insert(Customer, {
    companyId: company.id,
    name: "Acme Group",
    slug: "acme-group",
    domain: "acme-group.example",
    email: "billing@acme-group.example",
    taxNumber: "GB987654321",
  });
  const writes: Array<[string, Record<string, unknown>]> = [
    ["create_revenue_account", { name: "Acme Billing", email: "ap@acme-billing.example" }],
    ["update_revenue_account", { accountId: source.id, email: "new@acme.example" }],
    // A preview too: its rows would echo each account's current values.
    ["preview_revenue_bulk_operation", accountFieldUpdate([source.id], { taxNumber: "GB0" })],
    [
      "start_revenue_bulk_job",
      { ...accountFieldUpdate([source.id], { billingAddress: "9 New Street" }), idempotencyKey: "ai-refused-job" },
    ],
    [
      "merge_revenue_accounts",
      {
        sourceAccountId: source.id,
        targetAccountId: target.id,
        confirmSourceName: source.name,
        resolutions: { email: "source" },
      },
    ],
    [
      "merge_revenue_records",
      {
        resourceType: "account",
        sourceId: source.id,
        targetId: target.id,
        confirmSourceLabel: source.name,
        resolutions: { taxNumber: "source" },
      },
    ],
  ];
  const assertRefused = async (why: RegExp) => {
    for (const [tool, body] of writes) {
      const refused = await aiCall(tool, body);
      assert.equal(refused.status, 403, tool);
      assert.match(refused.body.error ?? "", why, tool);
    }
  };

  // A Revenue write Grant changes everything but billing details.
  await assertRefused(/do not have access to the finance system/);
  const noted = await aiCall("update_revenue_account", { accountId: source.id, notes: "Renewal" });
  assert.equal(noted.status, 200, noted.body.error);
  const grant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  await assertRefused(/needs the "invoice" finance access level; yours is "read"/);

  // In a Member's chat, a Read-only Member caps an invoice Grant.
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(grant.id, {
    accessLevel: "invoice",
  });
  const member = await insert(User, {
    email: "member@acme.example",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const membership = await insert(Membership, {
    companyId: company.id,
    userId: member.id,
    role: "member",
    financeAccess: "read",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: member.id,
    requesterSessionVersion: member.sessionVersion,
  });
  await assertRefused(/finance access level/);
  const accounts = AppDataSource.getRepository(Customer);
  const untouched = await accounts.findOneByOrFail({ id: source.id });
  assert.equal(untouched.email, "ap@acme.example");
  assert.equal(untouched.archivedAt, null);
  assert.equal(await accounts.countBy({ companyId: company.id, name: "Acme Billing" }), 0);

  // A Member with Full finance access lifts the cap.
  await AppDataSource.getRepository(Membership).update(membership.id, { financeAccess: "full" });
  const updated = await aiCall("update_revenue_account", {
    accountId: source.id,
    email: "new@acme.example",
  });
  assert.equal(updated.status, 200, updated.body.error);
  assert.equal((updated.body.account as { email?: string }).email, "new@acme.example");
  const preview = await aiCall(
    "preview_revenue_bulk_operation",
    accountFieldUpdate([source.id], { taxNumber: "GB0" }),
  );
  assert.equal(preview.status, 200, preview.body.error);
  const merged = await aiCall("merge_revenue_records", {
    resourceType: "account",
    sourceId: source.id,
    targetId: target.id,
    confirmSourceLabel: source.name,
    resolutions: { taxNumber: "source" },
  });
  assert.equal(merged.status, 200, merged.body.error);
  assert.equal((await accounts.findOneByOrFail({ id: target.id })).taxNumber, "GB123456789");
});

test("Revenue history tools leave Account billing details out without Finance access", async () => {
  const source = await insert(Customer, {
    companyId: company.id,
    name: "Acme Ltd",
    slug: "acme-ltd",
    domain: "acme.example",
    email: "ap@acme.example",
    billingAddress: "1 Ledger Lane, London",
  });
  const target = await insert(Customer, {
    companyId: company.id,
    name: "Acme Group",
    slug: "acme-group",
    domain: "acme-group.example",
    email: "billing@acme-group.example",
    billingAddress: "3 Treasury Street, Leeds",
  });
  const grant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  const queued = await aiCall("start_revenue_bulk_job", {
    ...accountFieldUpdate([target.id], { email: "accounts@acme-group.example", notes: "Renewal" }),
    idempotencyKey: "ai-history-job",
  });
  assert.equal(queued.status, 202, queued.body.error);
  const jobId = (queued.body.job as { id: string }).id;
  const job = await finishedBulkJob(jobId);
  assert.equal((job.operation as { status: string }).status, "completed");
  const merged = await aiCall("merge_revenue_records", {
    resourceType: "account",
    sourceId: source.id,
    targetId: target.id,
    confirmSourceLabel: source.name,
    resolutions: { billingAddress: "source" },
  });
  assert.equal(merged.status, 200, merged.body.error);
  const mergeId = merged.body.operationId as string;
  const hidden = [
    "ap@acme.example",
    "1 Ledger Lane, London",
    "billing@acme-group.example",
    "accounts@acme-group.example",
    "3 Treasury Street, Leeds",
  ];

  /** Every history tool, for both operations. */
  async function readHistory() {
    const responses = [
      await aiCall("list_revenue_operations", {}),
      await aiCall("get_revenue_operation", { operationId: mergeId }),
      await aiCall("get_revenue_operation", { operationId: jobId }),
      await aiCall("get_revenue_bulk_job", { operationId: jobId }),
      await aiCall("export_revenue_bulk_reconciliation", { operationId: jobId }),
      await aiCall("export_revenue_snapshot", { resource: "operation_audit", format: "json" }),
      await aiCall("export_revenue_snapshot", { resource: "operation_audit", format: "csv" }),
    ];
    for (const response of responses) assert.equal(response.status, 200, response.body.error);
    return JSON.stringify(responses.map((response) => response.body));
  }

  // Without a Finance Grant the history keeps everything but billing details,
  // and undoing a change to them is refused.
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete(grant.id);
  const withheld = await readHistory();
  for (const value of hidden) assert.equal(withheld.includes(value), false, value);
  for (const value of ["Renewal", "Acme Ltd", "billingWithheld"]) {
    assert.ok(withheld.includes(value), value);
  }
  for (const operationId of [mergeId, jobId]) {
    const undo = await aiCall("undo_revenue_operation", { operationId, confirm: "UNDO" });
    assert.equal(undo.status, 403, operationId);
  }

  // A read Grant reads them, and still can't undo them.
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  const visible = await readHistory();
  for (const value of hidden) assert.ok(visible.includes(value), value);
  assert.equal(visible.includes("billingWithheld"), false);
  const refusedUndo = await aiCall("undo_revenue_operation", { operationId: mergeId, confirm: "UNDO" });
  assert.equal(refusedUndo.status, 403);

  // An invoice Grant undoes them.
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(
    { employeeId: employee.id },
    { accessLevel: "invoice" },
  );
  for (const operationId of [mergeId, jobId]) {
    const undo = await aiCall("undo_revenue_operation", { operationId, confirm: "UNDO" });
    assert.equal(undo.status, 200, undo.body.error);
  }
  const restored = await AppDataSource.getRepository(Customer).findOneByOrFail({ id: target.id });
  assert.equal(restored.email, "billing@acme-group.example");
  assert.equal(restored.billingAddress, "3 Treasury Street, Leeds");
});
