import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { In } from "typeorm";

import { ENTRY_CATEGORY_LOCK_REASON } from "../../shared/entryCategory.js";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { hydrateBankTransactions, undoBankTransaction } from "./banking.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "./ledger.js";
import { categorizeBankTransaction } from "./reconcile.js";
import {
  approveLedgerReview,
  bulkLedgerReview,
  getLedgerEntryForReview,
  stageAiLedgerReview,
} from "./transactionReviews.js";

/**
 * A bank transaction's category is changed on Banking — undone there and
 * categorized again — and nowhere else. A change approved in Entry review was
 * a reclass keyed on the categorization that Undo never reversed: the books
 * kept the reviewed category holding the money and the original one owing it,
 * and Banking went on naming the original. Whatever order people use the two
 * pages in, the books hold the transaction under the category Banking names,
 * and undoing it leaves nothing behind.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_bank_category";
const DAY = new Date("2026-10-14T00:00:00Z");
const AMOUNT = 4_200;
const BANK_REASON = ENTRY_CATEGORY_LOCK_REASON.bank;

async function setup(amountCents = -AMOUNT) {
  await seedChartOfAccounts(CO);
  const bank = (await accountByCode(CO, "1100"))!;
  const general = (await accountByCode(CO, "6000"))!;
  const otherIncome = (await accountByCode(CO, "4900"))!;
  const travel = await insert(Account, {
    companyId: CO,
    code: "6200",
    name: "Travel",
    type: "expense",
  });
  const software = await insert(Account, {
    companyId: CO,
    code: "6300",
    name: "Software",
    type: "expense",
  });
  const consulting = await insert(Account, {
    companyId: CO,
    code: "4950",
    name: "Consulting",
    type: "revenue",
  });
  const feed = await insert(BankFeed, {
    companyId: CO,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  const txn = await insert(BankTransaction, {
    companyId: CO,
    feedId: feed.id,
    externalId: null,
    date: DAY,
    amountCents,
    description: "GITHUB",
    reference: "",
    raw: "",
  });
  return { bank, general, otherIncome, travel, software, consulting, txn };
}

async function reload<T extends { id: string }>(entity: new () => T, id: string): Promise<T> {
  return AppDataSource.getRepository(entity).findOneByOrFail({ id } as never);
}

/** Debits minus credits per account code across the whole ledger, zeros left out. */
async function balances(): Promise<Record<string, number>> {
  const [lines, accounts] = await Promise.all([
    AppDataSource.getRepository(LedgerLine).find({ where: { companyId: CO } }),
    AppDataSource.getRepository(Account).find({ where: { companyId: CO } }),
  ]);
  const codeOf = new Map(accounts.map((account) => [account.id, account.code]));
  const net = new Map<string, number>();
  for (const line of lines) {
    const code = codeOf.get(line.accountId)!;
    net.set(code, (net.get(code) ?? 0) + line.debitCents - line.creditCents);
  }
  return Object.fromEntries([...net].filter(([, cents]) => cents !== 0));
}

/** The category Banking names for the transaction, by code, or null while it waits. */
async function categoryOnBanking(txnId: string): Promise<string | null> {
  const [hydrated] = await hydrateBankTransactions(CO, [await reload(BankTransaction, txnId)]);
  const match = hydrated.match;
  if (match?.kind !== "ledger_entry" || !match.categoryAccountId) return null;
  return (await reload(Account, match.categoryAccountId)).code;
}

/** Every entry Banking posted for the transaction: each categorization and each undo. */
async function bankEntries(): Promise<LedgerEntry[]> {
  return AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId: CO, source: In(["bank_categorization", "bank_categorization_void"]) },
  });
}

