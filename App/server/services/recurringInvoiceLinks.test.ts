import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { RecurringInvoiceRun } from "../db/entities/RecurringInvoiceRun.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { duplicateInvoice, hydrateInvoices, issueInvoice } from "./finance.js";
import {
  deleteRecurringInvoice,
  generateInvoiceFromRecurring,
  runRecurringInvoiceTick,
} from "./recurringInvoices.js";

/**
 * Every invoice a recurring invoice schedule creates names the schedule, so
 * the schedule's page can list them and each invoice can link back to it.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const HOUR_MS = 60 * 60 * 1000;

const invoices = () => AppDataSource.getRepository(Invoice);
const schedules = () => AppDataSource.getRepository(RecurringInvoice);

/** An active, draft-only monthly schedule whose slot came due an hour ago. */
async function dueSchedule(companyId: string, slug = "monthly", customerSlug = "acme") {
  const customer = await insert(Customer, {
    companyId,
    name: `Customer ${customerSlug}`,
    slug: customerSlug,
    email: "",
  });
  const schedule = await insert(RecurringInvoice, {
    companyId,
    customerId: customer.id,
    slug,
    name: "Monthly retainer",
    cronExpr: "0 9 1 * *",
    status: "active",
    autoSend: false,
    nextRunAt: new Date(Date.now() - HOUR_MS),
  });
  await insert(RecurringInvoiceLineItem, {
    recurringInvoiceId: schedule.id,
    description: "Retainer",
    quantity: 1,
    unitPriceCents: 250_000,
  });
  return { customer, schedule };
}

/** Bring a schedule's next slot due again, then run one heartbeat pass. */
async function runAgain(schedule: RecurringInvoice): Promise<void> {
  await schedules().update({ id: schedule.id }, { nextRunAt: new Date(Date.now() - 1_000) });
  await runRecurringInvoiceTick();
}

test("scheduled runs and Run now both name the schedule on the invoice; a duplicate does not", async () => {
  const companyId = testCompanyId();
  const { customer, schedule } = await dueSchedule(companyId);

  await runRecurringInvoiceTick();
  const [scheduled] = await invoices().find();
  assert.equal(scheduled.recurringInvoiceId, schedule.id);

  const { invoice: manual } = await generateInvoiceFromRecurring(schedule, null);
  assert.equal(manual.recurringInvoiceId, schedule.id);
  assert.equal(
    (await invoices().findOneByOrFail({ id: manual.id })).recurringInvoiceId,
    schedule.id,
  );

  const copy = await invoices().findOneByOrFail({
    id: (await duplicateInvoice(scheduled, null)).id,
  });
  assert.equal(copy.recurringInvoiceId, null, "a duplicate is made by hand");
  const byHand = await insert(Invoice, {
    companyId,
    customerId: customer.id,
    slug: "draft-byhand",
    issueDate: new Date(),
    dueDate: new Date(),
  });

  const hydrated = await hydrateInvoices(companyId, [scheduled, manual, copy, byHand]);
  const stub = { id: schedule.id, name: "Monthly retainer", slug: "monthly" };
  assert.deepEqual(
    hydrated.map((invoice) => invoice.recurringInvoice),
    [stub, stub, null, null],
  );
});

test("a schedule in another company is never hydrated onto an invoice", async () => {
  const companyId = testCompanyId();
  const { schedule } = await dueSchedule(companyId);
  await runRecurringInvoiceTick();
  const [invoice] = await invoices().find();
  const [elsewhere] = await hydrateInvoices(testCompanyId(), [invoice]);
  assert.equal(elsewhere.recurringInvoice, null);
  assert.equal(invoice.recurringInvoiceId, schedule.id);
});

test("issuing the schedule's last draft moves its pointer to the issued slug", async () => {
  const companyId = testCompanyId();
  const { schedule } = await dueSchedule(companyId);
  await runRecurringInvoiceTick();
  const first = await invoices().findOneOrFail({ where: { companyId } });
  await runAgain(schedule);
  const second = await invoices().findOneOrFail({ where: { companyId, id: Not(first.id) } });
  assert.equal((await schedules().findOneByOrFail({ id: schedule.id })).lastInvoiceSlug, second.slug);

  // An older draft is not the one the schedule points at. (Issuing renames
  // the invoice it is handed, so the draft slugs are read first.)
  const firstDraftSlug = first.slug;
  const issuedFirst = await issueInvoice(first, null);
  assert.notEqual(issuedFirst.slug, firstDraftSlug);
  assert.equal((await schedules().findOneByOrFail({ id: schedule.id })).lastInvoiceSlug, second.slug);

  const draftSlug = second.slug;
  const issuedSecond = await issueInvoice(second, null);
  assert.notEqual(issuedSecond.slug, draftSlug);
  assert.equal(
    (await schedules().findOneByOrFail({ id: schedule.id })).lastInvoiceSlug,
    issuedSecond.slug,
    "the schedule's last invoice still opens after it is issued",
  );
});

test("deleting a schedule keeps its invoices and clears only their link", async () => {
  const companyId = testCompanyId();
  const { schedule } = await dueSchedule(companyId);
  const { schedule: other } = await dueSchedule(companyId, "weekly", "beta");
  await runRecurringInvoiceTick();
  assert.equal(await invoices().count(), 2);

  await deleteRecurringInvoice(schedule);

  assert.equal(await schedules().countBy({ id: schedule.id }), 0);
  assert.equal(
    await AppDataSource.getRepository(RecurringInvoiceLineItem).countBy({
      recurringInvoiceId: schedule.id,
    }),
    0,
  );
  assert.equal(
    await AppDataSource.getRepository(RecurringInvoiceRun).countBy({
      recurringInvoiceId: schedule.id,
    }),
    0,
  );
  assert.equal(await invoices().count(), 2, "the invoices it created stay in the books");
  assert.equal(await invoices().countBy({ recurringInvoiceId: IsNull() }), 1);
  assert.equal(
    await invoices().countBy({ recurringInvoiceId: other.id }),
    1,
    "the other schedule's invoice keeps its link",
  );
});
