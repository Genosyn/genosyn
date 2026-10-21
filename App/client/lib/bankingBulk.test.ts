import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Account, BankTransaction, CardTransaction } from "./api.js";
import {
  type BankingRow,
  bulkActionsFor,
  categoryGroups,
  planFor,
  rowKey,
  sendToReviewConfirmation,
  skippedSummary,
  unselectableReason,
} from "./bankingBulk.js";

/**
 * Banking's bulk bar offers only what the ticked rows can take, and says what
 * Send to review will undo before it does. The server applies the same rules
 * row by row; these keep the bar from offering what could only be skipped.
 */

function bank(id: string, changes: Partial<BankTransaction> = {}): BankingRow {
  const txn: BankTransaction = {
    id,
    companyId: "company",
    feedId: "checking",
    externalId: null,
    date: "2026-10-18T00:00:00.000Z",
    amountCents: -4_200,
    description: "GITHUB",
    reference: "",
    raw: "",
    matchedPaymentId: null,
    matchedLedgerEntryId: null,
    reconciledAt: null,
    reconciledById: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    match: null,
    ...changes,
  };
  return { kind: "bank", id, date: txn.date, txn };
}

function card(id: string, changes: Partial<CardTransaction> = {}): BankingRow {
  const txn: CardTransaction = {
    id,
    companyId: "company",
    feedId: "brex",
    externalId: id,
    cardId: "card_074k",
    postedAt: "2026-10-15T12:00:00.000Z",
    amountCents: 20_485,
    currency: "USD",
    description: "Claude",
    providerType: "PURCHASE",
    accountingKind: "expense",
    expenseAccountId: "g-and-a",
    ledgerEntryId: "entry",
    postingError: "",
    raw: "",
    reclassifiedAt: null,
    needsReview: false,
    createdAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    ...changes,
  };
  return { kind: "card", id, date: txn.postedAt, txn };
}

const categorized = (id: string) =>
  bank(id, {
    reconciledAt: "2026-10-19T00:00:00.000Z",
    match: {
      kind: "ledger_entry",
      entryId: "entry",
      memo: "GITHUB",
      source: "bank_categorization",
      sourceRefId: id,
      categoryAccountId: "software",
    },
  });

const matched = (id: string) =>
  bank(id, {
    reconciledAt: "2026-10-19T00:00:00.000Z",
    match: {
      kind: "ledger_entry",
      entryId: "rent",
      memo: "Rent",
      source: "manual",
      sourceRefId: null,
      categoryAccountId: null,
    },
  });

const payment = (recordedHere: boolean) => ({
  paymentId: "payment",
  invoiceId: "invoice",
  invoiceNumber: "INV-0001",
  invoiceSlug: "inv-0001",
  customerName: "Acme",
  amountCents: 80_000,
  recordedHere,
});

function account(id: string, code: string, type: Account["type"], archived = false): Account {
  return {
    id,
    code,
    name: id,
    type,
    archivedAt: archived ? "2026-01-01T00:00:00.000Z" : null,
  } as Account;
}

describe("what a row can take", () => {
  test("a bank transaction in review takes a category; a done one goes back to review", () => {
    assert.deepEqual(bulkActionsFor(bank("open")), ["categorize"]);
    assert.deepEqual(bulkActionsFor(categorized("done")), ["send_to_review"]);
    assert.deepEqual(bulkActionsFor(matched("matched")), ["send_to_review"]);
  });

  test("a deposit that paid invoices is left to its own row", () => {
    const paid = bank("paid", {
      amountCents: 80_000,
      reconciledAt: "2026-10-19T00:00:00.000Z",
      match: { kind: "payments", payments: [payment(true)] },
    });
    const partPaid = bank("part", {
      amountCents: 80_000,
      match: { kind: "payments", payments: [payment(true)] },
    });
    // Matched to a payment someone recorded by hand: only the link goes.
    const matchedPayment = bank("matched", {
      amountCents: 80_000,
      reconciledAt: "2026-10-19T00:00:00.000Z",
      match: { kind: "payments", payments: [payment(false)] },
    });
    assert.deepEqual(bulkActionsFor(paid), []);
    assert.deepEqual(bulkActionsFor(partPaid), []);
    assert.deepEqual(bulkActionsFor(matchedPayment), ["send_to_review"]);
    assert.equal(unselectableReason(paid), "It paid invoices. Open it to undo it on its own");
    assert.equal(
      unselectableReason(partPaid),
      "Part of it paid invoices. Open it to finish or undo it",
    );
    assert.equal(unselectableReason(matchedPayment), null);
  });

  test("a card purchase always takes a category, and is kept or sent back by where it is", () => {
    assert.deepEqual(bulkActionsFor(card("waiting", { needsReview: true })), [
      "categorize",
      "mark_reviewed",
    ]);
    assert.deepEqual(bulkActionsFor(card("reviewed")), ["categorize", "send_to_review"]);
    assert.deepEqual(bulkActionsFor(card("failed", { ledgerEntryId: null })), ["categorize"]);
    assert.deepEqual(bulkActionsFor(card("refund", { accountingKind: "refund" })), [
      "categorize",
      "send_to_review",
    ]);
  });

  test("a card bill payment can't be ticked", () => {
    const bill = card("bill", { accountingKind: "payment", expenseAccountId: null });
    assert.deepEqual(bulkActionsFor(bill), []);
    assert.equal(unselectableReason(bill), "A card bill payment has no category");
  });

  test("bank and card rows are keyed apart", () => {
    assert.notEqual(rowKey(bank("same")), rowKey(card("same")));
  });
});

