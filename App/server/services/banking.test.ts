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
import { claimedPaymentIds } from "./bankPaymentLinks.js";
import {
  BANKING_PAYMENT_NOTE,
  hydrateBankTransactions,
  type InvoiceShare,
  listBankingAccounts,
  listBankTransactions,
  openInvoicesForBankTransaction,
  payInvoicesFromBankTransaction,
  removeBankFeed,
  undoBankTransaction,
} from "./banking.js";
import { createInvoiceDraft, issueInvoice } from "./finance.js";
import { setRate } from "./fx.js";
import { recordInvoicePayment, removeInvoicePayment } from "./invoicePayments.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { autoMatchFeed, categorizeBankTransaction, manualMatch, PARTLY_PAID } from "./reconcile.js";

/**
 * Banking turns a deposit into invoice payments in one step — one invoice, or
 * several a customer settled with one transfer — and undoing it takes exactly
 * those payments back, never one somebody recorded on an invoice by hand.
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

async function customer(name: string, slug: string) {
  return insert(Customer, {
    companyId: CO,
    name,
    slug,
    email: `ap@${slug}.example`,
    currency: "USD",
  });
}

async function issued(
  customerId: string,
  cents: number,
  currency = "USD",
  dueDate = new Date("2026-10-31T00:00:00Z"),
): Promise<Invoice> {
  if (currency !== "USD") {
    await setRate(CO, currency, "USD", new Date("2026-09-30T00:00:00Z"), 1.1, "manual");
  }
  const draft = await createInvoiceDraft({
    companyId: CO,
    customerId,
    currency,
    issueDate: new Date("2026-10-01T00:00:00Z"),
    dueDate,
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

/** What the ledger says is in a bank account. */
async function bankBalance(accountId: string): Promise<number> {
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId: CO, accountId },
  });
  return lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0);
}

/** Every share at what is still due on its invoice. */
function whole(...invoices: Invoice[]): InvoiceShare[] {
  return invoices.map((invoice) => ({ invoiceId: invoice.id, amountCents: invoice.balanceCents }));
}

/** An unsaved line, for refusals that never reach the database. */
function unsaved(feedId: string, amountCents: number): BankTransaction {
  return Object.assign(new BankTransaction(), {
    id: "unsaved",
    companyId: CO,
    feedId,
    date: DEPOSIT_DAY,
    amountCents,
    description: "",
    reference: "",
    matchedPaymentId: null,
    reconciledAt: null,
  });
}

/** Three of Acme's invoices — $1,000, $1,500 and $500, oldest due first — and the $3,000 that paid them. */
async function threeInvoiceDeposit() {
  const { bank, feed, acme } = await setup();
  const first = await issued(acme.id, 100_000, "USD", new Date("2026-10-05T00:00:00Z"));
  const second = await issued(acme.id, 150_000, "USD", new Date("2026-10-10T00:00:00Z"));
  const third = await issued(acme.id, 50_000, "USD", new Date("2026-10-15T00:00:00Z"));
  const txn = await deposit(feed.id, 300_000);
  return { bank, feed, acme, first, second, third, txn };
}

