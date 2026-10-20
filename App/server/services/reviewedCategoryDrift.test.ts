import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
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
import { undoBankTransaction } from "./banking.js";
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
import { createInvoiceDraft, issueInvoice, reverseInvoicePayment, voidInvoice } from "./finance.js";
import { getFinanceSettings, setRate } from "./fx.js";
import { recordInvoicePayment, removeInvoicePayment } from "./invoicePayments.js";
import { accountByCode, postLedgerEntry, reverseLedgerEntriesForSources } from "./ledger.js";
import { categorizeBankTransaction } from "./reconcile.js";
import { findReviewedCategoryDrift, type ReviewedCategoryDrift } from "./reviewedCategoryDrift.js";
import { approveLedgerReview } from "./transactionReviews.js";
import {
  createVendorCreditFromBill,
  issueVendorCredit,
  refundVendorCredit,
  voidVendorCredit,
  voidVendorRefund,
} from "./vendorCredits.js";
import { createInvoiceWriteOff, reverseInvoiceWriteOff } from "./writeOffs.js";

/**
 * Until reversals reversed an entry as the books hold it, a void, a deleted
 * payment, a reversed credit, refund or write-off, or an Undo on Banking took
 * back only the entry's own lines, and Entry review could re-file an entry
 * already reversed or the reversal itself. Each left a reviewed category
 * holding money and the original one owing it. The finder lists every such
 * entry with what is left over, and its repair leaves nothing behind.
 *
 * The books such a company carries are rebuilt here from today's code, which
 * posts the same rows the old code did when Entry review had changed nothing
 * yet: the entry is reversed first, and the change is then posted as Entry
 * review used to post it, stamped with when it was approved.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_reviewed_category_drift";
const ISSUED = new Date("2026-10-01T00:00:00Z");
const DUE = new Date("2026-10-31T00:00:00Z");
const PAID = new Date("2026-10-15T00:00:00Z");
/** When Entry review approved a change, and when the entry was reversed. */
const APPROVED = new Date("2026-10-16T09:00:00Z");
const REVERSED = new Date("2026-10-16T10:00:00Z");
const APPROVED_LATER = new Date("2026-10-16T11:00:00Z");

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

type Ctx = Awaited<ReturnType<typeof setup>>;

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

/** Debits minus credits per account code over these lines, zeros left out. */
async function byCode(lines: LedgerLine[]): Promise<Record<string, number>> {
  const accounts = await AppDataSource.getRepository(Account).find({ where: { companyId: CO } });
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
  const net = new Map<string, number>();
  for (const line of lines) {
    const code = codeOf.get(line.accountId)!;
    net.set(code, (net.get(code) ?? 0) + line.debitCents - line.creditCents);
  }
  return Object.fromEntries([...net].filter(([, cents]) => cents !== 0));
}

/** Debits minus credits per account code across the whole ledger. */
async function balances(): Promise<Record<string, number>> {
  return byCode(await AppDataSource.getRepository(LedgerLine).find({ where: { companyId: CO } }));
}

/** What one entry moves, per account code. */
async function moves(entry: LedgerEntry): Promise<Record<string, number>> {
  return byCode(
    await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry.id } }),
  );
}

function leftoverByCode(drift: ReviewedCategoryDrift): Record<string, number> {
  return Object.fromEntries(drift.leftover.map((amount) => [amount.code, amount.cents]));
}

/** The entries `act` posts. */
async function posts(act: () => Promise<unknown>): Promise<LedgerEntry[]> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const before = new Set((await repo.find({ select: ["id"] })).map((entry) => entry.id));
  await act();
  return (await repo.find()).filter((entry) => !before.has(entry.id));
}

/** Stamp entries as posted at `at`. */
async function postedAt(entries: LedgerEntry[], at: Date): Promise<void> {
  for (const entry of entries) {
    await AppDataSource.getRepository(LedgerEntry).update({ id: entry.id }, { createdAt: at });
  }
}

/**
 * What approving a change in Entry review posted before the fix, with no lock
 * to refuse it: a reclass keyed on the entry, moving its line on `fromCode` to
 * `to`, approved at `at`.
 */
