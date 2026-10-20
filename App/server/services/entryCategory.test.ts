import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { ENTRY_CATEGORY_LOCK_REASON } from "../../shared/entryCategory.js";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Bill } from "../db/entities/Bill.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry, type LedgerEntrySource } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Vendor } from "../db/entities/Vendor.js";
import { VendorCredit } from "../db/entities/VendorCredit.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  issueBill,
  postBillPayment,
  recomputeBillTotals,
  replaceBillLines,
  reverseBillPayment,
  voidBill,
} from "./bills.js";
import {
  createCreditNoteDraft,
  createDeposit,
  issueCreditNote,
  refundCustomerCredit,
  voidCreditNote,
  voidCustomerRefund,
} from "./customerCredits.js";
import { createInvoiceDraft, issueInvoice, updateInvoice, voidInvoice } from "./finance.js";
import { getFinanceSettings, setRate } from "./fx.js";
import { recordInvoicePayment, removeInvoicePayment } from "./invoicePayments.js";
import { accountByCode, postLedgerEntry } from "./ledger.js";
import {
  approveLedgerReview,
  bulkLedgerReview,
  getLedgerEntryForReview,
  stageAiLedgerReview,
} from "./transactionReviews.js";
import {
  createVendorCreditFromBill,
  issueVendorCredit,
  refundVendorCredit,
  voidVendorCredit,
  voidVendorRefund,
} from "./vendorCredits.js";
import { createInvoiceWriteOff, reverseInvoiceWriteOff } from "./writeOffs.js";

/**
 * Entry review approves a category change by posting a reclass keyed on the
 * entry, beside the entry's own lines. Voiding an invoice or a bill, deleting
 * a payment, or reversing a credit, refund or write-off used to reverse only
 * the entry's own lines, leaving the reviewed category holding the money and
 * the original one owing it. Each now reverses the entry as the books hold it,
 * so nothing is left on any account — and Entry review refuses a change that
 * nothing would take back: on a reversal, or on an entry reversed already.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_entry_category";
const ISSUED = new Date("2026-10-01T00:00:00Z");
const DUE = new Date("2026-10-31T00:00:00Z");
const PAID = new Date("2026-10-15T00:00:00Z");

async function setup() {
  // Seeds the chart of accounts, with FX Gain (4910) and FX Loss (6900).
  await getFinanceSettings(CO);
  // A euro is worth $1.10 when documents are issued and $1.20 when paid, so a
  // euro payment or refund books an FX gain or loss.
  await setRate(CO, "EUR", "USD", new Date("2026-09-30T00:00:00Z"), 1.1, "manual");
  await setRate(CO, "EUR", "USD", new Date("2026-10-10T00:00:00Z"), 1.2, "manual");
  const consulting = await insert(Account, {
    companyId: CO,
    code: "4950",
    name: "Consulting",
    type: "revenue",
  });
  const travel = await insert(Account, {
    companyId: CO,
    code: "6200",
    name: "Travel",
    type: "expense",
  });
  const customer = await insert(Customer, {
    companyId: CO,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "ap@acme.example",
    currency: "USD",
  });
  const vendor = await insert(Vendor, {
    companyId: CO,
    name: "Hosting Co",
    slug: "hosting-co",
    currency: "USD",
  });
  return { consulting, travel, customer, vendor };
}

async function account(code: string): Promise<Account> {
  return (await accountByCode(CO, code))!;
}

async function reload<T extends { id: string }>(entity: new () => T, id: string): Promise<T> {
  return AppDataSource.getRepository(entity).findOneByOrFail({ id } as never);
}

/** The entry `source` posted for `sourceRefId`. */
async function entryFor(source: LedgerEntrySource, sourceRefId: string): Promise<LedgerEntry> {
  return AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    companyId: CO,
    source,
    sourceRefId,
  });
}

/** The entry's line on the account with this code. */
async function lineOn(entry: LedgerEntry, code: string): Promise<LedgerLine> {
  return AppDataSource.getRepository(LedgerLine).findOneByOrFail({
    ledgerEntryId: entry.id,
    accountId: (await account(code)).id,
  });
}

/** Approve the entry in Entry review with its line on `fromCode` moved to `to`. */
async function approveMoving(entry: LedgerEntry, fromCode: string, to: Account) {
  const line = await lineOn(entry, fromCode);
  return approveLedgerReview({
    companyId: CO,
    entryId: entry.id,
    userId: "u1",
    changes: [{ lineId: line.id, accountId: to.id }],
  });
}

