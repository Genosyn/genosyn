import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Customer } from "../db/entities/Customer.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Invoice } from "../db/entities/Invoice.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import {
  balancesByCode,
  type CardBooks,
  cardBooks,
  cardPurchase,
  reload,
} from "../test/cardFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  hydrateBankTransactions,
  listBankingAccounts,
  payInvoicesFromBankTransaction,
} from "./banking.js";
import { bulkBanking } from "./bankingBulk.js";
import { listCardTransactions, reclassifyCardTransaction, syncCardFeed } from "./cardExpenses.js";
import { createInvoiceDraft, issueInvoice } from "./finance.js";
import { encryptConnectionConfig } from "./integrations.js";
import { accountByCode, postLedgerEntry } from "./ledger.js";
import { categorizeBankTransaction, manualMatch } from "./reconcile.js";

/**
 * Banking's bulk bar sends each transaction through the helper its own row
 * uses, so a hundred at once leave the books exactly as a hundred one at a
 * time would — and anything that can't take the action stays as it was, with
 * the reason, instead of failing the rest.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_banking_bulk";
const DAY = new Date("2026-03-18T00:00:00Z");
const AMOUNT = 12_000;

let books: CardBooks;
let bankFeed: BankFeed;

beforeEach(async () => {
  books = await cardBooks(CO);
  bankFeed = await insert(BankFeed, {
    companyId: CO,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: books.bank.id,
  });
});

async function bankLine(cents: number, description = "GITHUB"): Promise<BankTransaction> {
  return insert(BankTransaction, {
    companyId: CO,
    feedId: bankFeed.id,
    externalId: null,
    date: DAY,
    amountCents: cents,
    description,
    reference: "",
    raw: "",
  });
}

/** A card purchase in the books under the card's default category, waiting or reviewed. */
async function purchase(needsReview: boolean, cents = AMOUNT): Promise<CardTransaction> {
  const { card } = await cardPurchase(books.feed, { cents });
  await AppDataSource.getRepository(CardTransaction).update({ id: card.id }, { needsReview });
  return reload(CardTransaction, card.id);
}

async function cardBillPayment(): Promise<CardTransaction> {
  return insert(CardTransaction, {
    companyId: CO,
    feedId: books.feed.id,
    externalId: randomUUID(),
    postedAt: DAY,
    amountCents: -AMOUNT,
    currency: "USD",
    description: "Payment - Thank you!",
    accountingKind: "payment",
    expenseAccountId: null,
    ledgerEntryId: "entry-payment",
  });
}

async function entryCount(): Promise<number> {
  return AppDataSource.getRepository(LedgerEntry).count({ where: { companyId: CO } });
}

async function categoryOf(txn: BankTransaction): Promise<string | null> {
  const [hydrated] = await hydrateBankTransactions(CO, [await reload(BankTransaction, txn.id)]);
  return hydrated.match?.kind === "ledger_entry" ? hydrated.match.categoryAccountId : null;
}

