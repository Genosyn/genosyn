import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { In } from "typeorm";

import { CARD_CATEGORY_ON_BANKING } from "../../shared/cardCategory.js";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { reclassifyCardTransaction, retryCardTransaction } from "./cardExpenses.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "./ledger.js";
import {
  approveLedgerReview,
  bulkLedgerReview,
  stageAiLedgerReview,
} from "./transactionReviews.js";

/**
 * A card purchase's category is changed on Banking and nowhere else. Banking
 * moves the amount out of whatever category the purchase is filed under now;
 * Entry review only ever saw the entry as first posted, so a change made there
 * moved money the purchase might no longer hold and left Banking showing the
 * old category. Whatever order people use the two pages in, the books must
 * hold the purchase under exactly one category — the one Banking shows.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_card_category";
const PURCHASE_DAY = new Date("2026-10-14T12:00:00Z");
const AMOUNT = 12_000;

async function setup() {
  await seedChartOfAccounts(CO);
  const general = (await accountByCode(CO, "6000"))!;
  const payable = (await accountByCode(CO, "2300"))!;
  const bank = (await accountByCode(CO, "1100"))!;
  const travel = await insert(Account, { companyId: CO, code: "6200", name: "Travel", type: "expense" });
  const software = await insert(Account, {
    companyId: CO,
    code: "6300",
    name: "Software",
    type: "expense",
  });
  const feed = await insert(CardFeed, {
    companyId: CO,
    name: "Brex card",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: general.id,
    paymentAccountId: bank.id,
  });
  return { general, bank, travel, software, feed };
}

/** A card purchase (or refund) synced and posted under the card's default category. */
async function purchase(
  feed: CardFeed,
  kind: "expense" | "refund" = "expense",
  cents = AMOUNT,
): Promise<{ card: CardTransaction; entry: LedgerEntry }> {
  const card = await retryCardTransaction(
    await insert(CardTransaction, {
      companyId: CO,
      feedId: feed.id,
      externalId: randomUUID(),
      postedAt: PURCHASE_DAY,
      // Brex counts a purchase as positive and a refund as negative.
      amountCents: kind === "refund" ? -cents : cents,
      currency: "USD",
      description: "Delta Air Lines",
      accountingKind: kind,
      expenseAccountId: feed.defaultExpenseAccountId,
    }),
  );
  const entry = await reload(LedgerEntry, card.ledgerEntryId!);
  return { card, entry };
}

async function reload<T extends { id: string }>(entity: new () => T, id: string): Promise<T> {
  return AppDataSource.getRepository(entity).findOneByOrFail({ id } as never);
}

/** Every entry filing the purchase: its own posting and each reclassification. */
async function cardEntries(): Promise<LedgerEntry[]> {
  return AppDataSource.getRepository(LedgerEntry).find({
    where: {
      companyId: CO,
      source: In(["brex_card_expense", "brex_card_refund", "brex_card_reclass"]),
    },
  });
}

/** The one reclassification Banking posted. */
async function reclassEntry(): Promise<LedgerEntry> {
  return AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    companyId: CO,
    source: "brex_card_reclass",
  });
}

/** The lines an Entry review category picker would offer: expense and income. */
async function categoryLines(entryId: string): Promise<LedgerLine[]> {
  const lines = await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entryId } });
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { id: In(lines.map((line) => line.accountId)) },
  });
  const typeOf = new Map(accounts.map((account) => [account.id, account.type]));
  return lines.filter((line) => ["expense", "revenue"].includes(typeOf.get(line.accountId) ?? ""));
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

/** The books hold the purchase under the category Banking shows, and only there. */
async function assertFiledAsBankingShows(cardId: string): Promise<void> {
  const card = await reload(CardTransaction, cardId);
  const category = await reload(Account, card.expenseAccountId!);
  assert.deepEqual(await balances(), { "2300": -AMOUNT, [category.code]: AMOUNT });
}

