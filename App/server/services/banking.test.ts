import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  BANKING_PAYMENT_NOTE,
  hydrateBankTransactions,
  listBankingAccounts,
  listBankTransactions,
  openInvoicesForBankTransaction,
  payInvoiceFromBankTransaction,
  undoBankTransaction,
} from "./banking.js";
import { createInvoiceDraft, issueInvoice } from "./finance.js";
import { setRate } from "./fx.js";
import { recordInvoicePayment, removeInvoicePayment } from "./invoicePayments.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { categorizeBankTransaction } from "./reconcile.js";

/**
 * Banking turns a deposit into an invoice payment in one step, and undoing it
 * takes exactly that payment back — never one somebody recorded on the
 * invoice by hand.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_banking";
const DEPOSIT_DAY = new Date("2026-10-18T00:00:00Z");

async function setup(accountCode = "1100") {
  await seedChartOfAccounts(CO);
  let bank = await accountByCode(CO, accountCode);
  if (!bank) {
    bank = await insert(Account, {
      companyId: CO,
      code: accountCode,
      name: "Brex Cash",
      type: "asset",
      isSystem: false,
    });
  }
  const feed = await insert(BankFeed, {
    companyId: CO,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  const acme = await insert(Customer, {
    companyId: CO,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "ap@acme.example",
    currency: "USD",
  });
  return { bank, feed, acme };
}

async function issued(customerId: string, cents: number, currency = "USD"): Promise<Invoice> {
  if (currency !== "USD") {
    await setRate(CO, currency, "USD", new Date("2026-09-30T00:00:00Z"), 1.1, "manual");
  }
  const draft = await createInvoiceDraft({
    companyId: CO,
    customerId,
    currency,
    issueDate: new Date("2026-10-01T00:00:00Z"),
    dueDate: new Date("2026-10-31T00:00:00Z"),
    lines: [{ description: "Retainer", quantity: 1, unitPriceCents: cents }],
  });
  return issueInvoice(draft);
}

async function deposit(feedId: string, cents: number, description = "ACME CORP ACH PAYMENT") {
  return insert(BankTransaction, {
    companyId: CO,
    feedId,
    externalId: null,
    date: DEPOSIT_DAY,
    amountCents: cents,
    description,
    reference: "",
    raw: "",
  });
}

async function reload<T extends { id: string }>(entity: new () => T, id: string): Promise<T> {
  return AppDataSource.getRepository(entity).findOneByOrFail({ id } as never);
}

async function paymentLines(paymentId: string): Promise<LedgerLine[]> {
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    companyId: CO,
    source: "invoice_payment",
    sourceRefId: paymentId,
  });
  return AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry.id } });
}

describe("payInvoiceFromBankTransaction", () => {
  test("records the deposit as the invoice's payment and matches it", async () => {
    const { bank, feed, acme } = await setup();
    const invoice = await issued(acme.id, 120_000);
    const txn = await deposit(feed.id, 120_000);

    const paid = await payInvoiceFromBankTransaction(txn, invoice.id, "u1");

    assert.equal(paid.invoice.status, "paid");
    assert.equal(paid.invoice.balanceCents, 0);
    const payment = paid.recorded.payment!;
    assert.equal(payment.amountCents, 120_000);
    assert.equal(payment.method, "bank_transfer");
    assert.equal(payment.paidAt.toISOString(), DEPOSIT_DAY.toISOString());
    assert.ok(payment.notes.startsWith(BANKING_PAYMENT_NOTE));
    assert.equal(paid.transaction.matchedPaymentId, payment.id);
    assert.ok(paid.transaction.reconciledAt);

    const lines = await paymentLines(payment.id);
    assert.equal(lines.find((l) => l.accountId === bank.id)?.debitCents, 120_000);

    const [hydrated] = await hydrateBankTransactions(CO, [paid.transaction]);
    assert.equal(hydrated.match?.kind, "payment");
    assert.equal(hydrated.match?.kind === "payment" && hydrated.match.recordedHere, true);
  });

  test("posts the cash to the bank account the deposit arrived in", async () => {
    const { bank, feed, acme } = await setup("1110");
    assert.equal(bank.code, "1110");
    const invoice = await issued(acme.id, 50_000);
    const txn = await deposit(feed.id, 50_000);

    const paid = await payInvoiceFromBankTransaction(txn, invoice.id, null);

    const lines = await paymentLines(paid.recorded.payment!.id);
    assert.equal(lines.find((l) => l.accountId === bank.id)?.debitCents, 50_000);
    const general = (await accountByCode(CO, "1100"))!;
    assert.equal(lines.some((l) => l.accountId === general.id), false);
  });

  test("a smaller deposit pays part of the invoice", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const paid = await payInvoiceFromBankTransaction(await deposit(feed.id, 40_000), invoice.id, null);
    assert.equal(paid.invoice.status, "sent");
    assert.equal(paid.invoice.balanceCents, 60_000);
  });

  test("refuses a deposit bigger than what is due, and records nothing", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const txn = await deposit(feed.id, 150_000);
    await assert.rejects(
      () => payInvoiceFromBankTransaction(txn, invoice.id, null),
      /\$500\.00 more than the \$1,000\.00 still due/,
    );
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
    assert.equal((await reload(BankTransaction, txn.id)).reconciledAt, null);
  });

  test("refuses money going out, a line already explained, and another currency", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    await assert.rejects(
      () => payInvoiceFromBankTransaction(txn(feed.id, -100_000), invoice.id, null),
      /Only money coming in/,
    );

    const otherIncome = (await accountByCode(CO, "4900"))!;
    const categorized = await categorizeBankTransaction(
      await deposit(feed.id, 100_000),
      otherIncome.id,
      null,
    );
    await assert.rejects(
      () => payInvoiceFromBankTransaction(categorized, invoice.id, null),
      /already matched or categorized/,
    );

    const euro = await issued(acme.id, 100_000, "EUR");
    const forEuro = await deposit(feed.id, 100_000);
    await assert.rejects(
      () => payInvoiceFromBankTransaction(forEuro, euro.id, null),
      /billed in EUR/,
    );
  });

  test("refuses an invoice that is already paid", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    await payInvoiceFromBankTransaction(await deposit(feed.id, 100_000), invoice.id, null);
    await assert.rejects(
      () => payInvoiceFromBankTransaction(txn(feed.id, 100_000), invoice.id, null),
      /already paid/,
    );
  });
});

/** An unsaved line, for refusals that never reach the database. */
function txn(feedId: string, amountCents: number): BankTransaction {
  return Object.assign(new BankTransaction(), {
    id: "unsaved",
    companyId: CO,
    feedId,
    date: DEPOSIT_DAY,
    amountCents,
    description: "",
    reference: "",
    reconciledAt: null,
  });
}

