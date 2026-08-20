import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
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
import { Invoice } from "../db/entities/Invoice.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

type ToolBody = Record<string, unknown> & { error?: string };

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let customer: Customer;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;

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
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ToolBody };
}

function annualSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerSlug: customer.slug,
    name: "OneUptime Starter annual renewal",
    cronExpr: "0 9 20 8 *",
    frequency: "yearly",
    daysUntilDue: 14,
    autoSend: false,
    currency: "USD",
    notes: "Nine licences billed annually at $22 per user per month.",
    lines: [
      {
        description: "OneUptime Starter — annual licence",
        quantity: 9,
        unitPriceCents: 26_400,
      },
    ],
    ...overrides,
  };
}

async function createAnnualSchedule(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await callTool("create_recurring_invoice", annualSchedule(overrides));
  assert.equal(response.status, 200, response.body.error);
  return response.body.recurringInvoice as Record<string, unknown>;
}

test("create_recurring_invoice schedules annual billing without billing immediately", async () => {
  const before = Date.now();
  const payload = await createAnnualSchedule();

  assert.match(String(payload.slug), /^ri-/);
  assert.equal(payload.name, "OneUptime Starter annual renewal");
  assert.equal(payload.cronExpr, "0 9 20 8 *");
  assert.equal(payload.frequency, "yearly");
  assert.equal(payload.intervalCount, 1);
  assert.equal(payload.status, "active");
  assert.equal(payload.autoSend, false);
  assert.equal(payload.currency, "USD");
  assert.ok(new Date(String(payload.nextRunAt)).getTime() > before);

  const schedule = await AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({
    id: String(payload.id),
    companyId: company.id,
  });
  assert.equal(schedule.customerId, customer.id);
  assert.equal(schedule.createdById, null);
  assert.equal(schedule.runsCreated, 0);
  assert.equal(schedule.lastRunAt, null);
  assert.equal(schedule.lastInvoiceSlug, "");
  assert.equal(
    await AppDataSource.getRepository(RecurringInvoiceLineItem).countBy({
      recurringInvoiceId: schedule.id,
    }),
    1,
  );

  assert.equal(await AppDataSource.getRepository(Invoice).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);

  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id,
    action: "finance.recurring_invoice.create",
  });
  assert.equal(audit.actorKind, "ai");
  assert.equal(audit.actorEmployeeId, employee.id);
  assert.equal(audit.targetType, "recurring_invoice");
  assert.equal(audit.targetId, schedule.id);
  assert.equal(
    await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: employee.id }),
    1,
  );

  const automatic = await callTool(
    "create_recurring_invoice",
    annualSchedule({ name: "Automatic annual renewal", autoSend: true }),
  );
  assert.equal(automatic.status, 200, automatic.body.error);
  assert.equal((automatic.body.recurringInvoice as Record<string, unknown>).autoSend, true);
  assert.match(String(automatic.body.note), /Each run will issue.*post.*email/i);
  assert.equal(await AppDataSource.getRepository(Invoice).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
});

test("list_recurring_invoices and get_recurring_invoice return the saved schedule", async () => {
  const created = await createAnnualSchedule();
  const slug = String(created.slug);

  const listed = await callTool("list_recurring_invoices");
  assert.equal(listed.status, 200, listed.body.error);
  const rows = listed.body.recurringInvoices as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.slug, slug);
  assert.equal(rows[0]?.status, "active");
  assert.equal((rows[0]?.customer as Record<string, unknown>)?.slug, customer.slug);

  const fetched = await callTool("get_recurring_invoice", {
    recurringInvoiceSlug: slug,
  });
  assert.equal(fetched.status, 200, fetched.body.error);
  const schedule = fetched.body.recurringInvoice as Record<string, unknown>;
  assert.equal(schedule.slug, slug);
  assert.equal((schedule.customer as Record<string, unknown>)?.slug, customer.slug);
  const lines = schedule.lines as Array<Record<string, unknown>>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.quantity, 9);
  assert.equal(lines[0]?.unitPriceCents, 26_400);
});

test("recurring invoice reads stay inside the employee's company", async () => {
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
  await insert(RecurringInvoice, {
    companyId: otherCompany.id,
    customerId: otherCustomer.id,
    slug: "ri-other-company",
    name: "Other schedule",
    cronExpr: "0 9 1 * *",
    frequency: "monthly",
    intervalCount: 1,
    status: "active",
    daysUntilDue: 14,
    autoSend: false,
    currency: "USD",
    notes: "",
    footer: "",
    runsCreated: 0,
    lastInvoiceSlug: "",
    maxRuns: null,
    endsOn: null,
    createdById: null,
  });

  const listed = await callTool("list_recurring_invoices");
  assert.equal(listed.status, 200, listed.body.error);
  assert.deepEqual(listed.body.recurringInvoices, []);

  const fetched = await callTool("get_recurring_invoice", {
    recurringInvoiceSlug: "ri-other-company",
  });
  assert.equal(fetched.status, 404);

  const filtered = await callTool("list_recurring_invoices", {
    customerSlug: otherCustomer.slug,
  });
  assert.equal(filtered.status, 404);
});