describe("a card purchase's category, changed from both pages in any order", () => {
  type Ctx = Awaited<ReturnType<typeof setup>> & { card: CardTransaction };

  const steps: Record<string, (ctx: Ctx) => Promise<void>> = {
    "Banking": async ({ card, travel }) => {
      await reclassifyCardTransaction(await reload(CardTransaction, card.id), travel.id, "u1");
    },
    "Entry review": async ({ software }) => {
      for (const entry of await cardEntries()) {
        for (const line of await categoryLines(entry.id)) {
          await assert.rejects(
            approveLedgerReview({
              companyId: CO,
              entryId: entry.id,
              userId: "u1",
              changes: [{ lineId: line.id, accountId: software.id }],
            }),
            { message: CARD_CATEGORY_ON_BANKING },
          );
        }
      }
    },
    "bulk Change category": async ({ software }) => {
      const entries = await cardEntries();
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
        entries.map((entry) => ({ id: entry.id, reason: CARD_CATEGORY_ON_BANKING })),
      );
    },
  };

  const orders = (names: string[]): string[][] =>
    names.length <= 1
      ? [names]
      : names.flatMap((name) => orders(names.filter((n) => n !== name)).map((rest) => [name, ...rest]));

  for (const order of orders(Object.keys(steps))) {
    test(order.join(" → "), async () => {
      const ctx = await setup();
      const { card } = await purchase(ctx.feed);
      await assertFiledAsBankingShows(card.id);
      for (const step of order) {
        await steps[step]({ ...ctx, card });
        await assertFiledAsBankingShows(card.id);
      }
      // Banking still moves it from where it is now, not where it was posted.
      await reclassifyCardTransaction(await reload(CardTransaction, card.id), ctx.software.id, "u1");
      await assertFiledAsBankingShows(card.id);
      assert.equal((await reload(CardTransaction, card.id)).expenseAccountId, ctx.software.id);
      assert.equal(
        await AppDataSource.getRepository(LedgerEntry).countBy({ source: "ledger_reclass" }),
        0,
      );
    });
  }
});

