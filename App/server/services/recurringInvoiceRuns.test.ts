import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { RecurringInvoiceRun } from "../db/entities/RecurringInvoiceRun.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  hydrateRecurringInvoices,
  processRecurringInvoiceRun,
  runRecurringInvoiceTick,
} from "./recurringInvoices.js";
import { SchedulerLeaseLostError } from "./schedulerLeases.js";
import { createSubsidiary, updateSubsidiary } from "./subsidiaries.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const HOUR_MS = 60 * 60 * 1000;

const runs = () => AppDataSource.getRepository(RecurringInvoiceRun);
const invoices = () => AppDataSource.getRepository(Invoice);
const schedules = () => AppDataSource.getRepository(RecurringInvoice);

/** An active monthly schedule whose slot came due an hour ago. The customer
 *  has no email, so an auto-send run fails at the email step. */
async function dueSchedule(overrides: Partial<RecurringInvoice> = {}, companyId = testCompanyId()) {
  const customer = await insert(Customer, { companyId, name: "Acme", slug: "acme", email: "" });
  const schedule = await insert(RecurringInvoice, {
    companyId,
    customerId: customer.id,
    slug: "monthly",
    name: "Monthly retainer",
    cronExpr: "0 9 1 * *",
    status: "active",
    autoSend: false,
    nextRunAt: new Date(Date.now() - HOUR_MS),
    ...overrides,
  });
  await insert(RecurringInvoiceLineItem, {
    recurringInvoiceId: schedule.id,
    description: "Retainer",
    quantity: 1,
    unitPriceCents: 250_000,
  });
  return { companyId, customer, schedule };
}

test("a due slot is billed exactly once, however many passes see it", async () => {
  const { schedule } = await dueSchedule();
  const slot = schedule.nextRunAt!;
  await runRecurringInvoiceTick();
  await runRecurringInvoiceTick();

  const all = await runs().find();
  assert.equal(all.length, 1);
  const [run] = all;
  assert.equal(run.status, "succeeded");
  assert.equal(run.scheduledFor.getTime(), slot.getTime());
  assert.equal(await invoices().count(), 1);
  const invoice = await invoices().findOneByOrFail({ id: run.invoiceId! });
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.totalCents, 250_000);
  assert.equal(
    await AppDataSource.getRepository(InvoiceLineItem).count({ where: { invoiceId: invoice.id } }),
    1,
  );

  const fresh = await schedules().findOneByOrFail({ id: schedule.id });
  assert.equal(fresh.runsCreated, 1);
  assert.equal(fresh.lastInvoiceSlug, invoice.slug);
  assert.ok(fresh.nextRunAt && fresh.nextRunAt.getTime() > Date.now());
});

test("an interrupted run resumes its own invoice instead of billing again", async () => {
  const { companyId, schedule } = await dueSchedule({ autoSend: true });
  const first = await insert(RecurringInvoiceRun, {
    companyId,
    recurringInvoiceId: schedule.id,
    scheduledFor: schedule.nextRunAt!,
    status: "pending",
  });

  // Lose the worker after the draft is saved but before it is issued.
  let checks = 0;
  await assert.rejects(
    processRecurringInvoiceRun(first.id, {
      assertLeaseHeld: () => {
        checks += 1;
        if (checks === 2) throw new SchedulerLeaseLostError("recurring-invoices");
      },
    }),
    SchedulerLeaseLostError,
  );
  const interrupted = await runs().findOneByOrFail({ id: first.id });
  assert.equal(interrupted.status, "pending");
  assert.equal(interrupted.lockedUntil, null, "the hold is handed back for the next worker");
  assert.ok(interrupted.invoiceId);
  assert.equal((await invoices().findOneByOrFail({ id: interrupted.invoiceId! })).status, "draft");

  // The next pass picks the same invoice up and issues it.
  await runRecurringInvoiceTick();
  const resumed = await runs().findOneByOrFail({ id: first.id });
  assert.equal(resumed.invoiceId, interrupted.invoiceId);
  assert.equal(await invoices().count(), 1);
  const invoice = await invoices().findOneByOrFail({ id: resumed.invoiceId! });
  assert.equal(invoice.status, "sent");
  assert.ok(invoice.number);
  assert.equal(resumed.status, "pending", "the email step is still retrying");
  assert.equal(resumed.emailAttempts, 1);
  assert.match(resumed.lastError, /no email address/);
  assert.equal((await schedules().findOneByOrFail({ id: schedule.id })).runsCreated, 0);
});

test("a run held by a live worker is left alone; a lapsed hold is taken over", async () => {
  const { companyId, schedule } = await dueSchedule();
  const run = await insert(RecurringInvoiceRun, {
    companyId,
    recurringInvoiceId: schedule.id,
    scheduledFor: schedule.nextRunAt!,
    status: "pending",
    lockedUntil: new Date(Date.now() + 60_000),
  });
  assert.equal(await processRecurringInvoiceRun(run.id, { ignoreBackoff: true }), null);
  assert.equal(await invoices().count(), 0);

  await runs().update({ id: run.id }, { lockedUntil: new Date(Date.now() - 1_000) });
  const result = await processRecurringInvoiceRun(run.id);
  assert.equal(result?.run.status, "succeeded");
  assert.equal(await invoices().count(), 1);
});