describe("categorize", () => {
  test("files bank transactions in review and card purchases under one category", async () => {
    const github = await bankLine(-4_200);
    const done = await categorizeBankTransaction(
      await bankLine(-900, "STRIPE FEE"),
      books.general.id,
      "u1",
    );
    const waiting = await purchase(true);
    const reviewed = await purchase(false);
    const payment = await cardBillPayment();

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "categorize",
      accountId: books.software.id,
      bankTransactionIds: [github.id, done.id],
      cardTransactionIds: [waiting.id, reviewed.id, payment.id],
    });

    assert.deepEqual(result.succeeded, { bank: [github.id], card: [waiting.id, reviewed.id] });
    assert.deepEqual(
      result.skipped.map(({ kind, id }) => [kind, id]),
      [
        ["bank", done.id],
        ["card", payment.id],
      ],
    );
    assert.match(result.skipped[0].reason, /already done/);
    assert.deepEqual(
      result.categorized.map((txn) => txn.id),
      [github.id],
    );
    assert.equal(await categoryOf(github), books.software.id);
    assert.equal(await categoryOf(done), books.general.id, "a done transaction stays as it was");
    for (const card of [waiting, reviewed]) {
      const fresh = await reload(CardTransaction, card.id);
      assert.equal(fresh.expenseAccountId, books.software.id);
      assert.equal(fresh.needsReview, false, "picking a category reviews it");
    }
    // Both purchases moved out of 6000, the bank fee stayed in it, and GitHub
    // came out of the bank into Software.
    assert.deepEqual(await balancesByCode(CO), {
      "1100": -5_100,
      "2300": -2 * AMOUNT,
      "6000": 900,
      "6300": 2 * AMOUNT + 4_200,
    });
  });

  test("files card purchases only under an expense category", async () => {
    const interest = await bankLine(2_500, "INTEREST");
    const card = await purchase(true);
    const otherIncome = (await accountByCode(CO, "4900"))!;

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "categorize",
      accountId: otherIncome.id,
      bankTransactionIds: [interest.id],
      cardTransactionIds: [card.id],
    });

    assert.deepEqual(result.succeeded, { bank: [interest.id], card: [] });
    assert.deepEqual(result.skipped, [
      { kind: "card", id: card.id, reason: "A card purchase is filed under an expense category" },
    ]);
    const fresh = await reload(CardTransaction, card.id);
    assert.equal(fresh.expenseAccountId, books.general.id);
    assert.equal(fresh.needsReview, true);
  });

  test("posts a card purchase that couldn't be added to the books, under the new category", async () => {
    const failed = await insert(CardTransaction, {
      companyId: CO,
      feedId: books.feed.id,
      externalId: randomUUID(),
      postedAt: DAY,
      amountCents: AMOUNT,
      currency: "USD",
      description: "Delta Air Lines",
      accountingKind: "expense",
      expenseAccountId: books.general.id,
      ledgerEntryId: null,
      postingError: "Exchange rate missing",
      needsReview: true,
    });

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "categorize",
      accountId: books.travel.id,
      bankTransactionIds: [],
      cardTransactionIds: [failed.id],
    });

    assert.deepEqual(result.succeeded.card, [failed.id]);
    const fresh = await reload(CardTransaction, failed.id);
    assert.ok(fresh.ledgerEntryId);
    assert.equal(fresh.postingError, "");
    assert.equal(fresh.needsReview, false);
    assert.deepEqual(await balancesByCode(CO), { "2300": -AMOUNT, "6200": AMOUNT });
  });

  test("refuses a category that doesn't exist or is archived, before touching anything", async () => {
    const card = await purchase(true);
    const archived = await insert(Account, {
      companyId: CO,
      code: "6950",
      name: "Old travel",
      type: "expense",
      archivedAt: new Date(),
    });
    for (const accountId of [randomUUID(), archived.id]) {
      await assert.rejects(
        bulkBanking({
          companyId: CO,
          actorUserId: "u1",
          action: "categorize",
          accountId,
          bankTransactionIds: [],
          cardTransactionIds: [card.id],
        }),
        accountId === archived.id ? /6950 Old travel is archived/ : /Category not found/,
      );
    }
    assert.equal((await reload(CardTransaction, card.id)).expenseAccountId, books.general.id);
  });

  test("never reaches another company's transactions", async () => {
    const other = await insert(BankTransaction, {
      companyId: "co_other",
      feedId: bankFeed.id,
      externalId: null,
      date: DAY,
      amountCents: -100,
      description: "Not ours",
      reference: "",
      raw: "",
    });
    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "categorize",
      accountId: books.software.id,
      bankTransactionIds: [other.id],
      cardTransactionIds: [],
    });
    assert.deepEqual(result.skipped, [
      { kind: "bank", id: other.id, reason: "Transaction not found" },
    ]);
    assert.equal((await reload(BankTransaction, other.id)).reconciledAt, null);
  });
});

