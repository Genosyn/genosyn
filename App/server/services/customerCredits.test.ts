import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { CustomerCreditApplication } from "../db/entities/CustomerCreditApplication.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { displayStatus } from "./finance.js";
import {
  applyCustomerCredit,
  createCreditNoteFromInvoice,
  creditOpenCents,
  issueCreditNote,
  unapplyCustomerCredit,
  voidCreditNote,
} from "./customerCredits.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_credits";

async function makeSentInvoice(sub: number, tax = 0, slug = "inv"): Promise<Invoice> {
  await seedChartOfAccounts(CO);
  const total = sub + tax;
  const inv = await insert(Invoice, {
    companyId: CO,
    customerId: "cust_1",
    slug: `${slug}-${sub}-${tax}`,
    numberSeq: 1,
    number: "INV-0001",
    status: "sent",
    issueDate: new Date("2026-01-10T00:00:00Z"),
    dueDate: new Date("2026-02-10T00:00:00Z"),
    currency: "USD",
    subtotalCents: sub,
    taxCents: tax,
    totalCents: total,
    paidCents: 0,
    creditedCents: 0,
    writtenOffCents: 0,
    balanceCents: total,
    notes: "",
    footer: "",
  });
  await insert(InvoiceLineItem, {
    invoiceId: inv.id,
    description: "Consulting",
    quantity: 1,
    unitPriceCents: total,
    taxRateId: null,
    taxName: tax > 0 ? "Sales tax" : "",
    taxPercent: 0,
    taxInclusive: false,
    lineSubtotalCents: sub,
    lineTaxCents: tax,
    lineTotalCents: total,
    sortOrder: 0,
  });
  return inv;
}

async function linesFor(source: string): Promise<LedgerLine[]> {
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    companyId: CO,
    source: source as LedgerEntry["source"],
  });
  assert.ok(entry, `expected a ${source} entry`);
  return AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry!.id } });
}

function balanced(lines: LedgerLine[]) {
  assert.equal(
    lines.reduce((s, l) => s + l.debitCents, 0),
    lines.reduce((s, l) => s + l.creditCents, 0),
  );
}

describe("issueCreditNote", () => {
  test("full credit posts DR 4100 + DR 2100 / CR 2400 and relieves tax", async () => {
    const inv = await makeSentInvoice(10000, 800);
    const draft = await createCreditNoteFromInvoice(inv, { mode: "full" }, "u1");
    const credit = await issueCreditNote(draft, "u1");

    assert.equal(credit.status, "issued");
    assert.match(credit.number, /CN-0001$/);
    assert.equal(credit.totalCents, 10800);
    assert.equal(credit.homeTotalCents, 10800);

    const returns = await accountByCode(CO, "4100");
    const taxAcct = await accountByCode(CO, "2100");
    const credits = await accountByCode(CO, "2400");
    const lines = await linesFor("credit_note_issue");
    balanced(lines);
    assert.equal(lines.find((l) => l.accountId === returns!.id)!.debitCents, 10000);
    assert.equal(lines.find((l) => l.accountId === taxAcct!.id)!.debitCents, 800);
    assert.equal(lines.find((l) => l.accountId === credits!.id)!.creditCents, 10800);
  });

  test("cumulative cap: a second full credit on the same invoice is refused", async () => {
    const inv = await makeSentInvoice(10000, 0);
    const d1 = await createCreditNoteFromInvoice(inv, { mode: "full" }, null);
    await issueCreditNote(d1, null);
    const d2 = await createCreditNoteFromInvoice(inv, { mode: "full" }, null);
    await assert.rejects(() => issueCreditNote(d2, null), /would exceed the invoice/);
  });
});

describe("applyCustomerCredit", () => {
  test("relieves AR, settles the invoice, and shows 'credited'", async () => {
    const inv = await makeSentInvoice(10000, 0);
    const credit = await issueCreditNote(
      await createCreditNoteFromInvoice(inv, { mode: "full" }, null),
      null,
    );
    await applyCustomerCredit(credit, inv, 10000, null);

    const ar = await accountByCode(CO, "1200");
    const credits = await accountByCode(CO, "2400");
    const lines = await linesFor("credit_note_apply");
    balanced(lines);
    assert.equal(lines.find((l) => l.accountId === credits!.id)!.debitCents, 10000);
    assert.equal(lines.find((l) => l.accountId === ar!.id)!.creditCents, 10000);

    const freshInv = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(freshInv!.creditedCents, 10000);
    assert.equal(freshInv!.balanceCents, 0);
    assert.equal(freshInv!.paidCents, 0);
    assert.equal(displayStatus(freshInv!), "credited");
  });

  test("caps at min(credit open, invoice balance)", async () => {
    const inv = await makeSentInvoice(5000, 0);
    // Credit is for a bigger invoice, then applied to this smaller one.
    const bigInv = await makeSentInvoice(20000, 0, "big");
    const credit = await issueCreditNote(
      await createCreditNoteFromInvoice(bigInv, { mode: "full" }, null),
      null,
    );
    await assert.rejects(() => applyCustomerCredit(credit, inv, 6000, null), /exceeds the room/);
    // Exactly the invoice balance is fine, and leaves the credit partly open.
    await applyCustomerCredit(credit, inv, 5000, null);
    const fresh = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(fresh!.balanceCents, 0);
  });
});

describe("unapply + void", () => {
  test("unapply puts AR and credit back", async () => {
    const inv = await makeSentInvoice(10000, 0);
    const credit = await issueCreditNote(
      await createCreditNoteFromInvoice(inv, { mode: "full" }, null),
      null,
    );
    const app = await applyCustomerCredit(credit, inv, 4000, null);
    await unapplyCustomerCredit(app, null);

    const reversal = await linesFor("credit_note_unapply");
    const ar = await accountByCode(CO, "1200");
    balanced(reversal);
    assert.equal(reversal.find((l) => l.accountId === ar!.id)!.debitCents, 4000);

    const freshInv = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(freshInv!.creditedCents, 0);
    assert.equal(freshInv!.balanceCents, 10000);
    const freshApp = await AppDataSource.getRepository(CustomerCreditApplication).findOneBy({ id: app.id });
    assert.ok(freshApp!.reversedAt);
  });

  test("void is refused while applied, allowed once fully open", async () => {
    const inv = await makeSentInvoice(10000, 0);
    const credit = await issueCreditNote(
      await createCreditNoteFromInvoice(inv, { mode: "full" }, null),
      null,
    );
    const app = await applyCustomerCredit(credit, inv, 10000, null);
    await assert.rejects(() => voidCreditNote(credit, null), /Unapply/);
    await unapplyCustomerCredit(app, null);
    const reopened = (await AppDataSource.getRepository(
      (await import("../db/entities/CustomerCredit.js")).CustomerCredit,
    ).findOneBy({ id: credit.id }))!;
    assert.equal(creditOpenCents(reopened), 10000);
    const voided = await voidCreditNote(reopened, null);
    assert.equal(voided.status, "void");
    balanced(await linesFor("credit_note_void"));
  });
});