describe("Entry review signs a card purchase off as it is", () => {
  test("approves it without a category change, and Banking can still move it afterwards", async () => {
    const { feed, travel } = await setup();
    const { card, entry } = await purchase(feed);

    const approved = await approveLedgerReview({ companyId: CO, entryId: entry.id, userId: "u1" });

    assert.equal(approved.reviewStatus, "approved");
    assert.deepEqual(approved.reviewChanges, []);
    await reclassifyCardTransaction(card, travel.id, "u1");
    const reclass = await reclassEntry();
    const bulk = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "approve",
      entryIds: [reclass.id],
    });
    assert.deepEqual(bulk.succeeded, [reclass.id]);
    assert.deepEqual(await balances(), { "2300": -AMOUNT, "6200": AMOUNT });
  });

  test("refuses even the category the entry was posted under, once Banking has moved it", async () => {
    const { feed, general, travel } = await setup();
    const { card, entry } = await purchase(feed);
    await reclassifyCardTransaction(card, travel.id, "u1");
    const [line] = await categoryLines(entry.id);
    assert.equal(line.accountId, general.id);

    // Approving this as a no-op would leave the purchase under Travel while
    // the reviewer asked for General & Administrative.
    await assert.rejects(
      approveLedgerReview({
        companyId: CO,
        entryId: entry.id,
        userId: "u1",
        changes: [{ lineId: line.id, accountId: general.id }],
      }),
      { message: CARD_CATEGORY_ON_BANKING },
    );
    assert.equal((await reload(LedgerEntry, entry.id)).reviewStatus, "unreviewed");
  });

  test("an AI Employee reviews it without proposing a category", async () => {
    const { feed, travel } = await setup();
    const { entry } = await purchase(feed);
    const [line] = await categoryLines(entry.id);

    await assert.rejects(
      stageAiLedgerReview({
        companyId: CO,
        entryId: entry.id,
        employeeId: "employee-1",
        changes: [{ lineId: line.id, accountId: travel.id }],
      }),
      { message: CARD_CATEGORY_ON_BANKING },
    );
    assert.equal((await reload(LedgerEntry, entry.id)).reviewStatus, "unreviewed");

    const reviewed = await stageAiLedgerReview({
      companyId: CO,
      entryId: entry.id,
      employeeId: "employee-1",
      changes: [],
      note: "A flight — Travel fits better. Change it on Banking.",
    });
    assert.equal(reviewed.reviewStatus, "ai_reviewed");
    const result = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "approve",
      entryIds: [entry.id],
    });
    assert.deepEqual(result.succeeded, [entry.id]);
    assert.deepEqual(await balances(), { "2300": -AMOUNT, "6000": AMOUNT });
  });

  test("a category an AI Employee proposed earlier is never posted from here", async () => {
    const { feed, general, travel, software } = await setup();
    const { card, entry } = await purchase(feed);
    await reclassifyCardTransaction(card, travel.id, "u1");
    const [line] = await categoryLines(entry.id);
    // Staged before card purchases were refused, straight onto the row.
    await AppDataSource.getRepository(LedgerEntry).update(
      { id: entry.id },
      {
        reviewStatus: "ai_reviewed",
        reviewChangesJson: JSON.stringify([
          { lineId: line.id, fromAccountId: general.id, toAccountId: software.id },
        ]),
      },
    );

    const bulk = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "approve",
      entryIds: [entry.id],
    });
    assert.deepEqual(bulk.skipped, [{ id: entry.id, reason: CARD_CATEGORY_ON_BANKING }]);

    // Opened on its own, the page approves it with no category change.
    const approved = await approveLedgerReview({
      companyId: CO,
      entryId: entry.id,
      userId: "u1",
      changes: [],
    });
    assert.equal(approved.reviewStatus, "approved");
    await assertFiledAsBankingShows(card.id);
  });

  test("bulk Change category moves other entries and skips card purchases", async () => {
    const { feed, general, bank, travel, software } = await setup();
    const { card, entry } = await purchase(feed);
    await reclassifyCardTransaction(card, travel.id, "u1");
    const reclass = await reclassEntry();
    const { entry: manual } = await postLedgerEntry({
      companyId: CO,
      date: PURCHASE_DAY,
      memo: "Team lunch",
      lines: [
        { accountId: general.id, debitCents: 5_000 },
        { accountId: bank.id, creditCents: 5_000 },
      ],
    });

    const result = await bulkLedgerReview({
      companyId: CO,
      userId: "u1",
      action: "recategorize",
      entryIds: [entry.id, reclass.id, manual.id],
      toAccountId: software.id,
    });

    assert.deepEqual(result.succeeded, [manual.id]);
    assert.deepEqual(result.skipped, [
      { id: entry.id, reason: CARD_CATEGORY_ON_BANKING },
      { id: reclass.id, reason: CARD_CATEGORY_ON_BANKING },
    ]);
    assert.deepEqual(await balances(), {
      "1100": -5_000,
      "2300": -AMOUNT,
      "6200": AMOUNT,
      "6300": 5_000,
    });
    assert.equal((await reload(CardTransaction, card.id)).expenseAccountId, travel.id);
  });

  test("a card refund follows the same rule", async () => {
    const { feed, travel } = await setup();
    const { card, entry } = await purchase(feed, "refund", 3_000);
    const [line] = await categoryLines(entry.id);

    await assert.rejects(
      approveLedgerReview({
        companyId: CO,
        entryId: entry.id,
        userId: "u1",
        changes: [{ lineId: line.id, accountId: travel.id }],
      }),
      { message: CARD_CATEGORY_ON_BANKING },
    );
    await reclassifyCardTransaction(card, travel.id, "u1");

    assert.deepEqual(await balances(), { "2300": 3_000, "6200": -3_000 });
  });
});