describe("mark reviewed", () => {
  test("moves waiting card purchases to Done and leaves their books alone", async () => {
    const waiting = await purchase(true);
    const unposted = await insert(CardTransaction, {
      companyId: CO,
      feedId: books.feed.id,
      externalId: randomUUID(),
      postedAt: DAY,
      amountCents: AMOUNT,
      currency: "USD",
      description: "Hotel",
      accountingKind: "expense",
      expenseAccountId: books.general.id,
      ledgerEntryId: null,
      needsReview: true,
    });
    const before = { entries: await entryCount(), balances: await balancesByCode(CO) };

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "mark_reviewed",
      bankTransactionIds: [],
      cardTransactionIds: [waiting.id, unposted.id],
    });

    assert.deepEqual(result.succeeded.card, [waiting.id]);
    assert.deepEqual(result.skipped, [
      {
        kind: "card",
        id: unposted.id,
        reason: "It isn't in your books yet, so retry it first",
      },
    ]);
    assert.equal((await reload(CardTransaction, waiting.id)).needsReview, false);
    assert.equal((await reload(CardTransaction, waiting.id)).expenseAccountId, books.general.id);
    assert.deepEqual({ entries: await entryCount(), balances: await balancesByCode(CO) }, before);
  });

  test("can't mark a bank transaction reviewed without explaining it", async () => {
    const open = await bankLine(-300);
    const done = await categorizeBankTransaction(await bankLine(-400), books.general.id, "u1");
    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "mark_reviewed",
      bankTransactionIds: [open.id, done.id],
      cardTransactionIds: [],
    });
    assert.deepEqual(result.succeeded.bank, [done.id]);
    assert.deepEqual(
      result.skipped.map(({ id }) => id),
      [open.id],
    );
    assert.equal((await reload(BankTransaction, open.id)).reconciledAt, null);
  });
});

describe("send to review", () => {
  test("card purchases go back with their categories, and their books stay as they are", async () => {
    const card = await purchase(false);
    await reclassifyCardTransaction(card, books.travel.id, "u1");
    const before = { entries: await entryCount(), balances: await balancesByCode(CO) };

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "send_to_review",
      bankTransactionIds: [],
      cardTransactionIds: [card.id],
    });

    assert.deepEqual(result.succeeded.card, [card.id]);
    const fresh = await reload(CardTransaction, card.id);
    assert.equal(fresh.needsReview, true);
    assert.equal(fresh.expenseAccountId, books.travel.id);
    assert.deepEqual({ entries: await entryCount(), balances: await balancesByCode(CO) }, before);
    assert.deepEqual(
      (await listCardTransactions(CO, undefined, "review")).map((txn) => txn.id),
      [card.id],
    );
  });

  test("reverses a category and unlinks a match, as each row's own Undo would", async () => {
    const categorized = await categorizeBankTransaction(
      await bankLine(-4_200),
      books.software.id,
      "u1",
    );
    const { entry } = await postLedgerEntry({
      companyId: CO,
      date: DAY,
      memo: "Rent, paid by hand",
      source: "manual",
      sourceRefId: null,
      createdById: "u1",
      lines: [
        { accountId: books.office.id, debitCents: 50_000 },
        { accountId: books.bank.id, creditCents: 50_000 },
      ],
    });
    const matched = await manualMatch(
      await bankLine(-50_000, "RENT"),
      { ledgerEntryId: entry.id },
      "u1",
    );

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "send_to_review",
      bankTransactionIds: [categorized.id, matched.id],
      cardTransactionIds: [],
    });

    assert.deepEqual(result.succeeded.bank, [categorized.id, matched.id]);
    for (const id of [categorized.id, matched.id]) {
      const fresh = await reload(BankTransaction, id);
      assert.equal(fresh.reconciledAt, null);
      assert.equal(fresh.matchedLedgerEntryId, null);
    }
    // The category is reversed; the rent entry someone recorded stays.
    assert.deepEqual(await balancesByCode(CO), { "1100": -50_000, "6500": 50_000 });
  });

  test("leaves a deposit that paid invoices for its own Undo", async () => {
    const acme = await insert(Customer, {
      companyId: CO,
      name: "Acme Corp",
      slug: "acme-corp",
      email: "ap@acme.example",
      currency: "USD",
    });
    const invoice = await issueInvoice(
      await createInvoiceDraft({
        companyId: CO,
        customerId: acme.id,
        currency: "USD",
        issueDate: new Date("2026-03-01T00:00:00Z"),
        dueDate: new Date("2026-03-31T00:00:00Z"),
        lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 80_000 }],
      }),
    );
    const deposit = await bankLine(80_000, "ACME CORP ACH");
    await payInvoicesFromBankTransaction(
      deposit,
      [{ invoiceId: invoice.id, amountCents: 80_000 }],
      "u1",
    );

    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "send_to_review",
      bankTransactionIds: [deposit.id],
      cardTransactionIds: [],
    });

    assert.deepEqual(result.succeeded.bank, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /paid invoices/);
    assert.ok((await reload(BankTransaction, deposit.id)).reconciledAt);
    assert.equal((await reload(Invoice, invoice.id)).status, "paid");
  });

  test("a card bill payment has nothing to send back", async () => {
    const payment = await cardBillPayment();
    const result = await bulkBanking({
      companyId: CO,
      actorUserId: "u1",
      action: "send_to_review",
      bankTransactionIds: [],
      cardTransactionIds: [payment.id],
    });
    assert.deepEqual(result.skipped, [
      { kind: "card", id: payment.id, reason: "A card bill payment has no category to review" },
    ]);
    assert.equal((await reload(CardTransaction, payment.id)).needsReview, false);
  });
});