describe("undoBankTransaction", () => {
  test("takes a payment Banking recorded back off the invoice", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const paid = await payInvoiceFromBankTransaction(await deposit(feed.id, 100_000), invoice.id, null);

    const undone = await undoBankTransaction(paid.transaction, null);

    assert.equal(undone.transaction.reconciledAt, null);
    assert.equal(undone.transaction.matchedPaymentId, null);
    assert.ok(undone.removedPayment);
    const fresh = await reload(Invoice, invoice.id);
    assert.equal(fresh.status, "sent");
    assert.equal(fresh.balanceCents, 100_000);
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
    // The original posting stays, beside the reversal that undid it.
    assert.equal(
      await AppDataSource.getRepository(LedgerEntry).countBy({ companyId: CO, source: "invoice_payment" }),
      1,
    );
  });

  test("leaves a payment recorded on the invoice by hand where it is", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const recorded = await recordInvoicePayment(
      invoice,
      { amountCents: 100_000, method: "bank_transfer", reference: "WIRE-77" },
      null,
    );
    const line = await deposit(feed.id, 100_000);
    line.matchedPaymentId = recorded.payment!.id;
    line.reconciledAt = new Date();
    const matched = await AppDataSource.getRepository(BankTransaction).save(line);

    const undone = await undoBankTransaction(matched, null);

    assert.equal(undone.removedPayment, null);
    assert.equal(undone.transaction.reconciledAt, null);
    assert.equal((await reload(Invoice, invoice.id)).status, "paid");
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 1);
  });
});