/** Debits minus credits per account code across the whole ledger, zeros left out. */
async function balances(): Promise<Record<string, number>> {
  const [lines, accounts] = await Promise.all([
    AppDataSource.getRepository(LedgerLine).find({ where: { companyId: CO } }),
    AppDataSource.getRepository(Account).find({ where: { companyId: CO } }),
  ]);
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
  const net = new Map<string, number>();
  for (const line of lines) {
    const code = codeOf.get(line.accountId)!;
    net.set(code, (net.get(code) ?? 0) + line.debitCents - line.creditCents);
  }
  return Object.fromEntries([...net].filter(([, cents]) => cents !== 0));
}

async function issuedInvoice(customerId: string, currency = "USD"): Promise<Invoice> {
  const draft = await createInvoiceDraft({
    companyId: CO,
    customerId,
    currency,
    issueDate: ISSUED,
    dueDate: DUE,
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 100_000 }],
  });
  return issueInvoice(draft);
}

async function issuedBill(vendorId: string, currency = "USD"): Promise<Bill> {
  const bill = await insert(Bill, {
    companyId: CO,
    vendorId,
    slug: `draft-${randomUUID()}`,
    status: "draft",
    issueDate: ISSUED,
    dueDate: DUE,
    currency,
  });
  await replaceBillLines(bill, [
    {
      expenseAccountId: (await account("6000")).id,
      description: "Servers",
      quantity: 1,
      unitPriceCents: 100_000,
    },
  ]);
  return issueBill(await recomputeBillTotals(bill));
}

/** Pay a bill in full, as the bill page does. */
async function payBill(bill: Bill): Promise<BillPayment> {
  const payment = await insert(BillPayment, {
    billId: bill.id,
    amountCents: bill.balanceCents,
    currency: bill.currency,
    paidAt: PAID,
    method: "bank_transfer",
  });
  await postBillPayment(bill, payment, null);
  await recomputeBillTotals(bill);
  return payment;
}

/** Delete a bill's payment, as the bill page does. */
async function deleteBillPayment(bill: Bill, payment: BillPayment): Promise<void> {
  await reverseBillPayment(bill, payment, null);
  await AppDataSource.getRepository(BillPayment).delete({ id: payment.id });
  await recomputeBillTotals(await reload(Bill, bill.id));
}

