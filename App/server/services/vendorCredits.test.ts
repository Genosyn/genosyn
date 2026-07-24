import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { VendorCredit } from "../db/entities/VendorCredit.js";
import { VendorRefund } from "../db/entities/VendorRefund.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import {
  applyVendorCredit,
  createVendorCreditFromBill,
  issueVendorCredit,
  refundVendorCredit,
  unapplyVendorCredit,
  vendorCreditOpenCents,
  voidVendorCredit,
  voidVendorRefund,
} from "./vendorCredits.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_vc";

async function line(source: string, code: string) {
  const acct = await accountByCode(CO, code);
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    companyId: CO,
    source: source as LedgerEntry["source"],
  });
  assert.ok(entry, `expected a ${source} entry`);
  const lines = await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry!.id } });
  assert.equal(
    lines.reduce((s, l) => s + l.debitCents, 0),
    lines.reduce((s, l) => s + l.creditCents, 0),
    `${source} must balance`,
  );
  return lines.find((l) => l.accountId === acct!.id);
}

async function makeSentBill(sub: number, tax = 0): Promise<Bill> {
  await seedChartOfAccounts(CO);
  const expense = await accountByCode(CO, "6000");
  const total = sub + tax;
  const bill = await insert(Bill, {
    companyId: CO,
    vendorId: "vend_1",
    slug: `bil-${sub}-${tax}`,
    numberSeq: 1,
    number: "BIL-0001",
    status: "sent",
    issueDate: new Date("2026-01-10T00:00:00Z"),
    dueDate: new Date("2026-02-10T00:00:00Z"),
    currency: "USD",
    subtotalCents: sub,
    taxCents: tax,
    totalCents: total,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: total,
    notes: "",
  });
  await insert(BillLineItem, {
    billId: bill.id,
    expenseAccountId: expense!.id,
    description: "Supplies",
    quantity: 1,
    unitPriceCents: total,
    taxRateId: null,
    taxName: tax > 0 ? "Tax" : "",
    taxPercent: 0,
    taxInclusive: false,
    lineSubtotalCents: sub,
    lineTaxCents: tax,
    lineTotalCents: total,
    sortOrder: 0,
  });
  return bill;
}

describe("issueVendorCredit", () => {
  test("full credit posts DR 1300 / CR expense + CR 2100 and relieves input tax", async () => {
    const bill = await makeSentBill(10000, 800);
    const credit = await issueVendorCredit(
      await createVendorCreditFromBill(bill, { mode: "full" }, "u1"),
      "u1",
    );
    assert.match(credit.number, /VCN-0001$/);
    assert.equal(credit.homeTotalCents, 10800);
    const vc = await line("vendor_credit_issue", "1300");
    const expense = await line("vendor_credit_issue", "6000");
    const tax = await line("vendor_credit_issue", "2100");
    assert.equal(vc!.debitCents, 10800);
    assert.equal(expense!.creditCents, 10000);
    assert.equal(tax!.creditCents, 800);
  });

  test("cumulative cap refuses a second full credit on the same bill", async () => {
    const bill = await makeSentBill(10000, 0);
    await issueVendorCredit(await createVendorCreditFromBill(bill, { mode: "full" }, null), null);
    const d2 = await createVendorCreditFromBill(bill, { mode: "full" }, null);
    await assert.rejects(() => issueVendorCredit(d2, null), /would exceed the bill/);
  });
});

describe("applyVendorCredit", () => {
  test("relieves AP and settles the bill", async () => {
    const bill = await makeSentBill(10000, 0);
    const credit = await issueVendorCredit(await createVendorCreditFromBill(bill, { mode: "full" }, null), null);
    await applyVendorCredit(credit, bill, 10000, null);
    const ap = await line("vendor_credit_apply", "2200");
    const vc = await line("vendor_credit_apply", "1300");
    assert.equal(ap!.debitCents, 10000);
    assert.equal(vc!.creditCents, 10000);
    const fresh = await AppDataSource.getRepository(Bill).findOneBy({ id: bill.id });
    assert.equal(fresh!.creditedCents, 10000);
    assert.equal(fresh!.balanceCents, 0);
  });

  test("caps at min(credit open, bill balance) and unapply restores", async () => {
    const bill = await makeSentBill(4000, 0);
    const bigBill = await makeSentBill(20000, 0);
    const credit = await issueVendorCredit(await createVendorCreditFromBill(bigBill, { mode: "full" }, null), null);
    await assert.rejects(() => applyVendorCredit(credit, bill, 5000, null), /exceeds the room/);
    const app = await applyVendorCredit(credit, bill, 4000, null);
    let fresh = await AppDataSource.getRepository(Bill).findOneBy({ id: bill.id });
    assert.equal(fresh!.balanceCents, 0);
    await unapplyVendorCredit(app, null);
    fresh = await AppDataSource.getRepository(Bill).findOneBy({ id: bill.id });
    assert.equal(fresh!.creditedCents, 0);
    assert.equal(fresh!.balanceCents, 4000);
    await line("vendor_credit_unapply", "2200");
  });
});

describe("void + refund", () => {
  test("void mirrors the issue entry", async () => {
    const bill = await makeSentBill(5000, 500);
    const credit = await issueVendorCredit(await createVendorCreditFromBill(bill, { mode: "full" }, null), null);
    const voided = await voidVendorCredit(credit, null);
    assert.equal(voided.status, "void");
    const expense = await line("vendor_credit_void", "6000");
    const vc = await line("vendor_credit_void", "1300");
    assert.equal(expense!.debitCents, 5000);
    assert.equal(vc!.creditCents, 5500);
  });

  test("refund brings cash in (DR 1100 / CR 1300); void reverses", async () => {
    const bill = await makeSentBill(10000, 0);
    const credit = await issueVendorCredit(await createVendorCreditFromBill(bill, { mode: "full" }, null), null);
    const refund = await refundVendorCredit(credit, { amountCents: 6000 }, "u1");
    const bank = await line("vendor_refund", "1100");
    const vc = await line("vendor_refund", "1300");
    assert.equal(bank!.debitCents, 6000);
    assert.equal(vc!.creditCents, 6000);
    let fresh = await AppDataSource.getRepository(VendorCredit).findOneBy({ id: credit.id });
    assert.equal(vendorCreditOpenCents(fresh!), 4000);

    await voidVendorRefund(refund, null);
    const bankBack = await line("vendor_refund_void", "1100");
    assert.equal(bankBack!.creditCents, 6000);
    fresh = await AppDataSource.getRepository(VendorCredit).findOneBy({ id: credit.id });
    assert.equal(vendorCreditOpenCents(fresh!), 10000);
    const fr = await AppDataSource.getRepository(VendorRefund).findOneBy({ id: refund.id });
    assert.ok(fr!.reversedAt);
  });
});