describe("removeInvoicePayment", () => {
  test("sends the deposit it explained back to review", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const paid = await payInvoiceFromBankTransaction(await deposit(feed.id, 100_000), invoice.id, null);

    await removeInvoicePayment(paid.invoice, paid.recorded.payment!.id, null);

    const line = await reload(BankTransaction, paid.transaction.id);
    assert.equal(line.matchedPaymentId, null);
    assert.equal(line.reconciledAt, null);
  });
});

describe("openInvoicesForBankTransaction", () => {
  test("puts the invoice the deposit most likely pays first", async () => {
    const { feed, acme } = await setup();
    const globex = await insert(Customer, {
      companyId: CO,
      name: "Globex Inc",
      slug: "globex-inc",
      email: "ap@globex.example",
      currency: "USD",
    });
    const otherAmount = await issued(acme.id, 99_000);
    const sameAmountOtherCustomer = await issued(globex.id, 120_000);
    const best = await issued(acme.id, 120_000);
    await issued(acme.id, 120_000, "EUR");
    const paidAlready = await issued(acme.id, 120_000);
    await recordInvoicePayment(paidAlready, { amountCents: 120_000 }, null);

    const candidates = await openInvoicesForBankTransaction(await deposit(feed.id, 120_000));

    assert.deepEqual(
      candidates.map((c) => c.invoiceId),
      [best.id, sameAmountOtherCustomer.id, otherAmount.id],
    );
    assert.equal(candidates[0].exactAmount, true);
    assert.equal(candidates[0].mentioned, true);
    assert.equal(candidates[1].mentioned, false);
    assert.equal(candidates[2].exceedsBalance, true);
  });

  test("offers nothing for money going out", async () => {
    const { feed, acme } = await setup();
    await issued(acme.id, 10_000);
    assert.deepEqual(await openInvoicesForBankTransaction(await deposit(feed.id, -10_000)), []);
  });
});

describe("listBankingAccounts", () => {
  test("counts what waits on each bank account and card", async () => {
    const { feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    await deposit(feed.id, 1_000);
    await categorizeBankTransaction(await deposit(feed.id, -2_000), expense.id, null);
    const liability = (await accountByCode(CO, "2300"))!;
    const bank = (await accountByCode(CO, "1100"))!;
    const card = await insert(CardFeed, {
      companyId: CO,
      name: "Brex card",
      kind: "brex_card",
      connectionId: "conn",
      liabilityAccountId: liability.id,
      defaultExpenseAccountId: expense.id,
      paymentAccountId: bank.id,
    });
    for (const [externalId, ledgerEntryId] of [
      ["a", "entry-1"],
      ["b", null],
    ] as const) {
      await insert(CardTransaction, {
        companyId: CO,
        feedId: card.id,
        externalId,
        postedAt: DEPOSIT_DAY,
        amountCents: 500,
        currency: "USD",
        description: "AWS",
        accountingKind: "expense",
        expenseAccountId: expense.id,
        ledgerEntryId,
      });
    }

    const accounts = await listBankingAccounts(CO);

    assert.deepEqual(
      accounts.map((a) => [a.kind, a.feed.name, a.toReview, a.total]),
      [
        ["bank", "Checking", 1, 2],
        ["card", "Brex card", 1, 2],
      ],
    );
    assert.equal((await listBankTransactions(CO, { status: "review" })).length, 1);
    assert.equal((await listBankTransactions(CO, { status: "done" })).length, 1);
    assert.equal((await listBankTransactions(CO, { feedId: feed.id })).length, 2);
  });

  test("names the category a categorized transaction was filed under", async () => {
    const { feed } = await setup();
    const software = (await accountByCode(CO, "6000"))!;
    const line = await categorizeBankTransaction(await deposit(feed.id, -4_200, "GITHUB"), software.id, null);
    const [hydrated] = await hydrateBankTransactions(CO, [line]);
    assert.equal(hydrated.match?.kind, "ledger_entry");
    assert.equal(
      hydrated.match?.kind === "ledger_entry" ? hydrated.match.categoryAccountId : null,
      software.id,
    );
  });
});
