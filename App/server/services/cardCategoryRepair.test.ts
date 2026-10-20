import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Like } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import {
  balancesByCode,
  type CardBooks,
  cardBooks,
  cardPurchase,
  legacyEntryReview,
  moveOnBanking,
  PURCHASE_DAY,
  reload,
} from "../test/cardFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { type CategoryLine, findCardCategoryDrift } from "./cardCategoryDrift.js";
import {
  CardCategoryFixError,
  cardCategoryFixesToReview,
  fixSplitCardCategory,
  matchCardCategoriesToBooks,
  matchCategoryToBooks,
} from "./cardCategoryRepair.js";
import { approveLedgerReview } from "./transactionReviews.js";

/**
 * The repair for card purchases Entry review moved before Banking became the
 * one place their category changes. Banking out of date is fixed at boot
 * without touching the books; split in the books waits for a person to press
 * Fix on Banking, posts exactly the entry they were shown, dated today, and
 * leaves the purchase under the category Banking shows.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_card_category_repair";
const OTHER_CO = "co_card_category_repair_other";
const AMOUNT = 12_000;
const MATCHED_TO_BOOKS = "finance.card_transaction.category_matched_to_books";
const BOOKS_MATCHED = "finance.card_transaction.books_matched_to_category";

/** Entry review moved it to Software, and Banking never did: Banking shows 6000. */
async function outOfDate(books: CardBooks, postedAt = PURCHASE_DAY): Promise<CardTransaction> {
  const { card, posting } = await cardPurchase(books.feed, { cents: AMOUNT, postedAt });
  await legacyEntryReview(posting, books.general, books.software);
  return card;
}

/** Entry review moved it to Software, then Banking to Travel: in the books under both. */
async function split(books: CardBooks, postedAt = PURCHASE_DAY): Promise<CardTransaction> {
  const { card, posting } = await cardPurchase(books.feed, { cents: AMOUNT, postedAt });
  await legacyEntryReview(posting, books.general, books.software);
  await moveOnBanking(card, books.travel);
  return card;
}

/** Entry review's change saved without its second line: the purchase doesn't add up. */
async function unbalanced(books: CardBooks, postedAt = PURCHASE_DAY): Promise<CardTransaction> {
  const { card, posting } = await cardPurchase(books.feed, { cents: AMOUNT, postedAt });
  const change = await insert(LedgerEntry, {
    companyId: books.companyId,
    date: posting.date,
    source: "ledger_reclass",
    sourceRefId: posting.id,
    reviewStatus: "approved",
  });
  await insert(LedgerLine, {
    companyId: books.companyId,
    ledgerEntryId: change.id,
    accountId: books.software.id,
    debitCents: AMOUNT,
  });
  return card;
}

/** The correcting entry Banking shows for a split purchase. */
async function shownLines(companyId: string, card: CardTransaction): Promise<CategoryLine[]> {
  const drift = (await findCardCategoryDrift(companyId)).find(
    (candidate) => candidate.transaction.id === card.id,
  );
  if (drift?.repair?.kind !== "reclassify")
    throw new Error("expected a purchase split in the books");
  return drift.repair.lines;
}

function fix(companyId: string, card: CardTransaction, lines: CategoryLine[]) {
  return fixSplitCardCategory({ companyId, transactionId: card.id, lines, actorUserId: "u-owner" });
}

/** The entries a Fix posted: the purchase's reclassifications nobody made on Banking. */
function fixEntries(card: CardTransaction): Promise<LedgerEntry[]> {
  return AppDataSource.getRepository(LedgerEntry).find({
    where: {
      source: "brex_card_reclass",
      sourceRefId: Like(card.id + ":%"),
      createdById: "u-owner",
    },
  });
}

function auditRows(action: string): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({ where: { action } });
}