async function approvedBeforeTheFix(
  entry: LedgerEntry,
  fromCode: string,
  to: Account,
  at: Date,
): Promise<LedgerEntry> {
  const line = await lineOn(entry, fromCode);
  const amount = line.debitCents || line.creditCents;
  const description = `Reclassifies ${entry.id.slice(0, 8)}`;
  const { entry: change } = await postLedgerEntry({
    companyId: CO,
    date: entry.date,
    memo: `Approved category changes for ${entry.memo || entry.id.slice(0, 8)}`,
    source: "ledger_reclass",
    sourceRefId: entry.id,
    createdById: "u1",
    reviewStatus: "approved",
    lines:
      line.debitCents > 0
        ? [
            { accountId: to.id, debitCents: amount, description },
            { accountId: line.accountId, creditCents: amount, description },
          ]
        : [
            { accountId: line.accountId, debitCents: amount, description },
            { accountId: to.id, creditCents: amount, description },
          ],
  });
  await postedAt([change], at);
  return reload(LedgerEntry, change.id);
}

/** Post a repair as proposed: an approved category change on the reversal. */
async function repairAsProposed(drift: ReviewedCategoryDrift): Promise<void> {
  assert.ok(drift.repair, "a repair is proposed");
  await postLedgerEntry({
    companyId: CO,
    date: drift.reversals[0].date,
    memo: "Takes back a category its reversal left behind",
    source: "ledger_reclass",
    sourceRefId: drift.reversals[0].id,
    reviewStatus: "approved",
    lines: drift.repair.lines,
  });
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

/** A bank transaction categorized on Banking under 6000. */
async function categorizedBankTransaction(): Promise<BankTransaction> {
  const feed = await insert(BankFeed, {
    companyId: CO,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: (await account("1100")).id,
  });
  const txn = await insert(BankTransaction, {
    companyId: CO,
    feedId: feed.id,
    externalId: null,
    date: PAID,
    amountCents: -4_200,
    description: "GITHUB",
    reference: "",
    raw: "",
  });
  return categorizeBankTransaction(txn, (await account("6000")).id, "u1");
}

type Posted = {
  /** The books before the entry was posted, which reversing it should bring back. */
  before: Record<string, number>;
  entry: LedgerEntry;
  /** The line Entry review moved, and where it moved it. */
  fromCode: string;
  to: Account;
  reverse: () => Promise<unknown>;
  /** What the reversal is posted as. */
  reversedAs: LedgerEntrySource;
};

/** Each entry something reverses, with what reverses it. */
const FLOWS: Record<string, (ctx: Ctx) => Promise<Posted>> = {
  "voiding an invoice": async ({ customer }) => {
    const invoice = await issuedInvoice(customer.id);
    return {
      before: {},
      entry: await entryFor("invoice_issue", invoice.id),
      fromCode: "4000",
      to: await account("4900"),
      reverse: async () => voidInvoice(await reload(Invoice, invoice.id)),
      reversedAs: "invoice_void",
    };
  },
  "deleting an invoice payment whose FX gain was moved": async ({ customer, consulting }) => {
    const invoice = await issuedInvoice(customer.id, "EUR");
    const before = await balances();
    const { payment } = await recordInvoicePayment(
      invoice,
      { amountCents: 100_000, paidAt: PAID, method: "bank_transfer", reference: "WIRE-1" },
      null,
    );
    return {
      before,
      entry: await entryFor("invoice_payment", payment!.id),
      fromCode: "4910",
      to: consulting,
      reverse: async () =>
        removeInvoicePayment(await reload(Invoice, invoice.id), payment!.id, null),
      reversedAs: "invoice_void",
    };
  },
  "voiding a bill": async ({ vendor, travel }) => {
    const bill = await issuedBill(vendor.id);
    return {
      before: {},
      entry: await entryFor("manual", `bill_issue:${bill.id}`),
      fromCode: "6000",
      to: travel,
      reverse: async () => voidBill(await reload(Bill, bill.id)),
      reversedAs: "manual",
    };
  },
  "deleting a bill payment whose FX loss was moved": async ({ vendor, travel }) => {
    const bill = await issuedBill(vendor.id, "EUR");
    const before = await balances();
    const payment = await payBill(bill);
    return {
      before,
      entry: await entryFor("manual", `bill_payment:${payment.id}`),
      fromCode: "6900",
      to: travel,
      reverse: () => deleteBillPayment(bill, payment),
      reversedAs: "manual",
    };
  },
  "voiding a credit note": async ({ customer, consulting }) => {
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
    return {
      before: {},
      entry: await entryFor("credit_note_issue", credit.id),
      fromCode: "4100",
      to: consulting,
      reverse: async () => voidCreditNote(await reload(CustomerCredit, credit.id), null),
      reversedAs: "credit_note_void",
    };
  },
  "reversing a customer refund whose FX loss was moved": async ({ customer, travel }) => {
    const deposit = await createDeposit(
      CO,
      { customerId: customer.id, amountCents: 100_000, currency: "EUR", issueDate: ISSUED },
      null,
    );
    const before = await balances();
    const refund = await refundCustomerCredit(
      deposit,
      { amountCents: 100_000, refundedAt: PAID },
      null,
    );
    return {
      before,
      entry: await entryFor("customer_refund", refund.id),
      fromCode: "6900",
      to: travel,
      reverse: () => voidCustomerRefund(refund, null),
      reversedAs: "customer_refund_void",
    };
  },
  "reversing a write-off": async ({ customer, travel }) => {
    const invoice = await issuedInvoice(customer.id);
    const before = await balances();
    const writeOff = await createInvoiceWriteOff(
      invoice,
      { amountCents: 30_000, kind: "bad_debt" },
      null,
    );
    return {
      before,
      entry: await entryFor("invoice_writeoff", writeOff.id),
      fromCode: "6100",
      to: travel,
      reverse: () => reverseInvoiceWriteOff(writeOff, null),
      reversedAs: "invoice_writeoff_reversal",
    };
  },
  "voiding a vendor credit": async ({ vendor, travel }) => {
    const bill = await issuedBill(vendor.id);
    const before = await balances();
    const credit = await issueVendorCredit(
      await createVendorCreditFromBill(bill, { mode: "full" }, null),
      null,
    );
    return {
      before,
      entry: await entryFor("vendor_credit_issue", credit.id),
      fromCode: "6000",
      to: travel,
      reverse: async () => voidVendorCredit(await reload(VendorCredit, credit.id), null),
      reversedAs: "vendor_credit_void",
    };
  },
  "reversing a vendor refund whose FX gain was moved": async ({ vendor, consulting }) => {
    const bill = await issuedBill(vendor.id, "EUR");
    const credit = await issueVendorCredit(
      await createVendorCreditFromBill(bill, { mode: "full" }, null),
      null,
    );
    const before = await balances();
    const refund = await refundVendorCredit(
      credit,
      { amountCents: 100_000, refundedAt: PAID },
      null,
    );
    return {
      before,
      entry: await entryFor("vendor_refund", refund.id),
      fromCode: "4910",
      to: consulting,
      reverse: () => voidVendorRefund(refund, null),
      reversedAs: "vendor_refund_void",
    };
  },
  "undoing a bank transaction on Banking": async ({ travel }) => {
    const categorized = await categorizedBankTransaction();
    return {
      before: {},
      entry: await reload(LedgerEntry, categorized.matchedLedgerEntryId!),
      fromCode: "6000",
      to: travel,
      reverse: async () =>
        undoBankTransaction(await reload(BankTransaction, categorized.id), "u1"),
      reversedAs: "bank_categorization_void",
    };
  },
};

describe("a reversal from before the fix that left the reviewed category behind", () => {
  for (const [name, flow] of Object.entries(FLOWS)) {
    test(name, async () => {
      const { before, entry, fromCode, to, reverse, reversedAs } = await flow(await setup());
      const reversals = await posts(reverse);
      assert.deepEqual(
        reversals.map((reversal) => reversal.source),
        [reversedAs],
      );
      await postedAt(reversals, REVERSED);
      // Approved before the reversal, which reversed only the entry's own lines.
      const change = await approvedBeforeTheFix(entry, fromCode, to, APPROVED);

      const drifts = await findReviewedCategoryDrift(CO);

      assert.equal(drifts.length, 1);
      const [drift] = drifts;
      assert.equal(drift.kind, "left_behind");
      assert.equal(drift.problem, null);
      assert.equal(drift.entry?.id, entry.id);
      assert.deepEqual(
        drift.reversals.map((reversal) => reversal.id),
        reversals.map((reversal) => reversal.id),
      );
      assert.deepEqual(
        drift.changes.map(({ id, changedEntryId, cause }) => ({ id, changedEntryId, cause })),
        [{ id: change.id, changedEntryId: entry.id, cause: "reversed_without_it" }],
      );
      // What is left over is exactly what Entry review moved.
      assert.deepEqual(leftoverByCode(drift), await moves(change));

      // The repair puts the books where reversing the entry should have.
      await repairAsProposed(drift);
      assert.deepEqual(await balances(), before);
      assert.deepEqual(await findReviewedCategoryDrift(CO), []);
    });
  }
});

describe("a change Entry review approved that no reversal would take back", () => {
  test("on an entry already reversed", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    const issue = await entryFor("invoice_issue", invoice.id);
    await postedAt(await posts(() => voidInvoice(invoice)), REVERSED);
    const otherIncome = await account("4900");
    await approvedBeforeTheFix(issue, "4000", otherIncome, APPROVED_LATER);

    const [drift] = await findReviewedCategoryDrift(CO);

    assert.equal(drift.kind, "left_behind");
    assert.equal(drift.entry?.id, issue.id);
    assert.deepEqual(
      drift.changes.map((change) => change.cause),
      ["approved_after_reversal"],
    );
    // Sales Revenue is left owing the invoice and Other Income holding it.
    assert.deepEqual(leftoverByCode(drift), { "4000": 100_000, "4900": -100_000 });
    assert.deepEqual(drift.repair, {
      kind: "reclassify",
      lines: [
        { accountId: otherIncome.id, debitCents: 100_000, creditCents: 0 },
        { accountId: (await account("4000")).id, debitCents: 0, creditCents: 100_000 },
      ],
    });
    await repairAsProposed(drift);
    assert.deepEqual(await balances(), {});
  });

  test("on the reversal itself", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    const [voided] = await posts(() => voidInvoice(invoice));
    await postedAt([voided], REVERSED);
    const change = await approvedBeforeTheFix(voided, "4000", await account("4900"), APPROVED_LATER);

    const [drift] = await findReviewedCategoryDrift(CO);

    assert.equal(drift.kind, "left_behind");
    assert.equal(drift.entry?.id, (await entryFor("invoice_issue", invoice.id)).id);
    assert.deepEqual(drift.changes.map(({ id, changedEntryId, cause }) => ({ id, changedEntryId, cause })), [
      { id: change.id, changedEntryId: voided.id, cause: "approved_on_reversal" },
    ]);
    assert.deepEqual(leftoverByCode(drift), { "4900": 100_000, "4000": -100_000 });
    await repairAsProposed(drift);
    assert.deepEqual(await balances(), {});
  });

  test("on an Undo on Banking", async () => {
    const { travel } = await setup();
    const categorized = await categorizedBankTransaction();
    const categorizationId = categorized.matchedLedgerEntryId;
    const [undo] = await posts(() => undoBankTransaction(categorized, "u1"));
    await postedAt([undo], REVERSED);
    await approvedBeforeTheFix(undo, "6000", travel, APPROVED_LATER);

    const [drift] = await findReviewedCategoryDrift(CO);

    assert.equal(drift.kind, "left_behind");
    assert.equal(drift.entry?.id, categorizationId);
    assert.deepEqual(
      drift.changes.map((change) => change.cause),
      ["approved_on_reversal"],
    );
    assert.deepEqual(leftoverByCode(drift), { "6000": 4_200, "6200": -4_200 });
    await repairAsProposed(drift);
    assert.deepEqual(await balances(), {});
  });
});