test("a plan sends each action only the rows that can take it, in order", () => {
  const rows = [
    card("waiting", { needsReview: true }),
    bank("open"),
    categorized("done"),
    card("reviewed"),
  ];
  const ids = (list: BankingRow[]) => list.map((row) => row.id);
  const plan = planFor(rows);
  assert.deepEqual(ids(plan.categorize), ["waiting", "open", "reviewed"]);
  assert.deepEqual(ids(plan.mark_reviewed), ["waiting"]);
  assert.deepEqual(ids(plan.send_to_review), ["done", "reviewed"]);
});

describe("the categories Categorize offers", () => {
  const accounts = [
    account("checking-1100", "1100", "asset"),
    account("savings-1110", "1110", "asset"),
    account("sales-4000", "4000", "revenue"),
    account("software-6300", "6300", "expense"),
    account("g-and-a-6000", "6000", "expense"),
    account("old-6900", "6900", "expense", true),
    account("equity-3000", "3000", "equity"),
  ];
  const ledgerOf = (feedId: string) => (feedId === "savings" ? "savings-1110" : "checking-1100");
  const shape = (groups: ReturnType<typeof categoryGroups>) =>
    groups.map((group) => [group.label, group.accounts.map((a) => a.code)]);

  test("card purchases alone take expenses alone, archived ones left out", () => {
    assert.deepEqual(shape(categoryGroups(accounts, [card("a"), card("b")], ledgerOf)), [
      ["Expenses", ["6000", "6300"]],
    ]);
  });

  test("money in leads with Income and leaves out its own bank account", () => {
    assert.deepEqual(
      shape(categoryGroups(accounts, [bank("interest", { amountCents: 2_500 })], ledgerOf)),
      [
        ["Income", ["4000"]],
        ["Assets", ["1110"]],
        ["Equity", ["3000"]],
        ["Expenses", ["6000", "6300"]],
      ],
    );
  });

  test("money out, or a mix with card purchases, leads with Expenses", () => {
    assert.deepEqual(shape(categoryGroups(accounts, [bank("fee"), card("a")], ledgerOf))[0], [
      "Expenses",
      ["6000", "6300"],
    ]);
  });

  test("bank transactions on two accounts keep both, since each explains the other", () => {
    const groups = categoryGroups(
      accounts,
      [bank("out"), bank("in", { feedId: "savings", amountCents: 4_200 })],
      ledgerOf,
    );
    assert.deepEqual(
      shape(groups).find(([label]) => label === "Assets"),
      ["Assets", ["1100", "1110"]],
    );
  });
});

describe("Send to review", () => {
  test("asks nothing when only card purchases go back", () => {
    assert.equal(sendToReviewConfirmation([card("a"), card("b")]), null);
  });

  test("says what it undoes in the books before it does", () => {
    assert.deepEqual(
      sendToReviewConfirmation([
        categorized("one"),
        categorized("two"),
        matched("rent"),
        card("a"),
        card("b"),
        card("c"),
      ]),
      {
        title: "Send 6 transactions back to review?",
        message:
          "The categories of 2 bank transactions are reversed with opposite entries. 1 bank transaction is unlinked from what it matched, which stays in your books. 3 card purchases keep their categories.",
        confirmLabel: "Send to review",
      },
    );
    assert.deepEqual(sendToReviewConfirmation([categorized("one")]), {
      title: "Send this transaction back to review?",
      message: "The category of 1 bank transaction is reversed with an opposite entry.",
      confirmLabel: "Send to review",
    });
  });
});

describe("why some were skipped", () => {
  test("names each reason once, with how often, and how many went through", () => {
    assert.deepEqual(
      skippedSummary(
        [
          { kind: "bank", id: "a", reason: "It's already done, so send it back to review first." },
          { kind: "bank", id: "b", reason: "It's already done, so send it back to review first" },
          { kind: "card", id: "c", reason: "A card bill payment has no category" },
        ],
        "categorize",
        47,
      ),
      {
        title: "3 transactions weren’t categorized",
        reasons: [
          { reason: "It's already done, so send it back to review first", count: 2 },
          { reason: "A card bill payment has no category", count: 1 },
        ],
        rest: "The other 47 were categorized.",
      },
    );
  });

  test("speaks of one when there is one", () => {
    const summary = skippedSummary(
      [{ kind: "card", id: "c", reason: "It isn't in your books yet, so retry it first" }],
      "mark_reviewed",
      1,
    );
    assert.equal(summary.title, "1 transaction wasn’t marked reviewed");
    assert.equal(summary.rest, "The other one was marked reviewed.");
    assert.equal(
      skippedSummary([{ kind: "bank", id: "b", reason: "x" }], "send_to_review", 0).rest,
      "",
    );
  });
});