test("a failed step backs off, holds the next slot, and bills once the cause is fixed", async () => {
  const companyId = testCompanyId();
  const subsidiary = await createSubsidiary(companyId, { name: "Example UK Ltd" });
  await updateSubsidiary(companyId, subsidiary.id, { archived: true });
  const { schedule } = await dueSchedule({ subsidiaryId: subsidiary.id }, companyId);

  await runRecurringInvoiceTick();
  const [run] = await runs().find();
  assert.equal(run.status, "pending");
  assert.equal(run.attempts, 1);
  assert.match(run.lastError, /Archived subsidiaries/);
  assert.ok(run.retryAt && run.retryAt.getTime() > Date.now());
  assert.equal(await invoices().count(), 0);

  // The next slot comes due while the first is still retrying: it waits,
  // and the backoff keeps the failing run from being hammered.
  await schedules().update({ id: schedule.id }, { nextRunAt: new Date(Date.now() - 1_000) });
  await runRecurringInvoiceTick();
  assert.equal(await runs().count(), 1);
  assert.equal((await runs().findOneByOrFail({ id: run.id })).attempts, 1);

  await updateSubsidiary(companyId, subsidiary.id, { archived: false });
  const result = await processRecurringInvoiceRun(run.id, { ignoreBackoff: true });
  assert.equal(result?.run.status, "succeeded");
  assert.equal(result?.run.lastError, "");
  assert.equal(await invoices().count(), 1);
});

test("email failures retry a bounded number of times, then leave the issued invoice", async () => {
  const { schedule } = await dueSchedule({ autoSend: true });
  await runRecurringInvoiceTick();
  const [run] = await runs().find();
  assert.equal(run.status, "pending");
  assert.equal(run.emailAttempts, 1);
  const issued = await invoices().findOneByOrFail({ id: run.invoiceId! });
  assert.equal(issued.status, "sent");

  for (let attempt = 2; attempt <= 6; attempt += 1) {
    await processRecurringInvoiceRun(run.id, { ignoreBackoff: true });
  }
  const failed = await runs().findOneByOrFail({ id: run.id });
  assert.equal(failed.status, "failed");
  assert.equal(failed.emailAttempts, 6);
  assert.match(
    failed.lastError,
    new RegExp(`Invoice ${issued.number} was issued, but emailing it failed 6 times`),
  );
  assert.equal(await invoices().count(), 1);
  const invoice = await invoices().findOneByOrFail({ id: run.invoiceId! });
  assert.equal(invoice.number, issued.number, "retries never re-issue");

  const fresh = await schedules().findOneByOrFail({ id: schedule.id });
  assert.equal(fresh.runsCreated, 1);
  assert.equal(fresh.lastInvoiceSlug, invoice.slug);
});

test("pausing a schedule stops its unfinished run", async () => {
  const companyId = testCompanyId();
  const subsidiary = await createSubsidiary(companyId, { name: "Example UK Ltd" });
  await updateSubsidiary(companyId, subsidiary.id, { archived: true });
  const { schedule } = await dueSchedule({ subsidiaryId: subsidiary.id }, companyId);
  await runRecurringInvoiceTick();
  const [run] = await runs().find();
  assert.equal(run.status, "pending");

  await schedules().update({ id: schedule.id }, { status: "paused", nextRunAt: null });
  await updateSubsidiary(companyId, subsidiary.id, { archived: false });
  const result = await processRecurringInvoiceRun(run.id, { ignoreBackoff: true });
  assert.equal(result?.run.status, "cancelled");
  assert.match(result?.run.lastError ?? "", /paused/);
  assert.equal(await invoices().count(), 0);
});

test("hydration reports the tax-inclusive total and the latest run", async () => {
  const companyId = testCompanyId();
  const vat = await insert(TaxRate, { companyId, name: "VAT", ratePercent: 20, inclusive: false });
  const { schedule } = await dueSchedule({}, companyId);
  await AppDataSource.getRepository(RecurringInvoiceLineItem).update(
    { recurringInvoiceId: schedule.id },
    { taxRateId: vat.id },
  );
  await insert(RecurringInvoiceRun, {
    companyId,
    recurringInvoiceId: schedule.id,
    scheduledFor: new Date(Date.now() - 40 * 24 * HOUR_MS),
    status: "failed",
    lastError: "An older run",
  });
  await runRecurringInvoiceTick();

  const [hydrated] = await hydrateRecurringInvoices(companyId, [
    await schedules().findOneByOrFail({ id: schedule.id }),
  ]);
  assert.equal(hydrated.totalCents, 300_000);
  assert.equal(hydrated.latestRun?.status, "succeeded");
  const invoice = await invoices().findOneOrFail({ where: { companyId } });
  assert.equal(invoice.totalCents, 300_000);
  assert.equal(hydrated.latestRun?.invoiceSlug, invoice.slug);
});