/** The entry's line on an expense or income account, which Entry review would offer to move. */
async function categoryLine(entryId: string): Promise<LedgerLine | null> {
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: entryId },
  });
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { id: In(lines.map((line) => line.accountId)) },
  });
  const typeOf = new Map(accounts.map((account) => [account.id, account.type]));
  return (
    lines.find((line) => ["expense", "revenue"].includes(typeOf.get(line.accountId) ?? "")) ?? null
  );
}

/** The books hold the transaction under the category Banking names, and only there. */
async function assertFiledAsBankingShows(txnId: string): Promise<void> {
  const category = await categoryOnBanking(txnId);
  assert.ok(category, "Banking names a category");
  assert.deepEqual(await balances(), { "1100": -AMOUNT, [category]: AMOUNT });
}

describe("a bank transaction's category, changed from both pages in any order", () => {
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const steps: Record<string, (ctx: Ctx) => Promise<void>> = {
    // Banking changes a category by undoing it and categorizing again.
    Banking: async ({ txn, travel }) => {
      const { transaction } = await undoBankTransaction(
        await reload(BankTransaction, txn.id),
        "u1",
      );
      await categorizeBankTransaction(transaction, travel.id, "u1");
    },
    // An owner picking a category, or an AI Employee proposing one.
    "Entry review": async ({ software }) => {
      for (const entry of await bankEntries()) {
        const changes = [{ lineId: (await categoryLine(entry.id))!.id, accountId: software.id }];
        await assert.rejects(
          approveLedgerReview({ companyId: CO, entryId: entry.id, userId: "u1", changes }),
          { message: BANK_REASON },
        );
        await assert.rejects(
          stageAiLedgerReview({
            companyId: CO,
            entryId: entry.id,
            employeeId: "employee-1",
            changes,
          }),
          { message: BANK_REASON },
        );
      }
    },
    "bulk Change category": async ({ software }) => {
      const entries = await bankEntries();
      const result = await bulkLedgerReview({
        companyId: CO,
        userId: "u1",
        action: "recategorize",
        entryIds: entries.map((entry) => entry.id),
        toAccountId: software.id,
      });
      assert.deepEqual(result.succeeded, []);
      assert.deepEqual(
        result.skipped,
        entries.map((entry) => ({ id: entry.id, reason: BANK_REASON })),
      );
    },
  };

  const orders = (names: string[]): string[][] =>
    names.length <= 1
      ? [names]
      : names.flatMap((name) =>
          orders(names.filter((n) => n !== name)).map((rest) => [name, ...rest]),
        );

  for (const order of orders(Object.keys(steps))) {
    test(order.join(" → "), async () => {
      const ctx = await setup();
      await categorizeBankTransaction(ctx.txn, ctx.general.id, "u1");
      await assertFiledAsBankingShows(ctx.txn.id);
      for (const step of order) {
        await steps[step](ctx);
        await assertFiledAsBankingShows(ctx.txn.id);
      }
      // Undoing it on Banking leaves nothing behind on any account.
      await undoBankTransaction(await reload(BankTransaction, ctx.txn.id), "u1");
      assert.deepEqual(await balances(), {});
      assert.equal(
        await AppDataSource.getRepository(LedgerEntry).countBy({ source: "ledger_reclass" }),
        0,
      );
    });
  }
});

