import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMoney, type AccountType, type TrialBalanceRow } from "./api.js";
import {
  ACCOUNT_TYPE_ORDER,
  accountMeaning,
  addedAndTakenOff,
  formatBalance,
  formatChange,
  isUnusualBalance,
  ledgerDate,
  summarizeTrialBalance,
  unusualBalanceNote,
} from "./ledgerAccounts.js";

function row(
  code: string,
  name: string,
  type: AccountType,
  debitCents: number,
  creditCents: number,
  isSystem = true,
): TrialBalanceRow {
  const debitNormal = type === "asset" || type === "expense";
  return {
    account: { id: `acct_${code}`, code, name, type, isSystem },
    debitCents,
    creditCents,
    balanceCents: debitNormal ? debitCents - creditCents : creditCents - debitCents,
  };
}

// A real trial balance a founder couldn't read: Bank showed "$165,669.15"
// with its minus sign dropped.
const ROWS: TrialBalanceRow[] = [
  row("1100", "Bank", "asset", 2_352_000, 18_918_915),
  row("1200", "Accounts Receivable", "asset", 27_090_100, 14_876_500),
  row("1300", "Vendor Credits", "asset", 0, 0),
  row("2300", "Corporate Card Payable", "liability", 18_022_897, 18_024_397),
  row("3100", "Retained Earnings", "equity", 0, 0),
  row("4000", "Sales Revenue", "revenue", 12_524_500, 25_914_100),
  row("6000", "General & Administrative", "expense", 18_024_397, 279_982),
];

const usd = (cents: number) => formatMoney(cents, "USD");

describe("summarizeTrialBalance", () => {
  test("adds up, and restates the check as owns = owes + stake + profit", () => {
    const s = summarizeTrialBalance(ROWS);
    assert.equal(s.debitCents, 78_013_894);
    assert.equal(s.creditCents, 78_013_894);
    assert.equal(s.ownCents, -4_353_315);
    assert.equal(s.oweCents, 1_500);
    assert.equal(s.stakeCents, 0);
    assert.equal(s.incomeCents - s.expensesCents, -4_354_815);
    assert.equal(s.ownCents, s.oweCents + s.stakeCents + s.incomeCents - s.expensesCents);
  });

  test("groups every kind of account in order, flags Bank, and counts the empty ones", () => {
    const s = summarizeTrialBalance(ROWS);
    assert.deepEqual(
      s.groups.map((g) => g.type),
      ACCOUNT_TYPE_ORDER,
    );
    assert.deepEqual(
      s.groups.find((g) => g.type === "asset")?.rows.map((r) => r.account.code),
      ["1100", "1200", "1300"],
    );
    assert.deepEqual(
      s.unusual.map((r) => r.account.code),
      ["1100"],
    );
    assert.equal(s.emptyCount, 2);
  });

  test("an entry missing a side shows up in both forms of the check", () => {
    const s = summarizeTrialBalance([
      ...ROWS,
      row("6100", "Bad Debt Expense", "expense", 5_000, 0),
    ]);
    assert.notEqual(s.debitCents, s.creditCents);
    assert.notEqual(s.ownCents, s.oweCents + s.stakeCents + s.incomeCents - s.expensesCents);
  });
});

describe("isUnusualBalance", () => {
  test("flags a balance below zero", () => {
    assert.equal(isUnusualBalance(row("1100", "Bank", "asset", 0, 100).account, -100), true);
    assert.equal(isUnusualBalance(row("2300", "Card", "liability", 100, 0).account, -100), true);
  });

  test("leaves equity, contra revenue, and balances at or above zero alone", () => {
    assert.equal(
      isUnusualBalance(row("3100", "Retained Earnings", "equity", 0, 0).account, -1),
      false,
    );
    assert.equal(isUnusualBalance(row("4100", "Returns", "revenue", 0, 0).account, -1), false);
    assert.equal(isUnusualBalance(row("1100", "Bank", "asset", 0, 0).account, 0), false);
    assert.equal(isUnusualBalance(row("1100", "Bank", "asset", 0, 0).account, 1), false);
  });

  test("an added account that happens to use 4100 is read like any other", () => {
    const custom = row("4100", "Consulting", "revenue", 0, 0, false).account;
    assert.equal(isUnusualBalance(custom, -1), true);
  });
});

describe("plain words", () => {
  test("explains a bank below zero from what came in and went out", () => {
    const bank = ROWS[0];
    assert.equal(
      unusualBalanceNote(bank.account, bank.debitCents, bank.creditCents, usd),
      "More is recorded going out ($189,189.15) than coming in ($23,520.00). Usually a deposit or customer payment that isn't in the books yet.",
    );
  });

  test("describes system accounts by code, renamed or not, and leaves added ones to their name", () => {
    assert.equal(
      accountMeaning({ code: "1100", isSystem: true }),
      "Money in the company's bank accounts.",
    );
    assert.equal(accountMeaning({ code: "1100", isSystem: false }), null);
    assert.equal(accountMeaning({ code: "7777", isSystem: true }), null);
  });

  test("reads debits as adding to what is owned and spent, credits to the rest", () => {
    assert.deepEqual(addedAndTakenOff("asset", 10, 3), { addedCents: 10, takenOffCents: 3 });
    assert.deepEqual(addedAndTakenOff("expense", 10, 3), { addedCents: 10, takenOffCents: 3 });
    assert.deepEqual(addedAndTakenOff("liability", 10, 3), { addedCents: 3, takenOffCents: 10 });
    assert.deepEqual(addedAndTakenOff("revenue", 10, 3), { addedCents: 3, takenOffCents: 10 });
  });

  test("writes money with a true minus sign and days in UTC", () => {
    assert.equal(formatBalance(-16_566_915, "USD"), "−$165,669.15");
    assert.equal(formatBalance(1_500, "USD"), "$15.00");
    assert.equal(formatChange(500_000, "USD"), "+$5,000.00");
    assert.equal(formatChange(-8_412, "USD"), "−$84.12");
    assert.equal(formatChange(0, "USD"), "$0.00");
    assert.equal(ledgerDate("2026-10-21"), "Oct 21, 2026");
    assert.equal(ledgerDate("2026-10-21T00:00:00.000Z"), "Oct 21, 2026");
  });
});
