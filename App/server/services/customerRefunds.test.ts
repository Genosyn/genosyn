import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { CustomerRefund } from "../db/entities/CustomerRefund.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import {
  applyCustomerCredit,
  createDeposit,
  createOverpaymentCredit,
  creditOpenCents,
  refundCustomerCredit,
  voidCustomerRefund,
} from "./customerCredits.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_refunds";

async function acctLine(source: string, code: string) {
  const acct = await accountByCode(CO, code);
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    companyId: CO,
    source: source as LedgerEntry["source"],
  });
  assert.ok(entry, `expected a ${source} entry`);
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: entry!.id },
  });
  assert.equal(
    lines.reduce((s, l) => s + l.debitCents, 0),
    lines.reduce((s, l) => s + l.creditCents, 0),
    `${source} must balance`,
  );
  return lines.find((l) => l.accountId === acct!.id);
}

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
    description: "Work",
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

describe("createDeposit", () => {
  test("posts DR Bank / CR Customer Deposits (no tax leg)", async () => {
    await seedChartOfAccounts(CO);
    const dep = await createDeposit(
      CO,
      { customerId: "cust_1", amountCents: 50000, currency: "USD" },
      "u1",
    );
    assert.equal(dep.kind, "deposit");
    assert.equal(dep.status, "issued");
    assert.equal(creditOpenCents(dep), 50000);
    const bank = await acctLine("credit_note_issue", "1100");
    const deposits = await acctLine("credit_note_issue", "2500");
    assert.equal(bank!.debitCents, 50000);
    assert.equal(deposits!.creditCents, 50000);
  });

  test("a deposit applies against an invoice via 2500", async () => {
    const inv = await makeSentInvoice(30000);
    const dep = await createDeposit(
      CO,
      { customerId: "cust_1", amountCents: 50000, currency: "USD" },
      null,
    );
    await applyCustomerCredit(dep, inv, 30000, null);
    const deposits = await acctLine("credit_note_apply", "2500");
    const ar = await acctLine("credit_note_apply", "1200");
    assert.equal(deposits!.debitCents, 30000);
    assert.equal(ar!.creditCents, 30000);
    const freshInv = await AppDataSource.getRepository(Invoice).findOneBy({ id: inv.id });
    assert.equal(freshInv!.balanceCents, 0);
  });
});

describe("createOverpaymentCredit", () => {
  test("posts DR Bank / CR Customer Credits", async () => {
    await seedChartOfAccounts(CO);
    const bankAcct = await accountByCode(CO, "1100");
    const credit = await createOverpaymentCredit(
      CO,
      { customerId: "cust_1", amountCents: 2500, currency: "USD", bankAccountId: bankAcct!.id, paidAt: new Date() },
      null,
    );
    assert.equal(credit.kind, "overpayment");
    const bank = await acctLine("credit_note_issue", "1100");
    const credits = await acctLine("credit_note_issue", "2400");
    assert.equal(bank!.debitCents, 2500);
    assert.equal(credits!.creditCents, 2500);
  });
});

describe("refundCustomerCredit", () => {
  test("posts DR 2500 / CR Bank and reduces the open balance", async () => {
    await seedChartOfAccounts(CO);
    const dep = await createDeposit(
      CO,
      { customerId: "cust_1", amountCents: 10000, currency: "USD" },
      null,
    );
    const refund = await refundCustomerCredit(dep, { amountCents: 4000 }, "u1");
    const deposits = await acctLine("customer_refund", "2500");
    const bank = await acctLine("customer_refund", "1100");
    assert.equal(deposits!.debitCents, 4000);
    assert.equal(bank!.creditCents, 4000);
    const fresh = await AppDataSource.getRepository(CustomerCredit).findOneBy({ id: dep.id });
    assert.equal(fresh!.refundedCents, 4000);
    assert.equal(creditOpenCents(fresh!), 6000);

    await voidCustomerRefund(refund, null);
    const bankBack = await acctLine("customer_refund_void", "1100");
    assert.equal(bankBack!.debitCents, 4000);
    const reopened = await AppDataSource.getRepository(CustomerCredit).findOneBy({ id: dep.id });
    assert.equal(creditOpenCents(reopened!), 10000);
    const freshRefund = await AppDataSource.getRepository(CustomerRefund).findOneBy({ id: refund.id });
    assert.ok(freshRefund!.reversedAt);
  });

  test("refuses a refund over the open balance", async () => {
    await seedChartOfAccounts(CO);
    const dep = await createDeposit(
      CO,
      { customerId: "cust_1", amountCents: 10000, currency: "USD" },
      null,
    );
    await assert.rejects(() => refundCustomerCredit(dep, { amountCents: 10001 }, null), /exceeds/);
  });
});