describe("Entry review signs a bank transaction off as it is", () => {
  test("approves it without a category change, and Banking can still move it", async () => {
    const { txn, general, travel } = await setup();
    const categorized = await categorizeBankTransaction(txn, general.id, "u1");
    const entryId = categorized.matchedLedgerEntryId!;
    assert.equal((await getLedgerEntryForReview(CO, entryId))?.categoryLock, "bank");

    const approved = await approveLedgerReview({ companyId: CO, entryId, userId: "u1" });

    assert.equal(approved.reviewStatus, "approved");
    assert.deepEqual(approved.reviewChanges, []);
    const { transaction } = await undoBankTransaction(categorized, "u1");
    const [undo] = await AppDataSource.getRepository(LedgerEntry).findBy({
      source: "bank_categorization_void",
    });
    assert.equal((await getLedgerEntryForReview(CO, undo.id))?.categoryLock, "bank");
    await categorizeBankTransaction(transaction, travel.id, "u1");
    await assertFiledAsBankingShows(txn.id);
    assert.equal(await categoryOnBanking(txn.id), "6200");
  });

  test("an AI Employee reviews it without proposing a category", async () => {
    const { txn, general } = await setup();
    const categorized = await categorizeBankTransaction(txn, general.id, "u1");
    const entryId = categorized.matchedLedgerEntryId!;

    const reviewed = await stageAiLedgerReview({
      companyId: CO,
      entryId,
      employeeId: "employee-1",
      changes: [],
      note: "GitHub is software. Undo it on Banking and file it under Software.",
    });

    assert.equal(reviewed.reviewStatus, "ai_reviewed");
    const result = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "approve",
      entryIds: [entryId],
    });
    assert.deepEqual(result.succeeded, [entryId]);
    await assertFiledAsBankingShows(txn.id);
  });
});

describe("a category Entry review approved before Banking owned it", () => {
  /**
   * What approving a change in Entry review posted until now: a reclass keyed
   * on the categorization, moving the line's amount to the reviewed category.
   */
  async function approvedEarlier(entryId: string, to: Account): Promise<void> {
    const line = (await categoryLine(entryId))!;
    const amount = line.debitCents || line.creditCents;
    await postLedgerEntry({
      companyId: CO,
      date: DAY,
      memo: "Approved category changes for GITHUB",
      source: "ledger_reclass",
      sourceRefId: entryId,
      reviewStatus: "approved",
      lines:
        line.debitCents > 0
          ? [
              { accountId: to.id, debitCents: amount },
              { accountId: line.accountId, creditCents: amount },
            ]
          : [
              { accountId: line.accountId, debitCents: amount },
              { accountId: to.id, creditCents: amount },
            ],
    });
    await AppDataSource.getRepository(LedgerEntry).update(
      { id: entryId },
      {
        reviewStatus: "approved",
        reviewChangesJson: JSON.stringify([
          { lineId: line.id, fromAccountId: line.accountId, toAccountId: to.id },
        ]),
      },
    );
  }

  test("is the one Banking names, and Undo takes the money back out of it", async () => {
    const { txn, bank, general, travel } = await setup();
    const categorized = await categorizeBankTransaction(txn, general.id, "u1");
    await approvedEarlier(categorized.matchedLedgerEntryId!, travel);
    assert.equal(await categoryOnBanking(txn.id), "6200");
    assert.deepEqual(await balances(), { "1100": -AMOUNT, "6200": AMOUNT });

    await undoBankTransaction(categorized, "u1");

    assert.deepEqual(await balances(), {});
    const [undo] = await AppDataSource.getRepository(LedgerEntry).findBy({
      source: "bank_categorization_void",
    });
    const undoLines = await AppDataSource.getRepository(LedgerLine).find({
      where: { ledgerEntryId: undo.id },
      order: { sortOrder: "ASC" },
    });
    // It reverses the category the money sits in now, not the one it left.
    assert.deepEqual(
      undoLines.map((line) => [line.accountId, line.debitCents, line.creditCents]),
      [
        [bank.id, AMOUNT, 0],
        [travel.id, 0, AMOUNT],
      ],
    );
  });

  test("works the same for money coming in", async () => {
    const { txn, otherIncome, consulting } = await setup(AMOUNT);
    const categorized = await categorizeBankTransaction(txn, otherIncome.id, "u1");
    await approvedEarlier(categorized.matchedLedgerEntryId!, consulting);
    assert.equal(await categoryOnBanking(txn.id), "4950");
    assert.deepEqual(await balances(), { "1100": AMOUNT, "4950": -AMOUNT });

    await undoBankTransaction(categorized, "u1");

    assert.deepEqual(await balances(), {});
  });
});