describe("whatever reverses an entry takes back the category Entry review gave it", () => {
  test("voiding an invoice", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    await approveMoving(await entryFor("invoice_issue", invoice.id), "4000", await account("4900"));
    assert.deepEqual(await balances(), { "1200": 100_000, "4900": -100_000 });

    await voidInvoice(await reload(Invoice, invoice.id));

    assert.deepEqual(await balances(), {});
  });

  test("voiding an invoice edited after the change", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    await approveMoving(await entryFor("invoice_issue", invoice.id), "4000", await account("4900"));
    await updateInvoice(
      await reload(Invoice, invoice.id),
      { lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 80_000 }] },
      null,
    );
    assert.deepEqual(await balances(), { "1200": 80_000, "4000": 20_000, "4900": -100_000 });

    await voidInvoice(await reload(Invoice, invoice.id));

    assert.deepEqual(await balances(), {});
  });

  test("deleting an invoice payment whose FX gain was moved", async () => {
    const { customer, consulting } = await setup();
    const invoice = await issuedInvoice(customer.id, "EUR");
    const issued = await balances();
    assert.deepEqual(issued, { "1200": 110_000, "4000": -110_000 });
    const { payment } = await recordInvoicePayment(
      invoice,
      { amountCents: 100_000, paidAt: PAID, method: "bank_transfer", reference: "WIRE-1" },
      null,
    );
    await approveMoving(await entryFor("invoice_payment", payment!.id), "4910", consulting);
    assert.deepEqual(await balances(), { "1100": 120_000, "4000": -110_000, "4950": -10_000 });

    await removeInvoicePayment(await reload(Invoice, invoice.id), payment!.id, null);

    assert.deepEqual(await balances(), issued);
  });

  test("voiding a bill", async () => {
    const { vendor, travel } = await setup();
    const bill = await issuedBill(vendor.id);
    await approveMoving(await entryFor("manual", `bill_issue:${bill.id}`), "6000", travel);
    assert.deepEqual(await balances(), { "2200": -100_000, "6200": 100_000 });

    await voidBill(await reload(Bill, bill.id));

    assert.deepEqual(await balances(), {});
  });

  test("deleting a bill payment whose FX loss was moved", async () => {
    const { vendor, travel } = await setup();
    const bill = await issuedBill(vendor.id, "EUR");
    const issued = await balances();
    assert.deepEqual(issued, { "2200": -110_000, "6000": 110_000 });
    const payment = await payBill(bill);
    await approveMoving(await entryFor("manual", `bill_payment:${payment.id}`), "6900", travel);
    assert.deepEqual(await balances(), { "1100": -120_000, "6000": 110_000, "6200": 10_000 });

    await deleteBillPayment(bill, payment);

    assert.deepEqual(await balances(), issued);
  });

  test("voiding a credit note", async () => {
    const { customer, consulting } = await setup();
    const credit = await issueCreditNote(
      await createCreditNoteDraft(
        CO,
        {
          customerId: customer.id,
          currency: "USD",
          lines: [{ description: "Downtime credit", quantity: 1, unitPriceCents: 20_000 }],
        },
        null,
      ),
      null,
    );
    await approveMoving(await entryFor("credit_note_issue", credit.id), "4100", consulting);
    assert.deepEqual(await balances(), { "2400": -20_000, "4950": 20_000 });

    await voidCreditNote(await reload(CustomerCredit, credit.id), null);

    assert.deepEqual(await balances(), {});
  });

  test("reversing a write-off", async () => {
    const { customer, travel } = await setup();
    const invoice = await issuedInvoice(customer.id);
    const issued = await balances();
    const writeOff = await createInvoiceWriteOff(
      invoice,
      { amountCents: 30_000, kind: "bad_debt" },
      null,
    );
    await approveMoving(await entryFor("invoice_writeoff", writeOff.id), "6100", travel);
    assert.deepEqual(await balances(), { "1200": 70_000, "4000": -100_000, "6200": 30_000 });

    await reverseInvoiceWriteOff(writeOff, null);

    assert.deepEqual(await balances(), issued);
  });

  test("voiding a vendor credit", async () => {
    const { vendor, travel } = await setup();
    const bill = await issuedBill(vendor.id);
    const billed = await balances();
    const credit = await issueVendorCredit(
      await createVendorCreditFromBill(bill, { mode: "full" }, null),
      null,
    );
    await approveMoving(await entryFor("vendor_credit_issue", credit.id), "6000", travel);
    assert.deepEqual(await balances(), {
      "1300": 100_000,
      "2200": -100_000,
      "6000": 100_000,
      "6200": -100_000,
    });

    await voidVendorCredit(await reload(VendorCredit, credit.id), null);

    assert.deepEqual(await balances(), billed);
  });

  test("reversing a customer refund whose FX loss was moved", async () => {
    const { customer, travel } = await setup();
    const deposit = await createDeposit(
      CO,
      { customerId: customer.id, amountCents: 100_000, currency: "EUR", issueDate: ISSUED },
      null,
    );
    const deposited = await balances();
    const refund = await refundCustomerCredit(
      deposit,
      { amountCents: 100_000, refundedAt: PAID },
      null,
    );
    await approveMoving(await entryFor("customer_refund", refund.id), "6900", travel);
    assert.deepEqual(await balances(), { "1100": -10_000, "6200": 10_000 });

    await voidCustomerRefund(refund, null);

    assert.deepEqual(await balances(), deposited);
  });

  test("reversing a vendor refund whose FX gain was moved", async () => {
    const { vendor, consulting } = await setup();
    const bill = await issuedBill(vendor.id, "EUR");
    const credit = await issueVendorCredit(
      await createVendorCreditFromBill(bill, { mode: "full" }, null),
      null,
    );
    const credited = await balances();
    const refund = await refundVendorCredit(
      credit,
      { amountCents: 100_000, refundedAt: PAID },
      null,
    );
    await approveMoving(await entryFor("vendor_refund", refund.id), "4910", consulting);
    assert.deepEqual(await balances(), {
      "1100": 120_000,
      "2200": -110_000,
      "4950": -10_000,
    });

    await voidVendorRefund(refund, null);

    assert.deepEqual(await balances(), credited);
  });
});