describe("what hasn't drifted", () => {
  test("a change on an entry nothing has reversed", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    await approvedBeforeTheFix(
      await entryFor("invoice_issue", invoice.id),
      "4000",
      await account("4900"),
      APPROVED,
    );

    assert.deepEqual(await findReviewedCategoryDrift(CO), []);
  });

  test("a change the reversal took back", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    const issue = await entryFor("invoice_issue", invoice.id);
    await approveLedgerReview({
      companyId: CO,
      entryId: issue.id,
      userId: "u1",
      changes: [{ lineId: (await lineOn(issue, "4000")).id, accountId: (await account("4900")).id }],
    });
    await voidInvoice(await reload(Invoice, invoice.id));

    assert.deepEqual(await balances(), {});
    assert.deepEqual(await findReviewedCategoryDrift(CO), []);
  });

  test("one someone already put right in Entry review", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    const issue = await entryFor("invoice_issue", invoice.id);
    const [voided] = await posts(() => voidInvoice(invoice));
    await postedAt([voided], REVERSED);
    const otherIncome = await account("4900");
    await approvedBeforeTheFix(issue, "4000", otherIncome, APPROVED);
    // The void's line moved where the invoice had been moved.
    await approvedBeforeTheFix(voided, "4000", otherIncome, APPROVED_LATER);

    assert.deepEqual(await balances(), {});
    assert.deepEqual(await findReviewedCategoryDrift(CO), []);
  });

  test("another company's books", async () => {
    const { customer } = await setup();
    const invoice = await issuedInvoice(customer.id);
    await postedAt(await posts(() => voidInvoice(invoice)), REVERSED);
    await approvedBeforeTheFix(
      await entryFor("invoice_issue", invoice.id),
      "4000",
      await account("4900"),
      APPROVED,
    );

    assert.equal((await findReviewedCategoryDrift(CO)).length, 1);
    assert.deepEqual(await findReviewedCategoryDrift("co_someone_else"), []);
  });
});

