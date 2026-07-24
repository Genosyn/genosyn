import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "./ledger.js";
import {
  categorizeBankTransaction,
  findMatchCandidates,
  manualMatch,
  unmatch,
} from "./reconcile.js";

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

describe("findMatchCandidates — ledger entries (P2)", () => {
  // Post a manual DR expense / CR bank entry — the money-out shape that
  // invoice-payment matching alone could never reach.
  async function postManualOut(bankId: string, expenseId: string, amountCents: number) {
    const { entry } = await postLedgerEntry({
      companyId: CO,
      date: new Date("2026-04-01T00:00:00Z"),
      memo: "Rent",
      source: "manual",
      sourceRefId: null,
      createdById: null,
      lines: [
        { accountId: expenseId, debitCents: amountCents, creditCents: 0, description: "" },
        { accountId: bankId, debitCents: 0, creditCents: amountCents, description: "" },
      ],
    });
    return entry;
  }

  test("surfaces a manual money-out entry on the bank account as a candidate", async () => {
    const { bank, feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    await postManualOut(bank.id, expense.id, 4000);
    const txn = await makeTxn(feed.id, -4000); // money out, same amount

    const candidates = await findMatchCandidates(txn);
    const led = candidates.filter((c) => c.kind === "ledger_entry");
    assert.equal(led.length, 1, "the manual entry should be the sole ledger candidate");
    assert.equal(led[0].amountCents, -4000, "reported signed as money out");
    assert.equal(led[0].source, "manual");
  });

  test("a matched entry is not offered again to a second like-amount line", async () => {
    const { bank, feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    const entry = await postManualOut(bank.id, expense.id, 4000);
    const first = await makeTxn(feed.id, -4000);
    const second = await makeTxn(feed.id, -4000);

    const matched = await manualMatch(first, { ledgerEntryId: entry.id }, "u1");
    assert.equal(matched.matchedLedgerEntryId, entry.id);

    const candidates = await findMatchCandidates(second);
    assert.equal(
      candidates.filter((c) => c.kind === "ledger_entry").length,
      0,
      "the claimed entry must not resurface",
    );
  });

  test("categorization entries are never re-offered as ledger candidates", async () => {
    const { feed } = await setup();
    const expense = (await accountByCode(CO, "6000"))!;
    const categorized = await makeTxn(feed.id, -5000);
    await categorizeBankTransaction(categorized, expense.id, null); // posts bank_categorization

    const other = await makeTxn(feed.id, -5000); // same amount, still uncleared
    const candidates = await findMatchCandidates(other);
    assert.equal(
      candidates.filter((c) => c.kind === "ledger_entry").length,
      0,
      "a bank_categorization entry is its own bank line, not a match target",
    );
  });
});