describe("payInvoicesFromBankTransaction", () => {
  test("records the deposit as the invoice's payment and matches it", async () => {
    const { bank, feed, acme } = await setup();
    const invoice = await issued(acme.id, 120_000);
    const txn = await deposit(feed.id, 120_000);

    const { transaction, paid } = await payInvoicesFromBankTransaction(txn, whole(invoice), "u1");

    assert.equal(paid.length, 1);
    assert.equal(paid[0].invoice.status, "paid");
    assert.equal(paid[0].invoice.balanceCents, 0);
    const payment = paid[0].recorded.payment;
    assert.equal(payment.amountCents, 120_000);
    assert.equal(payment.method, "bank_transfer");
    assert.equal(payment.paidAt.toISOString(), DEPOSIT_DAY.toISOString());
    assert.ok(payment.notes.startsWith(BANKING_PAYMENT_NOTE));
    assert.equal(payment.bankTransactionId, txn.id);
    assert.equal(transaction.matchedPaymentId, null);
    assert.ok(transaction.reconciledAt);
    assert.equal(transaction.reconciledById, "u1");

    const lines = await paymentLines(payment.id);
    assert.equal(lines.find((l) => l.accountId === bank.id)?.debitCents, 120_000);

    const [hydrated] = await hydrateBankTransactions(CO, [transaction]);
    assert.equal(hydrated.match?.kind, "payments");
    assert.deepEqual(
      hydrated.match?.kind === "payments"
        ? hydrated.match.payments.map((p) => [p.invoiceId, p.amountCents, p.recordedHere])
        : null,
      [[invoice.id, 120_000, true]],
    );
  });

  test("posts the cash to the bank account the deposit arrived in", async () => {
    const { bank, feed, acme } = await setup("1110");
    assert.equal(bank.code, "1110");
    const invoice = await issued(acme.id, 50_000);
    const txn = await deposit(feed.id, 50_000);

    const { paid } = await payInvoicesFromBankTransaction(txn, whole(invoice), null);

    const lines = await paymentLines(paid[0].recorded.payment.id);
    assert.equal(lines.find((l) => l.accountId === bank.id)?.debitCents, 50_000);
    const general = (await accountByCode(CO, "1100"))!;
    assert.equal(
      lines.some((l) => l.accountId === general.id),
      false,
    );
  });

  test("pays several invoices with one deposit", async () => {
    const { bank, first, second, third, txn } = await threeInvoiceDeposit();

    const { transaction, paid } = await payInvoicesFromBankTransaction(
      txn,
      whole(third, first, second),
      "u1",
    );

    assert.ok(transaction.reconciledAt);
    assert.deepEqual(
      paid.map((p) => [p.invoice.id, p.invoice.status, p.recorded.payment.amountCents]),
      [
        [third.id, "paid", 50_000],
        [first.id, "paid", 100_000],
        [second.id, "paid", 150_000],
      ],
    );
    const payments = await AppDataSource.getRepository(InvoicePayment).find();
    assert.equal(payments.length, 3);
    assert.ok(payments.every((p) => p.bankTransactionId === txn.id));
    assert.equal(await bankBalance(bank.id), 300_000);

    const [hydrated] = await hydrateBankTransactions(CO, [transaction]);
    assert.deepEqual(
      hydrated.match?.kind === "payments"
        ? hydrated.match.payments.map((p) => [p.invoiceNumber, p.amountCents])
        : null,
      [
        [first.number, 100_000],
        [second.number, 150_000],
        [third.number, 50_000],
      ],
    );
  });

  test("a share can pay part of an invoice", async () => {
    const { feed, acme } = await setup();
    const small = await issued(acme.id, 100_000);
    const large = await issued(acme.id, 100_000);
    const txn = await deposit(feed.id, 140_000);

    const { paid } = await payInvoicesFromBankTransaction(
      txn,
      [
        { invoiceId: small.id, amountCents: 100_000 },
        { invoiceId: large.id, amountCents: 40_000 },
      ],
      null,
    );

    assert.deepEqual(
      paid.map((p) => [p.invoice.status, p.invoice.balanceCents]),
      [
        ["paid", 0],
        ["sent", 60_000],
      ],
    );
  });

  test("refuses shares that don't add up to the deposit, and records nothing", async () => {
    const { first, second, third, txn } = await threeInvoiceDeposit();
    await assert.rejects(
      () => payInvoicesFromBankTransaction(txn, whole(first, second), null),
      /add up to \$2,500\.00, \$500\.00 less than the \$3,000\.00 deposit/,
    );
    await assert.rejects(
      () =>
        payInvoicesFromBankTransaction(
          txn,
          [...whole(first, second), { invoiceId: third.id, amountCents: 50_001 }],
          null,
        ),
      /add up to \$3,000\.01, \$0\.01 more than the \$3,000\.00 deposit/,
    );
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
    assert.equal((await reload(BankTransaction, txn.id)).reconciledAt, null);
  });

  test("refuses a share bigger than what is due, and records nothing", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const txn = await deposit(feed.id, 150_000);
    await assert.rejects(
      () =>
        payInvoicesFromBankTransaction(
          txn,
          [{ invoiceId: invoice.id, amountCents: 150_000 }],
          null,
        ),
      /\$1,500\.00 is more than the \$1,000\.00 still due on/,
    );
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
    assert.equal((await reload(BankTransaction, txn.id)).reconciledAt, null);
  });

  test("refuses money going out, a line already explained, another currency, and one invoice twice", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    await assert.rejects(
      () => payInvoicesFromBankTransaction(unsaved(feed.id, -100_000), whole(invoice), null),
      /Only money coming in/,
    );

    const otherIncome = (await accountByCode(CO, "4900"))!;
    const categorized = await categorizeBankTransaction(
      await deposit(feed.id, 100_000),
      otherIncome.id,
      null,
    );
    await assert.rejects(
      () => payInvoicesFromBankTransaction(categorized, whole(invoice), null),
      /already matched or categorized/,
    );

    const euro = await issued(acme.id, 100_000, "EUR");
    const forEuro = await deposit(feed.id, 100_000);
    await assert.rejects(
      () => payInvoicesFromBankTransaction(forEuro, whole(euro), null),
      /billed in EUR/,
    );

    const twice = await deposit(feed.id, 100_000);
    await assert.rejects(
      () =>
        payInvoicesFromBankTransaction(
          twice,
          [
            { invoiceId: invoice.id, amountCents: 50_000 },
            { invoiceId: invoice.id, amountCents: 50_000 },
          ],
          null,
        ),
      /listed only once/,
    );
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
  });

  test("refuses an invoice that is already paid", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    await payInvoicesFromBankTransaction(await deposit(feed.id, 100_000), whole(invoice), null);
    const again = await deposit(feed.id, 100_000);
    await assert.rejects(
      () =>
        payInvoicesFromBankTransaction(
          again,
          [{ invoiceId: invoice.id, amountCents: 100_000 }],
          null,
        ),
      /already paid/,
    );
  });

  test("is all or nothing: a payment that can't be recorded takes back the ones before it", async () => {
    const { bank, first, second, third, txn } = await threeInvoiceDeposit();
    // The ledger refuses the second invoice's payment, after the first is in.
    await AppDataSource.query(
      `CREATE TRIGGER refuse_second BEFORE INSERT ON ledger_entries
       WHEN NEW.memo LIKE 'Payment for ${second.number}%'
       BEGIN SELECT RAISE(ABORT, 'ledger refused'); END`,
    );

    await assert.rejects(
      () => payInvoicesFromBankTransaction(txn, whole(first, second, third), null),
      /ledger refused/,
    );

    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
    for (const invoice of [first, second, third]) {
      const fresh = await reload(Invoice, invoice.id);
      assert.equal(fresh.status, "sent");
      assert.equal(fresh.balanceCents, invoice.balanceCents);
    }
    const line = await reload(BankTransaction, txn.id);
    assert.equal(line.reconciledAt, null);
    assert.equal(
      await AppDataSource.getRepository(LedgerEntry).countBy({
        companyId: CO,
        source: "invoice_payment",
      }),
      1,
      "the first payment was in the books before the ledger refused the second",
    );
    assert.equal(await bankBalance(bank.id), 0, "and its posting is reversed");
  });

  test("two requests for one deposit can't both pay it", async () => {
    const { first, second, third, txn } = await threeInvoiceDeposit();
    const [one, two] = [
      await reload(BankTransaction, txn.id),
      await reload(BankTransaction, txn.id),
    ];
    const results = await Promise.allSettled([
      payInvoicesFromBankTransaction(one, whole(first, second, third), null),
      payInvoicesFromBankTransaction(two, whole(first, second, third), null),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 3);
    assert.equal((await reload(Invoice, first.id)).paidCents, 100_000);
  });
});

