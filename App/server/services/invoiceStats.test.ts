import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { addDays, clockName, dayOf, dayStart } from "../../shared/documentDays.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  applyCustomerCredit,
  createCreditNoteFromInvoice,
  issueCreditNote,
} from "./customerCredits.js";
import {
  createInvoiceDraft,
  issueInvoice,
  setInvoicesArchived,
  voidInvoice,
} from "./finance.js";
import { getFinanceSettings, setHomeCurrency, setRate } from "./fx.js";
import { recordInvoicePayment } from "./invoicePayments.js";
import { invoiceStats } from "./invoiceStats.js";
import { createInvoiceWriteOff } from "./writeOffs.js";

/**
 * Finance → Invoices leads with what customers still owe and how late it is,
 * what came in over the last 30 days, and how long customers take to pay —
 * in the home currency at each document's locked rate, with days read on the
 * company's clock. Every fixture goes through the services the product uses
 * to issue, pay, credit, write off, void and archive an invoice.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** Noon UTC on a Saturday: the same calendar day from UTC-11 to UTC+11. */
const NOW = new Date("2026-10-24T12:00:00.000Z");
const TODAY = "2026-10-24";

let company: Company;
let acme: Customer;
let globex: Customer;
let initech: Customer;

/** A calendar day `offset` days from today, as a document stores it. */
function day(offset: number, from = TODAY): Date {
  return dayStart(addDays(from, offset));
}

async function newCompany(timezone = "UTC"): Promise<Company> {
  return insert(Company, {
    name: "Sunwise",
    slug: `sunwise-${randomUUID().slice(0, 8)}`,
    ownerId: randomUUID(),
    timezone,
  });
}

async function customer(owner: Company, name: string, currency = "USD"): Promise<Customer> {
  return insert(Customer, {
    companyId: owner.id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    email: `billing@${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`,
    currency,
  });
}

beforeEach(async () => {
  company = await newCompany();
  await getFinanceSettings(company.id);
  acme = await customer(company, "Acme Corp");
  globex = await customer(company, "Globex");
  initech = await customer(company, "Initech");
});

type IssueOptions = {
  to?: Customer;
  amountCents: number;
  currency?: string;
  issued?: Date;
  due?: Date;
  taxRateId?: string | null;
  owner?: Company;
};

/** An invoice issued the way Issue does it: numbered, posted, its rate locked. */
async function issued(options: IssueOptions): Promise<Invoice> {
  const owner = options.owner ?? company;
  const draft = await createInvoiceDraft({
    companyId: owner.id,
    customerId: (options.to ?? acme).id,
    issueDate: options.issued ?? day(-10),
    dueDate: options.due ?? day(20),
    currency: options.currency ?? "USD",
    lines: [
      {
        description: "Rooftop survey",
        quantity: 1,
        unitPriceCents: options.amountCents,
        taxRateId: options.taxRateId ?? null,
      },
    ],
  });
  return issueInvoice(draft, null);
}

async function fresh(invoice: Invoice): Promise<Invoice> {
  return AppDataSource.getRepository(Invoice).findOneByOrFail({ id: invoice.id });
}

/** Record a payment the way Record payment does, dated `paidAt`. */
async function pay(invoice: Invoice, amountCents: number, paidAt: Date): Promise<Invoice> {
  const recorded = await recordInvoicePayment(
    await fresh(invoice),
    { amountCents, paidAt, method: "bank_transfer", reference: randomUUID() },
    null,
  );
  return recorded.invoice;
}

async function credit(invoice: Invoice, amountCents: number): Promise<void> {
  const note = await issueCreditNote(
    await createCreditNoteFromInvoice(await fresh(invoice), { mode: "amount", amountCents }, null),
    null,
  );
  await applyCustomerCredit(note, await fresh(invoice), amountCents, null);
}