describe("at boot", () => {
  test("shows every company's out-of-date purchases under the category their books hold, and posts nothing", async () => {
    const books = await cardBooks(CO);
    const other = await cardBooks(OTHER_CO);
    const stale = await outOfDate(books);
    const twice = await split(books);
    const { card: clean } = await cardPurchase(books.feed, { cents: AMOUNT });
    await moveOnBanking(clean, books.travel);
    const elsewhere = await outOfDate(other);
    const before = { mine: await balancesByCode(CO), theirs: await balancesByCode(OTHER_CO) };
    const entries = await AppDataSource.getRepository(LedgerEntry).count();

    await matchCardCategoriesToBooks();

    assert.equal((await reload(CardTransaction, stale.id)).expenseAccountId, books.software.id);
    assert.equal((await reload(CardTransaction, elsewhere.id)).expenseAccountId, other.software.id);
    // A purchase split in the books waits for a person, and a clean one is left alone.
    assert.equal((await reload(CardTransaction, twice.id)).expenseAccountId, books.travel.id);
    assert.equal((await reload(CardTransaction, clean.id)).expenseAccountId, books.travel.id);
    assert.deepEqual(await balancesByCode(CO), before.mine);
    assert.deepEqual(await balancesByCode(OTHER_CO), before.theirs);
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), entries);
    assert.deepEqual(
      (await findCardCategoryDrift(CO)).map((drift) => [drift.transaction.id, drift.kind]),
      [[twice.id, "split_in_books"]],
    );
    assert.deepEqual(await findCardCategoryDrift(OTHER_CO), []);

    const audits = await auditRows(MATCHED_TO_BOOKS);
    assert.deepEqual(
      audits.map((row) => [row.companyId, row.targetId, row.actorKind]).sort(),
      [
        [CO, stale.id, "system"],
        [OTHER_CO, elsewhere.id, "system"],
      ].sort(),
    );
    const mine = audits.find((row) => row.targetId === stale.id)!;
    assert.equal(mine.targetType, "card_transaction");
    assert.equal(mine.targetLabel, "Delta Air Lines");
    const metadata = JSON.parse(mine.metadataJson);
    assert.equal(metadata.fromAccountId, books.general.id);
    assert.equal(metadata.toAccountId, books.software.id);
    assert.equal(metadata.reviewEntryIds.length, 1);

    // The next boot finds nothing left to do.
    await matchCardCategoriesToBooks();
    assert.equal((await auditRows(MATCHED_TO_BOOKS)).length, 2);
  });

  test("leaves a purchase alone when its category changed on Banking after the finder looked", async () => {
    const books = await cardBooks(CO);
    const stale = await outOfDate(books);
    const [drift] = await findCardCategoryDrift(CO);
    await moveOnBanking(stale, books.meals);

    assert.equal(await matchCategoryToBooks(CO, drift), false);
    assert.equal((await reload(CardTransaction, stale.id)).expenseAccountId, books.meals.id);
    assert.deepEqual(await auditRows(MATCHED_TO_BOOKS), []);
  });
});