describe("undoBankTransaction", () => {
  test("takes every payment Banking recorded back off its invoice", async () => {
    const { bank, first, second, third, txn } = await threeInvoiceDeposit();
    const { transaction } = await payInvoicesFromBankTransaction(
      txn,
      whole(first, second, third),
      null,
    );

    const undone = await undoBankTransaction(transaction, null);

    assert.equal(undone.transaction.reconciledAt, null);
    assert.equal(undone.removedPayments.length, 3);
    for (const invoice of [first, second, third]) {
      const fresh = await reload(Invoice, invoice.id);
      assert.equal(fresh.status, "sent");
      assert.equal(fresh.balanceCents, invoice.balanceCents);
    }
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
    // The original postings stay, beside the reversals that undid them.
    assert.equal(
      await AppDataSource.getRepository(LedgerEntry).countBy({
        companyId: CO,
        source: "invoice_payment",
      }),
      3,
    );
    assert.equal(await bankBalance(bank.id), 0);
  });

  test("leaves a payment recorded on the invoice by hand where it is", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const recorded = await recordInvoicePayment(
      invoice,
      { amountCents: 100_000, method: "bank_transfer", reference: "WIRE-77" },
      null,
    );
    const matched = await manualMatch(
      await deposit(feed.id, 100_000),
      { paymentId: recorded.payment!.id },
      null,
    );
    const [hydrated] = await hydrateBankTransactions(CO, [matched]);
    assert.equal(
      hydrated.match?.kind === "payments" ? hydrated.match.payments[0].recordedHere : null,
      false,
    );

    const undone = await undoBankTransaction(matched, null);

    assert.deepEqual(undone.removedPayments, []);
    assert.equal(undone.transaction.reconciledAt, null);
    assert.equal((await reload(Invoice, invoice.id)).status, "paid");
    const payment = await reload(InvoicePayment, recorded.payment!.id);
    assert.equal(payment.bankTransactionId, null, "only the link goes");
  });

  test("still takes back a payment an older match links through the transaction", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    // How Banking linked its one payment before a deposit could pay several.
    const recorded = await recordInvoicePayment(
      invoice,
      {
        amountCents: 100_000,
        method: "bank_transfer",
        notes: `${BANKING_PAYMENT_NOTE} Checking · ACME`,
      },
      null,
    );
    const line = await deposit(feed.id, 100_000);
    line.matchedPaymentId = recorded.payment!.id;
    line.reconciledAt = new Date();
    const older = await AppDataSource.getRepository(BankTransaction).save(line);

    const [hydrated] = await hydrateBankTransactions(CO, [older]);
    assert.deepEqual(
      hydrated.match?.kind === "payments"
        ? hydrated.match.payments.map((p) => [p.paymentId, p.recordedHere])
        : null,
      [[recorded.payment!.id, true]],
    );
    assert.equal((await claimedPaymentIds(CO)).get(recorded.payment!.id), older.id);

    const undone = await undoBankTransaction(older, null);

    assert.equal(undone.removedPayments.length, 1);
    assert.equal(undone.transaction.matchedPaymentId, null);
    assert.equal(undone.transaction.reconciledAt, null);
    assert.equal((await reload(Invoice, invoice.id)).balanceCents, 100_000);
  });
});

