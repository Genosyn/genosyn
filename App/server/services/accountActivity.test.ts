import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts, trialBalance } from "./ledger.js";
import { accountActivity } from "./reports.js";

/**
 * The entries behind one account's total — what the Trial balance and
 * Reports open when someone clicks an account. Each row names the other side
 * of its entry, and an account read up to a date ends on exactly the balance
 * the trial balance shows for that date.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_account_activity";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

async function chart() {
  await seedChartOfAccounts(CO);
  const byCode = async (code: string) => {
    const account = await accountByCode(CO, code);
    assert.ok(account, `system account ${code}`);
    return account;
  };
  return {
    bank: await byCode("1100"),
    card: await byCode("2300"),
    equity: await byCode("3000"),
    sales: await byCode("4000"),
    admin: await byCode("6000"),
  };
}

describe("account activity", () => {
  test("names the other side of each entry and ends on the trial balance's figure", async () => {
    const a = await chart();
    await postLedgerEntry({
      companyId: CO,
      date: day("2026-01-05"),
      memo: "Owner investment",
      lines: [
        { accountId: a.bank.id, debitCents: 100_000 },
        { accountId: a.equity.id, creditCents: 100_000 },
      ],
    });
    // Two lines on the same other account name it once.
    await postLedgerEntry({
      companyId: CO,
      date: day("2026-02-10"),
      memo: "Consulting",
      lines: [
        { accountId: a.bank.id, debitCents: 3_000 },
        { accountId: a.sales.id, creditCents: 1_000 },
        { accountId: a.sales.id, creditCents: 2_000 },
      ],
    });
    await postLedgerEntry({
      companyId: CO,
      date: day("2026-02-28"),
      memo: "Software",
      lines: [
        { accountId: a.admin.id, debitCents: 2_500 },
        { accountId: a.bank.id, creditCents: 2_500 },
      ],
    });
    // After the date, so neither the activity nor the trial balance reads it.
    await postLedgerEntry({
      companyId: CO,
      date: day("2026-03-01"),
      memo: "Later sale",
      lines: [
        { accountId: a.bank.id, debitCents: 9_000 },
        { accountId: a.sales.id, creditCents: 9_000 },
      ],
    });

    const report = await accountActivity(CO, a.bank.id, null, day("2026-02-28"));
    assert.ok(report);
    assert.deepEqual(
      report.rows.map((r) => [r.memo, r.runningBalanceCents, r.otherAccounts.map((o) => o.code)]),
      [
        ["Owner investment", 100_000, ["3000"]],
        ["Consulting", 103_000, ["4000"]],
        ["Software", 100_500, ["6000"]],
      ],
    );
    assert.equal(report.account.isSystem, true);
    assert.equal(report.rows[0].sourceRefId, null);

    const rows = await trialBalance(CO, day("2026-02-28"));
    const bank = rows.find((r) => r.account.id === a.bank.id);
    assert.equal(report.closingBalance, bank?.balanceCents);
    assert.equal(report.closingBalance, 100_500);
  });

  test("opens a period on everything posted before it", async () => {
    const a = await chart();
    for (const [date, cents] of [
      ["2026-01-15", 5_000],
      ["2026-02-15", 7_000],
      ["2026-03-15", 11_000],
    ] as const) {
      await postLedgerEntry({
        companyId: CO,
        date: day(date),
        memo: `Sale ${date}`,
        lines: [
          { accountId: a.bank.id, debitCents: cents },
          { accountId: a.sales.id, creditCents: cents },
        ],
      });
    }

    const report = await accountActivity(CO, a.sales.id, day("2026-02-01"), day("2026-02-28"));
    assert.ok(report);
    assert.equal(report.openingBalance, 5_000);
    assert.deepEqual(
      report.rows.map((r) => r.memo),
      ["Sale 2026-02-15"],
    );
    assert.equal(report.closingBalance, 12_000);
  });

  test("a credit-normal account counts credits as adding", async () => {
    const a = await chart();
    await postLedgerEntry({
      companyId: CO,
      date: day("2026-04-01"),
      memo: "Flight on the company card",
      lines: [
        { accountId: a.admin.id, debitCents: 40_000 },
        { accountId: a.card.id, creditCents: 40_000 },
      ],
    });
    await postLedgerEntry({
      companyId: CO,
      date: day("2026-04-20"),
      memo: "Card payment",
      lines: [
        { accountId: a.card.id, debitCents: 40_000 },
        { accountId: a.bank.id, creditCents: 40_000 },
      ],
    });

    const report = await accountActivity(CO, a.card.id, null, day("2026-04-30"));
    assert.ok(report);
    assert.deepEqual(
      report.rows.map((r) => [r.runningBalanceCents, r.otherAccounts.map((o) => o.code)]),
      [
        [40_000, ["6000"]],
        [0, ["1100"]],
      ],
    );
  });

  test("an account of another company is not found", async () => {
    const a = await chart();
    assert.equal(
      await accountActivity("co_someone_else", a.bank.id, null, day("2026-04-30")),
      null,
    );
  });
});
