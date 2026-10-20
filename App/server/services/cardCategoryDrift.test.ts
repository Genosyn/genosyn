import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { type CardCategoryDrift, findCardCategoryDrift } from "./cardCategoryDrift.js";
import { reclassifyCardTransaction, retryCardTransaction } from "./cardExpenses.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "./ledger.js";
import { approveLedgerReview } from "./transactionReviews.js";

/**
 * Before Banking became the one place a card purchase's category changes,
 * Entry review could move one too, and the purchase never heard of it. The
 * finder has to spot every purchase that left behind — whichever entry Entry
 * review changed, in whichever order the two pages were used — and say what
 * would put it right: the books holding the purchase under exactly one
 * category, the one Banking shows, so that Banking's next change works again.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_card_category_drift";
const OTHER_CO = "co_card_category_drift_other";
const PURCHASE_DAY = new Date("2026-03-14T12:00:00Z");
const AMOUNT = 12_000;
const REFUND = 3_000;

async function setup(companyId = CO) {
  await seedChartOfAccounts(companyId);
  const general = (await accountByCode(companyId, "6000"))!;
  const payable = (await accountByCode(companyId, "2300"))!;
  const bank = (await accountByCode(companyId, "1100"))!;
  const expense = (code: string, name: string) =>
    insert(Account, { companyId, code, name, type: "expense" });
  const travel = await expense("6200", "Travel");
  const software = await expense("6300", "Software");
  const meals = await expense("6400", "Meals");
  const office = await expense("6500", "Office");
  const feed = await insert(CardFeed, {
    companyId,
    name: "Brex card",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: general.id,
    paymentAccountId: bank.id,
  });
  return { companyId, general, bank, travel, software, meals, office, feed };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Category = "general" | "travel" | "software" | "meals" | "office";

/** A card purchase (or refund) synced and posted under the card's default category. */
async function purchase(
  feed: CardFeed,
  options: { kind?: "expense" | "refund"; cents?: number; postedAt?: Date } = {},
): Promise<{ card: CardTransaction; posting: LedgerEntry }> {
  const kind = options.kind ?? "expense";
  const cents = options.cents ?? AMOUNT;
  const card = await retryCardTransaction(
    await insert(CardTransaction, {
      companyId: feed.companyId,
      feedId: feed.id,
      externalId: randomUUID(),
      postedAt: options.postedAt ?? PURCHASE_DAY,
      // Brex counts a purchase as positive and a refund as negative.
      amountCents: kind === "refund" ? -cents : cents,
      currency: "USD",
      description: kind === "refund" ? "Refund: Delta Air Lines" : "Delta Air Lines",
      accountingKind: kind,
      expenseAccountId: feed.defaultExpenseAccountId,
    }),
  );
  return { card, posting: await reload(LedgerEntry, card.ledgerEntryId!) };
}

async function reload<T extends { id: string }>(entity: new () => T, id: string): Promise<T> {
  return AppDataSource.getRepository(entity).findOneByOrFail({ id } as never);
}

/** Banking moves the purchase, and returns the reclassification it posted. */
async function onBanking(card: CardTransaction, to: Account): Promise<LedgerEntry> {
  const mine = () =>
    AppDataSource.getRepository(LedgerEntry).find({
      where: { companyId: card.companyId, source: "brex_card_reclass" },
    });
  const before = new Set((await mine()).map((entry) => entry.id));
  await reclassifyCardTransaction(await reload(CardTransaction, card.id), to.id, "u1");
  return (await mine()).find((entry) => !before.has(entry.id))!;
}

/**
 * What Entry review did before it stopped changing card categories: approve
 * the entry with one line moved, posting an approved `ledger_reclass` against
 * the entry as it was shown. Line for line what `approveLedgerReview` posted.
 */
async function inEntryReview(entry: LedgerEntry, from: Account, to: Account): Promise<LedgerEntry> {
  const line = (
    await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entry.id } })
  ).find((candidate) => candidate.accountId === from.id)!;
  const amount = line.debitCents || line.creditCents;
  const description = `Reclassifies ${entry.id.slice(0, 8)}`;
  const { entry: reclass } = await postLedgerEntry({
    companyId: entry.companyId,
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
            { accountId: from.id, creditCents: amount, description },
          ]
        : [
            { accountId: from.id, debitCents: amount, description },
            { accountId: to.id, creditCents: amount, description },
          ],
  });
  await AppDataSource.getRepository(LedgerEntry).update(
    { id: entry.id },
    {
      reviewStatus: "approved",
      reviewChangesJson: JSON.stringify([
        { lineId: line.id, fromAccountId: from.id, toAccountId: to.id },
      ]),
      approvedById: "u1",
      approvedAt: new Date(),
    },
  );
  return reclass;
}