describe("removeInvoicePayment", () => {
  test("sends the deposit it came in back to review", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const { transaction, paid } = await payInvoicesFromBankTransaction(
      await deposit(feed.id, 100_000),
      whole(invoice),
      null,
    );

    await removeInvoicePayment(paid[0].invoice, paid[0].recorded.payment.id, null);

    const line = await reload(BankTransaction, transaction.id);
    assert.equal(line.reconciledAt, null);
    assert.equal((await hydrateBankTransactions(CO, [line]))[0].match, null);
  });

  test("keeps the deposit's other payments, and what is left of it can be paid again or undone", async () => {
    const { first, second, third, txn } = await threeInvoiceDeposit();
    const { paid } = await payInvoicesFromBankTransaction(txn, whole(first, second, third), null);
    const forSecond = paid.find((p) => p.invoice.id === second.id)!;

    await removeInvoicePayment(forSecond.invoice, forSecond.recorded.payment.id, null);

    const line = await reload(BankTransaction, txn.id);
    assert.equal(line.reconciledAt, null, "the deposit is back in review");
    const [hydrated] = await hydrateBankTransactions(CO, [line]);
    assert.deepEqual(
      hydrated.match?.kind === "payments" ? hydrated.match.payments.map((p) => p.invoiceId) : null,
      [first.id, third.id],
      "the other invoices stay paid from it",
    );

    const options = await openInvoicesForBankTransaction(line);
    assert.equal(options.remainingCents, 150_000);
    assert.equal(options.invoices[0].invoiceId, second.id);
    assert.equal(options.invoices[0].exactAmount, true);

    // The rest of it can't be explained some other way while part pays invoices.
    const otherIncome = (await accountByCode(CO, "4900"))!;
    await assert.rejects(() => categorizeBankTransaction(line, otherIncome.id, null), {
      message: PARTLY_PAID,
    });
    await assert.rejects(
      () => manualMatch(line, { ledgerEntryId: "00000000-0000-0000-0000-000000000000" }, null),
      { message: PARTLY_PAID },
    );
    await assert.rejects(
      () => payInvoicesFromBankTransaction(line, whole(first, second, third), null),
      /\$1,500\.00 left of this deposit/,
    );

    const { transaction } = await payInvoicesFromBankTransaction(
      line,
      [{ invoiceId: second.id, amountCents: 150_000 }],
      null,
    );
    assert.ok(transaction.reconciledAt);

    const undone = await undoBankTransaction(transaction, null);
    assert.equal(undone.removedPayments.length, 3);
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 0);
  });
});

