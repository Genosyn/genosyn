import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { categorizeBankTransaction, unmatch } from "./reconcile.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_bankcat";

async function setup() {
  await seedChartOfAccounts(CO);
  const bank = (await accountByCode(CO, "1100"))!;
  const feed = await insert(BankFeed, {
    companyId: CO,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  return { bank, feed };
}

async function makeTxn(feedId: string, amountCents: number): Promise<BankTransaction> {
  return insert(BankTransaction, {
    companyId: CO,
    feedId,
    externalId: null,
    date: new Date("2026-04-01T00:00:00Z"),
    amountCents,
    description: "ACME hosting",
    reference: "",
    raw: "",
  });
}

async function lines(source: string): Promise<LedgerLine[]> {
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    companyId: CO,
    source: source as LedgerEntry["source"],
  });
  assert.ok(entry, `expected a ${source} entry`);
  const ls = await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry!.id } });
  assert.equal(
    ls.reduce((s, l) => s + l.debitCents, 0),
    ls.reduce((s, l) => s + l.creditCents, 0),
  );
  return ls;
}

describe("categorizeBankTransaction", () => {
  test("money out debits the category and credits the bank", async () => {
    const { bank, feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    const txn = await makeTxn(feed.id, -5000); // money out
    const fresh = await categorizeBankTransaction(txn, expense.id, "u1");
    assert.ok(fresh.reconciledAt);
    assert.ok(fresh.matchedLedgerEntryId);
    const ls = await lines("bank_categorization");
    assert.equal(ls.find((l) => l.accountId === expense.id)!.debitCents, 5000);
    assert.equal(ls.find((l) => l.accountId === bank.id)!.creditCents, 5000);
  });

  test("money in debits the bank and credits the category", async () => {
    const { bank, feed } = await setup();
    const income = (await accountByCode(CO, "4900"))!;
    const txn = await makeTxn(feed.id, 8000); // money in
    await categorizeBankTransaction(txn, income.id, null);
    const ls = await lines("bank_categorization");
    assert.equal(ls.find((l) => l.accountId === bank.id)!.debitCents, 8000);
    assert.equal(ls.find((l) => l.accountId === income.id)!.creditCents, 8000);
  });

  test("refuses an already-reconciled line and the bank account as its own category", async () => {
    const { bank, feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    const txn = await makeTxn(feed.id, -1000);
    await assert.rejects(() => categorizeBankTransaction(txn, bank.id, null), /other than the feed/);
    await categorizeBankTransaction(txn, expense.id, null);
    const reloaded = (await AppDataSource.getRepository(BankTransaction).findOneBy({ id: txn.id }))!;
    await assert.rejects(() => categorizeBankTransaction(reloaded, expense.id, null), /already reconciled/);
  });

  test("unmatch reverses the posting and lets the line be re-categorized", async () => {
    const { feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    const txn = await makeTxn(feed.id, -3000);
    await categorizeBankTransaction(txn, expense.id, null);
    const reloaded = (await AppDataSource.getRepository(BankTransaction).findOneBy({ id: txn.id }))!;
    const cleared = await unmatch(reloaded);
    assert.equal(cleared.reconciledAt, null);
    assert.equal(cleared.matchedLedgerEntryId, null);
    await lines("bank_categorization_void"); // a reversal was posted + balances

    // Re-categorizing the same line works (no idempotency-key collision).
    const fresh = await categorizeBankTransaction(cleared, expense.id, null);
    assert.ok(fresh.reconciledAt);
  });
});
