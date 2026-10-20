import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import {
  accountCodes,
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
import { type CardCategoryDrift, findCardCategoryDrift } from "./cardCategoryDrift.js";
import { fixSplitCardCategory, matchCardCategoriesToBooks } from "./cardCategoryRepair.js";
import { reclassifyCardTransaction } from "./cardExpenses.js";
import { postLedgerEntry } from "./ledger.js";
import { approveLedgerReview } from "./transactionReviews.js";

/**
 * Before Banking became the one place a card purchase's category changes,
 * Entry review could move one too, and the purchase never heard of it. The
 * finder has to spot every purchase that left behind — whichever entry Entry
 * review changed, in whichever order the two pages were used — and say what
 * puts it right: the books holding the purchase under exactly one category,
 * the one Banking shows, so that Banking's next change works again.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_card_category_drift";
const OTHER_CO = "co_card_category_drift_other";
const AMOUNT = 12_000;
const REFUND = 3_000;

type Category = "general" | "travel" | "software" | "meals" | "office";

const setup = (companyId = CO) => cardBooks(companyId);
const balances = () => balancesByCode(CO);

function purchase(
  feed: CardFeed,
  options: { kind?: "expense" | "refund"; cents?: number; postedAt?: Date } = {},
) {
  return cardPurchase(feed, { ...options, cents: options.cents ?? AMOUNT });
}

/** Where the finder says the books hold the purchase, by account code. */
async function filedByCode(drift: CardCategoryDrift): Promise<Record<string, number>> {
  const codeOf = await accountCodes(CO);
  return Object.fromEntries(
    drift.filed.map((amount) => [codeOf.get(amount.accountId)!, amount.cents]),
  );
}

/** Put the finder's repair into effect as Genosyn does: at boot, or with Fix on Banking. */
async function applyRepair(drift: CardCategoryDrift): Promise<void> {
  if (drift.repair?.kind === "reclassify") {
    await fixSplitCardCategory({
      companyId: CO,
      transactionId: drift.transaction.id,
      lines: drift.repair.lines,
      actorUserId: "u1",
    });
  } else {
    await matchCardCategoriesToBooks();
  }
}

type History = {
  name: string;
  refund?: boolean;
  steps: Array<(ctx: CardBooks & { posting: LedgerEntry; card: CardTransaction }) => Promise<void>>;
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
      reclass = await moveOnBanking(ctx.card, ctx[to]);
    },
    async (ctx) => {
      await legacyEntryReview(reclass, ctx[line], ctx[moveTo]);
    },
  ];
}

const review =
  (from: Category, to: Category): History["steps"][number] =>
  async (ctx) => {
    await legacyEntryReview(ctx.posting, ctx[from], ctx[to]);
  };
const bank =
  (to: Category): History["steps"][number] =>
  async (ctx) => {
    await moveOnBanking(ctx.card, ctx[to]);
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
      assert.equal(
        (await accountCodes(CO)).get(drift.transaction.expenseAccountId!),
        history.banking,
      );
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
      assert.equal((await accountCodes(CO)).get(repaired.expenseAccountId!), history.settlesOn);
      // Banking moves it from where it is again.
      await reclassifyCardTransaction(repaired, ctx.office.id, "u1");
      assert.deepEqual(await balances(), { "2300": -booked, "6500": booked });
      assert.deepEqual(await findCardCategoryDrift(CO), []);
    });
  }

  test("a split's correction moves only what is out of place, debits first", async () => {
    const { feed, general, software, travel } = await setup();
    const { card, posting } = await purchase(feed);
    await legacyEntryReview(posting, general, software);
    await moveOnBanking(card, travel);

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
    const first = await moveOnBanking(card, travel);
    const second = await moveOnBanking(card, software);
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
    await legacyEntryReview(entry, general, software);

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
    await legacyEntryReview(older.posting, ctx.general, ctx.software);
    await legacyEntryReview(newer.posting, ctx.general, ctx.meals);
    await moveOnBanking(newer.card, ctx.travel);
    await moveOnBanking(untouched.card, ctx.travel);
    await legacyEntryReview(elsewhere.posting, other.general, other.software);

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
    await legacyEntryReview(posting, await reload(Account, feed.liabilityAccountId), software);

    const [drift] = await findCardCategoryDrift(CO);

    assert.equal(drift.transaction.id, card.id);
    assert.equal(drift.kind, "unrecognized");
    assert.equal(drift.repair, null);
    assert.equal(drift.problem, "A category change moved money on the card's own account");
  });

  test("is listed with no repair when it is filed under an account that isn't an expense category", async () => {
    const { feed, general, software } = await setup();
    const { card, posting } = await purchase(feed);
    await legacyEntryReview(posting, general, software);
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