async function codes(companyId: string): Promise<Map<string, string>> {
  const accounts = await AppDataSource.getRepository(Account).find({ where: { companyId } });
  return new Map(accounts.map((account) => [account.id, account.code]));
}

/** Debits minus credits per account code across the whole ledger, zeros left out. */
async function balances(companyId = CO): Promise<Record<string, number>> {
  const [lines, codeOf] = await Promise.all([
    AppDataSource.getRepository(LedgerLine).find({ where: { companyId } }),
    codes(companyId),
  ]);
  const net = new Map<string, number>();
  for (const line of lines) {
    const code = codeOf.get(line.accountId)!;
    net.set(code, (net.get(code) ?? 0) + line.debitCents - line.creditCents);
  }
  return Object.fromEntries([...net].filter(([, cents]) => cents !== 0));
}

/** Where the finder says the books hold the purchase, by account code. */
async function filedByCode(
  drift: CardCategoryDrift,
  companyId = CO,
): Promise<Record<string, number>> {
  const codeOf = await codes(companyId);
  return Object.fromEntries(
    drift.filed.map((amount) => [codeOf.get(amount.accountId)!, amount.cents]),
  );
}

/**
 * Put the repair the finder proposes into effect the way Banking files a
 * purchase: Banking's category on the purchase, a correction as one of the
 * purchase's own reclassifications.
 */
async function applyRepair(drift: CardCategoryDrift, companyId = CO): Promise<void> {
  const repair = drift.repair!;
  if (repair.kind === "show_category") {
    await AppDataSource.getRepository(CardTransaction).update(
      { id: drift.transaction.id },
      { expenseAccountId: repair.accountId },
    );
    return;
  }
  await postLedgerEntry({
    companyId,
    date: new Date(),
    memo: "Correct the category of " + drift.transaction.description,
    source: "brex_card_reclass",
    sourceRefId: drift.transaction.id + ":" + randomUUID(),
    createdById: "u1",
    lines: repair.lines,
  });
}

type History = {
  name: string;
  refund?: boolean;
  steps: Array<(ctx: Setup & { posting: LedgerEntry; card: CardTransaction }) => Promise<void>>;
  kind: CardCategoryDrift["kind"];
  /** Where the books hold the purchase, by code. */
  filed: Record<string, number>;
  /** The category Banking shows. */
  banking: string;
  /** Where the purchase is filed once the repair is in, in the books and on Banking alike. */
  settlesOn: string;
};

/** Banking moves the purchase; Entry review then moves a line of the reclassification it posted. */
function bankingThenReview(to: Category, line: Category, moveTo: Category): History["steps"] {
  let reclass: LedgerEntry;
  return [
    async (ctx) => {
      reclass = await onBanking(ctx.card, ctx[to]);
    },
    async (ctx) => {
      await inEntryReview(reclass, ctx[line], ctx[moveTo]);
    },
  ];
}

const review =
  (from: Category, to: Category): History["steps"][number] =>
  async (ctx) => {
    await inEntryReview(ctx.posting, ctx[from], ctx[to]);
  };
const bank =
  (to: Category): History["steps"][number] =>
  async (ctx) => {
    await onBanking(ctx.card, ctx[to]);
  };

