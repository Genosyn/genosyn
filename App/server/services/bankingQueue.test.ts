import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { legacyEntryReview } from "../test/cardFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  BANKING_PAGE,
  bankingQueue,
  type BankingQueueFilter,
  type BankingQueueRow,
} from "./bankingQueue.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  encodeCursor,
  ListQueryError,
  TOOL_PAGE_BUDGET_CHARS,
} from "./listPaging.js";
import { categorizeBankTransaction } from "./reconcile.js";

/**
 * Banking's list reaches every transaction. The report this was built from:
 * an AI Employee filing 1,069 card purchases was handed the newest 500, told
 * nothing was missing, and had no offset or date filter to reach the 569 older
 * ones — so most of the money stayed unfiled. Here ~1,200 transactions, many
 * sharing a date and some sharing an instant across the bank and card tables,
 * are read page by page and each one must come back exactly once, in order.
 */

const DAYS = 20;
const BANK_ROWS = 600;
const CARD_ROWS = 600;

let companyId: string;
let otherCompanyId: string;
let checking: BankFeed;
let wise: BankFeed;
let brex: CardFeed;
let general: Account;
let software: Account;
let rent: Account;
let bankAccount: Account;

before(initTestDb);
after(closeTestDb);

function dayAt(index: number, time = "00:00:00.000"): Date {
  const day = new Date(Date.UTC(2023, 0, 1) + (index % DAYS) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return new Date(`${day}T${time}Z`);
}

async function books(company: string) {
  await seedChartOfAccounts(company);
  const bank = (await accountByCode(company, "1100"))!;
  const payable = (await accountByCode(company, "2300"))!;
  const g = (await accountByCode(company, "6000"))!;
  const feedA = await insert(BankFeed, {
    companyId: company,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  const feedB = await insert(BankFeed, {
    companyId: company,
    name: "Wise",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  const card = await insert(CardFeed, {
    companyId: company,
    name: "Brex Primary",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: g.id,
    paymentAccountId: bank.id,
  });
  return { bank, general: g, feedA, feedB, card };
}

/** ~1,200 rows: twenty days, so ~60 a day, and every fifth instant shared across both tables. */
async function seed(company: string, feeds: Awaited<ReturnType<typeof books>>) {
  const bankRows: Partial<BankTransaction>[] = [];
  for (let i = 0; i < BANK_ROWS; i++) {
    bankRows.push({
      id: randomUUID(),
      companyId: company,
      feedId: i % 3 === 0 ? feeds.feedB.id : feeds.feedA.id,
      externalId: null,
      // Most at midnight (date-only feeds); some later the same day.
      date: dayAt(i, i % 5 === 0 ? "13:45:10.250" : "00:00:00.000"),
      amountCents: i % 4 === 0 ? 10_000 + i : -(500 + i * 7),
      description: i % 50 === 0 ? `WORLDREMIT transfer ${i}` : `Bank line ${i}`,
      reference: i % 9 === 0 ? `REF-${i}` : "",
      raw: "",
      reconciledAt: i % 6 === 0 ? new Date() : null,
    });
  }
  const cardRows: Partial<CardTransaction>[] = [];
  for (let i = 0; i < CARD_ROWS; i++) {
    const kind = i % 10 === 0 ? "refund" : i % 25 === 1 ? "payment" : "expense";
    cardRows.push({
      id: randomUUID(),
      companyId: company,
      feedId: feeds.card.id,
      externalId: randomUUID(),
      // The same instants as the bank lines for every fifth row.
      postedAt: dayAt(i, i % 5 === 0 ? "13:45:10.250" : "00:00:00.000"),
      amountCents: kind === "expense" ? 2_000 + i : -(1_000 + i),
      currency: "USD",
      description: i % 40 === 0 ? `Google Ads ${i}` : `Card purchase ${i}`,
      accountingKind: kind,
      expenseAccountId: kind === "payment" ? null : feeds.general.id,
      ledgerEntryId: i % 7 === 0 ? null : `entry-${i}`,
      needsReview: i % 2 === 0,
      raw: "",
    });
  }
  for (let i = 0; i < bankRows.length; i += 150) {
    await AppDataSource.getRepository(BankTransaction).insert(bankRows.slice(i, i + 150));
  }
  for (let i = 0; i < cardRows.length; i += 150) {
    await AppDataSource.getRepository(CardTransaction).insert(cardRows.slice(i, i + 150));
  }
  return { bankRows, cardRows };
}

type Seeded = Awaited<ReturnType<typeof seed>>;
let seeded: Seeded;

/** The order the list promises: newest first, a bank line before a card purchase at the same instant, then id. */
function expectedOrder(rows: Array<{ kind: "bank" | "card"; id: string; at: Date }>): string[] {
  return [...rows]
    .sort((a, b) => {
      const byInstant = b.at.getTime() - a.at.getTime();
      if (byInstant !== 0) return byInstant;
      if (a.kind !== b.kind) return a.kind === "bank" ? -1 : 1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map((row) => row.id);
}

function allSeeded(
  filter: (row: {
    kind: "bank" | "card";
    bank?: Partial<BankTransaction>;
    card?: Partial<CardTransaction>;
  }) => boolean = () => true,
) {
  return [
    ...seeded.bankRows
      .filter((bank) => filter({ kind: "bank", bank }))
      .map((bank) => ({ kind: "bank" as const, id: bank.id!, at: bank.date! })),
    ...seeded.cardRows
      .filter((card) => filter({ kind: "card", card }))
      .map((card) => ({ kind: "card" as const, id: card.id!, at: card.postedAt! })),
  ];
}

/** Read every page of a filter, returning the ids in the order they came and each page's size. */
async function readAll(
  filter: BankingQueueFilter,
  options: {
    limit?: number;
    budgetChars?: number;
    between?: (page: BankingQueueRow[]) => Promise<void>;
  } = {},
) {
  const ids: string[] = [];
  const sizes: number[] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await bankingQueue(companyId, filter, {
      limit: options.limit,
      cursor,
      budgetChars: options.budgetChars,
    });
    ids.push(...page.transactions.map((row) => row.id));
    sizes.push(page.transactions.length);
    totals.push(page.total);
    if (page.hasMore) {
      assert.ok(page.nextCursor, "a page with more after it carries a cursor");
      assert.match(page.note ?? "", /nextCursor/);
    } else {
      assert.equal(page.nextCursor, null);
      assert.equal(page.note, undefined);
    }
    await options.between?.(page.transactions);
    if (!page.hasMore) return { ids, sizes, totals };
    cursor = page.nextCursor!;
  }
  throw new Error("paging never ended");
}

beforeEach(async () => {
  await resetTestDb();
  companyId = `co_${randomUUID()}`;
  otherCompanyId = `co_${randomUUID()}`;
  const mine = await books(companyId);
  checking = mine.feedA;
  wise = mine.feedB;
  brex = mine.card;
  general = mine.general;
  bankAccount = mine.bank;
  software = await insert(Account, { companyId, code: "6300", name: "Software", type: "expense" });
  rent = await insert(Account, { companyId, code: "6085", name: "Rent", type: "expense" });
  seeded = await seed(companyId, mine);
  // Another company with the same dates: none of its rows may ever appear.
  await seed(otherCompanyId, await books(otherCompanyId));
});

describe("paging through every transaction", () => {
  test("reaches all ~1,200 exactly once, newest first, with ties on date and instant broken stably", async () => {
    const { ids, totals } = await readAll({}, { limit: 37 });
    const expected = expectedOrder(allSeeded());
    assert.equal(expected.length, BANK_ROWS + CARD_ROWS);
    assert.equal(new Set(ids).size, ids.length, "no transaction is repeated");
    assert.deepEqual(ids, expected, "every transaction, in one order, with no gaps");
    assert.ok(
      totals.every((total) => total === BANK_ROWS + CARD_ROWS),
      "total counts every match on each page",
    );
  });

  test("pages the same list at every page size, including one row at a time across a shared instant", async () => {
    const expected = expectedOrder(allSeeded());
    for (const limit of [1, 50, 200]) {
      const filter: BankingQueueFilter = limit === 1 ? { to: "2023-01-01" } : {};
      const want =
        limit === 1
          ? expectedOrder(
              allSeeded(
                ({ bank, card }) =>
                  (bank?.date ?? card!.postedAt!) < new Date("2023-01-02T00:00:00Z"),
              ),
            )
          : expected;
      const { ids } = await readAll(filter, { limit });
      assert.deepEqual(ids, want, `limit ${limit}`);
    }
  });

  test("defaults to 50 a page and cuts a larger limit to 200", async () => {
    const first = await bankingQueue(companyId, {});
    assert.equal(first.transactions.length, BANKING_PAGE.defaultLimit);
    const big = await bankingQueue(companyId, {}, { limit: 5_000 });
    assert.equal(big.transactions.length, BANKING_PAGE.maxLimit);
    assert.equal(big.hasMore, true);
    assert.equal(big.total, BANK_ROWS + CARD_ROWS);
  });

  test("keeps every page inside an AI Employee's tool-result budget without losing a row", async () => {
    const { ids, sizes } = await readAll({}, { limit: 200, budgetChars: 12_000 });
    assert.deepEqual(ids, expectedOrder(allSeeded()));
    assert.ok(
      sizes.some((size) => size < 200),
      "long pages end early",
    );
    const page = await bankingQueue(
      companyId,
      {},
      { limit: 200, budgetChars: TOOL_PAGE_BUDGET_CHARS },
    );
    assert.ok(
      JSON.stringify(page, null, 2).length < TOOL_PAGE_BUDGET_CHARS + 2_000,
      "a tool page fits its budget",
    );
  });

  test("never shows another company's transactions, and refuses its cursor", async () => {
    const { ids } = await readAll({ q: "WORLDREMIT" }, { limit: 5 });
    const mine = new Set(allSeeded().map((row) => row.id));
    assert.ok(
      ids.every((id) => mine.has(id)),
      "only this company's rows",
    );
    const page = await bankingQueue(otherCompanyId, {}, { limit: 3 });
    await assert.rejects(
      bankingQueue(companyId, {}, { cursor: page.nextCursor! }),
      (err: unknown) => err instanceof ListQueryError && err.message === CURSOR_OTHER_FILTERS,
    );
  });
});

describe("a queue worked while it is read", () => {
  test("filing each page as it is read skips nothing that was waiting", async () => {
    const waiting = expectedOrder(
      allSeeded(({ bank, card }) =>
        bank
          ? bank.reconciledAt === null
          : card!.ledgerEntryId === null || card!.needsReview === true,
      ),
    );
    const { ids } = await readAll(
      { status: "review" },
      {
        limit: 40,
        // Take every card purchase on the page out of To review before reading on,
        // the way categorizing does: an offset would now skip as many rows.
        between: async (page) => {
          const cards = page.filter((row) => row.kind === "card").map((row) => row.id);
          if (cards.length) {
            await AppDataSource.getRepository(CardTransaction).update(cards, {
              needsReview: false,
              ledgerEntryId: "filed",
            });
          }
        },
      },
    );
    assert.deepEqual(ids, waiting);
  });

  test("a deleted last row does not lose the cursor's place", async () => {
    const first = await bankingQueue(companyId, {}, { limit: 25 });
    const last = first.transactions[first.transactions.length - 1];
    const repo =
      last.kind === "bank"
        ? AppDataSource.getRepository(BankTransaction)
        : AppDataSource.getRepository(CardTransaction);
    await repo.delete({ id: last.id });
    const second = await bankingQueue(companyId, {}, { limit: 25, cursor: first.nextCursor! });
    const expected = expectedOrder(allSeeded()).filter((id) => id !== last.id);
    assert.deepEqual(
      second.transactions.map((row) => row.id),
      expected.slice(24, 49),
    );
  });

  test("new transactions synced mid-way land on the first page, not in the middle of the read", async () => {
    const first = await bankingQueue(companyId, {}, { limit: 30 });
    const fresh = await insert(BankTransaction, {
      companyId,
      feedId: checking.id,
      externalId: null,
      date: new Date("2024-06-01T00:00:00Z"),
      amountCents: -100,
      description: "Arrived during the read",
      reference: "",
      raw: "",
    });
    const second = await bankingQueue(companyId, {}, { limit: 30, cursor: first.nextCursor! });
    assert.equal(
      second.transactions.some((row) => row.id === fresh.id),
      false,
    );
    assert.deepEqual(
      second.transactions.map((row) => row.id),
      expectedOrder(allSeeded()).slice(30, 60),
    );
    assert.equal(second.total, BANK_ROWS + CARD_ROWS + 1);
  });
});

describe("filters", () => {
  test("status: review is the To review queue, done what is explained", async () => {
    const review = await readAll({ status: "review" }, { limit: 200 });
    const done = await readAll({ status: "done" }, { limit: 200 });
    assert.equal(review.ids.length + done.ids.length, BANK_ROWS + CARD_ROWS);
    assert.equal(new Set([...review.ids, ...done.ids]).size, BANK_ROWS + CARD_ROWS);
    const expectedDone = allSeeded(({ bank, card }) =>
      bank
        ? bank.reconciledAt !== null
        : card!.ledgerEntryId !== null && card!.needsReview === false,
    );
    assert.deepEqual(done.ids, expectedOrder(expectedDone));
  });

  test("kind and feedId narrow to one table and one account", async () => {
    const cards = await readAll({ kind: "card" }, { limit: 200 });
    assert.equal(cards.ids.length, CARD_ROWS);
    const onWise = await readAll({ feedId: wise.id }, { limit: 200 });
    assert.deepEqual(onWise.ids, expectedOrder(allSeeded(({ bank }) => bank?.feedId === wise.id)));
    const onBrex = await readAll({ feedId: brex.id, kind: "bank" }, { limit: 200 });
    assert.deepEqual(onBrex.ids, []);
  });

  test("from and to are inclusive calendar days in UTC", async () => {
    // Day 0 is 2023-01-01, day 19 is 2023-01-20.
    const firstDay = await readAll({ from: "2023-01-01", to: "2023-01-01" }, { limit: 200 });
    assert.deepEqual(
      firstDay.ids,
      expectedOrder(
        allSeeded(({ bank, card }) =>
          (bank?.date ?? card!.postedAt!).toISOString().startsWith("2023-01-01"),
        ),
      ),
    );
    // Afternoon rows fall on days 0, 5, 10 and 15, so 2023-01-06 ends this window with some.
    const window = await readAll({ from: "2023-01-04", to: "2023-01-06" }, { limit: 200 });
    const inWindow = allSeeded(({ bank, card }) => {
      const at = (bank?.date ?? card!.postedAt!).toISOString().slice(0, 10);
      return at >= "2023-01-04" && at <= "2023-01-06";
    });
    assert.deepEqual(window.ids, expectedOrder(inWindow));
    const afternoonOfLastDay = allSeeded(
      ({ bank, card }) =>
        (bank?.date ?? card!.postedAt!).toISOString() === "2023-01-06T13:45:10.250Z",
    );
    assert.ok(afternoonOfLastDay.length > 0, "the window's last day has afternoon rows");
    assert.ok(
      afternoonOfLastDay.every((row) => window.ids.includes(row.id)),
      "a date-only `to` includes the whole of its day",
    );
    // …and nothing from the next morning.
    const nextMorning = allSeeded(({ bank, card }) =>
      (bank?.date ?? card!.postedAt!).toISOString().startsWith("2023-01-07"),
    );
    assert.ok(
      nextMorning.every((row) => !window.ids.includes(row.id)),
      "the day after `to` is outside the window",
    );
  });

  test("an ISO timestamp bound is that instant, its offset honoured", async () => {
    // 13:45:10.250Z written as 15:45:10.250+02:00: the afternoon rows of day 0 and nothing after.
    const page = await readAll(
      { from: "2023-01-01T15:45:10.250+02:00", to: "2023-01-01T23:59:59Z" },
      { limit: 200 },
    );
    assert.deepEqual(
      page.ids,
      expectedOrder(
        allSeeded(
          ({ bank, card }) =>
            (bank?.date ?? card!.postedAt!).toISOString() === "2023-01-01T13:45:10.250Z",
        ),
      ),
    );
    const justAfter = await bankingQueue(companyId, {
      from: "2023-01-01T13:45:10.251Z",
      to: "2023-01-01T23:59:59Z",
    });
    assert.equal(justAfter.total, 0);
  });

  test("direction and amount compare what moved, money in positive", async () => {
    const out = await readAll({ direction: "out", minAmountCents: 4_000 }, { limit: 200 });
    const expected = allSeeded(({ bank, card }) =>
      bank
        ? bank.amountCents! < 0 && Math.abs(bank.amountCents!) >= 4_000
        : card!.accountingKind === "expense" && Math.abs(card!.amountCents!) >= 4_000,
    );
    assert.deepEqual(out.ids, expectedOrder(expected));
    const between = await readAll({ minAmountCents: 1_200, maxAmountCents: 1_300 }, { limit: 200 });
    assert.deepEqual(
      between.ids,
      expectedOrder(
        allSeeded(({ bank, card }) => {
          const cents = Math.abs((bank ?? card)!.amountCents!);
          return cents >= 1_200 && cents <= 1_300;
        }),
      ),
    );
    const moneyIn = await bankingQueue(
      companyId,
      { direction: "in", kind: "card" },
      { limit: 200 },
    );
    assert.ok(
      moneyIn.transactions.every((row) => row.amountCents > 0 && row.cardKind !== "expense"),
      "money in is positive",
    );
  });

  test("q finds a merchant in the description, or a bank line's reference", async () => {
    const remit = await readAll({ q: "worldremit" }, { limit: 200 });
    assert.deepEqual(
      remit.ids,
      expectedOrder(allSeeded(({ bank }) => !!bank?.description?.startsWith("WORLDREMIT"))),
    );
    const ads = await readAll({ q: "google ADS" }, { limit: 200 });
    assert.deepEqual(
      ads.ids,
      expectedOrder(allSeeded(({ card }) => !!card?.description?.startsWith("Google Ads"))),
    );
    // A substring: REF-27 is in REF-270 and REF-279 too.
    const ref = await readAll({ q: "REF-27" }, { limit: 200 });
    assert.deepEqual(
      ref.ids,
      expectedOrder(allSeeded(({ bank }) => !!bank?.reference?.startsWith("REF-27"))),
    );
    assert.equal(ref.ids.length, 3);
    const literal = await bankingQueue(companyId, { q: "100%_" });
    assert.equal(literal.total, 0, "LIKE wildcards in q match literally");
  });

  test("categoryAccountId finds card purchases and bank lines filed under an account, as the books hold them now", async () => {
    // Two bank lines categorized on Banking, one of them since re-filed by Entry review before categories locked.
    const [toSoftware, toRentThenSoftware, toRent] = await AppDataSource.getRepository(
      BankTransaction,
    ).find({
      where: { companyId, reconciledAt: IsNull() },
      take: 3,
      order: { date: "ASC", id: "ASC" },
    });
    await categorizeBankTransaction(toSoftware, software.id, null);
    await categorizeBankTransaction(toRentThenSoftware, rent.id, null);
    await categorizeBankTransaction(toRent, rent.id, null);
    const refiled = await AppDataSource.getRepository(BankTransaction).findOneByOrFail({
      id: toRentThenSoftware.id,
    });
    await legacyEntryReview(
      await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
        id: refiled.matchedLedgerEntryId!,
      }),
      rent,
      software,
    );
    // And three card purchases moved to Software.
    const cards = seeded.cardRows.filter((card) => card.accountingKind === "expense").slice(0, 3);
    await AppDataSource.getRepository(CardTransaction).update(
      cards.map((card) => card.id!),
      { expenseAccountId: software.id },
    );

    const filedUnderSoftware = await bankingQueue(
      companyId,
      { categoryAccountId: software.id },
      { limit: 200 },
    );
    assert.deepEqual(
      filedUnderSoftware.transactions.map((row) => row.id).sort(),
      [toSoftware.id, toRentThenSoftware.id, ...cards.map((card) => card.id!)].sort(),
    );
    assert.ok(
      filedUnderSoftware.transactions.every((row) => row.category?.code === "6300"),
      "each row shows the category it was found by",
    );
    const filedUnderRent = await bankingQueue(
      companyId,
      { categoryAccountId: rent.id },
      { limit: 200 },
    );
    assert.deepEqual(
      filedUnderRent.transactions.map((row) => row.id),
      [toRent.id],
    );
    // The default card category holds every untouched purchase but no card bill payment.
    const general6000 = await readAll({ categoryAccountId: general.id }, { limit: 200 });
    assert.ok(general6000.ids.length > 0, "untouched purchases sit in 6000");
    const payments = new Set(
      seeded.cardRows.filter((card) => card.accountingKind === "payment").map((card) => card.id),
    );
    assert.ok(
      general6000.ids.every((id) => !payments.has(id)),
      "a card bill payment has no category",
    );
    // The feed's own bank account is never a bank line's category.
    assert.equal(
      (await bankingQueue(companyId, { kind: "bank", categoryAccountId: bankAccount.id })).total,
      0,
    );
  });

  test("filters combine, and a cursor only continues the filters that issued it", async () => {
    const filter: BankingQueueFilter = {
      status: "review",
      kind: "card",
      from: "2023-01-03",
      to: "2023-01-12",
      direction: "out",
      minAmountCents: 2_100,
      q: "purchase",
    };
    const { ids } = await readAll(filter, { limit: 7 });
    const expected = allSeeded(({ card }) => {
      if (!card) return false;
      const day = card.postedAt!.toISOString().slice(0, 10);
      return (
        (card.ledgerEntryId === null || card.needsReview === true) &&
        day >= "2023-01-03" &&
        day <= "2023-01-12" &&
        card.accountingKind === "expense" &&
        card.amountCents! >= 2_100 &&
        card.description!.includes("purchase")
      );
    });
    assert.ok(expected.length > 7, "several pages");
    assert.deepEqual(ids, expectedOrder(expected));
    const first = await bankingQueue(companyId, filter, { limit: 7 });
    await assert.rejects(
      bankingQueue(companyId, { ...filter, minAmountCents: 2_200 }, { cursor: first.nextCursor! }),
      {
        message: CURSOR_OTHER_FILTERS,
      },
    );
    // The same filters spelled with the same meaning still continue.
    const again = await bankingQueue(
      companyId,
      { ...filter, q: "  purchase " },
      { limit: 7, cursor: first.nextCursor! },
    );
    assert.deepEqual(
      again.transactions.map((row) => row.id),
      ids.slice(7, 14),
    );
  });
});

describe("refusals", () => {
  test("a garbled or foreign cursor is refused with what to do", async () => {
    await assert.rejects(
      bankingQueue(companyId, {}, { cursor: "garbage!" }),
      (err: unknown) =>
        err instanceof ListQueryError && err.status === 400 && err.message === CURSOR_INVALID,
    );
    await assert.rejects(
      bankingQueue(
        companyId,
        {},
        { cursor: encodeCursor("finance.transactions", "x", ["a", "b"]) },
      ),
      {
        message: CURSOR_OTHER_LIST,
      },
    );
  });

  test("dates and amount ranges that cannot be read, or end before they start, are refused", async () => {
    await assert.rejects(bankingQueue(companyId, { from: "last week" }), ListQueryError);
    await assert.rejects(
      bankingQueue(companyId, { from: "2023-02-01", to: "2023-01-31" }),
      ListQueryError,
    );
    await assert.rejects(
      bankingQueue(companyId, { minAmountCents: 10, maxAmountCents: 5 }),
      ListQueryError,
    );
  });

  test("an account or category of another company is not found", async () => {
    const theirs = await AppDataSource.getRepository(BankFeed).findOneByOrFail({
      companyId: otherCompanyId,
      name: "Checking",
    });
    await assert.rejects(
      bankingQueue(companyId, { feedId: theirs.id }),
      (err: unknown) => err instanceof ListQueryError && err.status === 404,
    );
    const theirAccount = (await accountByCode(otherCompanyId, "6000"))!;
    await assert.rejects(
      bankingQueue(companyId, { categoryAccountId: theirAccount.id }),
      (err: unknown) => err instanceof ListQueryError && err.status === 404,
    );
  });
});

describe("rows", () => {
  test("name their account and category and sign amounts from the company's side", async () => {
    const page = await bankingQueue(companyId, { kind: "card", direction: "out" }, { limit: 1 });
    const [row] = page.transactions;
    assert.equal(row.kind, "card");
    assert.ok(row.amountCents < 0, "a purchase is money out");
    assert.deepEqual(row.account, { feedId: brex.id, name: "Brex Primary" });
    assert.equal(row.category?.code, "6000");
    const bank = await bankingQueue(companyId, { feedId: checking.id }, { limit: 1 });
    assert.equal(bank.transactions[0].account.name, "Checking");
    assert.equal(bank.transactions[0].currency, "USD");
  });
});