describe("matching a deposit to a payment already recorded", () => {
  test("a payment recorded from one deposit can't be matched to another", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const { paid } = await payInvoicesFromBankTransaction(
      await deposit(feed.id, 100_000),
      whole(invoice),
      null,
    );

    await assert.rejects(
      () =>
        manualMatch(unsaved(feed.id, 100_000), { paymentId: paid[0].recorded.payment.id }, null),
      /already matched to the bank line from 2026-10-18/,
    );
  });

  test("auto-match links one payment to one deposit, and skips one already in a deposit", async () => {
    const { feed, acme } = await setup();
    const byHand = await issued(acme.id, 50_000);
    const recorded = await recordInvoicePayment(
      byHand,
      { amountCents: 50_000, method: "bank_transfer", paidAt: DEPOSIT_DAY, reference: "ACH-1" },
      null,
    );
    const fromBanking = await issued(acme.id, 70_000);
    await payInvoicesFromBankTransaction(await deposit(feed.id, 70_000), whole(fromBanking), null);
    const first = await deposit(feed.id, 50_000, "ACH 1");
    const second = await deposit(feed.id, 50_000, "ACH 2");
    const sameAsBanking = await deposit(feed.id, 70_000, "ACH 3");

    assert.equal(await autoMatchFeed(feed), 1);

    const payment = await reload(InvoicePayment, recorded.payment!.id);
    const matched = [first, second].find((line) => line.id === payment.bankTransactionId);
    assert.ok(matched, "the payment is linked to one of the two deposits");
    const other = first.id === matched.id ? second : first;
    assert.equal((await reload(BankTransaction, matched.id)).reconciledById, null);
    assert.ok((await reload(BankTransaction, matched.id)).reconciledAt);
    assert.equal((await reload(BankTransaction, other.id)).reconciledAt, null);
    assert.equal((await reload(BankTransaction, sameAsBanking.id)).reconciledAt, null);
  });

  test("auto-match leaves a deposit that already paid some invoices for a person", async () => {
    const { feed, acme, first, second, third, txn } = await threeInvoiceDeposit();
    const { paid } = await payInvoicesFromBankTransaction(txn, whole(first, second, third), null);
    const forThird = paid.find((p) => p.invoice.id === third.id)!;
    await removeInvoicePayment(forThird.invoice, forThird.recorded.payment.id, null);
    // A payment of the whole deposit's amount, recorded by hand the same day.
    const big = await issued(acme.id, 300_000);
    await recordInvoicePayment(
      big,
      { amountCents: 300_000, method: "bank_transfer", paidAt: DEPOSIT_DAY, reference: "ACH-9" },
      null,
    );

    assert.equal(await autoMatchFeed(feed), 0);
    assert.equal((await reload(BankTransaction, txn.id)).reconciledAt, null);
  });
});