const HISTORIES: History[] = [
  {
    name: "Entry review moved it and Banking never did: Banking is out of date",
    steps: [review("general", "software")],
    kind: "banking_out_of_date",
    filed: { "6300": AMOUNT },
    banking: "6000",
    settlesOn: "6300",
  },
  {
    name: "Entry review moved it, then Banking did: split in the books",
    steps: [review("general", "software"), bank("travel")],
    kind: "split_in_books",
    filed: { "6000": -AMOUNT, "6200": AMOUNT, "6300": AMOUNT },
    banking: "6200",
    settlesOn: "6200",
  },
  {
    name: "Banking moved it, then Entry review moved its posting: split in the books",
    steps: [bank("travel"), review("general", "software")],
    kind: "split_in_books",
    filed: { "6000": -AMOUNT, "6200": AMOUNT, "6300": AMOUNT },
    banking: "6200",
    settlesOn: "6200",
  },
  {
    name: "Entry review moved it on from where Banking put it: Banking is out of date",
    steps: bankingThenReview("travel", "travel", "software"),
    kind: "banking_out_of_date",
    filed: { "6300": AMOUNT },
    banking: "6200",
    settlesOn: "6300",
  },
  {
    name: "Entry review changed where Banking took it from: split in the books",
    steps: bankingThenReview("travel", "general", "software"),
    kind: "split_in_books",
    filed: { "6000": AMOUNT, "6200": AMOUNT, "6300": -AMOUNT },
    banking: "6200",
    settlesOn: "6200",
  },
  {
    name: "Entry review moved both the posting and Banking's change: none of it on Banking's category",
    steps: [...bankingThenReview("travel", "travel", "software"), review("general", "meals")],
    kind: "split_in_books",
    filed: { "6000": -AMOUNT, "6300": AMOUNT, "6400": AMOUNT },
    banking: "6200",
    settlesOn: "6200",
  },
  {
    name: "Banking moved it twice after Entry review had: split in the books",
    steps: [review("general", "software"), bank("travel"), bank("meals")],
    kind: "split_in_books",
    filed: { "6000": -AMOUNT, "6300": AMOUNT, "6400": AMOUNT },
    banking: "6400",
    settlesOn: "6400",
  },
  {
    name: "a refund Entry review moved: Banking is out of date",
    refund: true,
    steps: [review("general", "software")],
    kind: "banking_out_of_date",
    filed: { "6300": -REFUND },
    banking: "6000",
    settlesOn: "6300",
  },
  {
    name: "a refund both pages moved: split in the books",
    refund: true,
    steps: [review("general", "software"), bank("travel")],
    kind: "split_in_books",
    filed: { "6000": REFUND, "6200": -REFUND, "6300": -REFUND },
    banking: "6200",
    settlesOn: "6200",
  },
];

describe("a card purchase whose category Entry review changed", () => {
  for (const history of HISTORIES) {
    test(history.name, async () => {
      const ctx = await setup();
      const cents = history.refund ? REFUND : AMOUNT;
      // Debits minus credits on the purchase's category, and on the card's payable.
      const booked = history.refund ? -cents : cents;
      const { card, posting } = await purchase(ctx.feed, {
        kind: history.refund ? "refund" : "expense",
        cents,
      });
      for (const step of history.steps) await step({ ...ctx, card, posting });
      const books = await balances();

      const [drift, ...others] = await findCardCategoryDrift(CO);

      assert.deepEqual(others, []);
      assert.equal(drift.kind, history.kind);
      assert.equal(drift.transaction.id, card.id);
      assert.equal(drift.feedName, "Brex card");
      assert.equal(drift.bookedCents, booked);
      assert.deepEqual(await filedByCode(drift), history.filed);
      assert.equal((await codes(CO)).get(drift.transaction.expenseAccountId!), history.banking);
      assert.equal(drift.problem, null);
      assert.deepEqual(
        drift.reviewEntryIds.sort(),
        (await AppDataSource.getRepository(LedgerEntry).findBy({ source: "ledger_reclass" }))
          .map((entry) => entry.id)
          .sort(),
      );
      // Finding them changes nothing.
      assert.deepEqual(await balances(), books);
      assert.equal(
        (await reload(CardTransaction, card.id)).expenseAccountId,
        drift.transaction.expenseAccountId,
      );

      await applyRepair(drift);

      assert.deepEqual(await findCardCategoryDrift(CO), []);
      assert.deepEqual(await balances(), { "2300": -booked, [history.settlesOn]: booked });
      const repaired = await reload(CardTransaction, card.id);
      assert.equal((await codes(CO)).get(repaired.expenseAccountId!), history.settlesOn);
      // Banking moves it from where it is again.
      await reclassifyCardTransaction(repaired, ctx.office.id, "u1");
      assert.deepEqual(await balances(), { "2300": -booked, "6500": booked });
      assert.deepEqual(await findCardCategoryDrift(CO), []);
    });
  }

  test("a split repair moves only what is out of place, debits first", async () => {
    const { feed, general, software, travel } = await setup();
    const { card, posting } = await purchase(feed);
    await inEntryReview(posting, general, software);
    await onBanking(card, travel);

    const [drift] = await findCardCategoryDrift(CO);

    assert.deepEqual(drift.repair, {
      kind: "reclassify",
      lines: [
        { accountId: general.id, debitCents: AMOUNT, creditCents: 0 },
        { accountId: software.id, debitCents: 0, creditCents: AMOUNT },
      ],
    });
  });
});