test("recurring invoice reads need read access and writes need Invoicing access", async () => {
  const created = await createAnnualSchedule();
  const recurringInvoiceSlug = String(created.slug);

  grant.accessLevel = "read";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);

  const listed = await callTool("list_recurring_invoices");
  assert.equal(listed.status, 200, listed.body.error);
  const fetched = await callTool("get_recurring_invoice", { recurringInvoiceSlug });
  assert.equal(fetched.status, 200, fetched.body.error);

  const createDenied = await callTool(
    "create_recurring_invoice",
    annualSchedule({ name: "Must not be created" }),
  );
  assert.equal(createDenied.status, 403);
  assert.match(createDenied.body.error ?? "", /needs the "invoice" finance access level/);

  const updateDenied = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    status: "paused",
  });
  assert.equal(updateDenied.status, 403);
  assert.match(updateDenied.body.error ?? "", /needs the "invoice" finance access level/);
  assert.equal(await AppDataSource.getRepository(RecurringInvoice).count(), 1);

  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ employeeId: employee.id });
  const readDenied = await callTool("list_recurring_invoices");
  assert.equal(readDenied.status, 403);
  assert.match(readDenied.body.error ?? "", /do not have access to the finance system/);

  const dead = await deadToolNames(employee.id);
  for (const name of [
    "list_recurring_invoices",
    "get_recurring_invoice",
    "create_recurring_invoice",
    "update_recurring_invoice",
  ]) {
    assert.equal(dead.has(name), true, name);
  }
});

test("create_recurring_invoice rejects invalid references, schedules, and values atomically", async () => {
  const missingCustomer = await callTool(
    "create_recurring_invoice",
    annualSchedule({ customerSlug: "missing-customer" }),
  );
  assert.equal(missingCustomer.status, 404);
  assert.match(missingCustomer.body.error ?? "", /not found/i);

  const missingTaxRate = await callTool(
    "create_recurring_invoice",
    annualSchedule({
      lines: [
        {
          description: "Taxed annual licence",
          quantity: 1,
          unitPriceCents: 10_000,
          taxRateId: randomUUID(),
        },
      ],
    }),
  );
  assert.equal(missingTaxRate.status, 400);
  assert.match(missingTaxRate.body.error ?? "", /Unknown tax rate/);

  const invalidCron = await callTool(
    "create_recurring_invoice",
    annualSchedule({ cronExpr: "not a cron expression" }),
  );
  assert.equal(invalidCron.status, 400);

  const mismatchedFrequency = await callTool(
    "create_recurring_invoice",
    annualSchedule({ frequency: "monthly" }),
  );
  assert.equal(mismatchedFrequency.status, 400);

  const nonPositive = await callTool(
    "create_recurring_invoice",
    annualSchedule({
      lines: [{ description: "Free placeholder", quantity: 2, unitPriceCents: 0 }],
    }),
  );
  assert.equal(nonPositive.status, 400);
  assert.match(nonPositive.body.error ?? "", /more than zero|positive/i);

  const invalidSortOrder = await callTool(
    "create_recurring_invoice",
    annualSchedule({
      lines: [
        {
          description: "Annual licence",
          quantity: 1,
          unitPriceCents: 10_000,
          sortOrder: 200,
        },
      ],
    }),
  );
  assert.equal(invalidSortOrder.status, 400);

  assert.equal(await AppDataSource.getRepository(RecurringInvoice).count(), 0);
  assert.equal(await AppDataSource.getRepository(RecurringInvoiceLineItem).count(), 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
});

test("auto-send requires a customer email when it is created, enabled, moved, or resumed", async () => {
  const customerWithoutEmail = await insert(Customer, {
    companyId: company.id,
    name: "No-email customer",
    slug: "no-email-customer",
    email: "",
    currency: "USD",
  });

  const rejectedCreate = await callTool(
    "create_recurring_invoice",
    annualSchedule({ customerSlug: customerWithoutEmail.slug, autoSend: true }),
  );
  assert.equal(rejectedCreate.status, 400);
  assert.match(rejectedCreate.body.error ?? "", /email address/i);

  const draftSchedule = await createAnnualSchedule({
    customerSlug: customerWithoutEmail.slug,
    name: "Draft-only renewal",
  });
  const rejectedEnable = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: draftSchedule.slug,
    autoSend: true,
  });
  assert.equal(rejectedEnable.status, 400);
  assert.match(rejectedEnable.body.error ?? "", /email address/i);

  const automatic = await createAnnualSchedule({ name: "Automatic renewal", autoSend: true });
  const rejectedMove = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: automatic.slug,
    customerSlug: customerWithoutEmail.slug,
  });
  assert.equal(rejectedMove.status, 400);
  assert.match(rejectedMove.body.error ?? "", /email address/i);

  const automaticRow = await AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({
    id: String(automatic.id),
  });
  automaticRow.customerId = customerWithoutEmail.id;
  automaticRow.status = "paused";
  automaticRow.nextRunAt = null;
  await AppDataSource.getRepository(RecurringInvoice).save(automaticRow);
  const rejectedResume = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug: automatic.slug,
    status: "active",
  });
  assert.equal(rejectedResume.status, 400);
  assert.match(rejectedResume.body.error ?? "", /email address/i);
});

