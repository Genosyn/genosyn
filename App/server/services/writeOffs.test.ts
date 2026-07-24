import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Account } from "../db/entities/Account.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { displayStatus } from "./finance.js";
import {
  createInvoiceWriteOff,
  listInvoiceWriteOffs,
  reverseInvoiceWriteOff,
} from "./writeOffs.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_writeoffs";

/** A sent, unpaid USD invoice for `total`, with one matching line so
 *  recomputeInvoiceTotals derives the same total. */
async function makeSentInvoice(total: number): Promise<Invoice> {
  await seedChartOfAccounts(CO);
  const inv = await insert(Invoice, {
    companyId: CO,
    customerId: "cust_1",
    slug: `inv-${total}`,
    numberSeq: 1,
    number: "INV-0001",
    status: "sent",
    issueDate: new Date("2026-01-10T00:00:00Z"),
    dueDate: new Date("2026-02-10T00:00:00Z"),
    currency: "USD",
    subtotalCents: total,
    taxCents: 0,
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
    taxName: "",
    taxPercent: 0,
    taxInclusive: false,
    lineSubtotalCents: total,
    lineTaxCents: 0,
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
  assert.ok(entry, `expected a ${source} ledger entry`);
  return AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: entry!.id },
  });
}

describe("createInvoiceWriteOff", () => {
  test("posts DR Bad Debt / CR AR, balanced, and settles the invoice", async () => {
    const inv = await makeSentInvoice(10000);
    await createInvoiceWriteOff(inv, { amountCents: 10000, kind: "bad_debt" }, "user_1");

    const badDebt = await accountByCode(CO, "6100");
    const ar = await accountByCode(CO, "1200");
    const lines = await linesFor("invoice_writeoff");
    const debit = lines.find((l) => l.debitCents > 0)!;
    const credit = lines.find((l) => l.creditCents > 0)!;
    assert.equal(debit.accountId, badDebt!.id);
    assert.equal(debit.debitCents, 10000);
    assert.equal(credit.accountId, ar!.id);
    assert.equal(credit.creditCents, 10000);
    // Balanced by construction.
    assert.equal(
      lines.reduce((s, l) => s + l.debitCents, 0),
      lines.reduce((s, l) => s + l.creditCents, 0),
    );

    const fresh = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(fresh!.writtenOffCents, 10000);
    assert.equal(fresh!.paidCents, 0, "no cash was involved");
    assert.equal(fresh!.balanceCents, 0);
    assert.equal(fresh!.paidAt, null, "must not stamp paidAt for a pure write-off");
    // Fully settled with no cash ⇒ surfaced as written_off, not paid.
    assert.equal(displayStatus(fresh!), "written_off");
  });

  test("a partial write-off leaves the invoice open for the remainder", async () => {
    const inv = await makeSentInvoice(10000);
    await createInvoiceWriteOff(inv, { amountCents: 300, kind: "residual" }, null);
    const fresh = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(fresh!.writtenOffCents, 300);
    assert.equal(fresh!.balanceCents, 9700);
    assert.equal(fresh!.status, "sent");
  });

  test("refuses a draft invoice", async () => {
    const inv = await makeSentInvoice(10000);
    await AppDataSource.getRepository(Invoice).update({ id: inv.id }, { status: "draft" });
    inv.status = "draft";
    await assert.rejects(
      () => createInvoiceWriteOff(inv, { amountCents: 100, kind: "residual" }, null),
      /issued/,
    );
  });

  test("refuses an amount over the open balance", async () => {
    const inv = await makeSentInvoice(10000);
    await assert.rejects(
      () => createInvoiceWriteOff(inv, { amountCents: 10001, kind: "bad_debt" }, null),
      /exceeds/,
    );
  });
});

describe("reverseInvoiceWriteOff", () => {
  test("puts the balance back and posts a mirrored entry", async () => {
    const inv = await makeSentInvoice(10000);
    const writeOff = await createInvoiceWriteOff(
      inv,
      { amountCents: 10000, kind: "bad_debt" },
      "user_1",
    );

    await reverseInvoiceWriteOff(writeOff, "user_2");

    const reversal = await linesFor("invoice_writeoff_reversal");
    const ar = await accountByCode(CO, "1200");
    const debitBack = reversal.find((l) => l.debitCents > 0)!;
    assert.equal(debitBack.accountId, ar!.id, "reversal debits AR back");
    assert.equal(debitBack.debitCents, 10000);

    const fresh = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(fresh!.writtenOffCents, 0);
    assert.equal(fresh!.balanceCents, 10000);
    assert.equal(fresh!.status, "sent");

    const rows = await listInvoiceWriteOffs(CO, inv.id);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].reversedAt, "the write-off is marked reversed");
  });

  test("refuses to reverse twice", async () => {
    const inv = await makeSentInvoice(10000);
    const writeOff = await createInvoiceWriteOff(inv, { amountCents: 500, kind: "residual" }, null);
    await reverseInvoiceWriteOff(writeOff, null);
    await assert.rejects(() => reverseInvoiceWriteOff(writeOff, null), /already been reversed/);
  });
});