describe("invoiceStats", () => {
  test("an empty company has nothing to sum up, and says which day and clock it counted on", async () => {
    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.currency, "USD");
    assert.equal(stats.timeZone, "UTC");
    assert.equal(stats.today, TODAY);
    assert.equal(stats.issuedInvoices, 0);
    assert.deepEqual(stats.outstanding, { count: 0, amountCents: 0, ids: [], customers: 0 });
    assert.deepEqual(
      stats.ageing.map((band) => [band.bucket, band.count, band.amountCents]),
      [
        ["current", 0, 0],
        ["1-30", 0, 0],
        ["31-60", 0, 0],
        ["61-90", 0, 0],
        ["90+", 0, 0],
      ],
    );
    assert.deepEqual(stats.overdue, { count: 0, amountCents: 0, ids: [], oldest: null });
    assert.deepEqual(stats.dueSoon, { count: 0, amountCents: 0, ids: [], days: 30 });
    assert.deepEqual(stats.paid, {
      count: 0,
      amountCents: 0,
      ids: [],
      days: 30,
      previousCents: 0,
      previousCount: 0,
    });
    assert.deepEqual(stats.daysToPay, { days: 90, averageDays: null, count: 0, ids: [] });
    assert.equal(stats.largestCustomer, null);
    assert.deepEqual(stats.converted, []);
    assert.deepEqual(stats.unconverted, []);
  });

  test("outstanding is what is still due after partial payments, credit notes and write-offs, tax included", async () => {
    const vat = await insert(TaxRate, { companyId: company.id, name: "VAT", ratePercent: 10 });
    // 1,000 + 10% VAT, 400 of it paid.
    const partlyPaid = await issued({ amountCents: 100_000, taxRateId: vat.id });
    await pay(partlyPaid, 40_000, day(-2));
    // 500 with 200 of credit applied from a credit note.
    const credited = await issued({ to: globex, amountCents: 50_000 });
    await credit(credited, 20_000);
    // 800 with 300 written off as bad debt.
    const writtenOff = await issued({ to: initech, amountCents: 80_000 });
    await createInvoiceWriteOff(
      await fresh(writtenOff),
      { amountCents: 30_000, kind: "bad_debt", writeOffDate: day(-1) },
      null,
    );
    // Paid in full: owes nothing.
    const settled = await issued({ to: globex, amountCents: 25_000 });
    await pay(settled, 25_000, day(-3));

    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.issuedInvoices, 4);
    assert.equal(stats.outstanding.amountCents, 70_000 + 30_000 + 50_000);
    assert.equal(stats.outstanding.count, 3);
    assert.equal(stats.outstanding.customers, 3);
    assert.deepEqual(
      new Set(stats.outstanding.ids),
      new Set([partlyPaid.id, credited.id, writtenOff.id]),
    );
    assert.ok(!stats.outstanding.ids.includes(settled.id), "a paid invoice owes nothing");
    // Not yet due: every penny is current.
    assert.equal(stats.ageing[0].amountCents, 150_000);
    assert.equal(stats.overdue.count, 0);
    assert.equal(stats.dueSoon.amountCents, 150_000);
    // Cash that came in, not credit or write-offs.
    assert.equal(stats.paid.amountCents, 40_000 + 25_000);
    assert.deepEqual(new Set(stats.paid.ids), new Set([partlyPaid.id, settled.id]));
  });

  test("drafts and voided invoices count nowhere; archived ones only for the cash they brought in", async () => {
    await createInvoiceDraft({
      companyId: company.id,
      customerId: acme.id,
      issueDate: day(-5),
      dueDate: day(-1),
      lines: [{ description: "Not sent yet", quantity: 1, unitPriceCents: 99_000 }],
    });
    const voided = await issued({ amountCents: 70_000, due: day(-40) });
    await voidInvoice(await fresh(voided), null);
    const filed = await issued({ to: globex, amountCents: 30_000, issued: day(-20), due: day(-5) });
    await pay(filed, 30_000, day(-4));
    const outcome = await setInvoicesArchived(company.id, [filed.id], "archive");
    assert.deepEqual(
      outcome.changed.map((invoice) => invoice.id),
      [filed.id],
    );
    const owed = await issued({ to: initech, amountCents: 12_000 });

    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.issuedInvoices, 2, "the archived invoice was issued; the void and the draft weren't");
    assert.deepEqual(stats.outstanding.ids, [owed.id]);
    assert.equal(stats.overdue.count, 0, "neither the draft past its due date nor the void is overdue");
    assert.deepEqual(stats.paid.ids, [filed.id], "cash an archived invoice brought in still came in");
    assert.equal(stats.paid.amountCents, 30_000);
    assert.deepEqual(stats.daysToPay.ids, [filed.id]);
    assert.equal(stats.daysToPay.averageDays, 16);
  });

  test("overdue counts from the day after the due date, and the ageing bands split at 30, 60 and 90 days", async () => {
    const dueOn = async (offset: number) =>
      issued({ amountCents: 10_000 + Math.abs(offset), issued: day(offset - 30), due: day(offset) });
    const dueToday = await dueOn(0);
    const late1 = await dueOn(-1);
    const late30 = await dueOn(-30);
    const late31 = await dueOn(-31);
    const late60 = await dueOn(-60);
    const late61 = await dueOn(-61);
    const late90 = await dueOn(-90);
    const late91 = await dueOn(-91);

    const stats = await invoiceStats(company.id, NOW);
    const band = (bucket: string) => stats.ageing.find((row) => row.bucket === bucket)!;
    assert.deepEqual(band("current").ids, [dueToday.id], "due today is not overdue yet");
    assert.deepEqual(band("1-30").ids, [late30.id, late1.id]);
    assert.deepEqual(band("31-60").ids, [late60.id, late31.id]);
    assert.deepEqual(band("61-90").ids, [late90.id, late61.id]);
    assert.deepEqual(band("90+").ids, [late91.id]);
    assert.equal(stats.overdue.count, 7);
    assert.deepEqual(stats.overdue.ids, [
      late91.id,
      late90.id,
      late61.id,
      late60.id,
      late31.id,
      late30.id,
      late1.id,
    ]);
    assert.deepEqual(stats.overdue.oldest, {
      id: late91.id,
      number: late91.number,
      slug: late91.slug,
      daysLate: 91,
    });
    assert.equal(
      stats.overdue.amountCents,
      [1, 30, 31, 60, 61, 90, 91].reduce((sum, offset) => sum + 10_000 + offset, 0),
    );
    assert.equal(
      stats.ageing.reduce((sum, row) => sum + row.amountCents, 0),
      stats.outstanding.amountCents,
      "the bands add up to what is outstanding",
    );
  });

  test("due in the next 30 days runs from today through the 30th day", async () => {
    const today = await issued({ amountCents: 1_000, due: day(0) });
    const day30 = await issued({ amountCents: 2_000, due: day(30) });
    await issued({ amountCents: 4_000, due: day(31) });
    await issued({ amountCents: 8_000, issued: day(-40), due: day(-1) });

    const stats = await invoiceStats(company.id, NOW);
    assert.deepEqual(stats.dueSoon.ids, [today.id, day30.id]);
    assert.equal(stats.dueSoon.amountCents, 3_000);
    assert.equal(stats.ageing[0].amountCents, 7_000, "due on day 31 is current but not due soon");
  });

  test("the company's time zone decides what today is, for due dates and payments alike", async () => {
    // 20:00 UTC: already the 25th in Singapore, still the 24th in California.
    const evening = new Date("2026-10-24T20:00:00.000Z");
    const due24 = await issued({ amountCents: 50_000, issued: day(-30), due: day(0) });
    const early = await issued({ to: globex, amountCents: 9_000, issued: day(-60), due: day(-50) });
    // The 25th of September: 29 days before the 24th, 30 before the 25th.
    await pay(early, 9_000, dayStart("2026-09-25"));

    await AppDataSource.getRepository(Company).update(company.id, { timezone: "Asia/Singapore" });
    const singapore = await invoiceStats(company.id, evening);
    assert.equal(singapore.today, "2026-10-25");
    assert.equal(singapore.timeZone, "Asia/Singapore");
    assert.deepEqual(singapore.overdue.ids, [due24.id]);
    assert.equal(singapore.overdue.oldest?.daysLate, 1);
    assert.deepEqual(singapore.dueSoon.ids, []);
    assert.equal(singapore.paid.amountCents, 0, "the 25th of September is outside the last 30 days");
    assert.equal(singapore.paid.previousCents, 9_000);

    await AppDataSource.getRepository(Company).update(company.id, {
      timezone: "America/Los_Angeles",
    });
    const california = await invoiceStats(company.id, evening);
    assert.equal(california.today, "2026-10-24");
    assert.deepEqual(california.overdue.ids, []);
    assert.deepEqual(california.dueSoon.ids, [due24.id], "due today, so not overdue yet");
    assert.equal(california.paid.amountCents, 9_000);
    assert.deepEqual(california.paid.ids, [early.id]);

    // No zone: the server's own clock, named so the page can say which.
    await AppDataSource.getRepository(Company).update(company.id, { timezone: "" });
    const server = await invoiceStats(company.id, evening);
    assert.equal(server.today, dayOf(evening));
    assert.equal(server.timeZone, clockName(""));
  });

  test("every amount is in the home currency at the rate each invoice and payment locked", async () => {
    await setRate(company.id, "EUR", "USD", dayStart("2026-08-01"), 1.1, "manual");
    await setRate(company.id, "GBP", "USD", dayStart("2026-08-01"), 1.3, "manual");
    const euro = await issued({
      amountCents: 100_000,
      currency: "EUR",
      issued: dayStart("2026-09-01"),
      due: day(-10),
    });
    assert.equal((await fresh(euro)).exchangeRate, 1.1, "issuing locked the rate on file");
    const sterling = await issued({ to: globex, amountCents: 30_000, currency: "GBP" });
    assert.equal((await fresh(sterling)).exchangeRate, 1.3);
    // The euro moves after the invoice was issued; a payment locks its own day's rate.
    await setRate(company.id, "EUR", "USD", dayStart("2026-10-01"), 1.2, "manual");
    await pay(euro, 40_000, dayStart("2026-10-10"));
    const payment = await AppDataSource.getRepository(InvoicePayment).findOneByOrFail({
      invoiceId: euro.id,
    });
    assert.equal(payment.exchangeRate, 1.2);
    const local = await issued({ to: initech, amountCents: 10_000 });

    const stats = await invoiceStats(company.id, NOW);
    // 600 EUR still due at the 1.10 it was booked at, not today's 1.20.
    const euroDue = 66_000;
    const sterlingDue = 39_000;
    assert.equal(stats.outstanding.amountCents, euroDue + sterlingDue + 10_000);
    assert.equal(stats.overdue.amountCents, euroDue);
    assert.deepEqual(stats.overdue.ids, [euro.id]);
    // The cash came in at the 1.20 of the day it was paid.
    assert.equal(stats.paid.amountCents, 48_000);
    assert.deepEqual(stats.converted, ["EUR", "GBP"]);
    assert.deepEqual(stats.unconverted, []);
    assert.deepEqual(stats.largestCustomer && {
      id: stats.largestCustomer.id,
      amountCents: stats.largestCustomer.amountCents,
    }, { id: acme.id, amountCents: euroDue });
    assert.ok(stats.outstanding.ids.includes(local.id));
  });

  test("a home currency other than USD converts the other way, through the inverse rate", async () => {
    await setHomeCurrency(company.id, "EUR");
    await setRate(company.id, "EUR", "USD", dayStart("2026-08-01"), 1.25, "manual");
    const dollars = await issued({ amountCents: 50_000, currency: "USD" });

    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.currency, "EUR");
    assert.equal((await fresh(dollars)).exchangeRate, 0.8);
    assert.equal(stats.outstanding.amountCents, 40_000);
    assert.deepEqual(stats.converted, ["USD"]);
  });

  test("an invoice or payment from before rates were locked reads its rate the way the books do", async () => {
    await setRate(company.id, "EUR", "USD", dayStart("2026-08-01"), 1.1, "manual");
    const legacy = await issued({
      amountCents: 100_000,
      currency: "EUR",
      issued: dayStart("2026-09-01"),
      due: day(5),
    });
    await pay(legacy, 50_000, dayStart("2026-10-12"));
    // As it was before #115: no locked rates on the invoice or the payment, and
    // a rate typed in since for the issue date that the books never used.
    await AppDataSource.getRepository(Invoice).update(legacy.id, { exchangeRate: null });
    await AppDataSource.getRepository(InvoicePayment).update(
      { invoiceId: legacy.id },
      { exchangeRate: null },
    );
    await setRate(company.id, "EUR", "USD", dayStart("2026-09-01"), 1.5, "manual");
    await setRate(company.id, "EUR", "USD", dayStart("2026-10-12"), 1.4, "manual");

    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.outstanding.amountCents, 55_000, "500 EUR at the 1.10 its issue entry used");
    assert.equal(stats.paid.amountCents, 70_000, "500 EUR at the 1.40 on file for the day it was paid");
  });

  test("a currency no rate can be found for is left out of every figure and named", async () => {
    const owed = await issued({ amountCents: 20_000 });
    // An invoice from before rates were locked, in a currency with no rate at
    // all and no issue entry to read one from.
    const stranded = await insert(Invoice, {
      companyId: company.id,
      customerId: globex.id,
      slug: "globex-inv-0099",
      numberSeq: 99,
      number: "GLOBEX-INV-0099",
      status: "sent",
      issueDate: day(-40),
      dueDate: day(-10),
      currency: "XYZ",
      exchangeRate: null,
      subtotalCents: 70_000,
      totalCents: 70_000,
      balanceCents: 70_000,
    });

    const stats = await invoiceStats(company.id, NOW);
    assert.deepEqual(stats.outstanding.ids, [owed.id]);
    assert.equal(stats.overdue.count, 0, "the stranded invoice is overdue, but uncounted");
    assert.equal(stats.largestCustomer?.id, acme.id);
    assert.deepEqual(stats.unconverted, [{ currency: "XYZ", invoices: 1 }]);
    assert.ok(!stats.outstanding.ids.includes(stranded.id));
  });

  test("paid in the last 30 days counts the cash dated in them, against the 30 days before", async () => {
    const big = await issued({ amountCents: 500_000, issued: day(-80), due: day(10) });
    await pay(big, 1_000, day(0));
    await pay(big, 2_000, day(-29));
    await pay(big, 4_000, day(-30));
    await pay(big, 8_000, day(-59));
    await pay(big, 16_000, day(-60));
    await pay(big, 32_000, day(1));
    const other = await issued({ to: globex, amountCents: 50_000, issued: day(-50), due: day(10) });
    await pay(other, 50_000, day(-45));

    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.paid.amountCents, 3_000, "today and 29 days ago; a payment dated tomorrow isn't in yet");
    assert.deepEqual(stats.paid.ids, [big.id]);
    assert.equal(stats.paid.count, 1);
    assert.equal(stats.paid.previousCents, 4_000 + 8_000 + 50_000);
    assert.equal(stats.paid.previousCount, 2);
  });

  test("average days to pay runs from the issue date to the last payment of invoices paid in full in the last 90 days", async () => {
    // Paid in two parts, the last 25 days after issue.
    const twoParts = await issued({ amountCents: 100_000, issued: day(-40), due: day(-10) });
    await pay(twoParts, 30_000, day(-30));
    await pay(twoParts, 70_000, day(-15));
    // Paid in full five days after issue.
    const quick = await issued({ to: globex, amountCents: 20_000, issued: day(-10), due: day(4) });
    await pay(quick, 20_000, day(-5));
    // Paid before it was dated: the same day, not minus three.
    const early = await issued({ to: initech, amountCents: 5_000, issued: day(-6), due: day(8) });
    await pay(early, 5_000, day(-9));
    // Only partly paid, cleared only by credit, or paid in full too long ago.
    const partial = await issued({ amountCents: 40_000, issued: day(-20), due: day(10) });
    await pay(partial, 10_000, day(-3));
    const creditOnly = await issued({ to: globex, amountCents: 15_000, issued: day(-20) });
    await credit(creditOnly, 15_000);
    const longAgo = await issued({ amountCents: 9_000, issued: day(-130), due: day(-100) });
    await pay(longAgo, 9_000, day(-95));

    const stats = await invoiceStats(company.id, NOW);
    assert.deepEqual(stats.daysToPay.ids, [twoParts.id, early.id, quick.id]);
    assert.equal(stats.daysToPay.count, 3);
    assert.equal(stats.daysToPay.averageDays, 10, "(25 + 0 + 5) / 3");
  });

  test("the largest customer owes the most of what is outstanding, a tie going to the name first", async () => {
    await issued({ to: globex, amountCents: 30_000 });
    await issued({ to: acme, amountCents: 30_000 });
    const initechOwes = await issued({ to: initech, amountCents: 10_000 });

    const tie = await invoiceStats(company.id, NOW);
    assert.equal(tie.largestCustomer?.name, "Acme Corp");
    assert.equal(tie.largestCustomer?.slug, "acme-corp");
    assert.equal(tie.largestCustomer?.amountCents, 30_000);

    const more = await issued({ to: initech, amountCents: 25_000 });
    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.largestCustomer?.id, initech.id);
    assert.deepEqual(stats.largestCustomer?.ids, [initechOwes.id, more.id]);
    assert.equal(stats.largestCustomer?.count, 2);
    assert.equal(stats.largestCustomer?.amountCents, 35_000);
    assert.equal(stats.outstanding.customers, 3);
  });

  test("another company's invoices never count", async () => {
    const other = await newCompany();
    await getFinanceSettings(other.id);
    const stranger = await customer(other, "Stranger Things");
    const theirs = await issued({ owner: other, to: stranger, amountCents: 77_000, due: day(-3) });
    await pay(theirs, 1_000, day(-1));
    const ours = await issued({ amountCents: 5_000 });

    const stats = await invoiceStats(company.id, NOW);
    assert.equal(stats.issuedInvoices, 1);
    assert.deepEqual(stats.outstanding.ids, [ours.id]);
    assert.equal(stats.paid.amountCents, 0);
    const theirStats = await invoiceStats(other.id, NOW);
    assert.deepEqual(theirStats.outstanding.ids, [theirs.id]);
    assert.equal(theirStats.paid.amountCents, 1_000);
  });
});