describe("Entry review won't re-file what nothing would take back", () => {
  const REVERSAL = ENTRY_CATEGORY_LOCK_REASON.reversal;
  const REVERSED = ENTRY_CATEGORY_LOCK_REASON.reversed;

  test("a reversal takes no category change, and is approved as it is", async () => {
    const { customer, vendor, travel } = await setup();
    const invoice = await issuedInvoice(customer.id);
    await voidInvoice(invoice);
    const bill = await issuedBill(vendor.id);
    await voidBill(bill);
    const invoiceVoid = await entryFor("invoice_void", invoice.id);
    const billVoid = await entryFor("manual", `bill_void:${bill.id}`);

    for (const [entry, code, to] of [
      [invoiceVoid, "4000", await account("4900")],
      [billVoid, "6000", travel],
    ] as const) {
      assert.equal((await getLedgerEntryForReview(CO, entry.id))?.categoryLock, "reversal");
      await assert.rejects(approveMoving(entry, code, to), { message: REVERSAL });
      const approved = await approveLedgerReview({
        companyId: CO,
        entryId: entry.id,
        userId: "u1",
      });
      assert.equal(approved.reviewStatus, "approved");
    }
    assert.deepEqual(await balances(), {});
  });

  test("an entry reversed since takes no category change", async () => {
    const { customer, vendor, travel, consulting } = await setup();
    const invoice = await issuedInvoice(customer.id, "EUR");
    const { payment } = await recordInvoicePayment(
      invoice,
      { amountCents: 100_000, paidAt: PAID, reference: "WIRE-2" },
      null,
    );
    await removeInvoicePayment(await reload(Invoice, invoice.id), payment!.id, null);
    await voidInvoice(await reload(Invoice, invoice.id));
    const bill = await issuedBill(vendor.id, "EUR");
    const billPayment = await payBill(bill);
    await deleteBillPayment(bill, billPayment);
    await voidBill(await reload(Bill, bill.id));

    for (const [entry, code, to] of [
      [await entryFor("invoice_issue", invoice.id), "4000", await account("4900")],
      [await entryFor("invoice_payment", payment!.id), "4910", consulting],
      [await entryFor("manual", `bill_issue:${bill.id}`), "6000", travel],
      [await entryFor("manual", `bill_payment:${billPayment.id}`), "6900", travel],
    ] as const) {
      assert.equal((await getLedgerEntryForReview(CO, entry.id))?.categoryLock, "reversed");
      await assert.rejects(approveMoving(entry, code, to), { message: REVERSED });
      await approveLedgerReview({ companyId: CO, entryId: entry.id, userId: "u1" });
    }
    assert.deepEqual(await balances(), {});
  });

  test("a category an AI Employee proposed before the reversal is never posted", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    const issue = await entryFor("invoice_issue", invoice.id);
    await stageAiLedgerReview({
      companyId: CO,
      entryId: issue.id,
      employeeId: "employee-1",
      changes: [
        { lineId: (await lineOn(issue, "4000")).id, accountId: (await account("4900")).id },
      ],
    });
    await voidInvoice(await reload(Invoice, invoice.id));

    const bulk = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "approve",
      entryIds: [issue.id],
    });
    assert.deepEqual(bulk.skipped, [{ id: issue.id, reason: REVERSED }]);

    // Opened on its own, the page approves it with no category change.
    const approved = await approveLedgerReview({
      companyId: CO,
      entryId: issue.id,
      userId: "u1",
      changes: [],
    });
    assert.equal(approved.reviewStatus, "approved");
    assert.deepEqual(await balances(), {});
  });

  test("bulk Change category moves other entries and skips the rest", async () => {
    const { customer, travel } = await setup();
    const invoice = await issuedInvoice(customer.id);
    await voidInvoice(invoice);
    const issue = await entryFor("invoice_issue", invoice.id);
    const reversal = await entryFor("invoice_void", invoice.id);
    const { entry: manual } = await postLedgerEntry({
      companyId: CO,
      date: ISSUED,
      memo: "Team offsite",
      lines: [
        { accountId: (await account("6000")).id, debitCents: 5_000 },
        { accountId: (await account("1100")).id, creditCents: 5_000 },
      ],
    });

    const result = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "recategorize",
      entryIds: [issue.id, reversal.id, manual.id],
      toAccountId: travel.id,
    });

    assert.deepEqual(result.succeeded, [manual.id]);
    assert.deepEqual(result.skipped, [
      { id: issue.id, reason: REVERSED },
      { id: reversal.id, reason: REVERSAL },
    ]);
    assert.deepEqual(await balances(), { "1100": -5_000, "6200": 5_000 });
  });
});