describe("Fix on Banking", () => {
  test("posts one entry, dated today, leaving the purchase under the category Banking shows", async () => {
    const books = await cardBooks(CO);
    const card = await split(books);
    const lines = await shownLines(CO, card);

    const fixed = await fix(CO, card, lines);

    assert.deepEqual(await balancesByCode(CO), { "2300": -AMOUNT, "6200": AMOUNT });
    assert.equal(fixed.expenseAccountId, books.travel.id);
    assert.ok(fixed.reclassifiedAt);
    assert.deepEqual(await findCardCategoryDrift(CO), []);
    const [entry, ...more] = await fixEntries(card);
    assert.deepEqual(more, []);
    assert.equal(entry.memo, "Fix category of Delta Air Lines");
    assert.equal(entry.date.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    const posted = await AppDataSource.getRepository(LedgerLine).find({
      where: { ledgerEntryId: entry.id },
      order: { sortOrder: "ASC" },
    });
    assert.deepEqual(
      posted.map(({ accountId, debitCents, creditCents }) => ({
        accountId,
        debitCents,
        creditCents,
      })),
      lines,
    );
    // Entry review lists it with the purchase's other entries and signs it off as it is.
    const approved = await approveLedgerReview({ companyId: CO, entryId: entry.id, userId: "u1" });
    assert.equal(approved.reviewStatus, "approved");

    const [audit, ...extra] = await auditRows(BOOKS_MATCHED);
    assert.deepEqual(extra, []);
    assert.equal(audit.companyId, CO);
    assert.equal(audit.actorUserId, "u-owner");
    assert.equal(audit.targetType, "card_transaction");
    assert.equal(audit.targetId, card.id);
    assert.equal(JSON.parse(audit.metadataJson).entryId, entry.id);
  });

  test("is dated today when the purchase's own period has been closed", async () => {
    const books = await cardBooks(CO);
    const card = await split(books);
    const march = {
      start: new Date("2026-03-01T00:00:00Z"),
      end: new Date("2026-03-31T23:59:59Z"),
    };
    await insert(AccountingPeriod, {
      companyId: CO,
      name: "March 2026",
      startDate: march.start,
      endDate: march.end,
      status: "closed",
    });

    await fix(CO, card, await shownLines(CO, card));

    assert.deepEqual(await balancesByCode(CO), { "2300": -AMOUNT, "6200": AMOUNT });
    const [entry] = await fixEntries(card);
    assert.ok(entry.date.getTime() > march.end.getTime());
  });

  test("refuses an entry other than the one the person was shown", async () => {
    const books = await cardBooks(CO);
    const card = await split(books);
    const shown = await shownLines(CO, card);
    const before = await balancesByCode(CO);
    const changed = {
      message:
        "This purchase changed since you opened it. Look at the entry again before you fix it.",
      status: 409,
    };

    const doubled = shown.map((line) => ({
      ...line,
      debitCents: line.debitCents * 2,
      creditCents: line.creditCents * 2,
    }));
    const elsewhere = shown.map((line) =>
      line.accountId === books.software.id ? { ...line, accountId: books.meals.id } : line,
    );
    await assert.rejects(fix(CO, card, doubled), changed);
    await assert.rejects(fix(CO, card, elsewhere), changed);
    await assert.rejects(fix(CO, card, shown.slice(0, 1)), changed);

    assert.deepEqual(await balancesByCode(CO), before);
    assert.deepEqual(await fixEntries(card), []);
  });

  test("leaves the purchase under the category Banking shows when the Fix lands", async () => {
    const books = await cardBooks(CO);
    const card = await split(books);
    const shown = await shownLines(CO, card);
    // Someone moves it on Banking before the Fix lands. A move takes the whole
    // amount from one category to the next, so the categories out of place —
    // and the entry that clears them — stay the same.
    await moveOnBanking(card, books.meals);
    assert.deepEqual(await shownLines(CO, card), shown);

    await fix(CO, card, shown);

    assert.deepEqual(await balancesByCode(CO), { "2300": -AMOUNT, "6400": AMOUNT });
    assert.equal((await reload(CardTransaction, card.id)).expenseAccountId, books.meals.id);
  });

  test("refuses a purchase the books hold under one category", async () => {
    const books = await cardBooks(CO);
    const stale = await outOfDate(books);
    const { card: clean } = await cardPurchase(books.feed, { cents: AMOUNT });
    const lines = [
      { accountId: books.general.id, debitCents: AMOUNT, creditCents: 0 },
      { accountId: books.software.id, debitCents: 0, creditCents: AMOUNT },
    ];

    for (const card of [stale, clean]) {
      await assert.rejects(fix(CO, card, lines), {
        message: "There's nothing to fix: your books hold this purchase under one category",
        status: 409,
      });
      assert.deepEqual(await fixEntries(card), []);
    }
  });

  test("refuses a purchase whose entries don't add up, and says why", async () => {
    const books = await cardBooks(CO);
    const card = await unbalanced(books);

    await assert.rejects(
      fix(CO, card, [
        { accountId: books.software.id, debitCents: 0, creditCents: AMOUNT },
        { accountId: books.general.id, debitCents: AMOUNT, creditCents: 0 },
      ]),
      {
        message:
          "Its entries don't balance — some of their lines are missing. Correct it with a journal entry.",
        status: 409,
      },
    );
    assert.deepEqual(await fixEntries(card), []);
  });

  test("can't reach another company's purchase", async () => {
    await cardBooks(CO);
    const card = await split(await cardBooks(OTHER_CO));

    await assert.rejects(fix(CO, card, await shownLines(OTHER_CO, card)), {
      message: "Card transaction not found",
      status: 404,
    });
    assert.deepEqual(await fixEntries(card), []);
  });

  test("posts once when asked twice at the same time", async () => {
    const books = await cardBooks(CO);
    const card = await split(books);
    const lines = await shownLines(CO, card);

    const results = await Promise.allSettled([fix(CO, card, lines), fix(CO, card, lines)]);

    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const refused = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )!.reason;
    assert.ok(refused instanceof CardCategoryFixError);
    assert.equal(refused.status, 409);
    assert.equal((await fixEntries(card)).length, 1);
    assert.deepEqual(await balancesByCode(CO), { "2300": -AMOUNT, "6200": AMOUNT });
  });
});

describe("what Banking lists", () => {
  test("the purchases only a person can fix, newest first", async () => {
    const books = await cardBooks(CO);
    await outOfDate(books, new Date("2026-03-20T12:00:00Z"));
    const twice = await split(books, new Date("2026-03-10T12:00:00Z"));
    const broken = await unbalanced(books, new Date("2026-03-01T12:00:00Z"));

    const listed = await cardCategoryFixesToReview(CO);

    assert.deepEqual(
      listed.map((drift) => [drift.transaction.id, drift.kind]),
      [
        [twice.id, "split_in_books"],
        [broken.id, "unrecognized"],
      ],
    );
  });
});
