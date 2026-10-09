import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Account, type AccountType } from "../db/entities/Account.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { stageAiLedgerReview } from "./transactionReviews.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_reviews";

async function account(code: string, type: AccountType): Promise<Account> {
  return insert(Account, { companyId: CO, code, name: `${type} ${code}`, type });
}

/** A transaction with one line on `from`, ready for a proposed category change. */
async function lineOn(from: Account): Promise<{ entry: LedgerEntry; line: LedgerLine }> {
  const entry = await insert(LedgerEntry, {
    companyId: CO,
    date: new Date("2026-03-01T00:00:00Z"),
    memo: "Software",
    source: "manual",
    reviewStatus: "unreviewed",
  });
  const line = await insert(LedgerLine, {
    companyId: CO,
    ledgerEntryId: entry.id,
    accountId: from.id,
    debitCents: 4_200,
  });
  return { entry, line };
}

describe("a proposed category change across account types", () => {
  for (const [type, other, message] of [
    // Read "A expense line" while the article was hard-coded.
    ["expense", "revenue", "An expense line can only move to another expense account"],
    ["revenue", "expense", "A revenue line can only move to another revenue account"],
  ] as const) {
    test(`moving a line from ${type} to ${other} is refused with "${message}"`, async () => {
      const from = await account("6000", type);
      const to = await account("4000", other);
      const { entry, line } = await lineOn(from);
      await assert.rejects(
        stageAiLedgerReview({
          companyId: CO,
          entryId: entry.id,
          employeeId: "employee-1",
          changes: [{ lineId: line.id, accountId: to.id }],
        }),
        (error: unknown) => error instanceof Error && error.message === message,
      );
      const unchanged = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
        id: entry.id,
      });
      assert.equal(unchanged.reviewStatus, "unreviewed");
      assert.equal(unchanged.reviewChangesJson, null);
    });
  }

  test("a line on any other account type cannot be reclassified here at all", async () => {
    const from = await account("1000", "asset");
    const to = await account("1010", "asset");
    const { entry, line } = await lineOn(from);
    await assert.rejects(
      stageAiLedgerReview({
        companyId: CO,
        entryId: entry.id,
        employeeId: "employee-1",
        changes: [{ lineId: line.id, accountId: to.id }],
      }),
      /Only expense and revenue category lines can be reclassified here/,
    );
  });
});