test("non-cadence edits preserve the next run and legacy schedules can still be paused", async () => {
  const created = await createAnnualSchedule();
  const recurringInvoiceSlug = String(created.slug);
  const repo = AppDataSource.getRepository(RecurringInvoice);
  const legacy = await repo.findOneByOrFail({ companyId: company.id, slug: recurringInvoiceSlug });
  const preservedNextRunAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  legacy.cronExpr = "0 9 1,15 * *";
  legacy.frequency = "monthly";
  legacy.nextRunAt = preservedNextRunAt;
  await repo.save(legacy);

  const edited = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    notes: "Keep the existing run date.",
  });
  assert.equal(edited.status, 200, edited.body.error);
  assert.equal(
    new Date(String((edited.body.recurringInvoice as Record<string, unknown>).nextRunAt)).getTime(),
    preservedNextRunAt.getTime(),
  );

  const paused = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    status: "paused",
  });
  assert.equal(paused.status, 200, paused.body.error);
  assert.equal((paused.body.recurringInvoice as Record<string, unknown>).status, "paused");
  assert.equal((paused.body.recurringInvoice as Record<string, unknown>).nextRunAt, null);
});

test("update_recurring_invoice pauses, resumes, and ends a schedule terminally", async () => {
  const created = await createAnnualSchedule();
  const recurringInvoiceSlug = String(created.slug);

  const revised = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    name: "Revised annual renewal",
    cronExpr: "30 8 3 9 *",
    frequency: "yearly",
    intervalCount: 2,
    lines: [{ description: "Revised annual licence", quantity: 10, unitPriceCents: 30_000 }],
  });
  assert.equal(revised.status, 200, revised.body.error);
  const revisedSchedule = revised.body.recurringInvoice as Record<string, unknown>;
  assert.equal(revisedSchedule.name, "Revised annual renewal");
  assert.equal(revisedSchedule.cronExpr, "30 8 3 9 *");
  assert.equal(revisedSchedule.intervalCount, 2);
  const revisedLines = revisedSchedule.lines as Array<Record<string, unknown>>;
  assert.equal(revisedLines.length, 1);
  assert.equal(revisedLines[0]?.description, "Revised annual licence");
  assert.equal(revisedLines[0]?.quantity, 10);

  const paused = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    status: "paused",
  });
  assert.equal(paused.status, 200, paused.body.error);
  const pausedSchedule = paused.body.recurringInvoice as Record<string, unknown>;
  assert.equal(pausedSchedule.status, "paused");
  assert.equal(pausedSchedule.nextRunAt, null);

  const resumed = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    status: "active",
  });
  assert.equal(resumed.status, 200, resumed.body.error);
  const resumedSchedule = resumed.body.recurringInvoice as Record<string, unknown>;
  assert.equal(resumedSchedule.status, "active");
  assert.ok(resumedSchedule.nextRunAt);

  const ended = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    status: "ended",
  });
  assert.equal(ended.status, 200, ended.body.error);
  const endedSchedule = ended.body.recurringInvoice as Record<string, unknown>;
  assert.equal(endedSchedule.status, "ended");
  assert.equal(endedSchedule.nextRunAt, null);

  const reactivate = await callTool("update_recurring_invoice", {
    recurringInvoiceSlug,
    status: "active",
  });
  assert.equal(reactivate.status, 409);
  assert.match(reactivate.body.error ?? "", /ended|terminal/i);

  const persisted = await AppDataSource.getRepository(RecurringInvoice).findOneByOrFail({
    companyId: company.id,
    slug: recurringInvoiceSlug,
  });
  assert.equal(persisted.status, "ended");
  assert.equal(persisted.nextRunAt, null);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({
      companyId: company.id,
      action: "finance.recurring_invoice.update",
    }),
    4,
  );
});