describe("what is not drift", () => {
  test("a purchase changed only on Banking, however often, and approved as it is", async () => {
    const { feed, travel, software } = await setup();
    const { card, posting } = await purchase(feed);
    const first = await onBanking(card, travel);
    const second = await onBanking(card, software);
    for (const entry of [posting, first, second]) {
      await approveLedgerReview({ companyId: CO, entryId: entry.id, userId: "u1" });
    }

    assert.deepEqual(await findCardCategoryDrift(CO), []);
    assert.deepEqual(await balances(), { "2300": -AMOUNT, "6300": AMOUNT });
  });

  test("a category Entry review changed on an entry that isn't a card purchase", async () => {
    const { general, bank, software } = await setup();
    const { entry } = await postLedgerEntry({
      companyId: CO,
      date: PURCHASE_DAY,
      memo: "Team lunch",
      lines: [
        { accountId: general.id, debitCents: 5_000 },
        { accountId: bank.id, creditCents: 5_000 },
      ],
    });
    await inEntryReview(entry, general, software);

    assert.deepEqual(await findCardCategoryDrift(CO), []);
  });
});

describe("listing drifted purchases", () => {
  test("lists the company's own drifted purchases, newest first", async () => {
    const ctx = await setup();
    const other = await setup(OTHER_CO);
    const older = await purchase(ctx.feed, { postedAt: new Date("2026-03-01T12:00:00Z") });
    const newer = await purchase(ctx.feed, { postedAt: new Date("2026-03-10T12:00:00Z") });
    const untouched = await purchase(ctx.feed, { postedAt: new Date("2026-03-20T12:00:00Z") });
    const elsewhere = await purchase(other.feed);
    await inEntryReview(older.posting, ctx.general, ctx.software);
    await inEntryReview(newer.posting, ctx.general, ctx.meals);
    await onBanking(newer.card, ctx.travel);
    await onBanking(untouched.card, ctx.travel);
    await inEntryReview(elsewhere.posting, other.general, other.software);

    const found = await findCardCategoryDrift(CO);

    assert.deepEqual(
      found.map((drift) => [drift.transaction.id, drift.kind]),
      [
        [newer.card.id, "split_in_books"],
        [older.card.id, "banking_out_of_date"],
      ],
    );
    assert.deepEqual(
      (await findCardCategoryDrift(OTHER_CO)).map((drift) => drift.transaction.id),
      [elsewhere.card.id],
    );
  });
});

describe("a purchase whose entries don't add up", () => {
  test("is listed with no repair when a category change is missing a line", async () => {
    const { feed, software } = await setup();
    const { card, posting } = await purchase(feed);
    // An approval whose second line never saved: postLedgerEntry writes the
    // entry and its lines in separate statements.
    const change = await insert(LedgerEntry, {
      companyId: CO,
      date: posting.date,
      memo: "Approved category changes for " + posting.memo,
      source: "ledger_reclass",
      sourceRefId: posting.id,
      reviewStatus: "approved",
    });
    await insert(LedgerLine, {
      companyId: CO,
      ledgerEntryId: change.id,
      accountId: software.id,
      debitCents: AMOUNT,
    });

    const [drift] = await findCardCategoryDrift(CO);

    assert.equal(drift.transaction.id, card.id);
    assert.equal(drift.kind, "unrecognized");
    assert.equal(drift.repair, null);
    assert.equal(drift.problem, "Its entries don't balance — some of their lines are missing");
    assert.deepEqual(await filedByCode(drift), { "6000": AMOUNT, "6300": AMOUNT });
  });

  test("is listed with no repair when a change moved money on the card's own account", async () => {
    const { feed, software } = await setup();
    const { card, posting } = await purchase(feed);
    // Entry review only moved income and expense lines, so in the wild this
    // takes a custom card account someone retyped as an expense for a while.
    await inEntryReview(posting, await reload(Account, feed.liabilityAccountId), software);

    const [drift] = await findCardCategoryDrift(CO);

    assert.equal(drift.transaction.id, card.id);
    assert.equal(drift.kind, "unrecognized");
    assert.equal(drift.repair, null);
    assert.equal(drift.problem, "A category change moved money on the card's own account");
  });

  test("is listed with no repair when it is filed under an account that isn't an expense category", async () => {
    const { feed, general, software } = await setup();
    const { card, posting } = await purchase(feed);
    await inEntryReview(posting, general, software);
    // Retyped afterwards, which an account the company added allows. Moving
    // the purchase off it would change the company's income.
    await AppDataSource.getRepository(Account).update({ id: software.id }, { type: "revenue" });

    const [drift] = await findCardCategoryDrift(CO);

    assert.equal(drift.transaction.id, card.id);
    assert.equal(drift.kind, "unrecognized");
    assert.equal(drift.repair, null);
    assert.equal(drift.problem, "It is filed under an account that isn't an expense category");
  });
});