describe("card purchases waiting for review", () => {
  test("count toward To review and list there until someone looks at them", async () => {
    const waiting = await purchase(true);
    const reviewed = await purchase(false);
    const unposted = await insert(CardTransaction, {
      companyId: CO,
      feedId: books.feed.id,
      externalId: randomUUID(),
      postedAt: DAY,
      amountCents: AMOUNT,
      currency: "USD",
      description: "Hotel",
      accountingKind: "expense",
      expenseAccountId: books.general.id,
      ledgerEntryId: null,
    });

    const [card] = (await listBankingAccounts(CO)).filter((account) => account.kind === "card");
    assert.deepEqual([card.toReview, card.total], [2, 3]);
    const ids = async (status: "review" | "done") =>
      (await listCardTransactions(CO, books.feed.id, status)).map((txn) => txn.id).sort();
    assert.deepEqual(await ids("review"), [waiting.id, unposted.id].sort());
    assert.deepEqual(await ids("done"), [reviewed.id]);
  });

  test("picking the category a purchase already has reviews it, and posts nothing", async () => {
    const waiting = await purchase(true);
    const before = await entryCount();
    await reclassifyCardTransaction(waiting, books.general.id, "u1");
    assert.equal((await reload(CardTransaction, waiting.id)).needsReview, false);
    assert.equal(await entryCount(), before);
  });

  test("new purchases and refunds arrive waiting; card bill payments don't", async (t) => {
    const connection = await insert(IntegrationConnection, {
      companyId: CO,
      provider: "brex",
      label: "Brex",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ userToken: "brex-token" }, CO),
    });
    await AppDataSource.getRepository(CardFeed).update(
      { id: books.feed.id },
      { connectionId: connection.id },
    );
    const remote = (id: string, type: string, cents: number) => ({
      id,
      card_id: "card_074k",
      description: id,
      type,
      posted_at_date: "2026-03-18",
      amount: { amount: cents, currency: "USD" },
    });
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        items: [
          remote("purchase", "PURCHASE", 4_200),
          remote("refund", "REFUND", -1_000),
          remote("payment", "COLLECTION", -9_000),
        ],
        next_cursor: null,
      }),
    );

    const synced = await syncCardFeed(await reload(CardFeed, books.feed.id));

    assert.equal(synced.inserted, 3);
    const rows = await AppDataSource.getRepository(CardTransaction).find({
      where: { feedId: books.feed.id },
    });
    assert.deepEqual(
      Object.fromEntries(
        rows.map((row) => [row.externalId, [row.accountingKind, row.needsReview]]),
      ),
      {
        purchase: ["expense", true],
        refund: ["refund", true],
        payment: ["payment", false],
      },
    );
  });
});