describe("a void from before v1.47.0, which reversed the invoice's payments too", () => {
  /** How voiding an invoice reversed it then: its issue and every payment, all under the void's key. */
  async function voidedWithPayments(invoice: Invoice, paymentIds: string[]) {
    const reversals = await posts(() =>
      reverseLedgerEntriesForSources({
        companyId: CO,
        sources: ["invoice_issue", "invoice_payment"],
        sourceRefIds: [invoice.id, ...paymentIds],
        reverseAs: "invoice_void",
        reverseRefId: invoice.id,
        date: new Date(),
        memo: `Void of invoice ${invoice.number}`,
        createdById: null,
      }),
    );
    await postedAt(reversals, REVERSED);
    return reversals;
  }

  async function paidInvoice(customerId: string) {
    const invoice = await issuedInvoice(customerId, "EUR");
    const { payment } = await recordInvoicePayment(
      invoice,
      { amountCents: 100_000, paidAt: PAID, method: "bank_transfer", reference: "WIRE-1" },
      null,
    );
    return {
      invoice: await reload(Invoice, invoice.id),
      payment: payment!,
      issue: await entryFor("invoice_issue", invoice.id),
      paid: await entryFor("invoice_payment", payment!.id),
    };
  }

  test("judges the issue and the payment each with the reversal that names it", async () => {
    const { customer, consulting } = await setup();
    const { invoice, payment, issue, paid } = await paidInvoice(customer.id);
    const reversals = await voidedWithPayments(invoice, [payment.id]);
    assert.equal(reversals.length, 2);
    const issueChange = await approvedBeforeTheFix(issue, "4000", await account("4900"), APPROVED);
    // Today's Entry review still takes this one: nothing is posted under the
    // payment's own key, so it doesn't look reversed.
    const paymentChange = await approvedBeforeTheFix(paid, "4910", consulting, APPROVED_LATER);

    const drifts = await findReviewedCategoryDrift(CO);

    assert.equal(drifts.length, 2);
    for (const [entry, change, cause] of [
      [issue, issueChange, "reversed_without_it"],
      [paid, paymentChange, "approved_after_reversal"],
    ] as const) {
      const drift = drifts.find((d) => d.entry?.id === entry.id);
      assert.ok(drift, `${entry.source} is listed`);
      assert.equal(drift.kind, "left_behind");
      assert.equal(drift.reversals.length, 1);
      assert.match(drift.reversals[0].memo, new RegExp(`\\(reverses ${entry.id.slice(0, 8)}\\)$`));
      assert.deepEqual(
        drift.changes.map((c) => c.cause),
        [cause],
      );
      assert.deepEqual(leftoverByCode(drift), await moves(change));
    }
    for (const drift of drifts) await repairAsProposed(drift);
    assert.deepEqual(await balances(), {});
    assert.deepEqual(await findReviewedCategoryDrift(CO), []);
  });

  test("a payment reversed again since is listed with no repair", async () => {
    const { customer, consulting } = await setup();
    const { invoice, payment, paid } = await paidInvoice(customer.id);
    await voidedWithPayments(invoice, [payment.id]);
    // Deleting the payment reversed it under its own key as well.
    await reverseInvoicePayment(invoice, payment, null);
    await approvedBeforeTheFix(paid, "4910", consulting, APPROVED_LATER);

    const [drift, ...rest] = await findReviewedCategoryDrift(CO);

    assert.deepEqual(rest, []);
    assert.equal(drift.kind, "unrecognized");
    assert.equal(drift.entry?.id, paid.id);
    assert.equal(drift.reversals.length, 2);
    assert.equal(drift.problem, "It was reversed more than once");
    assert.equal(drift.repair, null);
  });
});

test("a change on a reversal whose entry isn't in the books is listed with no repair", async () => {
  const { consulting } = await setup();
  const { entry: orphan } = await postLedgerEntry({
    companyId: CO,
    date: ISSUED,
    memo: "Void credit note CN-0001",
    source: "credit_note_void",
    sourceRefId: randomUUID(),
    reviewStatus: "approved",
    lines: [
      { accountId: (await account("2400")).id, debitCents: 20_000 },
      { accountId: (await account("4100")).id, creditCents: 20_000 },
    ],
  });
  await approvedBeforeTheFix(orphan, "4100", consulting, APPROVED);

  const [drift] = await findReviewedCategoryDrift(CO);

  assert.equal(drift.kind, "unrecognized");
  assert.equal(drift.entry, null);
  assert.deepEqual(
    drift.reversals.map((reversal) => reversal.id),
    [orphan.id],
  );
  assert.deepEqual(
    drift.changes.map((change) => change.cause),
    ["approved_on_reversal"],
  );
  assert.equal(drift.problem, "It reverses an entry that isn't in the books");
  assert.equal(drift.repair, null);
});