describe("openInvoicesForBankTransaction", () => {
  test("puts the invoice the deposit most likely pays first", async () => {
    const { feed, acme } = await setup();
    const globex = await customer("Globex Inc", "globex-inc");
    const otherAmount = await issued(acme.id, 99_000);
    const sameAmountOtherCustomer = await issued(globex.id, 120_000);
    const best = await issued(acme.id, 120_000);
    await issued(acme.id, 120_000, "EUR");
    const paidAlready = await issued(acme.id, 120_000);
    await recordInvoicePayment(paidAlready, { amountCents: 120_000 }, null);

    const options = await openInvoicesForBankTransaction(await deposit(feed.id, 120_000));

    assert.equal(options.remainingCents, 120_000);
    assert.deepEqual(
      options.invoices.map((c) => c.invoiceId),
      [best.id, sameAmountOtherCustomer.id, otherAmount.id],
    );
    assert.equal(options.invoices[0].exactAmount, true);
    assert.equal(options.invoices[0].mentioned, true);
    assert.equal(options.invoices[1].mentioned, false);
    assert.deepEqual(options.sets, []);
  });

  test("suggests one customer's invoices that add up to exactly the deposit", async () => {
    const { feed, acme, first, second, third } = await threeInvoiceDeposit();
    // Acme's newest invoice pays $3,000 with the oldest too — but customers
    // usually clear their oldest invoices first.
    await issued(acme.id, 200_000, "USD", new Date("2026-10-20T00:00:00Z"));
    const globex = await customer("Globex Inc", "globex-inc");
    const g1 = await issued(globex.id, 100_000, "USD", new Date("2026-10-01T00:00:00Z"));
    const g2 = await issued(globex.id, 200_000, "USD", new Date("2026-10-02T00:00:00Z"));
    // Never across customers: Initech's $1,000 and Acme's $2,000 add up too.
    const initech = await customer("Initech", "initech");
    await issued(initech.id, 100_000);

    const options = await openInvoicesForBankTransaction(
      await deposit(feed.id, 300_000, "ACME CORP ACH PAYMENT"),
    );

    assert.deepEqual(options.sets, [
      { customerName: "Acme Corp", invoiceIds: [first.id, second.id, third.id] },
      { customerName: "Globex Inc", invoiceIds: [g1.id, g2.id] },
    ]);
    assert.deepEqual(
      options.invoices
        .slice(0, 3)
        .map((c) => c.invoiceId)
        .sort(),
      [first.id, second.id, third.id].sort(),
      "the best set's invoices lead the list",
    );
  });

  test("offers nothing for money going out", async () => {
    const { feed, acme } = await setup();
    await issued(acme.id, 10_000);
    const options = await openInvoicesForBankTransaction(await deposit(feed.id, -10_000));
    assert.deepEqual(options, { remainingCents: 0, invoices: [], sets: [] });
  });
});

describe("removeBankFeed", () => {
  test("takes the account's transactions off and leaves their payments on the invoices", async () => {
    const { feed, acme } = await setup();
    const invoice = await issued(acme.id, 100_000);
    const { paid } = await payInvoicesFromBankTransaction(
      await deposit(feed.id, 100_000),
      whole(invoice),
      null,
    );

    await removeBankFeed(feed);

    assert.equal(await AppDataSource.getRepository(BankTransaction).count(), 0);
    assert.equal(await AppDataSource.getRepository(BankFeed).count(), 0);
    const payment = await reload(InvoicePayment, paid[0].recorded.payment.id);
    assert.equal(payment.bankTransactionId, null);
    assert.equal((await reload(Invoice, invoice.id)).status, "paid");
    assert.equal((await claimedPaymentIds(CO)).size, 0);
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
    const line = await categorizeBankTransaction(
      await deposit(feed.id, -4_200, "GITHUB"),
      software.id,
      null,
    );
    const [hydrated] = await hydrateBankTransactions(CO, [line]);
    assert.equal(hydrated.match?.kind, "ledger_entry");
    assert.equal(
      hydrated.match?.kind === "ledger_entry" ? hydrated.match.categoryAccountId : null,
      software.id,
    );
  });
});
